// Etapas do webhook orders/create que NÃO são da personalização: atribuição de vendas de
// bundle (D1 + tags do bundle) e tags de campanha de desconto.
//
// Mesmo resultado da versão anterior (webhooks.jsx), com bem menos trabalho por pedido:
//   - config de bundles só é lida se o pedido tiver alguma linha `_brk_bundle`;
//   - campanhas buscadas pelo TÍTULO (antes: `discountNodes(first: 100)` — as campanhas do
//     app ficavam além dos 100 primeiros descontos da loja e nunca eram encontradas);
//   - tag de campanha só quando ATIVADA na tela Descontos (config.enabled === true) E ativa
//     na Shopify (status ACTIVE: dentro do período, não expirada);
//   - sem campanha ativa → nenhuma consulta de coleções;
//   - com campanha ativa → pergunta só "o produto está nesta coleção?" (inCollection) em vez
//     de baixar até 250 coleções por produto.
// A lógica de elegibilidade (unidades por coleção e gatilhos) é a mesma.

export const BUNDLES_NS = "brk_bundles";
export const BUNDLES_KEY = "config";
export const DISCOUNT_NS = "$app:descontos-personalizados";
export const DISCOUNT_KEY = "config";

// Título do desconto → tipo de campanha (títulos fixos criados por app.descontos.jsx).
export const CAMPAIGN_KIND_BY_TITLE = {
  "Descontos Personalizados": "pairs",
  "Desconto Progressivo por Coleção": "progressive",
  "Frete Grátis por Coleção": "shipping",
};

function toCents(v) {
  return Math.round(Number(v || 0) * 100);
}

// ── Bundles ──

function bundleIdOf(li) {
  const props = li.properties || [];
  const p = Array.isArray(props) ? props.find((x) => x.name === "_brk_bundle") : null;
  return p && p.value ? String(p.value) : null;
}

export function orderHasBundleLines(order) {
  return (order?.line_items || []).some((li) => bundleIdOf(li) != null);
}

// Config de bundles (shop metafield) → map id → bundle (usamos mode + orderTags).
export async function loadBundlesConfig(admin) {
  try {
    const res = await admin.graphql(`query { shop { metafield(namespace: "${BUNDLES_NS}", key: "${BUNDLES_KEY}") { value } } }`);
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

// Linhas de bundle do pedido → rows p/ o D1 + tags do bundle (inalterado).
export function buildAttribution(order, config) {
  const rows = [];
  const tags = new Set();
  for (const li of order.line_items || []) {
    const bundleId = bundleIdOf(li);
    if (!bundleId) continue;
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

// Atribuição completa: só lê a config se houver linha de bundle.
export async function bundleAttribution(admin, order) {
  if (!orderHasBundleLines(order)) return { rows: [], tags: [] };
  const config = await loadBundlesConfig(admin);
  return buildAttribution(order, config);
}

// ── Campanhas de desconto ──

const CAMPAIGN_QUERY = Object.keys(CAMPAIGN_KIND_BY_TITLE)
  .map((t) => `title:'${t}'`)
  .join(" OR ");

// Campanhas ATIVAS (na tela e na Shopify) com tags configuradas.
export async function loadActiveCampaigns(admin) {
  try {
    const res = await admin.graphql(
      `query ($q: String!) {
        discountNodes(first: 25, query: $q) {
          nodes {
            discount { ... on DiscountAutomaticApp { title status } }
            metafield(namespace: "${DISCOUNT_NS}", key: "${DISCOUNT_KEY}") { value }
          }
        }
      }`,
      { variables: { q: CAMPAIGN_QUERY } }
    );
    const data = await res.json();
    return campaignsFromNodes(data?.data?.discountNodes?.nodes ?? []);
  } catch (e) {
    console.error("[webhooks] loadActiveCampaigns", e?.message);
    return [];
  }
}

export function campaignsFromNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    const kind = CAMPAIGN_KIND_BY_TITLE[n.discount?.title]; // título EXATO (a busca é ampla)
    if (!kind || !n.metafield?.value) continue;
    if (n.discount?.status !== "ACTIVE") continue; // fora do período / expirada / agendada
    let cfg;
    try {
      cfg = JSON.parse(n.metafield.value);
    } catch {
      continue;
    }
    if (cfg.enabled !== true) continue; // desativada na tela Descontos
    const tags = Array.isArray(cfg.orderTags) ? cfg.orderTags.filter(Boolean) : [];
    if (tags.length === 0) continue;
    out.push({ kind, config: cfg, tags });
  }
  return out;
}

const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

// productGid → Set(collectionGid) só das coleções pedidas (inCollection, resposta mínima).
export async function loadCampaignMembership(admin, productGids, collectionGids) {
  const map = new Map();
  const prods = productGids.filter((g) => PRODUCT_GID.test(g));
  const colls = [...new Set(collectionGids)].filter((g) => COLLECTION_GID.test(g));
  if (!prods.length || !colls.length) return map;
  const fields = colls.map((c, i) => `c${i}: inCollection(id: "${c}")`).join(" ");
  try {
    const res = await admin.graphql(
      `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id ${fields} } } }`,
      { variables: { ids: prods } }
    );
    const data = await res.json();
    for (const node of data?.data?.nodes ?? []) {
      if (!node?.id) continue;
      const set = new Set();
      colls.forEach((c, i) => {
        if (node[`c${i}`] === true) set.add(c);
      });
      map.set(node.id, set);
    }
  } catch (e) {
    console.error("[webhooks] loadCampaignMembership", e?.message);
  }
  return map;
}

// Soma as unidades do pedido cujos produtos pertencem a alguma das coleções (inalterado).
export function eligibleUnits(order, collectionIds, prodColls) {
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

// Gatilho mínimo de unidades elegíveis por tipo de campanha (inalterado).
export function thresholdFor(kind, config) {
  if (kind === "progressive") {
    const mins = (config.tiers || []).map((t) => Number(t.minQty)).filter((n) => Number.isFinite(n) && n >= 1);
    return mins.length ? Math.min(...mins) : Infinity;
  }
  if (kind === "pairs") return 2;
  return 1; // shipping
}

export function tagsForCampaigns(order, campaigns, prodColls) {
  const tags = new Set();
  for (const camp of campaigns) {
    const units = eligibleUnits(order, camp.config.collectionIds, prodColls);
    if (units >= thresholdFor(camp.kind, camp.config)) for (const t of camp.tags) tags.add(t);
  }
  return [...tags];
}

// Tags de campanha do pedido (vazio, sem consultar coleções, se nenhuma campanha ativa).
export async function collectDiscountTags(admin, order) {
  const campaigns = await loadActiveCampaigns(admin);
  if (campaigns.length === 0) return [];
  const productGids = [
    ...new Set((order.line_items || []).filter((li) => li.product_id != null).map((li) => `gid://shopify/Product/${li.product_id}`)),
  ];
  const collectionGids = campaigns.flatMap((c) => c.config.collectionIds || []);
  const prodColls = await loadCampaignMembership(admin, productGids, collectionGids);
  return tagsForCampaigns(order, campaigns, prodColls);
}

export async function tagsAddToOrder(admin, orderGid, tags) {
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
