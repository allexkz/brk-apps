import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useFetcher,
  useSearchParams,
} from "@remix-run/react";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Thumbnail,
  Select,
  Badge,
  Box,
  Divider,
  Checkbox,
  EmptyState,
  IndexTable,
  Tag,
  useIndexResourceState,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";
import { statsByBundle, salesReport } from "../bundles-db.server";

const NS = "brk_bundles"; // shop metafield (fonte da verdade: admin/webhook/discount)
const KEY = "config";
const KEY_LIVE = "live"; // shop: bundles ativos, casados ao vivo no tema (derivado do config)
// Legado (índice por produto, substituído por `live`): só lidos pelo fallback do
// bloco e apagados pela limpeza.
const KEY_APPLIES = "applies";
const KEY_DYNAMIC = "dynamic";
const KEY_INDEXED = "indexed";
const DISCOUNT_NS = "brk-bundles"; // metafield da discount (lido pela function)
const DISCOUNT_MAX_BYTES = 9500; // function não recebe metafield > 10.000 bytes
const FN_LIST_MAX = 100; // variables de lista do input query: máx. 100 itens
const DISCOUNT_KEY = "config";
const FN_TITLE = "BRK Bundles Desconto";
const FN_HANDLE = "brk-bundles-discount";
const DISCOUNT_TITLE = "BRK Bundles";

function numericId(gid) {
  return Number(String(gid).split("/").pop());
}

const MODE_OPTIONS = [
  { label: "Brinde (100% off)", value: "gift" },
  { label: "Desconto — porcentagem (%)", value: "percent" },
  { label: "Desconto — valor fixo (R$)", value: "fixed" },
];
const DISPLAY_OPTIONS = [
  { label: "Inline (na página de produto)", value: "inline" },
  { label: "Popup (após adicionar ao carrinho)", value: "popup" },
];
const TARGET_OPTIONS = [
  { label: "Produtos específicos", value: "products" },
  { label: "Collections", value: "collections" },
  { label: "Tags de produto", value: "tags" },
  { label: "Metafield de produto", value: "metafield" },
];
const PAGE_SIZE_OPTIONS = [
  { label: "25 por página", value: "25" },
  { label: "50 por página", value: "50" },
  { label: "70 por página", value: "70" },
  { label: "100 por página", value: "100" },
  { label: "Todos", value: "all" },
];

// Interpola as variáveis de label de um ITEM p/ o texto exibido no checkout.
function labelForItem(item) {
  let lbl = item.label || item.title || "Bundle";
  if (item.mode === "percent") lbl = lbl.replace("{{brk_discount_percentage}}", item.value);
  else if (item.mode === "fixed") lbl = lbl.replace("{{brk_discount_flat}}", item.value);
  return lbl;
}

// ── GraphQL helpers ─────────────────────────────────────────────────────────

async function ensureDefinition(admin) {
  const defs = [
    { name: "BRK Bundles (config)", key: KEY, ownerType: "SHOP" },
    { name: "BRK Bundles (ao vivo)", key: KEY_LIVE, ownerType: "SHOP" },
  ];
  for (const d of defs) {
    await admin
      .graphql(
        `mutation create($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { code message }
          }
        }`,
        {
          variables: {
            definition: {
              name: d.name,
              namespace: NS,
              key: d.key,
              ownerType: d.ownerType,
              type: "json",
              access: { storefront: "PUBLIC_READ" },
            },
          },
        }
      )
      .catch(() => {});
  }
}

// ── Dados ao vivo (lidos pelo tema) ─────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Bundles ativos no formato lido pelo bloco do tema, que casa a segmentação ao
// vivo (product.id / product.collections / product.tags) — nada é gravado por
// produto. Ids viram string (o `contains` do Liquid compara strings) e os *Meta
// (só usados pelo editor) ficam de fora. `priority` vira número (o `sort` do
// Liquid põe nil no topo após o `reverse`). Derivado do config: pode ser recriado.
function buildLive(bundles) {
  return bundles
    .filter((b) => b.enabled)
    .map((b) => {
      const t = b.targets || {};
      return {
        ...b,
        priority: Number(b.priority) || 0,
        targets: {
          type: t.type,
          productIds: (t.productIds || []).map(String),
          collectionIds: (t.collectionIds || []).map(String),
          tags: (t.tags || []).map(String),
          metafield: t.metafield || { namespace: "", key: "", value: "" },
        },
      };
    });
}

async function setShopMetafields(admin, metafields) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { variables: { metafields } }
  );
  const data = await res.json();
  return data.data.metafieldsSet.userErrors;
}

function liveMetafield(shopId, bundles) {
  return { ownerId: shopId, namespace: NS, key: KEY_LIVE, type: "json", value: JSON.stringify(buildLive(bundles)) };
}

// ── Limpeza do índice legado (brk_bundles.applies por produto) ──────────────
// Uma página de 250 produtos por chamada (≤ 11 subrequests); o cliente chama em
// loop com o cursor. Só apaga metafields derivados — nunca o config.

async function deleteMetafields(admin, identifiers) {
  const errors = [];
  for (const group of chunk(identifiers, 25)) {
    const res = await admin.graphql(
      `mutation del($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { deletedMetafields { key ownerId } userErrors { field message } }
      }`,
      { variables: { metafields: group } }
    );
    const data = await res.json();
    errors.push(...(data.data?.metafieldsDelete?.userErrors || []).map((e) => e.message));
  }
  return errors;
}

async function cleanupLegacyPage(admin, cursor, dryRun) {
  const res = await admin.graphql(
    `query($after: String) {
      products(first: 250, after: $after) {
        nodes { id applies: metafield(namespace: "${NS}", key: "${KEY_APPLIES}") { id } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { variables: { after: cursor || null } }
  );
  const conn = (await res.json()).data.products;
  const owners = conn.nodes.filter((n) => n.applies).map((n) => n.id);
  const errors = dryRun || !owners.length
    ? []
    : await deleteMetafields(admin, owners.map((ownerId) => ({ ownerId, namespace: NS, key: KEY_APPLIES })));
  return {
    scanned: conn.nodes.length,
    found: owners.length,
    errors,
    hasNextPage: conn.pageInfo.hasNextPage,
    endCursor: conn.pageInfo.endCursor,
  };
}

async function loadConfig(admin) {
  const res = await admin.graphql(
    `query {
      shop {
        id
        metafield(namespace: "${NS}", key: "${KEY}") { value }
        live: metafield(namespace: "${NS}", key: "${KEY_LIVE}") { id }
      }
    }`
  );
  const data = await res.json();
  const shopId = data.data.shop.id;
  const raw = data.data.shop.metafield?.value;
  let bundles = [];
  try {
    bundles = raw ? JSON.parse(raw) : [];
  } catch {
    bundles = [];
  }
  return { shopId, bundles, hasLive: Boolean(data.data.shop.live) };
}

// Config (fonte da verdade) + `live` (derivado) na mesma mutation.
async function saveConfig(admin, shopId, bundles) {
  return setShopMetafields(admin, [
    { ownerId: shopId, namespace: NS, key: KEY, type: "json", value: JSON.stringify(bundles) },
    liveMetafield(shopId, bundles),
  ]);
}

async function findBundlesFunction(admin) {
  const res = await admin.graphql(`
    query { shopifyFunctions(first: 100) { edges { node { id title apiType } } } }
  `);
  const data = await res.json();
  return data.data.shopifyFunctions.edges.find(
    (e) =>
      e.node.apiType === "discount" &&
      (e.node.title === FN_TITLE || e.node.title === FN_HANDLE)
  )?.node;
}

async function findBundlesDiscount(admin) {
  const res = await admin.graphql(`
    query {
      discountNodes(first: 50, query: "title:${DISCOUNT_TITLE}*") {
        edges { node { id discount { ... on DiscountAutomaticApp { title status } } } }
      }
    }
  `);
  const data = await res.json();
  return data.data.discountNodes.edges.find(
    (e) => e.node.discount?.title === DISCOUNT_TITLE
  )?.node;
}

// Metafield da discount, no formato compacto v2 (chaves curtas + tabela de
// labels — a function não recebe metafield > 10.000 bytes; ver o formato em
// extensions/brk-bundles-discount/src/cart_lines_discounts_generate_run.js):
// items por bundle + `t` (a function valida o gatilho) + variables do input
// query (`collectionIds`/`tags`, chaves de topo). Listas ≤ 100 e metafield <
// 10.000 bytes: estourou, aquela validação sai (volta à regra antiga) e avisa,
// em vez de quebrar o desconto.
const V2_MODE = { gift: "g", percent: "p", fixed: "f" };

function buildDiscountConfig(bundles) {
  const active = bundles.filter((b) => b.enabled);
  const collGids = new Set();
  const tagSet = new Set();
  for (const b of active) {
    const t = b.targets || {};
    if (t.type === "collections") for (const id of t.collectionIds || []) collGids.add(`gid://shopify/Collection/${id}`);
    if (t.type === "tags") for (const tag of t.tags || []) tagSet.add(String(tag));
  }
  const checkColl = collGids.size <= FN_LIST_MAX;
  const checkTags = tagSet.size <= FN_LIST_MAX;
  const warnings = [];
  if (!checkColl) warnings.push(`Mais de ${FN_LIST_MAX} collections nos bundles ativos: o checkout não vai validar a collection do produto-gatilho.`);
  if (!checkTags) warnings.push(`Mais de ${FN_LIST_MAX} tags nos bundles ativos: o checkout não vai validar a tag do produto-gatilho.`);

  const labels = [];
  const labelIdx = (l) => {
    let i = labels.indexOf(l);
    if (i < 0) i = labels.push(l) - 1;
    return i;
  };
  const map = {};
  for (const b of active) {
    const i = {};
    for (const a of b.addons || []) {
      const it = {
        m: V2_MODE[a.mode] || V2_MODE.gift,
        v: Number(a.value) || 0,
        l: labelIdx(labelForItem(a)),
        q: Number.isFinite(Number(a.maxQty)) ? Number(a.maxQty) : 1,
      };
      if (b.exemption) it.a = 1;
      i[String(a.productId)] = it;
    }
    const entry = { i };
    const t = b.targets || {};
    if (t.type === "products") {
      entry.t = { k: "p", ids: (t.productIds || []).map(Number) };
    } else if (t.type === "collections" && checkColl) {
      entry.t = { k: "c", ids: (t.collectionIds || []).map(Number) };
    } else if (t.type === "tags" && checkTags) {
      entry.t = { k: "g", ids: (t.tags || []).map(String) };
    }
    map[b.id] = entry;
  }

  const full = {
    v: 2,
    L: labels,
    collectionIds: checkColl ? [...collGids] : [],
    tags: checkTags ? [...tagSet] : [],
    b: map,
  };
  const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
  if (bytes(full) <= DISCOUNT_MAX_BYTES) return { value: JSON.stringify(full), warnings };

  // Grande demais: tira a validação de segmentação (só items).
  const slim = { v: 2, L: labels, collectionIds: [], tags: [], b: {} };
  for (const [id, e] of Object.entries(map)) slim.b[id] = { i: e.i };
  if (bytes(slim) <= DISCOUNT_MAX_BYTES) {
    warnings.push("Config de desconto grande demais para validar a segmentação no checkout (limite de 10 KB da Shopify Function). Os descontos seguem funcionando sem essa validação.");
    return { value: JSON.stringify(slim), warnings };
  }
  return { error: "A config de desconto passou de 10 KB (limite da Shopify Function) — a function não conseguiria ler os descontos. Reduza bundles/add-ons ativos." };
}

// Espelha a config no metafield da discount e cria/atualiza a automatic discount.
async function syncDiscount(admin, bundles) {
  const built = buildDiscountConfig(bundles);
  if (built.error) return { error: built.error };
  const discountMetafieldValue = built.value;
  const configWarning = built.warnings.length ? built.warnings.join(" ") : null;

  const fn = await findBundlesFunction(admin);
  if (!fn) {
    return { warning: `Config salva, mas a function "${FN_TITLE}" ainda não foi deployada (rode shopify app dev/deploy).` };
  }

  const existing = await findBundlesDiscount(admin);
  const metafields = [
    { namespace: DISCOUNT_NS, key: DISCOUNT_KEY, type: "json", value: discountMetafieldValue },
  ];

  if (existing) {
    const res = await admin.graphql(
      `mutation upd($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          id: existing.id,
          automaticAppDiscount: {
            title: DISCOUNT_TITLE,
            combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
            metafields,
          },
        },
      }
    );
    const data = await res.json();
    const errs = data.data.discountAutomaticAppUpdate.userErrors;
    if (errs.length) return { error: `Erro ao atualizar desconto: ${errs.map((e) => e.message).join(", ")}` };
  } else {
    const res = await admin.graphql(
      `mutation create($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          automaticAppDiscount: {
            title: DISCOUNT_TITLE,
            functionId: fn.id,
            discountClasses: ["PRODUCT"],
            startsAt: new Date().toISOString(),
            combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
            metafields,
          },
        },
      }
    );
    const data = await res.json();
    const errs = data.data.discountAutomaticAppCreate.userErrors;
    if (errs.length) return { error: `Erro ao criar desconto: ${errs.map((e) => e.message).join(", ")}` };
  }
  return { warning: configWarning };
}

// Resolve o conjunto de produtos (gid -> título) que um bundle realmente atinge.
// Expande collections/tags via API (capado em 250 por collection/tag). metafield
// não é resolvido (marcado como não verificável).
async function resolveBundleProducts(admin, b) {
  const t = b.targets || {};
  const set = new Map();
  let truncated = false;

  if (t.type === "products") {
    const titles = new Map((t.productsMeta || []).map((p) => [String(p.id), p.title]));
    for (const id of t.productIds || []) {
      set.set(`gid://shopify/Product/${id}`, titles.get(String(id)) || String(id));
    }
  } else if (t.type === "collections") {
    for (const cid of t.collectionIds || []) {
      const res = await admin.graphql(
        `query($id: ID!) { collection(id: $id) { products(first: 250) { nodes { id title } pageInfo { hasNextPage } } } }`,
        { variables: { id: `gid://shopify/Collection/${cid}` } }
      );
      const c = (await res.json()).data.collection;
      if (!c) continue;
      for (const n of c.products.nodes) set.set(n.id, n.title);
      if (c.products.pageInfo.hasNextPage) truncated = true;
    }
  } else if (t.type === "tags") {
    for (const tag of t.tags || []) {
      const res = await admin.graphql(
        `query($q: String!) { products(first: 250, query: $q) { nodes { id title } pageInfo { hasNextPage } } }`,
        { variables: { q: `tag:'${String(tag).replace(/'/g, "")}'` } }
      );
      const ps = (await res.json()).data.products;
      for (const n of ps.nodes) set.set(n.id, n.title);
      if (ps.pageInfo.hasNextPage) truncated = true;
    }
  } else {
    return { set, truncated: false, unresolved: true };
  }
  return { set, truncated, unresolved: false };
}

// Converte YYYY-MM-DD nos limites ISO usados no D1.
function rangeToIso(start, end) {
  return {
    start: start ? `${start}T00:00:00Z` : undefined,
    end: end ? `${end}T23:59:59Z` : undefined,
  };
}

// Grava config (fonte da verdade) + `live` + espelha a discount. Poucas
// chamadas fixas, independente do tamanho das collections (sem índice por produto).
async function persist(admin, shopId, bundles) {
  const errs = await saveConfig(admin, shopId, bundles);
  if (errs.length) return { error: errs.map((e) => e.message).join(", ") };
  const sync = await syncDiscount(admin, bundles);
  if (sync.error) return { error: sync.error };
  return { warning: sync.warning || null };
}

// Recria só os dados derivados (`live` + discount) a partir do config atual,
// sem tocar no config.
async function regenerateDerived(admin, shopId, bundles) {
  const errs = await setShopMetafields(admin, [liveMetafield(shopId, bundles)]);
  if (errs.length) return { error: errs.map((e) => e.message).join(", ") };
  const sync = await syncDiscount(admin, bundles);
  if (sync.error) return { error: sync.error };
  return { warning: sync.warning || null };
}

// ── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin, session } = await shopify.authenticate.admin(request);

  await ensureDefinition(admin);
  const { shopId, bundles, hasLive } = await loadConfig(admin);
  // Primeira abertura após a migração: gera `live` + discount a partir do config.
  let liveWarning = null;
  if (!hasLive) {
    const r = await regenerateDerived(admin, shopId, bundles);
    liveWarning = r.error || r.warning || null;
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start") || "";
  const end = url.searchParams.get("end") || "";
  const iso = rangeToIso(start, end);
  const stats = await statsByBundle(context.env.BUNDLES_DB, session.shop, iso);

  const fn = await findBundlesFunction(admin);
  const discount = await findBundlesDiscount(admin);

  return json({
    bundles,
    stats,
    start,
    end,
    hasFn: Boolean(fn),
    hasDiscount: Boolean(discount),
    liveWarning,
  });
};

// O loop da limpeza não precisa recarregar o loader a cada página.
export function shouldRevalidate({ formData, defaultShouldRevalidate }) {
  if (formData?.get("intent") === "cleanupLegacy") return false;
  return defaultShouldRevalidate;
}

// ── Action ────────────────────────────────────────────────────────────────

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin, session } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    // Enriquecer os produtos escolhidos no picker (variantes/preço/imagem).
    if (intent === "fetchAddonProducts") {
      const ids = JSON.parse(formData.get("ids") || "[]");
      if (!ids.length) return json({ action: "fetchAddonProducts", products: [] });
      const res = await admin.graphql(
        `query ($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id title featuredImage { url }
              variants(first: 100) {
                edges { node { id title price availableForSale image { url } } }
              }
            }
          }
        }`,
        { variables: { ids } }
      );
      const data = await res.json();
      const products = (data.data.nodes || [])
        .filter(Boolean)
        .map((p) => ({
          productId: numericId(p.id),
          title: p.title,
          image: p.featuredImage?.url || null,
          variants: (p.variants?.edges || []).map((e) => ({
            variantId: numericId(e.node.id),
            title: e.node.title === "Default Title" ? p.title : e.node.title,
            priceCents: Math.round(Number(e.node.price || 0) * 100),
            available: !!e.node.availableForSale,
            image: e.node.image?.url || p.featuredImage?.url || null,
          })),
        }));
      return json({ action: "fetchAddonProducts", products });
    }

    // Enriquecer os produtos escolhidos na segmentação (nome/imagem p/ chips).
    if (intent === "fetchTargetProducts") {
      const ids = JSON.parse(formData.get("ids") || "[]");
      if (!ids.length) return json({ action: "fetchTargetProducts", products: [] });
      const res = await admin.graphql(
        `query ($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Product { id title featuredImage { url } } }
        }`,
        { variables: { ids } }
      );
      const data = await res.json();
      const products = (data.data.nodes || [])
        .filter(Boolean)
        .map((p) => ({ id: numericId(p.id), title: p.title, image: p.featuredImage?.url || null }));
      return json({ action: "fetchTargetProducts", products });
    }

    // Limpeza do índice legado: 1 página por chamada (o cliente faz o loop).
    // dryRun = só conta. Só apaga brk_bundles.applies (e, na última página,
    // os shop metafields legados `indexed`/`dynamic`) — nunca o config.
    if (intent === "cleanupLegacy") {
      const dryRun = formData.get("dryRun") === "1";
      const page = await cleanupLegacyPage(admin, formData.get("cursor") || null, dryRun);
      if (!dryRun && !page.hasNextPage) {
        const shopRes = await admin.graphql(`query { shop { id } }`);
        const shopGid = (await shopRes.json()).data.shop.id;
        page.errors.push(...(await deleteMetafields(admin, [
          { ownerId: shopGid, namespace: NS, key: KEY_INDEXED },
          { ownerId: shopGid, namespace: NS, key: KEY_DYNAMIC },
        ])));
      }
      return json({ action: "cleanupLegacy", dryRun, ...page });
    }

    const { shopId, bundles } = await loadConfig(admin);

    if (intent === "regenerate") {
      const r = await regenerateDerived(admin, shopId, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "regenerate", warning: r.warning });
    }

    if (intent === "save") {
      const bundle = JSON.parse(formData.get("bundle"));
      const err = validateBundle(bundle);
      if (err) return json({ success: false, error: err });

      if (!bundle.id) bundle.id = `bdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!bundle.createdAt) bundle.createdAt = new Date().toISOString();

      const i = bundles.findIndex((b) => b.id === bundle.id);
      if (i >= 0) bundles[i] = bundle;
      else bundles.push(bundle);

      const r = await persist(admin, shopId, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "save", warning: r.warning });
    }

    if (intent === "toggle") {
      const id = formData.get("id");
      const b = bundles.find((x) => x.id === id);
      if (b) b.enabled = !b.enabled;
      const r = await persist(admin, shopId, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "toggle", warning: r.warning });
    }

    if (intent === "toggleExemption") {
      const id = formData.get("id");
      const b = bundles.find((x) => x.id === id);
      if (b) b.exemption = !b.exemption;
      const r = await persist(admin, shopId, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "toggleExemption", warning: r.warning });
    }

    if (intent === "duplicate") {
      const id = formData.get("id");
      const b = bundles.find((x) => x.id === id);
      if (b) {
        const copy = JSON.parse(JSON.stringify(b));
        copy.id = `bdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        copy.name = `${b.name || "Bundle"} (cópia)`;
        copy.enabled = false;
        copy.createdAt = new Date().toISOString();
        bundles.push(copy);
      }
      const r = await persist(admin, shopId, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "duplicate", warning: r.warning });
    }

    if (intent === "delete" || intent === "deleteMany") {
      const ids = intent === "delete"
        ? [formData.get("id")]
        : JSON.parse(formData.get("ids") || "[]");
      const idSet = new Set(ids);
      const next = bundles.filter((b) => !idSet.has(b.id));
      const r = await persist(admin, shopId, next);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: intent, count: ids.length, warning: r.warning });
    }

    if (intent === "report") {
      const start = formData.get("start") || "";
      const end = formData.get("end") || "";
      const iso = rangeToIso(start, end);
      const rows = await salesReport(context.env.BUNDLES_DB, session.shop, iso);
      return json({ action: "report", rows });
    }

    if (intent === "checkConflicts") {
      const active = bundles.filter((b) => b.enabled);
      const resolved = [];
      for (const b of active) resolved.push({ b, ...(await resolveBundleProducts(admin, b)) });

      const pairs = [];
      for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
          const A = resolved[i], B = resolved[j];
          if (A.unresolved || B.unresolved) continue;
          const overlap = [];
          for (const [gid, title] of A.set) if (B.set.has(gid)) overlap.push(title);
          if (overlap.length) {
            pairs.push({
              a: A.b.name || A.b.id, b: B.b.name || B.b.id,
              aPrio: A.b.priority ?? 0, bPrio: B.b.priority ?? 0,
              aExcl: !!A.b.exclusive, bExcl: !!B.b.exclusive,
              count: overlap.length, products: overlap.slice(0, 20),
              truncated: A.truncated || B.truncated,
            });
          }
        }
      }
      const unresolved = resolved.filter((r) => r.unresolved).map((r) => r.b.name || r.b.id);
      return json({ action: "checkConflicts", pairs, unresolved });
    }

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[app.bundles action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

function validateBundle(b) {
  if (!b.name || !b.name.trim()) return "Dê um nome ao bundle.";
  if (!b.addons || b.addons.length === 0) return "Selecione ao menos 1 add-on.";
  const t = b.targets || {};
  if (t.type === "products" && (!t.productIds || !t.productIds.length)) return "Selecione ao menos 1 produto na segmentação.";
  if (t.type === "collections" && (!t.collectionIds || !t.collectionIds.length)) return "Selecione ao menos 1 collection.";
  if (t.type === "tags" && (!t.tags || !t.tags.length)) return "Informe ao menos 1 tag.";
  if (t.type === "metafield" && (!t.metafield?.namespace || !t.metafield?.key)) return "Informe namespace e key do metafield.";
  for (const a of b.addons) {
    if ((a.mode === "percent" || a.mode === "fixed") && !(Number(a.value) > 0)) {
      return `Defina um valor de desconto (> 0) para o add-on "${a.title}".`;
    }
  }
  return null;
}

// ── CSV export ────────────────────────────────────────────────────────────

function exportBundlesCSV(list, stats, filename) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["id", "nome", "ativo", "exibicao", "prioridade", "exclusivo", "isencao", "itens", "descontos", "segmentacao", "criado_em", "pedidos", "quantidade", "receita_reais"];
  const lines = [header.join(",")];
  for (const b of list) {
    const s = stats[b.id] || {};
    const descontos = (b.addons || [])
      .map((a) => `${a.title}:${a.mode}${a.mode === "gift" ? "" : "(" + a.value + ")"}`)
      .join(" | ");
    lines.push(
      [
        b.id,
        b.name,
        b.enabled ? "sim" : "nao",
        b.display,
        b.priority ?? 0,
        b.exclusive ? "sim" : "nao",
        b.exemption ? "sim" : "nao",
        (b.addons || []).length,
        descontos,
        b.targets?.type,
        b.createdAt,
        s.orders || 0,
        s.quantity || 0,
        ((s.netCents || 0) / 100).toFixed(2),
      ].map(esc).join(",")
    );
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Component ───────────────────────────────────────────────────────────────

function formatBRL(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((cents || 0) / 100);
}
function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function blankBundle() {
  return {
    id: `bdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    enabled: true,
    createdAt: "",
    display: "inline",
    priority: 0,
    exclusive: false,
    exemption: false, // isenção fiscal: desconto do add-on vai p/ o produto vinculado
    chooseMax: 0, // 0 = sem limite de quantos add-ons o cliente pode marcar
    hidePrice: false, // esconde preço e preço riscado dos add-ons na página de produto
    title: "Leve também",
    subtitle: "",
    orderTags: [],
    targets: {
      type: "products",
      productIds: [],
      productsMeta: [],
      collectionIds: [],
      collectionsMeta: [],
      tags: [],
      metafield: { namespace: "", key: "", value: "" },
    },
    // cada add-on tem seu próprio desconto
    addons: [],
  };
}

// defaults de desconto de um add-on recém-selecionado
function withItemDefaults(a) {
  return {
    productId: a.productId,
    title: a.title,
    image: a.image,
    variants: a.variants || [],
    mode: "gift",
    value: 0,
    label: "BRINDE",
    maxQty: 1,
    preselected: true,
  };
}

const MODE_LABEL = { gift: "Brinde", percent: "% off", fixed: "R$ off" };
const TARGET_LABEL = { products: "Produtos", collections: "Collections", tags: "Tags", metafield: "Metafield" };

function typeSummary(b) {
  const modes = [...new Set((b.addons || []).map((a) => a.mode || "gift"))];
  const label = modes.map((m) => MODE_LABEL[m] || m).join(", ");
  return `${(b.addons || []).length} item(s)${label ? ` · ${label}` : ""}`;
}

// Detecta bundles ATIVOS que se sobrepõem (mesmo tipo de segmentação com ids/tags
// em comum). Não cobre cruzamentos produto-em-collection (exigiria consultar a API).
function detectConflicts(bundles) {
  const active = bundles.filter((b) => b.enabled);
  const out = [];
  const keyId = { products: "productIds", collections: "collectionIds", tags: "tags" };
  const metaOf = { products: "productsMeta", collections: "collectionsMeta" };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const t = a.targets?.type;
      if (!t || t !== b.targets?.type || t === "metafield") continue;
      const ka = a.targets?.[keyId[t]] || [];
      const kb = new Set((b.targets?.[keyId[t]] || []).map(String));
      const overlap = ka.map(String).filter((x) => kb.has(x));
      if (overlap.length === 0) continue;
      let labels = overlap;
      if (metaOf[t]) {
        const meta = new Map([...(a.targets[metaOf[t]] || []), ...(b.targets[metaOf[t]] || [])].map((m) => [String(m.id), m.title]));
        labels = overlap.map((id) => meta.get(String(id)) || id);
      }
      out.push({ a, b, type: t, labels });
    }
  }
  return out;
}

export default function Bundles() {
  const { bundles, stats, start, end, hasFn, hasDiscount, liveWarning } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const addonFetcher = useFetcher();
  const targetFetcher = useFetcher();
  const saveFetcher = useFetcher();
  const conflictFetcher = useFetcher();
  const cleanupFetcher = useFetcher();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Limpeza do índice legado (loop página a página pelo cliente) ──
  // Sempre começa em simulação (só conta); apagar exige um 2º clique.
  const [cleanup, setCleanup] = useState(null); // { dryRun, scanned, found, errors, running }
  const runCleanup = useCallback((dryRun) => {
    setCleanup({ dryRun, scanned: 0, found: 0, errors: [], running: true });
    cleanupFetcher.submit({ intent: "cleanupLegacy", dryRun: dryRun ? "1" : "0", cursor: "" }, { method: "post" });
  }, [cleanupFetcher]);
  const lastCleanup = useRef(null);
  useEffect(() => {
    const d = cleanupFetcher.data;
    if (!d || d === lastCleanup.current) return;
    lastCleanup.current = d;
    if (d.action !== "cleanupLegacy") {
      setCleanup((cur) => cur && { ...cur, running: false, errors: [...cur.errors, d.error || "Erro desconhecido."] });
      return;
    }
    setCleanup((cur) => cur && {
      ...cur,
      scanned: cur.scanned + d.scanned,
      found: cur.found + d.found,
      errors: [...cur.errors, ...d.errors],
      running: d.hasNextPage,
    });
    if (d.hasNextPage) {
      cleanupFetcher.submit({ intent: "cleanupLegacy", dryRun: d.dryRun ? "1" : "0", cursor: d.endCursor }, { method: "post" });
    }
  }, [cleanupFetcher.data, cleanupFetcher]);

  const isSubmitting = navigation.state === "submitting";
  const isSaving = saveFetcher.state !== "idle";
  const [editing, setEditing] = useState(null);
  const [savedOk, setSavedOk] = useState(false);

  const startNew = useCallback(() => { setSavedOk(false); setEditing(blankBundle()); }, []);
  const startEdit = useCallback((b) => { setSavedOk(false); setEditing(JSON.parse(JSON.stringify(b))); }, []);
  const cancel = useCallback(() => { setSavedOk(false); setEditing(null); }, []);
  const setField = useCallback((field, val) => setEditing((cur) => ({ ...cur, [field]: val })), []);
  const setTarget = useCallback((field, val) =>
    setEditing((cur) => ({ ...cur, targets: { ...cur.targets, [field]: val } })), []);

  // ── Pickers ──
  const pickProducts = useCallback(async () => {
    const selectionIds = (editing?.targets?.productsMeta || []).map((p) => ({ id: `gid://shopify/Product/${p.id}` }));
    const picked = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds });
    if (!picked) return;
    const fd = new FormData();
    fd.set("intent", "fetchTargetProducts");
    fd.set("ids", JSON.stringify(picked.map((p) => p.id)));
    targetFetcher.submit(fd, { method: "post" });
  }, [shopify, targetFetcher, editing]);

  const pickCollections = useCallback(async () => {
    const selectionIds = (editing?.targets?.collectionsMeta || []).map((c) => ({ id: `gid://shopify/Collection/${c.id}` }));
    const picked = await shopify.resourcePicker({ type: "collection", multiple: true, selectionIds });
    if (!picked) return;
    setEditing((cur) => ({
      ...cur,
      targets: {
        ...cur.targets,
        collectionIds: picked.map((c) => numericId(c.id)),
        collectionsMeta: picked.map((c) => ({ id: numericId(c.id), title: c.title, image: c.image?.originalSrc || c.image?.src || null })),
      },
    }));
  }, [shopify, editing]);

  const pickAddons = useCallback(async () => {
    const selectionIds = (editing?.addons || []).map((a) => ({ id: `gid://shopify/Product/${a.productId}` }));
    const picked = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds });
    if (!picked || !picked.length) {
      if (picked && picked.length === 0) setEditing((cur) => ({ ...cur, addons: [] }));
      return;
    }
    const fd = new FormData();
    fd.set("intent", "fetchAddonProducts");
    fd.set("ids", JSON.stringify(picked.map((p) => p.id)));
    addonFetcher.submit(fd, { method: "post" });
  }, [shopify, addonFetcher, editing]);

  // aplica os produtos enriquecidos quando os fetchers voltam (preservando o
  // desconto já configurado dos itens que continuam selecionados)
  const lastAddon = useRef(null);
  if (addonFetcher.data?.action === "fetchAddonProducts" && addonFetcher.data !== lastAddon.current && editing) {
    lastAddon.current = addonFetcher.data;
    setEditing((cur) => {
      if (!cur) return cur;
      const prev = new Map((cur.addons || []).map((a) => [String(a.productId), a]));
      const addons = addonFetcher.data.products.map((p) => {
        const p0 = prev.get(String(p.productId));
        const base = withItemDefaults(p);
        return p0 ? { ...base, mode: p0.mode, value: p0.value, label: p0.label, maxQty: p0.maxQty, preselected: p0.preselected } : base;
      });
      return { ...cur, addons };
    });
  }
  const lastTarget = useRef(null);
  if (targetFetcher.data?.action === "fetchTargetProducts" && targetFetcher.data !== lastTarget.current && editing) {
    lastTarget.current = targetFetcher.data;
    setEditing((cur) =>
      cur
        ? { ...cur, targets: { ...cur.targets, productIds: targetFetcher.data.products.map((p) => p.id), productsMeta: targetFetcher.data.products } }
        : cur
    );
  }

  // reflete o sucesso do save (mantém o editor aberto)
  const lastSave = useRef(null);
  if (saveFetcher.data && saveFetcher.data !== lastSave.current) {
    lastSave.current = saveFetcher.data;
    setSavedOk(!!saveFetcher.data.success);
  }

  const removeAddon = useCallback((productId) => {
    setEditing((cur) => ({ ...cur, addons: cur.addons.filter((a) => a.productId !== productId) }));
  }, []);

  const updateAddon = useCallback((productId, field, val) => {
    setEditing((cur) => ({
      ...cur,
      addons: cur.addons.map((a) => (a.productId === productId ? { ...a, [field]: val } : a)),
    }));
  }, []);

  const removeTargetProduct = useCallback((id) => {
    setEditing((cur) => ({
      ...cur,
      targets: {
        ...cur.targets,
        productIds: cur.targets.productIds.filter((x) => x !== id),
        productsMeta: (cur.targets.productsMeta || []).filter((p) => p.id !== id),
      },
    }));
  }, []);

  const handleSave = useCallback(() => {
    if (!editing) return;
    setSavedOk(false);
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("bundle", JSON.stringify(editing));
    saveFetcher.submit(fd, { method: "post" });
  }, [editing, saveFetcher]);

  const runIntent = useCallback((intent, extra = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    submit(fd, { method: "post" });
  }, [submit]);

  // ── Busca + paginação ──
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bundles;
    return bundles.filter(
      (b) =>
        (b.name || "").toLowerCase().includes(q) ||
        (b.title || "").toLowerCase().includes(q) ||
        (b.id || "").toLowerCase().includes(q)
    );
  }, [bundles, query]);

  const conflicts = useMemo(() => detectConflicts(bundles), [bundles]);

  const [pageSize, setPageSize] = useState("25");
  const [page, setPage] = useState(0);
  const pageSizeNum = pageSize === "all" ? Math.max(filtered.length, 1) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSizeNum));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => filtered.slice(safePage * pageSizeNum, safePage * pageSizeNum + pageSizeNum),
    [filtered, safePage, pageSizeNum]
  );

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(pageItems);

  const changeQuery = useCallback((v) => { setQuery(v); setPage(0); clearSelection(); }, [clearSelection]);
  const changePageSize = useCallback((v) => { setPageSize(v); setPage(0); clearSelection(); }, [clearSelection]);

  // ── Date filter ──
  const [dStart, setDStart] = useState(start);
  const [dEnd, setDEnd] = useState(end);
  const applyDates = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    if (dStart) next.set("start", dStart); else next.delete("start");
    if (dEnd) next.set("end", dEnd); else next.delete("end");
    setSearchParams(next);
  }, [dStart, dEnd, searchParams, setSearchParams]);
  const clearDates = useCallback(() => {
    setDStart(""); setDEnd("");
    const next = new URLSearchParams(searchParams);
    next.delete("start"); next.delete("end");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const handleExport = useCallback(() => exportBundlesCSV(bundles, stats, "brk-bundles.csv"), [bundles, stats]);
  const handleExportSelected = useCallback(() => {
    const set = new Set(selectedResources);
    exportBundlesCSV(bundles.filter((b) => set.has(b.id)), stats, "brk-bundles-selecionados.csv");
  }, [selectedResources, bundles, stats]);

  const fetchingAddons = addonFetcher.state !== "idle";
  const fetchingTargets = targetFetcher.state !== "idle";

  // ── Editor ──
  if (editing) {
    const b = editing;
    return (
      <Page
        title={b.createdAt ? "Editar bundle" : "Novo bundle"}
        backAction={{ content: "Bundles", onAction: cancel }}
        primaryAction={{ content: isSaving ? "Salvando…" : "Salvar", onAction: handleSave, loading: isSaving }}
      >
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {savedOk && (
                <Banner tone="success" title="Bundle salvo!" onDismiss={() => setSavedOk(false)}>
                  <p>As alterações já estão valendo. Você pode continuar editando ou voltar para a lista.</p>
                </Banner>
              )}
              {saveFetcher.data?.error && (
                <Banner tone="critical" title="Erro ao salvar"><p>{saveFetcher.data.error}</p></Banner>
              )}
              {saveFetcher.data?.success && saveFetcher.data.warning && (
                <Banner tone="warning" title="Salvo, com aviso"><p>{saveFetcher.data.warning}</p></Banner>
              )}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Geral</Text>
                  <TextField label="Nome (referência interna)" value={b.name} onChange={(v) => setField("name", v)} autoComplete="off" />
                  <Checkbox label="Ativo" checked={b.enabled} onChange={(v) => setField("enabled", v)} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Segmentação (onde aparece)</Text>
                  <Select label="Segmentar por" options={TARGET_OPTIONS} value={b.targets.type} onChange={(v) => setTarget("type", v)} />
                  {b.targets.type === "products" && (
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" tone="subdued" variant="bodySm">{b.targets.productIds.length} produto(s)</Text>
                        <Button onClick={pickProducts} loading={fetchingTargets}>Selecionar produtos</Button>
                      </InlineStack>
                      <BlockStack gap="200">
                        {(b.targets.productsMeta || []).map((p) => (
                          <Box key={p.id} padding="200" borderWidth="025" borderColor="border" borderRadius="200">
                            <InlineStack gap="300" blockAlign="center">
                              {p.image && <Thumbnail source={p.image} alt={p.title} size="small" />}
                              <Box width="100%"><Text as="span" variant="bodyMd">{p.title}</Text></Box>
                              <Button variant="plain" tone="critical" onClick={() => removeTargetProduct(p.id)}>Remover</Button>
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    </BlockStack>
                  )}
                  {b.targets.type === "collections" && (
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" tone="subdued" variant="bodySm">{b.targets.collectionIds.length} collection(s)</Text>
                        <Button onClick={pickCollections}>Selecionar collections</Button>
                      </InlineStack>
                      <InlineStack gap="200" wrap>
                        {(b.targets.collectionsMeta || []).map((c) => (
                          <Tag key={c.id}>{c.title}</Tag>
                        ))}
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        A loja confere as collections do produto na hora. A collection precisa estar publicada na Loja Online para o bundle aparecer.
                      </Text>
                    </BlockStack>
                  )}
                  {b.targets.type === "tags" && (
                    <TextField
                      label="Tags (separadas por vírgula)"
                      value={(b.targets.tags || []).join(", ")}
                      onChange={(v) => setTarget("tags", v.split(",").map((s) => s.trim()).filter(Boolean))}
                      autoComplete="off"
                      placeholder="ex: verao, promo"
                    />
                  )}
                  {b.targets.type === "metafield" && (
                    <InlineStack gap="300" wrap>
                      <Box minWidth="160px"><TextField label="Namespace" value={b.targets.metafield?.namespace || ""} onChange={(v) => setTarget("metafield", { ...b.targets.metafield, namespace: v })} autoComplete="off" /></Box>
                      <Box minWidth="160px"><TextField label="Key" value={b.targets.metafield?.key || ""} onChange={(v) => setTarget("metafield", { ...b.targets.metafield, key: v })} autoComplete="off" /></Box>
                      <Box minWidth="160px"><TextField label="Valor (opcional)" value={b.targets.metafield?.value || ""} onChange={(v) => setTarget("metafield", { ...b.targets.metafield, value: v })} autoComplete="off" placeholder="vazio = só existir" /></Box>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Add-ons oferecidos</Text>
                    <Button onClick={pickAddons} loading={fetchingAddons}>Selecionar produtos</Button>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Cada add-on tem seu próprio desconto. Produtos com +1 variante viram pills na página p/ o cliente escolher.
                  </Text>
                  <Checkbox
                    label="Isenção fiscal — aplicar o desconto no produto vinculado"
                    checked={!!b.exemption}
                    onChange={(v) => setField("exemption", v)}
                    helpText="O add-on sai a preço cheio e o valor do desconto dele é abatido do produto que disparou o bundle. O total do cliente não muda."
                  />
                  {b.addons.length === 0 && <Text as="p" tone="subdued">Nenhum add-on. Clique em "Selecionar produtos".</Text>}
                  <BlockStack gap="300">
                    {b.addons.map((a) => {
                      const showV = a.mode === "percent" || a.mode === "fixed";
                      return (
                        <Box key={a.productId} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                          <BlockStack gap="300">
                            <InlineStack gap="300" blockAlign="center">
                              {a.image && <Thumbnail source={a.image} alt={a.title} size="small" />}
                              <Box width="100%">
                                <BlockStack gap="050">
                                  <Text as="span" variant="bodyMd" fontWeight="semibold">{a.title}</Text>
                                  <Text as="span" tone="subdued" variant="bodySm">
                                    {a.variants?.length || 0} variante(s){a.variants?.length ? ` · a partir de ${formatBRL(Math.min(...a.variants.map((v) => v.priceCents)))}` : ""}
                                  </Text>
                                </BlockStack>
                              </Box>
                              <Button variant="plain" tone="critical" onClick={() => removeAddon(a.productId)}>Remover</Button>
                            </InlineStack>
                            <InlineStack gap="300" wrap blockAlign="end">
                              <Box minWidth="170px">
                                <Select label="Desconto" options={MODE_OPTIONS} value={a.mode} onChange={(v) => updateAddon(a.productId, "mode", v)} />
                              </Box>
                              {showV && (
                                <Box minWidth="110px">
                                  <TextField label={a.mode === "percent" ? "Porcentagem (%)" : "Valor fixo (R$)"} type="number" value={String(a.value ?? "")} onChange={(v) => updateAddon(a.productId, "value", v)} autoComplete="off" />
                                </Box>
                              )}
                              <Box minWidth="150px">
                                <TextField label="Máx. c/ desconto" type="number" min={0} value={String(a.maxQty ?? 1)} onChange={(v) => updateAddon(a.productId, "maxQty", v === "" ? "" : Number(v))} autoComplete="off" helpText="0 = ilimitado" />
                              </Box>
                            </InlineStack>
                            <TextField
                              label="Label (badge)"
                              value={a.label || ""}
                              onChange={(v) => updateAddon(a.productId, "label", v)}
                              autoComplete="off"
                              helpText="Variáveis: {{brk_discount_percentage}} / {{brk_discount_flat}}"
                            />
                            <Checkbox label="Já vem marcado" checked={!!a.preselected} onChange={(v) => updateAddon(a.productId, "preselected", v)} />
                          </BlockStack>
                        </Box>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Textos</Text>
                  <TextField label="Título" value={b.title} onChange={(v) => setField("title", v)} autoComplete="off" />
                  <TextField label="Subtítulo (opcional)" value={b.subtitle} onChange={(v) => setField("subtitle", v)} autoComplete="off" />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Exibição</Text>
                  <Select label="Como aparece" options={DISPLAY_OPTIONS} value={b.display} onChange={(v) => setField("display", v)} />
                  <TextField
                    label="Máx. de add-ons que o cliente pode escolher"
                    type="number"
                    min={0}
                    value={String(b.chooseMax ?? 0)}
                    onChange={(v) => setField("chooseMax", v === "" ? "" : Number(v))}
                    autoComplete="off"
                    helpText="Limita quantos itens o cliente marca. 0 = sem limite. Se o produto cair em mais de um bundle com limite, o limite vale para todos juntos (o menor deles). Ex.: 1 = o cliente escolhe só um brinde no total."
                  />
                  <Checkbox
                    label="Esconder preços dos add-ons"
                    helpText="Oculta o preço e o preço riscado (compare-at) dos itens deste bundle na página de produto. O desconto continua valendo no carrinho."
                    checked={!!b.hidePrice}
                    onChange={(v) => setField("hidePrice", v)}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Prioridade & conflito</Text>
                  <TextField
                    label="Prioridade"
                    type="number"
                    value={String(b.priority ?? 0)}
                    onChange={(v) => setField("priority", v === "" ? "" : Number(v))}
                    autoComplete="off"
                    helpText="Maior número aparece primeiro quando vários bundles pegam o mesmo produto."
                  />
                  <Checkbox
                    label="Exclusivo (suprime bundles de menor prioridade neste produto)"
                    checked={!!b.exclusive}
                    onChange={(v) => setField("exclusive", v)}
                  />
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Tags de pedido</Text>
                  <TextField
                    label="Tags aplicadas ao pedido quando aceito (vírgula)"
                    labelHidden
                    value={(b.orderTags || []).join(", ")}
                    onChange={(v) => setField("orderTags", v.split(",").map((s) => s.trim()).filter(Boolean))}
                    autoComplete="off"
                    placeholder="ex: brk-upsell"
                  />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ── Lista ──
  return (
    <Page
      fullWidth
      title="BRK Bundles"
      subtitle="Add-ons (upsell / cross-sell / brinde) na página de produto — nativo, sem app externo."
      primaryAction={{ content: "Novo bundle", onAction: startNew }}
      secondaryActions={[
        { content: "Exportar CSV", onAction: handleExport, disabled: bundles.length === 0 },
        {
          content: conflictFetcher.state !== "idle" ? "Verificando…" : "Verificar conflitos por produto",
          loading: conflictFetcher.state !== "idle",
          disabled: bundles.length < 2,
          onAction: () => conflictFetcher.submit({ intent: "checkConflicts" }, { method: "post" }),
        },
        {
          content: "Regenerar dados ao vivo",
          loading: isSubmitting && navigation.formData?.get("intent") === "regenerate",
          onAction: () => runIntent("regenerate"),
        },
        {
          content: "Limpar índice antigo",
          disabled: !!cleanup?.running,
          onAction: () => runCleanup(true),
        },
      ]}
    >
      <BlockStack gap="400">
        {liveWarning && (
          <Banner tone="warning" title="Dados ao vivo gerados com aviso"><p>{liveWarning}</p></Banner>
        )}
        {cleanup && (
          <Banner
            tone={cleanup.errors.length ? "critical" : cleanup.running ? "info" : cleanup.dryRun ? "warning" : "success"}
            title={
              cleanup.running
                ? `${cleanup.dryRun ? "Simulando" : "Limpando"}… ${cleanup.scanned} produto(s) verificados`
                : cleanup.dryRun
                  ? `Simulação: ${cleanup.found} produto(s) com índice antigo (de ${cleanup.scanned} verificados)`
                  : `Limpeza concluída: ${cleanup.found} índice(s) antigo(s) removido(s)`
            }
            onDismiss={cleanup.running ? undefined : () => setCleanup(null)}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodySm">
                Remove só o metafield antigo <code>brk_bundles.applies</code> dos produtos (o índice que deixava bundle &quot;grudado&quot;). A configuração dos bundles não é alterada.
              </Text>
              {cleanup.errors.length > 0 && (
                <Text as="p" variant="bodySm" tone="critical">{cleanup.errors.slice(0, 5).join(" · ")}</Text>
              )}
              {!cleanup.running && cleanup.dryRun && cleanup.found > 0 && (
                <InlineStack>
                  <Button tone="critical" onClick={() => runCleanup(false)}>{`Apagar ${cleanup.found} índice(s) antigo(s)`}</Button>
                </InlineStack>
              )}
            </BlockStack>
          </Banner>
        )}
        {!hasFn && (
          <Banner tone="warning" title="Function ainda não deployada">
            <p>A discount function "{FN_TITLE}" não foi encontrada. Rode <code>shopify app dev</code> (ou deploy) para os descontos funcionarem.</p>
          </Banner>
        )}
        {actionData?.success && actionData.warning && (
          <Banner tone="warning"><p>{actionData.warning}</p></Banner>
        )}
        {actionData?.success && !actionData.warning && (
          <Banner tone="success" title="Feito!" />
        )}
        {actionData?.error && <Banner tone="critical" title="Erro"><p>{actionData.error}</p></Banner>}

        {conflicts.length > 0 && (
          <Banner tone="warning" title={`${conflicts.length} conflito(s) de bundles detectado(s)`}>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                Bundles ativos pegando os mesmos itens. Na loja aparecem por ordem de <strong>prioridade</strong> (maior primeiro); um bundle <strong>exclusivo</strong> suprime os de menor prioridade.
              </Text>
              {conflicts.slice(0, 12).map((c, i) => (
                <Text key={i} as="p" variant="bodySm">
                  • <strong>{c.a.name || c.a.id}</strong> (prio {c.a.priority ?? 0}{c.a.exclusive ? ", excl." : ""}) ✕ <strong>{c.b.name || c.b.id}</strong> (prio {c.b.priority ?? 0}{c.b.exclusive ? ", excl." : ""}) — {TARGET_LABEL[c.type]}: {c.labels.slice(0, 6).join(", ")}{c.labels.length > 6 ? "…" : ""}
                </Text>
              ))}
              <Text as="p" variant="bodySm" tone="subdued">
                Obs.: só detecta sobreposição do mesmo tipo de segmentação (produtos×produtos, etc.). Cruzamentos produto↔collection não são detectados aqui.
              </Text>
            </BlockStack>
          </Banner>
        )}

        {conflictFetcher.data?.action === "checkConflicts" && (
          conflictFetcher.data.pairs.length === 0 ? (
            <Banner tone="success" title="Nenhum conflito de produto encontrado">
              <Text as="p" variant="bodySm">
                Os bundles ativos não compartilham produtos.
                {conflictFetcher.data.unresolved.length > 0 && ` (Não verificados por serem segmentados por metafield: ${conflictFetcher.data.unresolved.join(", ")}.)`}
              </Text>
            </Banner>
          ) : (
            <Banner tone="warning" title={`${conflictFetcher.data.pairs.length} conflito(s) de produto`}>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">
                  Produtos que caem em mais de um bundle ativo. Na loja aplica a <strong>prioridade</strong> (maior primeiro); um <strong>exclusivo</strong> suprime os menores.
                </Text>
                {conflictFetcher.data.pairs.map((p, i) => (
                  <Text key={i} as="p" variant="bodySm">
                    • <strong>{p.a}</strong> (prio {p.aPrio}{p.aExcl ? ", excl." : ""}) ✕ <strong>{p.b}</strong> (prio {p.bPrio}{p.bExcl ? ", excl." : ""}) — {p.count} produto(s): {p.products.join(", ")}{p.count > p.products.length ? "…" : ""}{p.truncated ? " (amostra parcial)" : ""}
                  </Text>
                ))}
                {conflictFetcher.data.unresolved.length > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Não verificados (segmentação por metafield): {conflictFetcher.data.unresolved.join(", ")}.
                  </Text>
                )}
              </BlockStack>
            </Banner>
          )
        )}

        {bundles.length === 0 ? (
          <Card>
            <EmptyState
              heading="Nenhum bundle ainda"
              action={{ content: "Novo bundle", onAction: startNew }}
              image="https://cdn.shopify.com/shopifycloud/web/assets/v1/vite/client/en/assets/personalized-empty-state-Bu4xlcHV0rQu.svg"
            >
              <p>Crie um add-on para exibir upsell/cross-sell/brinde nas páginas de produto.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <BlockStack gap="300">
                <TextField
                  label="Buscar" labelHidden value={query} onChange={changeQuery} autoComplete="off"
                  placeholder="Buscar por nome, título ou id…" clearButton onClearButtonClick={() => changeQuery("")}
                />
                <InlineStack align="space-between" blockAlign="end" gap="300">
                  <InlineStack gap="200" blockAlign="end">
                    <Box minWidth="150px"><TextField label="De" type="date" value={dStart} onChange={setDStart} autoComplete="off" /></Box>
                    <Box minWidth="150px"><TextField label="Até" type="date" value={dEnd} onChange={setDEnd} autoComplete="off" /></Box>
                    <Button onClick={applyDates}>Aplicar</Button>
                    {(start || end) && <Button variant="plain" onClick={clearDates}>Limpar</Button>}
                  </InlineStack>
                  <Box minWidth="190px">
                    <Select label="Por página" labelInline options={PAGE_SIZE_OPTIONS} value={pageSize} onChange={changePageSize} />
                  </Box>
                </InlineStack>
                {(start || end) && (
                  <Text as="span" tone="subdued" variant="bodySm">
                    Métricas no período {start || "início"} → {end || "hoje"}.
                  </Text>
                )}
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "bundle", plural: "bundles" }}
              itemCount={pageItems.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              bulkActions={[
                { content: "Exportar selecionados", onAction: handleExportSelected },
                { content: "Excluir selecionados", destructive: true, onAction: () => runIntent("deleteMany", { ids: JSON.stringify(selectedResources) }) },
              ]}
              headings={[
                { title: "Bundle" }, { title: "Segmentação" }, { title: "Tipo" }, { title: "Tag do pedido" },
                { title: "Criado em" }, { title: "Pedidos" }, { title: "Receita" }, { title: "Ações" },
              ]}
              pagination={pageCount > 1 ? {
                hasPrevious: safePage > 0,
                hasNext: safePage < pageCount - 1,
                onPrevious: () => { setPage((p) => Math.max(0, p - 1)); clearSelection(); },
                onNext: () => { setPage((p) => p + 1); clearSelection(); },
                label: `Página ${safePage + 1} de ${pageCount}`,
              } : undefined}
            >
              {pageItems.map((b, index) => {
                const s = stats[b.id] || {};
                return (
                  <IndexTable.Row id={b.id} key={b.id} position={index} selected={selectedResources.includes(b.id)} onClick={() => startEdit(b)}>
                    <IndexTable.Cell>
                      <InlineStack gap="200" blockAlign="center">
                        {b.addons?.[0]?.image && <Thumbnail source={b.addons[0].image} alt={b.name} size="small" />}
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="bold">{b.name || b.id}</Text>
                          <InlineStack gap="150" blockAlign="center">
                            <Badge tone={b.enabled ? "success" : undefined}>{b.enabled ? "Ativo" : "Desativado"}</Badge>
                            {b.exemption && <Badge tone="info">Isenção</Badge>}
                            <Text as="span" tone="subdued" variant="bodySm">Prioridade {b.priority ?? 0}{b.exclusive ? " · exclusivo" : ""}</Text>
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell><Tag>{TARGET_LABEL[b.targets?.type] || b.targets?.type}</Tag></IndexTable.Cell>
                    <IndexTable.Cell>{typeSummary(b)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {(b.orderTags || []).length ? (
                        <InlineStack gap="100" wrap>
                          {b.orderTags.map((t) => <Tag key={t}>{t}</Tag>)}
                        </InlineStack>
                      ) : (
                        <Text as="span" tone="subdued" variant="bodySm">—</Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{formatDate(b.createdAt)}</IndexTable.Cell>
                    <IndexTable.Cell>{s.orders || 0}</IndexTable.Cell>
                    <IndexTable.Cell>{formatBRL(s.netCents)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <div onClick={(e) => e.stopPropagation()}>
                        <InlineStack gap="100">
                          <Button size="micro" onClick={() => runIntent("duplicate", { id: b.id })}>Duplicar</Button>
                          <Button size="micro" onClick={() => startEdit(b)}>Editar</Button>
                          <Button size="micro" onClick={() => runIntent("toggle", { id: b.id })}>{b.enabled ? "Desativar" : "Ativar"}</Button>
                          <Button size="micro" onClick={() => runIntent("toggleExemption", { id: b.id })}>{b.exemption ? "Desativar isenção" : "Ativar isenção"}</Button>
                          <Button size="micro" tone="critical" onClick={() => runIntent("delete", { id: b.id })}>Excluir</Button>
                        </InlineStack>
                      </div>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
