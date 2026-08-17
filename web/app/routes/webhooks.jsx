import { getShopify } from "../shopify.server";
import { recordBundleSales } from "../bundles-db.server";
import { loadSellers } from "../vendedores";
import { buildPersoFromRestOrder, ingestPersoOrder } from "../personalizados.server";

const NS = "brk_bundles";
const KEY = "config";

// Configs das campanhas de desconto (mesmo metafield lido pela function/admin).
const DISCOUNT_NS = "$app:descontos-personalizados";
const DISCOUNT_KEY = "config";

// Título do desconto (nó) -> tipo de campanha. Usamos o título porque o app
// cria cada campanha com um título fixo (ver app.descontos.jsx).
const CAMPAIGN_KIND_BY_TITLE = {
  "Descontos Personalizados": "pairs",
  "Desconto Progressivo por Coleção": "progressive",
  "Frete Grátis por Coleção": "shipping",
};

// Lê a config de bundles do shop metafield e devolve um map id -> bundle
// (usamos mode + orderTags na atribuição).
async function loadBundlesConfig(admin) {
  try {
    const res = await admin.graphql(
      `query {
        shop { metafield(namespace: "${NS}", key: "${KEY}") { value } }
      }`
    );
    const data = await res.json();
    const raw = data?.data?.shop?.metafield?.value;
    const list = raw ? JSON.parse(raw) : [];
    const map = {};
    for (const b of list) map[b.id] = b;
    return map;
  } catch (e) {
    console.error("[webhooks] loadBundlesConfig", e?.message);
    return {};
  }
}

async function tagsAddToOrder(admin, orderGid, tags) {
  if (!tags.length) return;
  try {
    await admin.graphql(
      `mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { variables: { id: orderGid, tags } }
    );
  } catch (e) {
    console.error("[webhooks] tagsAdd", e?.message);
  }
}

function toCents(v) {
  return Math.round(Number(v || 0) * 100);
}

// ── Tags de pedido por campanha de desconto ────────────────────────────────
// Carrega as campanhas ATIVAS que têm tags configuradas. Sem tags => a campanha
// é ignorada (nada é rastreado, conforme regra do lojista).
async function loadDiscountCampaigns(admin) {
  try {
    const res = await admin.graphql(
      `query {
        discountNodes(first: 100) {
          nodes {
            discount { ... on DiscountAutomaticApp { title } }
            metafield(namespace: "${DISCOUNT_NS}", key: "${DISCOUNT_KEY}") { value }
          }
        }
      }`
    );
    const data = await res.json();
    const nodes = data?.data?.discountNodes?.nodes ?? [];
    const out = [];
    for (const n of nodes) {
      const kind = CAMPAIGN_KIND_BY_TITLE[n.discount?.title];
      if (!kind || !n.metafield?.value) continue;
      let cfg;
      try {
        cfg = JSON.parse(n.metafield.value);
      } catch {
        continue;
      }
      const tags = Array.isArray(cfg.orderTags)
        ? cfg.orderTags.filter(Boolean)
        : [];
      // Só rastreia se a campanha estiver ativa E tiver tags.
      if (cfg.enabled === false || tags.length === 0) continue;
      out.push({ kind, config: cfg, tags });
    }
    return out;
  } catch (e) {
    console.error("[webhooks] loadDiscountCampaigns", e?.message);
    return [];
  }
}

// productGid -> Set(collectionGid) para os produtos do pedido.
async function loadProductCollections(admin, productGids) {
  const map = new Map();
  if (productGids.length === 0) return map;
  try {
    const res = await admin.graphql(
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            collections(first: 250) { nodes { id } }
          }
        }
      }`,
      { variables: { ids: productGids } }
    );
    const data = await res.json();
    for (const node of data?.data?.nodes ?? []) {
      if (!node?.id) continue;
      map.set(node.id, new Set((node.collections?.nodes ?? []).map((c) => c.id)));
    }
  } catch (e) {
    console.error("[webhooks] loadProductCollections", e?.message);
  }
  return map;
}

// Soma as unidades do pedido cujos produtos pertencem a alguma das coleções.
function eligibleUnits(order, collectionIds, prodColls) {
  const wanted = new Set(collectionIds || []);
  if (wanted.size === 0) return 0;
  let units = 0;
  for (const li of order.line_items || []) {
    if (li.product_id == null) continue;
    const colls = prodColls.get(`gid://shopify/Product/${li.product_id}`);
    if (!colls) continue;
    let inAny = false;
    for (const c of colls) {
      if (wanted.has(c)) {
        inAny = true;
        break;
      }
    }
    if (inAny) units += Number(li.quantity || 0);
  }
  return units;
}

// Gatilho mínimo de unidades elegíveis por tipo de campanha.
function thresholdFor(kind, config) {
  if (kind === "progressive") {
    const mins = (config.tiers || [])
      .map((t) => Number(t.minQty))
      .filter((n) => Number.isFinite(n) && n >= 1);
    return mins.length ? Math.min(...mins) : Infinity;
  }
  if (kind === "pairs") return 2;
  return 1; // shipping
}

// Tags a aplicar no pedido a partir das campanhas de desconto elegíveis.
async function collectDiscountTags(admin, order) {
  const campaigns = await loadDiscountCampaigns(admin);
  if (campaigns.length === 0) return [];

  const productGids = [
    ...new Set(
      (order.line_items || [])
        .filter((li) => li.product_id != null)
        .map((li) => `gid://shopify/Product/${li.product_id}`)
    ),
  ];
  const prodColls = await loadProductCollections(admin, productGids);

  const tags = new Set();
  for (const camp of campaigns) {
    const units = eligibleUnits(order, camp.config.collectionIds, prodColls);
    if (units >= thresholdFor(camp.kind, camp.config)) {
      for (const t of camp.tags) tags.add(t);
    }
  }
  return [...tags];
}

// Extrai as linhas de bundle de um pedido e monta as rows p/ o D1 + as tags.
function buildAttribution(order, config) {
  const lineItems = order.line_items || [];
  const rows = [];
  const tags = new Set();

  for (const li of lineItems) {
    const props = li.properties || [];
    const bundleProp = Array.isArray(props)
      ? props.find((p) => p.name === "_brk_bundle")
      : null;
    if (!bundleProp || !bundleProp.value) continue;

    const bundleId = String(bundleProp.value);
    const cfg = config[bundleId] || {};
    const qty = Number(li.quantity || 1);
    const grossCents = toCents(li.price) * qty;
    const discountCents = toCents(li.total_discount);
    const netCents = Math.max(0, grossCents - discountCents);

    rows.push({
      bundleId,
      orderId: String(order.id),
      orderName: order.name || null,
      variantId: li.variant_id != null ? String(li.variant_id) : null,
      quantity: qty,
      grossCents,
      discountCents,
      netCents,
      mode: cfg.mode || null,
      createdAt: order.created_at || new Date().toISOString(),
    });

    for (const t of cfg.orderTags || []) if (t) tags.add(t);
  }

  return { rows, tags: [...tags] };
}

export const action = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { topic, shop, session, admin, payload } =
    await shopify.authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  switch (topic) {
    case "ORDERS_CREATE": {
      try {
        const order = payload;
        const orderGid =
          order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;
        const tagSet = new Set();

        // 1) Bundles: atribuição de vendas (D1) + tags de bundle.
        const bundlesConfig = await loadBundlesConfig(admin);
        const { rows, tags: bundleTags } = buildAttribution(order, bundlesConfig);
        if (rows.length > 0) {
          await recordBundleSales(context.env.BUNDLES_DB, shop, rows);
        }
        for (const t of bundleTags) tagSet.add(t);

        // 2) Campanhas de desconto: tag por elegibilidade de coleção.
        for (const t of await collectDiscountTags(admin, order)) tagSet.add(t);

        if (tagSet.size > 0) {
          await tagsAddToOrder(admin, orderGid, [...tagSet]);
        }
      } catch (e) {
        // Não relança: um erro aqui não deve fazer o Shopify reentregar em loop.
        console.error("[webhooks ORDERS_CREATE]", e?.message, e?.stack);
      }

      // Personalização → Sankhya: ingestão do pedido novo. Grava o job em KV e tenta
      // gravar na hora (best-effort); o cron reprocessa até o NUNOTA existir. Isolado
      // num try próprio para não interferir na lógica de bundles/descontos acima.
      try {
        const { sellers } = await loadSellers(admin);
        const perso = buildPersoFromRestOrder(payload, sellers);
        await ingestPersoOrder(context.env, context.env.SESSIONS, shop, perso);
      } catch (e) {
        console.error("[webhooks ORDERS_CREATE perso]", e?.message, e?.stack);
      }
      break;
    }

    case "APP_UNINSTALLED":
      if (session) {
        // Clean up session data when the app is uninstalled
      }
      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
