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
  Modal,
  useIndexResourceState,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";
import { statsByBundle, salesReport } from "../bundles-db.server";
import {
  loadBundles,
  loadShopState,
  listMetaobjectBundles,
  upsertMetaobjectBundles,
  writeMetaobjectBundles,
  setMode,
  compareBundles,
  bytes,
  LEGACY_MAX_BYTES,
  isProductBundle,
  assignFnKeys,
  planProductFnWrites,
  writeProductFn,
  readProductFn,
  scanProductFnPage,
  setEngine,
  bundleHandle,
  orderKey,
  metaobjectFullType,
  KEY_LIVE_INDEX,
} from "../bundles-store.server";

const NS = "brk_bundles"; // shop metafield (fonte da verdade: admin/webhook/discount)
const KEY = "config";
const KEY_LIVE = "live"; // shop: bundles ativos, casados ao vivo no tema (derivado do config)
const KEY_BACKUP = "config_backup"; // shop: cópia dos bundles alterados por operação em massa (rollback manual)
const MIGRATE_PAGE = 40; // bundles por chamada na cópia p/ metaobjects (loop no cliente)
const SHOPIFY_JSON_MAX = 131072; // limite de gravação de JSON (Admin API 2026-04+)
const PRODUCT_FN_INLINE_MAX = 400; // produtos a regravar num save; acima disso, "Sincronizar produtos" (loop)
const PRODUCT_FN_PAGE = 200; // produtos por chamada na sincronização
const PRODUCT_BUNDLE_WARN = 100; // bundle "por produto" com mais produtos que isso: sugerir collection/tag
// Opções que a ação em massa "Editar opções" pode mudar (whitelist do servidor).
const BULK_OPTION_KEYS = ["exemption", "hidePrice", "showAddonDiscount"];
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
    { name: "BRK Bundles (índice da vitrine)", key: KEY_LIVE_INDEX, ownerType: "SHOP" },
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
  return bundles.filter((b) => b.enabled).map(liveItem);
}

// Um bundle no formato que o tema lê (item do `live` e campo `storefront` do registro).
function liveItem(b) {
  const t = b.targets || {};
  const x = excludeOf(t);
  return {
    ...b,
    priority: Number(b.priority) || 0,
    targets: {
      type: t.type,
      productIds: (t.productIds || []).map(String),
      collectionIds: (t.collectionIds || []).map(String),
      tags: (t.tags || []).map(String),
      metafield: t.metafield || { namespace: "", key: "", value: "" },
      ...(hasExclude(x) ? { exclude: x } : {}),
    },
  };
}

// Vitrine v2: índice só com os bundles AMPLOS ativos (os por produto o tema acha no
// `fn` do produto). `h` = handle do registro, `o` = ordem, `t` = segmentação (p/ o
// tema já descartar os que não casam antes de buscar o registro).
function buildLiveIndex(bundles, mo, on) {
  return {
    on: !!on,
    mo,
    b: bundles
      .filter((b) => b.enabled && !isProductBundle(b))
      .map((b) => ({ h: bundleHandle(b.id), o: orderKey(b), t: liveItem(b).targets })),
  };
}

// Exclusões da segmentação (opcional; bundles antigos não têm): o produto que
// casa com alguma delas nunca recebe o bundle, mesmo casando a segmentação.
// Valem no tema (bundle-addon.liquid) e na function (`x` no metafield da discount).
function excludeOf(t) {
  const x = (t && t.exclude) || {};
  return {
    productIds: (x.productIds || []).map(String),
    collectionIds: (x.collectionIds || []).map(String),
    tags: (x.tags || []).map(String).filter(Boolean),
  };
}

function hasExclude(x) {
  return x.productIds.length > 0 || x.collectionIds.length > 0 || x.tags.length > 0;
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

// Config (fonte da verdade) + `live` (derivado) na mesma mutation.
async function saveConfig(admin, shopId, bundles) {
  return setShopMetafields(admin, [
    { ownerId: shopId, namespace: NS, key: KEY, type: "json", value: JSON.stringify(bundles) },
    liveMetafield(shopId, bundles),
  ]);
}

// Guarda os bundles que a operação em massa vai alterar (como estavam antes) em
// `config_backup`. Uma posição só: a próxima operação sobrescreve. Só os afetados
// (não o config inteiro), p/ caber no limite de 128 KB. Não é lido pelo tema nem
// pela function. Retorna { errors, skipped }.
async function backupBundles(admin, shopId, affected, reason) {
  const value = JSON.stringify({ savedAt: new Date().toISOString(), reason, partial: true, bundles: affected });
  if (bytes(value) > LEGACY_MAX_BYTES) return { errors: [], skipped: true };
  const errs = await setShopMetafields(admin, [{ ownerId: shopId, namespace: NS, key: KEY_BACKUP, type: "json", value }]);
  return { errors: errs.map((e) => e.message), skipped: false };
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
    const x = excludeOf(t);
    for (const id of x.collectionIds) collGids.add(`gid://shopify/Collection/${id}`);
    for (const tag of x.tags) tagSet.add(tag);
  }
  const checkColl = collGids.size <= FN_LIST_MAX;
  const checkTags = tagSet.size <= FN_LIST_MAX;
  const warnings = [];
  if (!checkColl) warnings.push(`Mais de ${FN_LIST_MAX} collections nos bundles ativos (segmentação + exclusões): o checkout não vai validar a collection do produto-gatilho.`);
  if (!checkTags) warnings.push(`Mais de ${FN_LIST_MAX} tags nos bundles ativos (segmentação + exclusões): o checkout não vai validar a tag do produto-gatilho.`);

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
    if (b.limitPerTrigger) entry.u = 1;
    const t = b.targets || {};
    if (t.type === "products") {
      entry.t = { k: "p", ids: (t.productIds || []).map(Number) };
    } else if (t.type === "collections" && checkColl) {
      entry.t = { k: "c", ids: (t.collectionIds || []).map(Number) };
    } else if (t.type === "tags" && checkTags) {
      entry.t = { k: "g", ids: (t.tags || []).map(String) };
    }
    const x = excludeOf(t);
    const ex = {};
    if (x.productIds.length) ex.p = x.productIds.map(Number);
    if (x.collectionIds.length && checkColl) ex.c = x.collectionIds.map(Number);
    if (x.tags.length && checkTags) ex.g = x.tags;
    if (Object.keys(ex).length) entry.x = ex;
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

  // Grande demais: tira a validação de segmentação (só items). Exclusão por
  // produto não depende das variables e fica se couber.
  const slimOf = (keepX) => {
    const slim = { v: 2, L: labels, collectionIds: [], tags: [], b: {} };
    for (const [id, e] of Object.entries(map)) {
      const s = e.u ? { i: e.i, u: 1 } : { i: e.i };
      if (keepX && e.x?.p) s.x = { p: e.x.p };
      slim.b[id] = s;
    }
    return slim;
  };
  for (const keepX of [true, false]) {
    const slim = slimOf(keepX);
    if (bytes(slim) > DISCOUNT_MAX_BYTES) continue;
    warnings.push("Config de desconto grande demais para validar a segmentação no checkout (limite de 10 KB da Shopify Function). Os descontos seguem funcionando sem essa validação.");
    if (!keepX && Object.values(map).some((e) => e.x)) warnings.push("As exclusões também não serão validadas no checkout (só na página do produto).");
    else if (Object.values(map).some((e) => e.x?.c || e.x?.g)) warnings.push("Exclusões por collection/tag não serão validadas no checkout (só na página do produto); as por produto continuam.");
    return { value: JSON.stringify(slim), warnings };
  }
  return { error: "A config de desconto passou de 10 KB (limite da Shopify Function) — a function não conseguiria ler os descontos. Reduza bundles/add-ons ativos." };
}

// ── Motor v3 do checkout ────────────────────────────────────────────────────
// Bundles por produto específico: as regras vão p/ o metafield `brk_bundles.fn` de
// cada produto-gatilho (pid -> { bundleId: { k, i, u? } }); a config da discount só
// guarda os bundles amplos (collections/tags/metafield, iguais ao v2) e as chaves
// (`fnKey`) dos por produto ativos em `a`. Assim ela não cresce com os por produto.
function buildProductFn(bundles) {
  const map = new Map();
  for (const b of bundles) {
    if (!b.enabled || !isProductBundle(b) || !Number.isInteger(b.fnKey)) continue;
    const i = {};
    for (const a of b.addons || []) {
      const it = {
        m: V2_MODE[a.mode] || V2_MODE.gift,
        v: Number(a.value) || 0,
        l: labelForItem(a),
        q: Number.isFinite(Number(a.maxQty)) ? Number(a.maxQty) : 1,
      };
      if (b.exemption) it.a = 1;
      i[String(a.productId)] = it;
    }
    // h/o: p/ a vitrine (handle do registro e ordem); x: exclusões (iguais ao v2)
    const entry = { k: b.fnKey, i, h: bundleHandle(b.id), o: orderKey(b) };
    if (b.limitPerTrigger) entry.u = 1;
    const ex = excludeOf(b.targets || {});
    if (hasExclude(ex)) {
      entry.x = {};
      if (ex.productIds.length) entry.x.p = ex.productIds.map(Number);
      if (ex.collectionIds.length) entry.x.c = ex.collectionIds.map(Number);
      if (ex.tags.length) entry.x.g = ex.tags;
    }
    for (const pid of (b.targets?.productIds || []).map(String)) {
      if (!map.has(pid)) map.set(pid, {});
      map.get(pid)[b.id] = entry;
    }
  }
  return map;
}

function buildDiscountConfigV3(bundles) {
  const broad = bundles.filter((b) => !isProductBundle(b));
  const built = buildDiscountConfig(broad);
  if (built.error) return built;
  const cfg = JSON.parse(built.value);
  cfg.v = 3;
  // exclusões dos bundles por produto (no `fn`) também precisam das variables
  const colls = new Set(cfg.collectionIds);
  const tags = new Set(cfg.tags);
  for (const b of bundles) {
    if (!b.enabled || !isProductBundle(b)) continue;
    const ex = excludeOf(b.targets || {});
    for (const id of ex.collectionIds) colls.add(`gid://shopify/Collection/${id}`);
    for (const t of ex.tags) tags.add(t);
  }
  if (colls.size <= FN_LIST_MAX) cfg.collectionIds = [...colls];
  if (tags.size <= FN_LIST_MAX) cfg.tags = [...tags];
  cfg.a = bundles.filter((b) => b.enabled && isProductBundle(b) && Number.isInteger(b.fnKey)).map((b) => b.fnKey).sort((x, y) => x - y);
  const value = JSON.stringify(cfg);
  if (bytes(value) > DISCOUNT_MAX_BYTES) {
    return { error: "A config de desconto (v3) passou do limite de 10 KB da Shopify Function — reduza bundles amplos ativos." };
  }
  return { value, warnings: built.warnings };
}

// Verificação do v3 (pura): cada bundle por produto ativo reconstruído a partir dos
// `fn` dos produtos tem que ser igual à entrada dele no v2 (itens, limite por
// produto, conjunto de produtos-gatilho) e a chave tem que estar em `a`; os bundles
// amplos do v3 têm que ser idênticos aos do v2.
function verifyV3Logic(bundles) {
  const v2 = buildDiscountConfig(bundles);
  const v3 = buildDiscountConfigV3(bundles);
  if (v2.error || v3.error) return { ok: false, problems: [v2.error || v3.error], problemCount: 1 };
  const c2 = JSON.parse(v2.value);
  const c3 = JSON.parse(v3.value);
  const fn = buildProductFn(bundles);
  const active = new Set(c3.a);
  const problems = [];
  for (const [id, e2] of Object.entries(c2.b)) {
    const b = bundles.find((x) => x.id === id);
    if (!b) continue;
    if (!isProductBundle(b)) {
      // compara com o TEXTO dos labels: a tabela `L` do v3 só tem os labels dos
      // amplos, então o índice (`l`) muda mesmo com a regra idêntica
      const withLabels = (e, L) => e && { ...e, i: Object.fromEntries(Object.entries(e.i || {}).map(([k, it]) => [k, { ...it, l: L[it.l] }])) };
      if (JSON.stringify(withLabels(c3.b[id], c3.L)) !== JSON.stringify(withLabels(e2, c2.L))) problems.push(`${b.name}: regra ampla diferente`);
      continue;
    }
    if (c3.b[id]) problems.push(`${b.name}: por produto ainda na config central`);
    if (!active.has(b.fnKey)) problems.push(`${b.name}: sem chave ativa`);
    const pids = [...fn.entries()].filter(([, m]) => m[id]).map(([pid]) => pid).sort();
    const want = (e2.t?.ids || []).map(String).sort();
    if (e2.t && JSON.stringify(pids) !== JSON.stringify(want)) problems.push(`${b.name}: produtos-gatilho diferentes`);
    const e3 = pids.length ? fn.get(pids[0])[id] : null;
    if (!e3) { problems.push(`${b.name}: sem regra nos produtos`); continue; }
    const items2 = Object.fromEntries(Object.entries(e2.i).map(([k, it]) => [k, { ...it, l: c2.L[it.l] }]));
    if (JSON.stringify(e3.i) !== JSON.stringify(items2)) problems.push(`${b.name}: itens diferentes`);
    if (!!e3.u !== !!e2.u) problems.push(`${b.name}: limite por produto diferente`);
  }
  let maxProductBytes = 0;
  for (const m of fn.values()) maxProductBytes = Math.max(maxProductBytes, bytes(m));
  if (maxProductBytes > DISCOUNT_MAX_BYTES) problems.push(`Um produto passou de 10 KB de regras (${maxProductBytes} B)`);
  return { ok: problems.length === 0, problems: problems.slice(0, 10), problemCount: problems.length, v2Bytes: bytes(v2.value), v3Bytes: bytes(v3.value), maxProductBytes, products: fn.size };
}

// Espelha a config no metafield da discount e cria/atualiza a automatic discount.
// `engine` "v3" grava a config v3; "v2"/"dual" a v2 de sempre.
async function syncDiscount(admin, bundles, engine = "v2") {
  const built = engine === "v3" ? buildDiscountConfigV3(bundles) : buildDiscountConfig(bundles);
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

// Produtos (gid -> título) de uma collection / tag, capado em 250.
async function collectionProducts(admin, cid) {
  const res = await admin.graphql(
    `query($id: ID!) { collection(id: $id) { products(first: 250) { nodes { id title } pageInfo { hasNextPage } } } }`,
    { variables: { id: `gid://shopify/Collection/${cid}` } }
  );
  const c = (await res.json()).data.collection;
  if (!c) return { nodes: [], truncated: false };
  return { nodes: c.products.nodes, truncated: c.products.pageInfo.hasNextPage };
}

async function tagProducts(admin, tag) {
  const res = await admin.graphql(
    `query($q: String!) { products(first: 250, query: $q) { nodes { id title } pageInfo { hasNextPage } } }`,
    { variables: { q: `tag:'${String(tag).replace(/'/g, "")}'` } }
  );
  const ps = (await res.json()).data.products;
  return { nodes: ps.nodes, truncated: ps.pageInfo.hasNextPage };
}

// Resolve o conjunto de produtos (gid -> título) que um bundle realmente atinge,
// já sem as exclusões. Expande collections/tags via API (capado em 250 por
// collection/tag). metafield não é resolvido (marcado como não verificável).
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
      const r = await collectionProducts(admin, cid);
      for (const n of r.nodes) set.set(n.id, n.title);
      if (r.truncated) truncated = true;
    }
  } else if (t.type === "tags") {
    for (const tag of t.tags || []) {
      const r = await tagProducts(admin, tag);
      for (const n of r.nodes) set.set(n.id, n.title);
      if (r.truncated) truncated = true;
    }
  } else {
    return { set, truncated: false, unresolved: true };
  }

  const x = excludeOf(t);
  for (const id of x.productIds) set.delete(`gid://shopify/Product/${id}`);
  for (const cid of x.collectionIds) {
    const r = await collectionProducts(admin, cid);
    for (const n of r.nodes) set.delete(n.id);
    if (r.truncated) truncated = true;
  }
  for (const tag of x.tags) {
    const r = await tagProducts(admin, tag);
    for (const n of r.nodes) set.delete(n.id);
    if (r.truncated) truncated = true;
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

// Grava a fonte da verdade + `live` + espelha a discount. `st` vem de loadBundles
// (ver os modos em bundles-store.server.js):
//   legacy       → config + live (como sempre foi);
//   dual         → config + live, depois copia o que mudou p/ os metaobjects;
//   metaobjects  → metaobjects primeiro; depois live + config antigo (só enquanto
//                  couber, p/ o rollback continuar possível).
// `live` e a discount saem das mesmas funções em todos os modos.
async function persist(admin, st, bundles) {
  const warnings = [];
  const fnOn = st.engine === "dual" || st.engine === "v3";
  if (fnOn) assignFnKeys(bundles);
  for (const b of bundles) {
    const changed = !st.prev || !st.prev.some((p) => p.id === b.id && JSON.stringify(p.targets) === JSON.stringify(b.targets));
    if (changed && isProductBundle(b) && (b.targets?.productIds || []).length > PRODUCT_BUNDLE_WARN) {
      warnings.push(`"${b.name}" tem mais de ${PRODUCT_BUNDLE_WARN} produtos escolhidos um a um: para bundles grandes, segmente por collection ou tag.`);
    }
  }
  const vitrineOn = st.vitrine === "on" || st.vitrine === "prepared";
  if (st.mode === "metaobjects") {
    const moErrs = await writeMetaobjectBundles(admin, bundles, st.mo, vitrineOn ? liveItem : null);
    if (moErrs.length) return { error: moErrs.join(", ") };
    const metafields = [];
    const live = JSON.stringify(buildLive(bundles));
    if (st.vitrine === "on" && bytes(live) > LEGACY_MAX_BYTES) {
      warnings.push("O `live` antigo passou de 120 KB e não foi atualizado: a vitrine já usa o formato novo; voltar ao antigo não teria as últimas mudanças.");
    } else {
      metafields.push({ ownerId: st.shopId, namespace: NS, key: KEY_LIVE, type: "json", value: live });
    }
    if (vitrineOn) {
      metafields.push({ ownerId: st.shopId, namespace: NS, key: KEY_LIVE_INDEX, type: "json", value: JSON.stringify(buildLiveIndex(bundles, st.vitrineMo, st.vitrine === "on")) });
    }
    const cfg = JSON.stringify(bundles);
    if (bytes(cfg) <= LEGACY_MAX_BYTES) metafields.push({ ownerId: st.shopId, namespace: NS, key: KEY, type: "json", value: cfg });
    else warnings.push("O config antigo passou de 120 KB e não foi atualizado: voltar ao armazenamento antigo não teria as últimas mudanças.");
    const errs = await setShopMetafields(admin, metafields);
    if (errs.length) return { error: errs.map((e) => e.message).join(", ") };
  } else {
    const errs = await saveConfig(admin, st.shopId, bundles);
    if (errs.length) return { error: errs.map((e) => e.message).join(", ") };
    if (st.mode === "dual") {
      const moErrs = await writeMetaobjectBundles(admin, bundles, st.mo);
      if (moErrs.length) warnings.push(`Salvo, mas a cópia nos registros novos falhou: ${moErrs.join(", ")}`);
    }
  }
  // Regras dos bundles por produto nos produtos-gatilho (só o que mudou).
  if (fnOn) {
    const plan = planProductFnWrites(buildProductFn(st.prev || []), buildProductFn(bundles));
    if (plan.sets.length + plan.deletes.length > PRODUCT_FN_INLINE_MAX) {
      warnings.push(`Muitos produtos afetados (${plan.sets.length + plan.deletes.length}): rode "Sincronizar produtos" no painel do checkout.`);
    } else {
      const fnErrs = await writeProductFn(admin, plan.sets, plan.deletes);
      if (fnErrs.length) warnings.push(`Regras nos produtos com erro (rode "Sincronizar produtos"): ${fnErrs.slice(0, 3).join(", ")}`);
    }
  }
  const sync = await syncDiscount(admin, bundles, st.engine);
  if (sync.error) return { error: sync.error };
  if (sync.warning) warnings.push(sync.warning);
  return { warning: warnings.join(" ") || null };
}

// Verificação da migração: mesmos bundles, mesma ordem, e — o que importa p/ a
// loja e o checkout — `live` e o config da discount byte a byte iguais.
function verifyMigration(legacy, moBundles) {
  const cmp = compareBundles(legacy, moBundles);
  const liveSame = JSON.stringify(buildLive(legacy)) === JSON.stringify(buildLive(moBundles));
  const dl = buildDiscountConfig(legacy);
  const dm = buildDiscountConfig(moBundles);
  const discountSame = (dl.value || dl.error) === (dm.value || dm.error);
  const ok = !cmp.missing.length && !cmp.different.length && !cmp.extra.length && cmp.sameOrder && liveSame && discountSame;
  return {
    ok, total: legacy.length, migrated: moBundles.length,
    missingCount: cmp.missing.length, differentCount: cmp.different.length, extraCount: cmp.extra.length,
    examples: [...cmp.missing, ...cmp.different, ...cmp.extra].slice(0, 8),
    sameOrder: cmp.sameOrder, liveSame, discountSame,
  };
}

// Recria só os dados derivados (`live` + discount) a partir do config atual,
// sem tocar no config.
async function regenerateDerived(admin, shopId, bundles, engine = "v2") {
  const errs = await setShopMetafields(admin, [liveMetafield(shopId, bundles)]);
  if (errs.length) return { error: errs.map((e) => e.message).join(", ") };
  const sync = await syncDiscount(admin, bundles, engine);
  if (sync.error) return { error: sync.error };
  return { warning: sync.warning || null };
}

// Verificação da vitrine v2: cada registro com o `storefront` igual ao que o `live`
// teria; o índice com os bundles amplos certos; o `fn` de cada produto-gatilho igual
// ao esperado (é dele que o tema tira os bundles por produto).
async function verifyVitrine(admin, st, bundles) {
  const problems = [];
  if (st.mode !== "metaobjects") problems.push("armazenamento novo não está ativo");
  if (st.engine === "v2") problems.push("motor do checkout não preparado");
  if (st.vitrine === "off") problems.push("vitrine não preparada (passo 1)");
  const mo = await listMetaobjectBundles(admin);
  let wrongRecords = 0;
  for (const b of bundles) {
    if (mo.snapSf.get(b.id) !== JSON.stringify(liveItem(b))) wrongRecords++;
  }
  if (wrongRecords) problems.push(`${wrongRecords} registro(s) sem o campo da vitrine atualizado`);
  const expected = buildProductFn(bundles);
  const stored = await readProductFn(admin, [...expected.keys()]);
  const wrongProducts = [...expected.entries()].filter(([pid, m]) => JSON.stringify(stored.get(pid)) !== JSON.stringify(m)).length;
  if (wrongProducts) problems.push(`${wrongProducts} produto(s) sem as regras atualizadas — rode "Sincronizar produtos"`);
  if (!st.vitrineMo && st.vitrine !== "off") problems.push("índice sem o tipo do registro — rode o passo 1 de novo");
  const index = buildLiveIndex(bundles, st.vitrineMo, false);
  return {
    ok: problems.length === 0,
    problems,
    broad: index.b.length,
    productBundles: bundles.filter((b) => b.enabled && isProductBundle(b)).length,
    products: expected.size,
    indexBytes: bytes(index),
    liveBytes: bytes(buildLive(bundles)),
  };
}

// Tamanhos da config do checkout (v2 atual e como ficaria no v3) p/ o painel.
function engineInfo(mode, bundles) {
  const v2 = buildDiscountConfig(bundles);
  const v3 = buildDiscountConfigV3(bundles);
  return {
    mode,
    v2Bytes: v2.value ? bytes(v2.value) : null,
    v3Bytes: v3.value ? bytes(v3.value) : null,
    maxBytes: DISCOUNT_MAX_BYTES,
    productBundles: bundles.filter((b) => b.enabled && isProductBundle(b)).length,
    broadBundles: bundles.filter((b) => b.enabled && !isProductBundle(b)).length,
  };
}

// ── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin, session } = await shopify.authenticate.admin(request);

  await ensureDefinition(admin);
  let st = await loadBundles(admin);
  // Loja sem nenhum bundle (instalação nova): não há o que migrar, então vai direto ao
  // formato final — armazenamento novo + checkout v3 + vitrine nova — sem as etapas dos
  // painéis, mesmo que alguma etapa já tenha sido clicada pela metade. Lojas com
  // bundles não entram aqui (seguem as etapas, com verificação).
  const isFinal = st.mode === "metaobjects" && st.engine === "v3" && st.vitrine === "on";
  if (!isFinal && st.legacy.length === 0) {
    const mo = await metaobjectFullType(admin);
    if (mo && (await listMetaobjectBundles(admin)).bundles.length === 0) {
      const errs = [...(await setMode(admin, st.shopId, "metaobjects")), ...(await setEngine(admin, st.shopId, "v3"))];
      if (!errs.length) {
        await setShopMetafields(admin, [
          { ownerId: st.shopId, namespace: NS, key: KEY_LIVE_INDEX, type: "json", value: JSON.stringify(buildLiveIndex([], mo, true)) },
          liveMetafield(st.shopId, []),
        ]);
        await syncDiscount(admin, [], "v3");
        st = await loadBundles(admin);
      }
    }
  }
  const { shopId, bundles, hasLive } = st;
  // Primeira abertura após a migração: gera `live` + discount a partir do config.
  let liveWarning = null;
  if (!hasLive) {
    const r = await regenerateDerived(admin, shopId, bundles, st.engine);
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
    storage: {
      mode: st.mode,
      legacyCount: st.legacy.length,
      migratedCount: st.mo ? st.mo.bundles.length : (await listMetaobjectBundles(admin)).bundles.length,
      configBytes: bytes(JSON.stringify(bundles)),
      liveBytes: bytes(JSON.stringify(buildLive(bundles))),
      maxBytes: SHOPIFY_JSON_MAX,
    },
    engine: engineInfo(st.engine, bundles),
    vitrine: {
      mode: st.vitrine,
      storage: st.mode,
      engine: st.engine,
      liveBytes: bytes(JSON.stringify(buildLive(bundles))),
      indexBytes: bytes(buildLiveIndex(bundles, st.vitrineMo, false)),
      maxBytes: SHOPIFY_JSON_MAX,
    },
  });
};

// O loop da limpeza não precisa recarregar o loader a cada página.
export function shouldRevalidate({ formData, defaultShouldRevalidate }) {
  const intent = formData?.get("intent");
  if (["cleanupLegacy", "migrateBundles", "verifyBundles", "syncProductFn", "scanProductFn", "verifyV3", "verifyVitrine"].includes(intent)) return false;
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
      // "include" (segmentação) ou "exclude" (exclusões): só ecoado p/ o cliente
      const scope = formData.get("scope") === "exclude" ? "exclude" : "include";
      if (!ids.length) return json({ action: "fetchTargetProducts", scope, products: [] });
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
      return json({ action: "fetchTargetProducts", scope, products });
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

    // ── Migração do config (blob) p/ metaobjects ──
    // migrateBundles: copia 1 página do config antigo (upsert idempotente, mesma ordem).
    // verifyBundles: confere bundles, ordem e os dados derivados (live + discount).
    // setBundlesMode: dual/metaobjects só com a verificação ok; legacy = voltar.
    if (intent === "migrateBundles" || intent === "verifyBundles" || intent === "setBundlesMode") {
      const st0 = await loadShopState(admin, { withConfig: true });
      if (intent === "migrateBundles") {
        if (st0.mode === "metaobjects") return json({ action: "migrateBundles", error: "Já está no armazenamento novo." });
        const offset = Math.max(0, Number(formData.get("offset")) || 0);
        const slice = st0.legacy.slice(offset, offset + MIGRATE_PAGE);
        const errors = await upsertMetaobjectBundles(admin, slice.map((bundle, k) => ({ bundle, position: offset + k })));
        const next = offset + slice.length;
        return json({ action: "migrateBundles", total: st0.legacy.length, next, done: next >= st0.legacy.length, errors });
      }
      const mo = await listMetaobjectBundles(admin);
      const report = verifyMigration(st0.legacy, mo.bundles);
      if (intent === "verifyBundles") return json({ action: "verifyBundles", ...report });
      const mode = formData.get("mode");
      if (!["legacy", "dual", "metaobjects"].includes(mode)) return json({ success: false, error: "Modo inválido." });
      if (mode !== "legacy" && !report.ok) return json({ action: "verifyBundles", ...report });
      const errs = await setMode(admin, st0.shopId, mode);
      if (errs.length) return json({ success: false, error: errs.join(", ") });
      return json({ success: true, action: "setBundlesMode", mode, ...report });
    }

    const st = await loadBundles(admin);
    st.prev = JSON.parse(JSON.stringify(st.bundles)); // estado antes da mudança (diff dos produtos)
    const { shopId, bundles } = st;

    // ── Motor v3 do checkout ──
    // prepareV3: dá chave (`fnKey`) aos bundles por produto e liga o modo "dual"
    //   (os saves passam a manter as regras nos produtos); a discount continua v2.
    // syncProductFn: grava o `fn` de todos os produtos-gatilho (1 página por chamada).
    // scanProductFn: varre a loja e apaga `fn` que não deveria existir (1 página/chamada).
    // verifyV3: lógica (pura) + o que está gravado nos produtos == o esperado.
    // setEngine: v3 só com a verificação ok; v2/dual = voltar.
    if (intent === "prepareV3") {
      const assigned = assignFnKeys(bundles);
      if (assigned.length) {
        // grava as chaves nos bundles; os produtos são gravados pelo "Sincronizar produtos"
        const r = await persist(admin, { ...st, engine: "dual", prev: bundles }, bundles);
        if (r.error) return json({ success: false, error: r.error });
      }
      const errs = await setEngine(admin, shopId, "dual");
      if (errs.length) return json({ success: false, error: errs.join(", ") });
      return json({ action: "prepareV3", assigned: assigned.length });
    }
    if (intent === "syncProductFn") {
      const offset = Math.max(0, Number(formData.get("offset")) || 0);
      const all = [...buildProductFn(bundles).entries()].sort(([a], [b]) => a.localeCompare(b));
      const slice = all.slice(offset, offset + PRODUCT_FN_PAGE);
      const errors = await writeProductFn(admin, slice.map(([pid, m]) => ({ pid, value: JSON.stringify(m) })), []);
      const next = offset + slice.length;
      return json({ action: "syncProductFn", total: all.length, next, done: next >= all.length, errors });
    }
    if (intent === "scanProductFn") {
      const expected = buildProductFn(bundles);
      const page = await scanProductFnPage(admin, formData.get("cursor") || null);
      const orphans = [...page.found.keys()].filter((pid) => !expected.has(pid));
      const errors = orphans.length ? await writeProductFn(admin, [], orphans) : [];
      return json({ action: "scanProductFn", scanned: page.scanned, orphans: orphans.length, cursor: page.next, done: !page.next, errors });
    }
    if (intent === "verifyV3" || intent === "setEngine") {
      const logic = verifyV3Logic(bundles);
      const expected = buildProductFn(bundles);
      const stored = await readProductFn(admin, [...expected.keys()]);
      const wrong = [...expected.entries()].filter(([pid, m]) => JSON.stringify(stored.get(pid)) !== JSON.stringify(m)).length;
      const report = { ...logic, storedOk: wrong === 0, wrongProducts: wrong, ok: logic.ok && wrong === 0 && st.engine !== "v2" };
      if (intent === "verifyV3") return json({ action: "verifyV3", ...report });
      const engine = formData.get("engine");
      if (!["v2", "dual", "v3"].includes(engine)) return json({ success: false, error: "Motor inválido." });
      if (engine === "v3" && !report.ok) return json({ action: "verifyV3", ...report });
      const errs = await setEngine(admin, shopId, engine);
      if (errs.length) return json({ success: false, error: errs.join(", ") });
      const sync = await syncDiscount(admin, bundles, engine);
      if (sync.error) {
        await setEngine(admin, shopId, st.engine);
        return json({ success: false, error: `Desconto não atualizado, motor mantido: ${sync.error}` });
      }
      return json({ success: true, action: "setEngine", engine, warning: sync.warning || null, ...report });
    }

    // ── Vitrine v2 ──
    // prepareVitrine: grava o campo `storefront` em todos os registros + o índice
    //   (`on: false`): nada muda na loja ainda. Exige armazenamento novo e o motor do
    //   checkout preparado (o tema usa o `fn` dos produtos).
    // verifyVitrine: registros, índice e `fn` dos produtos == o esperado.
    // setVitrine: on só com a verificação ok; off = volta ao `live`.
    if (intent === "prepareVitrine") {
      if (st.mode !== "metaobjects") return json({ success: false, error: "Ative antes o armazenamento novo dos bundles." });
      if (st.engine === "v2") return json({ success: false, error: "Prepare antes o motor novo do checkout (as regras nos produtos são usadas pela vitrine)." });
      const mo = await metaobjectFullType(admin);
      if (!mo) return json({ success: false, error: "Tipo do registro não encontrado: faça o deploy do app (shopify app deploy)." });
      const moErrs = await writeMetaobjectBundles(admin, bundles, st.mo, liveItem);
      if (moErrs.length) return json({ success: false, error: moErrs.join(", ") });
      const on = st.vitrine === "on";
      const errs = await setShopMetafields(admin, [
        { ownerId: shopId, namespace: NS, key: KEY_LIVE_INDEX, type: "json", value: JSON.stringify(buildLiveIndex(bundles, mo, on)) },
      ]);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "prepareVitrine" });
    }
    if (intent === "verifyVitrine" || intent === "setVitrine") {
      const report = await verifyVitrine(admin, st, bundles);
      if (intent === "verifyVitrine") return json({ action: "verifyVitrine", ...report });
      const on = formData.get("on") === "1";
      if (on && !report.ok) return json({ action: "verifyVitrine", ...report });
      const mo = st.vitrineMo || (await metaobjectFullType(admin));
      const errs = await setShopMetafields(admin, [
        { ownerId: shopId, namespace: NS, key: KEY_LIVE_INDEX, type: "json", value: JSON.stringify(buildLiveIndex(bundles, mo, on)) },
        liveMetafield(shopId, bundles), // `live` atualizado: o caminho antigo continua pronto
      ]);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "setVitrine", on, ...report });
    }

    if (intent === "regenerate") {
      const r = await regenerateDerived(admin, shopId, bundles, st.engine);
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

      const r = await persist(admin, st, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "save", warning: r.warning });
    }

    if (intent === "toggle") {
      const id = formData.get("id");
      const b = bundles.find((x) => x.id === id);
      if (b) b.enabled = !b.enabled;
      const r = await persist(admin, st, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "toggle", warning: r.warning });
    }

    if (intent === "toggleExemption") {
      const id = formData.get("id");
      const b = bundles.find((x) => x.id === id);
      if (b) b.exemption = !b.exemption;
      const r = await persist(admin, st, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "toggleExemption", warning: r.warning });
    }

    // Opções em massa: só as chaves de BULK_OPTION_KEYS, só booleanos, só nos
    // ids enviados. Backup do config antes de gravar.
    if (intent === "bulkOptions") {
      const ids = new Set(JSON.parse(formData.get("ids") || "[]"));
      const patchIn = JSON.parse(formData.get("patch") || "{}");
      const patch = {};
      for (const k of BULK_OPTION_KEYS) if (typeof patchIn[k] === "boolean") patch[k] = patchIn[k];
      if (!ids.size || !Object.keys(patch).length) return json({ success: false, error: "Nada para aplicar." });

      let count = 0;
      const next = bundles.map((b) => {
        if (!ids.has(b.id)) return b;
        const nb = { ...b, ...patch };
        if (Object.keys(patch).some((k) => !!nb[k] !== !!b[k])) count++;
        return nb;
      });
      if (!count) return json({ success: true, action: "bulkOptions", count: 0, warning: "Nenhum bundle precisou mudar." });

      const backup = await backupBundles(admin, shopId, bundles.filter((b) => ids.has(b.id)), "bulkOptions");
      if (backup.errors.length) return json({ success: false, error: `Backup falhou, nada foi alterado: ${backup.errors.join(", ")}` });
      const r = await persist(admin, st, next);
      if (r.error) return json({ success: false, error: r.error });
      const warning = [backup.skipped ? "Seleção grande demais para o backup automático (exporte o CSV antes de mudanças em massa)." : null, r.warning].filter(Boolean).join(" ") || null;
      return json({ success: true, action: "bulkOptions", count, warning });
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
      const r = await persist(admin, st, bundles);
      if (r.error) return json({ success: false, error: r.error });
      return json({ success: true, action: "duplicate", warning: r.warning });
    }

    if (intent === "delete" || intent === "deleteMany") {
      const ids = intent === "delete"
        ? [formData.get("id")]
        : JSON.parse(formData.get("ids") || "[]");
      const idSet = new Set(ids);
      const next = bundles.filter((b) => !idSet.has(b.id));
      const r = await persist(admin, st, next);
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
    showAddonDiscount: false, // isenção: no cart/minicart exibe o desconto no add-on (só visual, tema)
    limitPerTrigger: false, // "Máx. c/ desconto" vale por produto do bundle no carrinho, não pelo carrinho todo
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
      exclude: blankExclude(), // exclusões: vencem a segmentação (tema + checkout)
    },
    // cada add-on tem seu próprio desconto
    addons: [],
  };
}

function blankExclude() {
  return { productIds: [], productsMeta: [], collectionIds: [], collectionsMeta: [], tags: [] };
}

// Cópia p/ o editor; bundles antigos ganham `targets.exclude` vazio.
function forEditor(b) {
  const c = JSON.parse(JSON.stringify(b));
  c.targets = { ...blankBundle().targets, ...(c.targets || {}) };
  c.targets.exclude = { ...blankExclude(), ...(c.targets.exclude || {}) };
  return c;
}

function excludeCount(b) {
  const x = b.targets?.exclude || {};
  return (x.productIds || []).length + (x.collectionIds || []).length + (x.tags || []).length;
}

// Tags separadas por vírgula, com o texto digitado guardado localmente (dá p/
// digitar a vírgula e o espaço antes da próxima tag).
function TagListField({ tags, onChange, ...props }) {
  const [text, setText] = useState(() => (tags || []).join(", "));
  return (
    <TextField
      {...props}
      value={text}
      onChange={(v) => { setText(v); onChange(v.split(",").map((s) => s.trim()).filter(Boolean)); }}
      autoComplete="off"
    />
  );
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

// Ação em massa "Editar opções" (o servidor só aceita estas chaves: BULK_OPTION_KEYS).
const BULK_OPTIONS = [
  { key: "exemption", label: "Isenção fiscal" },
  { key: "hidePrice", label: "Esconder preços dos add-ons" },
  { key: "showAddonDiscount", label: "Mostrar desconto do add-on no carrinho" },
];
const BULK_CHOICES = [
  { label: "Manter como está", value: "keep" },
  { label: "Ativar", value: "on" },
  { label: "Desativar", value: "off" },
];

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
      // excluído de um dos dois não conflita (mesma lista de exclusão do tipo)
      const excl = new Set([...(a.targets?.exclude?.[keyId[t]] || []), ...(b.targets?.exclude?.[keyId[t]] || [])].map(String));
      const overlap = ka.map(String).filter((x) => kb.has(x) && !excl.has(x));
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

const kb = (n) => `${(n / 1024).toFixed(1).replace(".", ",")} KB`;

// Texto do resultado da verificação da migração.
function verifyText(r) {
  if (r.ok) return `Verificação ok: ${r.total} bundle(s) idênticos, mesma ordem; dados da loja e do checkout iguais byte a byte.`;
  const parts = [];
  if (r.missingCount) parts.push(`${r.missingCount} faltando`);
  if (r.differentCount) parts.push(`${r.differentCount} diferente(s)`);
  if (r.extraCount) parts.push(`${r.extraCount} sobrando`);
  if (!r.sameOrder) parts.push("ordem diferente");
  if (!r.liveSame) parts.push("dados da loja (live) diferentes");
  if (!r.discountSame) parts.push("config do checkout diferente");
  return `Verificação não bateu: ${parts.join(", ")}${r.examples?.length ? ` (ex.: ${r.examples.join(", ")})` : ""}. Rode a cópia de novo.`;
}

// Painel do armazenamento dos bundles: tamanho (limite de 128 KB) e a migração
// p/ metaobjects em etapas (copiar → verificar → gravação dupla → novo), com volta.
function StoragePanel({ storage, migration, onCopy, verify, onVerify, onMode, busy, result }) {
  const pct = Math.round((Math.max(storage.configBytes, storage.liveBytes) / storage.maxBytes) * 100);
  const sizes = `Tamanho: config ${kb(storage.configBytes)} · dados da loja (live) ${kb(storage.liveBytes)} — limite ${kb(storage.maxBytes)} cada (${pct}% do limite).`;
  const v = verify.data?.action === "verifyBundles" ? verify.data : result?.action === "verifyBundles" ? result : null;
  const confirmBack = () => {
    if (window.confirm("Voltar ao armazenamento antigo (config único)? Ele foi mantido atualizado enquanto coube em 120 KB.")) onMode("legacy");
  };
  const modeDone = result?.success && result.action === "setBundlesMode";

  if (storage.mode === "metaobjects") {
    return (
      <BlockStack gap="200">
        {modeDone && <Banner tone="success" title="Armazenamento novo ativado: 1 registro por bundle." />}
        {storage.liveBytes / storage.maxBytes >= 0.8 && (
          <Banner tone="warning" title="Dados da loja (live) perto do limite">
            <p>{sizes} O live só inclui bundles ativos; desative os que não usa mais.</p>
          </Banner>
        )}
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" tone="subdued" variant="bodySm">Armazenamento: 1 registro por bundle (metaobjects). {sizes}</Text>
          <Button variant="plain" tone="critical" onClick={confirmBack}>Voltar ao armazenamento antigo</Button>
        </InlineStack>
      </BlockStack>
    );
  }

  const dual = storage.mode === "dual";
  return (
    <Banner
      tone={dual ? "info" : pct >= 80 ? "warning" : "info"}
      title={dual ? "Gravação dupla ativa (período de teste do armazenamento novo)" : "Armazenamento dos bundles: migrar para 1 registro por bundle"}
    >
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">{sizes}</Text>
        <Text as="p" variant="bodySm">
          {dual
            ? "Tudo continua lendo o formato antigo, e cada alteração também é gravada nos registros novos. Use normalmente por alguns dias; depois verifique e ative o armazenamento novo."
            : "Hoje todos os bundles ficam num JSON único, que a Shopify só aceita gravar até 128 KB. A migração copia cada bundle para um registro próprio (metaobject). A loja e o checkout não mudam: os dados que eles leem continuam sendo gerados do mesmo jeito, e a verificação confere isso byte a byte."}
        </Text>
        {!dual && (
          <Text as="p" variant="bodySm">
            {migration
              ? `Copiando… ${migration.next} de ${migration.total}${migration.running ? "" : " (parado)"}`
              : `${storage.migratedCount} de ${storage.legacyCount} bundle(s) já copiados.`}
          </Text>
        )}
        {migration?.errors.length > 0 && <Text as="p" variant="bodySm" tone="critical">{migration.errors.slice(0, 5).join(" · ")}</Text>}
        {v && <Text as="p" variant="bodySm" tone={v.ok ? "success" : "critical"}>{verifyText(v)}</Text>}
        {modeDone && <Text as="p" variant="bodySm" tone="success">{result.mode === "dual" ? "Gravação dupla ativada." : "Voltou ao armazenamento antigo."}</Text>}
        <InlineStack gap="200">
          {!dual && <Button onClick={onCopy} loading={!!migration?.running}>1. Copiar bundles</Button>}
          <Button onClick={onVerify} loading={verify.state !== "idle"} disabled={!!migration?.running}>{dual ? "Verificar" : "2. Verificar"}</Button>
          {!dual && (
            <Button variant="primary" onClick={() => onMode("dual")} loading={busy} disabled={!v?.ok || !!migration?.running}>
              3. Ativar gravação dupla
            </Button>
          )}
          {dual && (
            <>
              <Button variant="primary" onClick={() => onMode("metaobjects")} loading={busy} disabled={!v?.ok}>Ativar armazenamento novo</Button>
              <Button variant="plain" tone="critical" onClick={() => onMode("legacy")}>Desligar gravação dupla</Button>
            </>
          )}
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

// Texto do resultado da verificação do motor v3.
function verifyV3Text(r) {
  if (r.ok) return `Verificação ok: ${r.products} produto(s) com as regras certas; checkout ${kb(r.v2Bytes)} → ${kb(r.v3Bytes)}; maior produto ${r.maxProductBytes} B.`;
  const parts = [];
  if (r.problemCount) parts.push(`${r.problemCount} problema(s) de regra${r.problems?.length ? ` (ex.: ${r.problems.slice(0, 3).join("; ")})` : ""}`);
  if (!r.storedOk) parts.push(`${r.wrongProducts} produto(s) sem a regra gravada — rode "Sincronizar produtos"`);
  if (!parts.length) parts.push('prepare primeiro (passo 1)');
  return `Verificação não bateu: ${parts.join("; ")}.`;
}

// Painel do motor do checkout: config do desconto (limite de ~10 KB da Shopify
// Function) e a troca p/ o v3 (regras dos bundles por produto nos próprios produtos).
function EnginePanel({ engine, fnSync, onSync, verify, onVerify, onPrepare, onEngine, busy, result }) {
  const pct = engine.v2Bytes ? Math.round((engine.v2Bytes / engine.maxBytes) * 100) : null;
  const v = verify.data?.action === "verifyV3" ? verify.data : result?.action === "verifyV3" ? result : null;
  const done = result?.success && result.action === "setEngine";
  const syncText = fnSync && (fnSync.phase === "sync"
    ? `Gravando regras nos produtos… ${fnSync.next} de ${fnSync.total || "?"}${fnSync.running ? "" : " (parado)"}`
    : fnSync.phase === "scan"
      ? `Procurando regras antigas na loja… ${fnSync.scanned} produto(s) verificados, ${fnSync.orphans} limpas${fnSync.running ? "" : " (parado)"}`
      : `Produtos sincronizados: ${fnSync.total} com regra; ${fnSync.orphans} regra(s) antiga(s) limpa(s) em ${fnSync.scanned} produto(s).`);

  if (engine.mode === "v3") {
    return (
      <BlockStack gap="200">
        {done && <Banner tone="success" title="Motor novo do checkout ativado." />}
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" tone="subdued" variant="bodySm">
            Checkout: motor novo — {kb(engine.v3Bytes || 0)} de {kb(engine.maxBytes)} ({engine.broadBundles} bundle(s) amplo(s) na config; {engine.productBundles} por produto ficam nos próprios produtos).
          </Text>
          <Button variant="plain" onClick={onSync} loading={!!fnSync?.running}>Sincronizar produtos</Button>
          <Button variant="plain" tone="critical" onClick={() => { if (window.confirm("Voltar ao motor antigo do checkout? Todas as regras voltam para a config do desconto.")) onEngine("dual"); }}>Voltar ao motor antigo</Button>
        </InlineStack>
        {syncText && <Text as="p" variant="bodySm">{syncText}</Text>}
        {fnSync?.errors.length > 0 && <Text as="p" variant="bodySm" tone="critical">{fnSync.errors.slice(0, 5).join(" · ")}</Text>}
      </BlockStack>
    );
  }

  const dual = engine.mode === "dual";
  return (
    <Banner
      tone={pct != null && pct >= 80 ? "warning" : "info"}
      title={dual ? "Checkout: preparando o motor novo" : "Checkout: config do desconto dos bundles"}
    >
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          Tamanho: {engine.v2Bytes != null ? `${kb(engine.v2Bytes)} de ${kb(engine.maxBytes)} (${pct}%)` : "passou do limite (modo resumido)"}. Com o motor novo: {engine.v3Bytes != null ? kb(engine.v3Bytes) : "—"}.
        </Text>
        <Text as="p" variant="bodySm">
          A Shopify só entrega ~10 KB de config à regra de desconto. No motor novo, as regras dos {engine.productBundles} bundle(s) por produto ficam gravadas nos próprios produtos-gatilho, e a config guarda só os {engine.broadBundles} bundle(s) amplo(s) (por collection/tag). Os descontos são os mesmos; a verificação confere regra por regra antes de ativar.
        </Text>
        {syncText && <Text as="p" variant="bodySm">{syncText}</Text>}
        {fnSync?.errors.length > 0 && <Text as="p" variant="bodySm" tone="critical">{fnSync.errors.slice(0, 5).join(" · ")}</Text>}
        {v && <Text as="p" variant="bodySm" tone={v.ok ? "success" : "critical"}>{verifyV3Text(v)}</Text>}
        {done && <Text as="p" variant="bodySm" tone="success">{result.engine === "dual" ? "Motor antigo ativo (regras continuam sendo mantidas nos produtos)." : "Motor antigo ativo."}</Text>}
        <InlineStack gap="200">
          {!dual && <Button onClick={onPrepare} loading={busy}>1. Preparar</Button>}
          {dual && (
            <>
              <Button onClick={onSync} loading={!!fnSync?.running}>2. Sincronizar produtos</Button>
              <Button onClick={onVerify} loading={verify.state !== "idle"} disabled={!!fnSync?.running}>3. Verificar</Button>
              <Button variant="primary" onClick={() => onEngine("v3")} loading={busy} disabled={!v?.ok || !!fnSync?.running}>4. Ativar motor novo</Button>
              <Button variant="plain" tone="critical" onClick={() => onEngine("v2")}>Cancelar preparação</Button>
            </>
          )}
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

// Painel da vitrine (página do produto + carrinho): sai do `live` (JSON único com
// todos os bundles, limite de 128 KB) p/ índice pequeno + registro de cada bundle.
function VitrinePanel({ vitrine, verify, onVerify, onPrepare, onSet, busy, result }) {
  const pct = Math.round((vitrine.liveBytes / vitrine.maxBytes) * 100);
  const v = verify.data?.action === "verifyVitrine" ? verify.data : result?.action === "verifyVitrine" ? result : null;
  const done = result?.success && result.action === "setVitrine";
  const blocked = vitrine.storage !== "metaobjects" ? "Primeiro ative o armazenamento novo dos bundles (painel acima)."
    : vitrine.engine === "v2" ? 'Primeiro faça o "1. Preparar" e o "2. Sincronizar produtos" do checkout (a vitrine usa as regras gravadas nos produtos).' : null;
  const verifyText = v && (v.ok
    ? `Verificação ok: ${v.productBundles} bundle(s) por produto em ${v.products} produto(s), ${v.broad} amplo(s) no índice (${kb(v.indexBytes)}).`
    : `Verificação não bateu: ${v.problems.join("; ")}.`);

  if (vitrine.mode === "on") {
    return (
      <BlockStack gap="200">
        {done && <Banner tone="success" title="Vitrine nova ativada." />}
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" tone="subdued" variant="bodySm">
            Vitrine: formato novo — índice {kb(vitrine.indexBytes)} (só bundles amplos); detalhes no registro de cada bundle. O `live` antigo ({kb(vitrine.liveBytes)}) segue atualizado enquanto couber, p/ poder voltar.
          </Text>
          <Button variant="plain" tone="critical" onClick={() => { if (window.confirm("Voltar a vitrine para o formato antigo (live)?")) onSet(false); }}>Voltar ao formato antigo</Button>
        </InlineStack>
      </BlockStack>
    );
  }
  return (
    <Banner tone={pct >= 80 ? "warning" : "info"} title={vitrine.mode === "prepared" ? "Vitrine: formato novo preparado (ainda não ativo)" : "Vitrine: dados da página do produto e do carrinho"}>
      <BlockStack gap="200">
        <Text as="p" variant="bodySm">
          Hoje o tema lê o `live`: {kb(vitrine.liveBytes)} de {kb(vitrine.maxBytes)} ({pct}%). No formato novo ele lê só um índice dos bundles amplos ({kb(vitrine.indexBytes)}), as regras de cada produto e o registro de cada bundle — nada cresce com o total de bundles. O visual e o comportamento são os mesmos.
        </Text>
        {blocked && <Text as="p" variant="bodySm" tone="caution">{blocked}</Text>}
        {verifyText && <Text as="p" variant="bodySm" tone={v.ok ? "success" : "critical"}>{verifyText}</Text>}
        {done && !result.on && <Text as="p" variant="bodySm" tone="success">Vitrine de volta ao formato antigo.</Text>}
        <InlineStack gap="200">
          <Button onClick={onPrepare} loading={busy} disabled={!!blocked}>{vitrine.mode === "prepared" ? "1. Preparar de novo" : "1. Preparar"}</Button>
          <Button onClick={onVerify} loading={verify.state !== "idle"} disabled={!!blocked || vitrine.mode === "off"}>2. Verificar</Button>
          <Button variant="primary" onClick={() => onSet(true)} loading={busy} disabled={!v?.ok}>3. Ativar vitrine nova</Button>
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

export default function Bundles() {
  const { bundles, stats, start, end, hasFn, hasDiscount, liveWarning, storage, engine, vitrine } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const addonFetcher = useFetcher();
  const targetFetcher = useFetcher();
  const saveFetcher = useFetcher();
  const conflictFetcher = useFetcher();
  const cleanupFetcher = useFetcher();
  const migrateFetcher = useFetcher();
  const verifyFetcher = useFetcher();
  const fnFetcher = useFetcher();
  const verifyV3Fetcher = useFetcher();
  const verifyVitrineFetcher = useFetcher();

  // ── Motor v3: sincronizar regras nos produtos (grava todos, depois varre órfãos) ──
  const [fnSync, setFnSync] = useState(null); // { phase, running, next, total, scanned, orphans, errors }
  const startFnSync = useCallback(() => {
    setFnSync({ phase: "sync", running: true, next: 0, total: 0, scanned: 0, orphans: 0, errors: [] });
    fnFetcher.submit({ intent: "syncProductFn", offset: "0" }, { method: "post" });
  }, [fnFetcher]);
  const lastFn = useRef(null);
  useEffect(() => {
    const d = fnFetcher.data;
    if (!d || d === lastFn.current) return;
    lastFn.current = d;
    if (d.action !== "syncProductFn" && d.action !== "scanProductFn") {
      setFnSync((cur) => cur && { ...cur, running: false, errors: [...cur.errors, d.error || "Erro desconhecido."] });
      return;
    }
    const errors = d.errors || [];
    if (d.action === "syncProductFn") {
      const toScan = d.done && errors.length === 0;
      setFnSync((cur) => cur && { ...cur, next: d.next, total: d.total, errors: [...cur.errors, ...errors], phase: toScan ? "scan" : "sync", running: errors.length === 0 });
      if (errors.length) return;
      if (!d.done) fnFetcher.submit({ intent: "syncProductFn", offset: String(d.next) }, { method: "post" });
      else fnFetcher.submit({ intent: "scanProductFn", cursor: "" }, { method: "post" });
      return;
    }
    const keepGoing = !d.done && errors.length === 0;
    setFnSync((cur) => cur && { ...cur, scanned: cur.scanned + d.scanned, orphans: cur.orphans + d.orphans, errors: [...cur.errors, ...errors], phase: keepGoing ? "scan" : "done", running: keepGoing });
    if (keepGoing) fnFetcher.submit({ intent: "scanProductFn", cursor: d.cursor }, { method: "post" });
  }, [fnFetcher.data, fnFetcher]);

  // ── Migração do armazenamento (loop página a página pelo cliente) ──
  const [migration, setMigration] = useState(null); // { running, next, total, errors }
  const startMigration = useCallback(() => {
    setMigration({ running: true, next: 0, total: storage.legacyCount, errors: [] });
    migrateFetcher.submit({ intent: "migrateBundles", offset: "0" }, { method: "post" });
  }, [migrateFetcher, storage.legacyCount]);
  const lastMigrate = useRef(null);
  useEffect(() => {
    const d = migrateFetcher.data;
    if (!d || d === lastMigrate.current) return;
    lastMigrate.current = d;
    if (d.action !== "migrateBundles" || d.error) {
      setMigration((cur) => cur && { ...cur, running: false, errors: [...cur.errors, d.error || "Erro desconhecido."] });
      return;
    }
    const keepGoing = !d.done && d.errors.length === 0;
    setMigration((cur) => cur && { ...cur, next: d.next, total: d.total, errors: [...cur.errors, ...d.errors], running: keepGoing });
    if (keepGoing) migrateFetcher.submit({ intent: "migrateBundles", offset: String(d.next) }, { method: "post" });
  }, [migrateFetcher.data, migrateFetcher]);
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
  const startEdit = useCallback((b) => { setSavedOk(false); setEditing(forEditor(b)); }, []);
  const cancel = useCallback(() => { setSavedOk(false); setEditing(null); }, []);
  const setField = useCallback((field, val) => setEditing((cur) => ({ ...cur, [field]: val })), []);
  const setTarget = useCallback((field, val) =>
    setEditing((cur) => ({ ...cur, targets: { ...cur.targets, [field]: val } })), []);
  const setExclude = useCallback((field, val) =>
    setEditing((cur) => ({ ...cur, targets: { ...cur.targets, exclude: { ...cur.targets.exclude, [field]: val } } })), []);

  // ── Pickers ──
  // scope "include" = segmentação; "exclude" = exclusões (targets.exclude)
  const pickProducts = useCallback(async (scope = "include") => {
    const src = scope === "exclude" ? editing?.targets?.exclude : editing?.targets;
    const selectionIds = (src?.productsMeta || []).map((p) => ({ id: `gid://shopify/Product/${p.id}` }));
    const picked = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds });
    if (!picked) return;
    const fd = new FormData();
    fd.set("intent", "fetchTargetProducts");
    fd.set("scope", scope);
    fd.set("ids", JSON.stringify(picked.map((p) => p.id)));
    targetFetcher.submit(fd, { method: "post" });
  }, [shopify, targetFetcher, editing]);

  const pickCollections = useCallback(async (scope = "include") => {
    const src = scope === "exclude" ? editing?.targets?.exclude : editing?.targets;
    const selectionIds = (src?.collectionsMeta || []).map((c) => ({ id: `gid://shopify/Collection/${c.id}` }));
    const picked = await shopify.resourcePicker({ type: "collection", multiple: true, selectionIds });
    if (!picked) return;
    const next = {
      collectionIds: picked.map((c) => numericId(c.id)),
      collectionsMeta: picked.map((c) => ({ id: numericId(c.id), title: c.title, image: c.image?.originalSrc || c.image?.src || null })),
    };
    setEditing((cur) => ({
      ...cur,
      targets: scope === "exclude"
        ? { ...cur.targets, exclude: { ...cur.targets.exclude, ...next } }
        : { ...cur.targets, ...next },
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
    const next = { productIds: targetFetcher.data.products.map((p) => p.id), productsMeta: targetFetcher.data.products };
    const toExclude = targetFetcher.data.scope === "exclude";
    setEditing((cur) =>
      cur
        ? {
            ...cur,
            targets: toExclude
              ? { ...cur.targets, exclude: { ...cur.targets.exclude, ...next } }
              : { ...cur.targets, ...next },
          }
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
  const removeExcluded = useCallback((field, id) => {
    const meta = field === "productIds" ? "productsMeta" : "collectionsMeta";
    setEditing((cur) => {
      const x = cur.targets.exclude;
      return {
        ...cur,
        targets: {
          ...cur.targets,
          exclude: {
            ...x,
            [field]: (x[field] || []).filter((v) => String(v) !== String(id)),
            [meta]: (x[meta] || []).filter((m) => String(m.id) !== String(id)),
          },
        },
      };
    });
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

  // ── Opções em massa (ação "Editar opções" dos selecionados) ──
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkChoice, setBulkChoice] = useState({}); // key -> "keep" | "on" | "off"
  const openBulk = useCallback(() => { setBulkChoice({}); setBulkOpen(true); }, []);
  const bulkSelected = useMemo(() => {
    const set = new Set(selectedResources);
    return bundles.filter((b) => set.has(b.id));
  }, [selectedResources, bundles]);
  const bulkPreview = useMemo(() => {
    const patch = {};
    for (const o of BULK_OPTIONS) {
      if (bulkChoice[o.key] === "on") patch[o.key] = true;
      else if (bulkChoice[o.key] === "off") patch[o.key] = false;
    }
    const perKey = {};
    const changed = new Set();
    let showWithoutExemption = 0;
    for (const b of bulkSelected) {
      for (const k of Object.keys(patch)) {
        if (!!b[k] !== patch[k]) {
          perKey[k] = (perKey[k] || 0) + 1;
          changed.add(b.id);
        }
      }
      const after = { ...b, ...patch };
      if (after.showAddonDiscount && !after.exemption) showWithoutExemption++;
    }
    const touchesShow = "showAddonDiscount" in patch || "exemption" in patch;
    return { patch, perKey, changed: changed.size, showWithoutExemption: touchesShow ? showWithoutExemption : 0 };
  }, [bulkChoice, bulkSelected]);
  const applyBulk = useCallback(() => {
    runIntent("bulkOptions", { ids: JSON.stringify(selectedResources), patch: JSON.stringify(bulkPreview.patch) });
    setBulkOpen(false);
    clearSelection();
  }, [runIntent, selectedResources, bulkPreview, clearSelection]);

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
                        <Button onClick={() => pickProducts("include")} loading={fetchingTargets}>Selecionar produtos</Button>
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
                        <Button onClick={() => pickCollections("include")}>Selecionar collections</Button>
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

                  <Divider />
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">Excluir (não aparece em)</Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Produtos que caem em qualquer exclusão abaixo não recebem este bundle, mesmo estando na segmentação acima. Vale na página do produto e no checkout. Use para separar produtos que vão ter um bundle próprio.
                      </Text>
                    </BlockStack>

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" tone="subdued" variant="bodySm">{b.targets.exclude.productIds.length} produto(s) excluído(s)</Text>
                      <Button onClick={() => pickProducts("exclude")} loading={fetchingTargets}>Selecionar produtos a excluir</Button>
                    </InlineStack>
                    {(b.targets.exclude.productsMeta || []).length > 0 && (
                      <BlockStack gap="200">
                        {b.targets.exclude.productsMeta.map((p) => (
                          <Box key={p.id} padding="200" borderWidth="025" borderColor="border" borderRadius="200">
                            <InlineStack gap="300" blockAlign="center">
                              {p.image && <Thumbnail source={p.image} alt={p.title} size="small" />}
                              <Box width="100%"><Text as="span" variant="bodyMd">{p.title}</Text></Box>
                              <Button variant="plain" tone="critical" onClick={() => removeExcluded("productIds", p.id)}>Remover</Button>
                            </InlineStack>
                          </Box>
                        ))}
                      </BlockStack>
                    )}

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" tone="subdued" variant="bodySm">{b.targets.exclude.collectionIds.length} collection(s) excluída(s)</Text>
                      <Button onClick={() => pickCollections("exclude")}>Selecionar collections a excluir</Button>
                    </InlineStack>
                    {(b.targets.exclude.collectionsMeta || []).length > 0 && (
                      <InlineStack gap="200" wrap>
                        {b.targets.exclude.collectionsMeta.map((c) => (
                          <Tag key={c.id} onRemove={() => removeExcluded("collectionIds", c.id)}>{c.title}</Tag>
                        ))}
                      </InlineStack>
                    )}

                    <TagListField
                      key={`${b.id}-exclude-tags`}
                      label="Tags a excluir (separadas por vírgula)"
                      tags={b.targets.exclude.tags}
                      onChange={(v) => setExclude("tags", v)}
                      placeholder="ex: halloween"
                      helpText="Na página do produto, a collection excluída precisa estar publicada na Loja Online (igual à segmentação)."
                    />
                  </BlockStack>
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
                  {b.exemption && (
                    <Checkbox
                      label="Mostrar desconto do add-on no carrinho"
                      checked={!!b.showAddonDiscount}
                      onChange={(v) => setField("showAddonDiscount", v)}
                      helpText="Só visual, no carrinho e no minicart: o add-on aparece com o desconto e o produto vinculado aparece sem ele. No checkout continua a divisão real."
                    />
                  )}
                  <Checkbox
                    label="Limite por produto do bundle"
                    checked={!!b.limitPerTrigger}
                    onChange={(v) => setField("limitPerTrigger", v)}
                    helpText={'O "Máx. c/ desconto" de cada add-on passa a valer para cada produto do bundle no carrinho. Ex.: máx. 1 + 2 camisas = até 2 brindes. Se o cliente tirar uma camisa, o brinde continua valendo pela outra. Desligado, o máximo vale para o carrinho todo.'}
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
        <StoragePanel
          storage={storage}
          migration={migration}
          onCopy={startMigration}
          verify={verifyFetcher}
          onVerify={() => verifyFetcher.submit({ intent: "verifyBundles" }, { method: "post" })}
          onMode={(mode) => runIntent("setBundlesMode", { mode })}
          busy={isSubmitting && navigation.formData?.get("intent") === "setBundlesMode"}
          result={actionData}
        />
        <EnginePanel
          engine={engine}
          fnSync={fnSync}
          onSync={startFnSync}
          verify={verifyV3Fetcher}
          onVerify={() => verifyV3Fetcher.submit({ intent: "verifyV3" }, { method: "post" })}
          onPrepare={() => runIntent("prepareV3")}
          onEngine={(e) => runIntent("setEngine", { engine: e })}
          busy={isSubmitting && ["prepareV3", "setEngine"].includes(navigation.formData?.get("intent"))}
          result={actionData}
        />
        <VitrinePanel
          vitrine={vitrine}
          verify={verifyVitrineFetcher}
          onVerify={() => verifyVitrineFetcher.submit({ intent: "verifyVitrine" }, { method: "post" })}
          onPrepare={() => runIntent("prepareVitrine")}
          onSet={(on) => runIntent("setVitrine", { on: on ? "1" : "0" })}
          busy={isSubmitting && ["prepareVitrine", "setVitrine"].includes(navigation.formData?.get("intent"))}
          result={actionData}
        />
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
          <Banner
            tone="success"
            title={actionData.action === "bulkOptions" ? `Opções aplicadas em ${actionData.count} bundle(s)` : "Feito!"}
          />
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
                { content: "Editar opções", onAction: openBulk },
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
                            {b.limitPerTrigger && <Badge>Limite por produto</Badge>}
                            <Text as="span" tone="subdued" variant="bodySm">Prioridade {b.priority ?? 0}{b.exclusive ? " · exclusivo" : ""}</Text>
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <Tag>{TARGET_LABEL[b.targets?.type] || b.targets?.type}</Tag>
                        {excludeCount(b) > 0 && <Badge tone="attention">{`− ${excludeCount(b)} exclusão(ões)`}</Badge>}
                      </InlineStack>
                    </IndexTable.Cell>
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

      {bulkOpen && (
        <Modal
          open
          onClose={() => setBulkOpen(false)}
          title={`Editar opções de ${bulkSelected.length} bundle(s)`}
          primaryAction={{
            content: bulkPreview.changed ? `Aplicar em ${bulkPreview.changed} bundle(s)` : "Aplicar",
            onAction: applyBulk,
            disabled: bulkPreview.changed === 0,
          }}
          secondaryActions={[{ content: "Cancelar", onAction: () => setBulkOpen(false) }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {BULK_OPTIONS.map((o) => (
                <Select
                  key={o.key}
                  label={o.label}
                  options={BULK_CHOICES}
                  value={bulkChoice[o.key] || "keep"}
                  onChange={(v) => setBulkChoice((cur) => ({ ...cur, [o.key]: v }))}
                  helpText={
                    o.key in bulkPreview.patch
                      ? `${bulkPreview.perKey[o.key] || 0} de ${bulkSelected.length} bundle(s) mudam`
                      : undefined
                  }
                />
              ))}
              {bulkPreview.showWithoutExemption > 0 && (
                <Banner tone="warning">
                  <p>
                    {bulkPreview.showWithoutExemption} bundle(s) vão ficar com &quot;Mostrar desconto do add-on no carrinho&quot; sem isenção fiscal. Essa opção só tem efeito com a isenção ativa.
                  </p>
                </Banner>
              )}
              <Text as="p" tone="subdued" variant="bodySm">
                Só muda essas opções; o resto de cada bundle fica igual. Uma cópia do config atual é guardada antes de gravar.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
