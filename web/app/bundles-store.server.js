// Armazenamento dos BRK Bundles (fonte da verdade do admin e do webhook).
//
// Antes: o shop metafield `brk_bundles.config`, um JSON único com todos os bundles
// (a Shopify só aceita gravar JSON de até 128 KB na Admin API 2026-04+).
// Depois: 1 metaobject `$app:brk_bundle` por bundle (definição no shopify.app.toml).
//
// O tema e o checkout NÃO leem nada daqui: continuam em `brk_bundles.live` e no
// metafield da discount, gerados pela rota a partir da lista de bundles.
//
// Modo (shop metafield `brk_bundles.storage`):
//   ausente        → lê e grava só o `config` antigo (como sempre foi);
//   "dual"         → lê o `config` antigo e grava os dois (período de teste);
//   "metaobjects"  → lê os metaobjects e grava os dois, o `config` antigo enquanto
//                    couber (assim voltar atrás continua possível).
//
// Sem imports: as funções puras são testadas em scripts/bundles-store.test.mjs.

export const NS = "brk_bundles";
export const KEY_CONFIG = "config";
export const KEY_STORAGE = "storage";
export const MO_TYPE = "$app:brk_bundle";
export const LEGACY_MAX_BYTES = 120 * 1024; // folga sob o limite de 131.072 bytes
export const MODES = ["legacy", "dual", "metaobjects"];

// Motor do checkout (shop metafield `brk_bundles.engine`), independente do modo acima:
//   ausente → config da discount v2 (todas as regras nela, como sempre foi);
//   "dual"  → continua v2, mas já grava as regras dos bundles por produto no
//             metafield `brk_bundles.fn` de cada produto-gatilho;
//   "v3"    → config da discount v3: só bundles amplos + chaves ativas; os por
//             produto a Function lê do `fn` dos produtos do carrinho.
export const KEY_ENGINE = "engine";
export const KEY_PRODUCT_FN = "fn";
export const ENGINES = ["v2", "dual", "v3"];
const PRODUCT_BATCH = 25; // metafieldsSet: até 25 por chamada

// Vitrine v2 (shop metafield `brk_bundles.live_index`, lido pelo tema):
//   { on, mo, b: [{ h, o, t }] } — só os bundles AMPLOS ativos (collection/tag/metafield).
//   `on` liga o caminho novo no bloco do produto e no carrinho; `mo` = tipo completo do
//   metaobject (app--<id>--brk_bundle), p/ o tema (fora do app) buscar por handle.
//   Os bundles por produto o tema acha no `fn` do próprio produto; os detalhes de
//   exibição vêm do campo `storefront` do registro de cada bundle.
export const KEY_LIVE_INDEX = "live_index";

const UPSERT_BATCH = 10;
const DELETE_BATCH = 25;

export function bundleHandle(id) {
  return String(id || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// `storefront` (opcional): o objeto que o tema lê (mesmo formato de um item do `live`).
export function bundleToFields(b, position, storefront) {
  const fields = [
    { key: "bundle_id", value: String(b.id) },
    { key: "name", value: String(b.name || b.id).replace(/[\r\n]+/g, " ").slice(0, 255) },
    { key: "position", value: String(Number.isFinite(position) ? position : 0) },
    { key: "data", value: JSON.stringify(b) },
  ];
  if (storefront) fields.push({ key: "storefront", value: JSON.stringify(storefront) });
  return fields;
}

// Nó do metaobject → { bundle, position, metaobjectId, json }.
export function nodeToBundle(node) {
  const f = {};
  for (const x of node.fields || []) f[x.key] = x.value;
  let bundle = null;
  try {
    bundle = f.data ? JSON.parse(f.data) : null;
  } catch {
    bundle = null;
  }
  return { bundle, position: Number(f.position) || 0, metaobjectId: node.id, json: f.data || "", sf: f.storefront || "" };
}

export function bytes(v) {
  return new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

function modeOf(value) {
  return value === "dual" || value === "metaobjects" ? value : "legacy";
}

// shop id + modo + (opcional) o `config` antigo + se `live` existe, numa query.
export async function loadShopState(admin, { withConfig = true } = {}) {
  const res = await admin.graphql(
    `query {
      shop {
        id
        storage: metafield(namespace: "${NS}", key: "${KEY_STORAGE}") { value }
        engine: metafield(namespace: "${NS}", key: "${KEY_ENGINE}") { value }
        ${withConfig ? `config: metafield(namespace: "${NS}", key: "${KEY_CONFIG}") { value }` : ""}
        live: metafield(namespace: "${NS}", key: "live") { id }
        vix: metafield(namespace: "${NS}", key: "${KEY_LIVE_INDEX}") { value }
      }
    }`
  );
  const shop = (await res.json()).data.shop;
  let legacy = [];
  const raw = shop.config?.value;
  if (raw) {
    try {
      legacy = JSON.parse(raw);
    } catch {
      legacy = [];
    }
  }
  const engine = shop.engine?.value === "dual" || shop.engine?.value === "v3" ? shop.engine.value : "v2";
  let vitrine = "off";
  let vitrineMo = null;
  if (shop.vix?.value) {
    try {
      const vix = JSON.parse(shop.vix.value);
      vitrine = vix.on ? "on" : "prepared";
      vitrineMo = vix.mo || null;
    } catch {
      vitrine = "off";
    }
  }
  return { shopId: shop.id, mode: modeOf(shop.storage?.value), engine, vitrine, vitrineMo, legacy, legacyBytes: raw ? bytes(raw) : 0, hasLive: Boolean(shop.live) };
}

// Todos os bundles dos metaobjects, na ordem de `position`.
export async function listMetaobjectBundles(admin) {
  const rows = [];
  let after = null;
  do {
    const res = await admin.graphql(
      `query($after: String) {
        metaobjects(type: "${MO_TYPE}", first: 250, after: $after) {
          nodes { id handle fields { key value } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { after } }
    );
    const conn = (await res.json()).data.metaobjects;
    for (const n of conn.nodes) {
      const r = nodeToBundle(n);
      if (r.bundle && r.bundle.id) rows.push(r);
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  rows.sort((a, b) => a.position - b.position);
  return {
    bundles: rows.map((r) => r.bundle),
    ids: new Map(rows.map((r) => [r.bundle.id, r.metaobjectId])),
    positions: new Map(rows.map((r) => [r.bundle.id, r.position])),
    snap: new Map(rows.map((r) => [r.bundle.id, r.json])),
    snapSf: new Map(rows.map((r) => [r.bundle.id, r.sf])),
  };
}

// Bundles da fonte ativa + contexto p/ gravar só o que mudou.
export async function loadBundles(admin) {
  const st = await loadShopState(admin, { withConfig: true });
  if (st.mode === "legacy") return { ...st, bundles: st.legacy, mo: null };
  const mo = await listMetaobjectBundles(admin);
  return { ...st, bundles: st.mode === "metaobjects" ? mo.bundles : st.legacy, mo };
}

// ── Gravação ────────────────────────────────────────────────────────────────

// Diferença entre a lista nova e o que está nos metaobjects: upserts (novos ou
// alterados, posição estável) e ids de metaobject a apagar.
// `sfOf` (opcional): bundle -> objeto `storefront`; regrava também quando ele mudou
// (ou o registro ainda não tem).
export function planMetaobjectWrites(next, mo, sfOf) {
  const positions = mo ? mo.positions : new Map();
  const snap = mo ? mo.snap : new Map();
  const ids = mo ? mo.ids : new Map();
  let maxPos = Math.max(-1, ...positions.values());
  const upserts = [];
  const keep = new Set();
  for (const b of next) {
    keep.add(b.id);
    let position = positions.get(b.id);
    if (position === undefined) position = ++maxPos;
    const storefront = sfOf ? sfOf(b) : null;
    const sfChanged = sfOf && (mo ? mo.snapSf : new Map()).get(b.id) !== JSON.stringify(storefront);
    if (snap.get(b.id) !== JSON.stringify(b) || sfChanged) upserts.push({ bundle: b, position, storefront });
  }
  const deletes = [...ids.entries()].filter(([id]) => !keep.has(id)).map(([, moId]) => moId);
  return { upserts, deletes };
}

export async function upsertMetaobjectBundles(admin, items) {
  const errors = [];
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const slice = items.slice(i, i + UPSERT_BATCH);
    const vars = {};
    const decl = [];
    const body = [];
    slice.forEach(({ bundle, position, storefront }, k) => {
      decl.push(`$h${k}: MetaobjectHandleInput!`, `$m${k}: MetaobjectUpsertInput!`);
      body.push(`u${k}: metaobjectUpsert(handle: $h${k}, metaobject: $m${k}) { metaobject { id } userErrors { field message } }`);
      vars[`h${k}`] = { type: MO_TYPE, handle: bundleHandle(bundle.id) };
      vars[`m${k}`] = { fields: bundleToFields(bundle, position, storefront) };
    });
    const res = await admin.graphql(`mutation up(${decl.join(", ")}) { ${body.join("\n")} }`, { variables: vars });
    const data = await res.json();
    if (data.errors?.length) errors.push(...data.errors.map((e) => e.message));
    slice.forEach(({ bundle }, k) => {
      for (const e of data.data?.[`u${k}`]?.userErrors || []) errors.push(`${bundle.name || bundle.id}: ${e.message}`);
    });
  }
  return errors;
}

export async function deleteMetaobjects(admin, metaobjectIds) {
  const errors = [];
  const ids = metaobjectIds.filter(Boolean);
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const slice = ids.slice(i, i + DELETE_BATCH);
    const vars = {};
    const decl = [];
    const body = [];
    slice.forEach((id, k) => {
      decl.push(`$i${k}: ID!`);
      body.push(`d${k}: metaobjectDelete(id: $i${k}) { deletedId userErrors { field message } }`);
      vars[`i${k}`] = id;
    });
    const res = await admin.graphql(`mutation del(${decl.join(", ")}) { ${body.join("\n")} }`, { variables: vars });
    const data = await res.json();
    if (data.errors?.length) errors.push(...data.errors.map((e) => e.message));
    slice.forEach((_, k) => {
      for (const e of data.data?.[`d${k}`]?.userErrors || []) errors.push(e.message);
    });
  }
  return errors;
}

export async function writeMetaobjectBundles(admin, next, mo, sfOf) {
  const plan = planMetaobjectWrites(next, mo, sfOf);
  const errors = await upsertMetaobjectBundles(admin, plan.upserts);
  if (errors.length) return errors;
  return deleteMetaobjects(admin, plan.deletes);
}

export async function setMode(admin, shopId, mode) {
  if (mode === "legacy") {
    const res = await admin.graphql(
      `mutation del($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { userErrors { field message } }
      }`,
      { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_STORAGE }] } }
    );
    return (await res.json()).data.metafieldsDelete.userErrors.map((e) => e.message);
  }
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_STORAGE, type: "single_line_text_field", value: mode }] } }
  );
  return (await res.json()).data.metafieldsSet.userErrors.map((e) => e.message);
}

// Mesmos bundles, na mesma ordem, campo a campo (verificação da migração).
export function compareBundles(legacy, mo) {
  const byId = new Map(mo.map((b) => [b.id, b]));
  const missing = [];
  const different = [];
  for (const b of legacy) {
    const m = byId.get(b.id);
    if (!m) missing.push(b.name || b.id);
    else if (JSON.stringify(m) !== JSON.stringify(b)) different.push(b.name || b.id);
  }
  const legacyIds = new Set(legacy.map((b) => b.id));
  const extra = mo.filter((b) => !legacyIds.has(b.id)).map((b) => b.name || b.id);
  const sameOrder = legacy.length === mo.length && legacy.every((b, i) => mo[i].id === b.id);
  return { missing, different, extra, sameOrder };
}

// ── Motor v3: regras dos bundles por produto no próprio produto ─────────────

export function isProductBundle(b) {
  return (b?.targets?.type || "products") === "products";
}

// Dá a cada bundle por produto uma chave inteira fixa (`fnKey`), nunca reaproveitada.
// Retorna os ids que ganharam chave (precisam ser regravados).
export function assignFnKeys(bundles) {
  let max = 0;
  for (const b of bundles) if (Number.isInteger(b.fnKey) && b.fnKey > max) max = b.fnKey;
  const assigned = [];
  for (const b of bundles) {
    if (isProductBundle(b) && !Number.isInteger(b.fnKey)) {
      b.fnKey = ++max;
      assigned.push(b.id);
    }
  }
  return assigned;
}

// O que mudar nos produtos para sair de `prev` (pid -> json) e chegar em `next`.
export function planProductFnWrites(prev, next) {
  const sets = [];
  const deletes = [];
  for (const [pid, value] of next) {
    const v = JSON.stringify(value);
    if (JSON.stringify(prev.get(pid)) !== v) sets.push({ pid, value: v });
  }
  for (const pid of prev.keys()) if (!next.has(pid)) deletes.push(pid);
  return { sets, deletes };
}

const productGid = (pid) => `gid://shopify/Product/${pid}`;

// Grava/apaga o metafield `fn` dos produtos. Retorna mensagens de erro.
export async function writeProductFn(admin, sets, deletes) {
  const errors = [];
  for (let i = 0; i < sets.length; i += PRODUCT_BATCH) {
    const metafields = sets.slice(i, i + PRODUCT_BATCH).map(({ pid, value }) => ({
      ownerId: productGid(pid), namespace: NS, key: KEY_PRODUCT_FN, type: "json", value,
    }));
    const res = await admin.graphql(
      `mutation set($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`,
      { variables: { metafields } }
    );
    const data = await res.json();
    if (data.errors?.length) errors.push(...data.errors.map((e) => e.message));
    errors.push(...(data.data?.metafieldsSet?.userErrors || []).map((e) => e.message));
  }
  for (let i = 0; i < deletes.length; i += 250) {
    const metafields = deletes.slice(i, i + 250).map((pid) => ({ ownerId: productGid(pid), namespace: NS, key: KEY_PRODUCT_FN }));
    const res = await admin.graphql(
      `mutation del($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { userErrors { field message } } }`,
      { variables: { metafields } }
    );
    const data = await res.json();
    if (data.errors?.length) errors.push(...data.errors.map((e) => e.message));
    errors.push(...(data.data?.metafieldsDelete?.userErrors || []).map((e) => e.message));
  }
  return errors;
}

// Lê o `fn` atual de uma lista de produtos (verificação). pid -> json | null.
export async function readProductFn(admin, pids) {
  const out = new Map();
  for (let i = 0; i < pids.length; i += 250) {
    const ids = pids.slice(i, i + 250).map(productGid);
    const res = await admin.graphql(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id fn: metafield(namespace: "${NS}", key: "${KEY_PRODUCT_FN}") { jsonValue } } } }`,
      { variables: { ids } }
    );
    const data = await res.json();
    for (const n of data.data?.nodes || []) {
      if (n && n.id) out.set(n.id.split("/").pop(), n.fn ? n.fn.jsonValue : null);
    }
  }
  return out;
}

// Uma página de produtos com `fn` (varredura de órfãos). Retorna { found: Map, next }.
export async function scanProductFnPage(admin, cursor) {
  const res = await admin.graphql(
    `query($after: String) {
      products(first: 250, after: $after) {
        nodes { id fn: metafield(namespace: "${NS}", key: "${KEY_PRODUCT_FN}") { jsonValue } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { variables: { after: cursor || null } }
  );
  const conn = (await res.json()).data.products;
  const found = new Map();
  for (const n of conn.nodes) if (n.fn) found.set(n.id.split("/").pop(), n.fn.jsonValue);
  return { found, scanned: conn.nodes.length, next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
}

export async function setEngine(admin, shopId, engine) {
  if (engine === "v2") {
    const res = await admin.graphql(
      `mutation del($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { userErrors { field message } } }`,
      { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_ENGINE }] } }
    );
    return (await res.json()).data.metafieldsDelete.userErrors.map((e) => e.message);
  }
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_ENGINE, type: "single_line_text_field", value: engine }] } }
  );
  return (await res.json()).data.metafieldsSet.userErrors.map((e) => e.message);
}

// Tipo completo do metaobject (app--<id>--brk_bundle): o tema (fora do app) não
// entende o prefixo `$app:`.
export async function metaobjectFullType(admin) {
  const res = await admin.graphql(`query { metaobjectDefinitionByType(type: "${MO_TYPE}") { type } }`);
  const data = await res.json();
  return data.data?.metaobjectDefinitionByType?.type || null;
}

// Chave de ordem da vitrine: prioridade (maior primeiro) e, empatando, o bundle mais
// novo primeiro — o mesmo resultado do `sort: 'priority' | reverse` do `live`, cuja
// ordem é a de criação (timestamp no id). Texto de largura fixa: o Liquid ordena como texto.
export function orderKey(b) {
  const prio = Math.max(-49999, Math.min(49999, Math.trunc(Number(b.priority) || 0)));
  const ts = Number((String(b.id).match(/^bdl_(\d+)_/) || [])[1]) || Date.parse(b.createdAt || "") || 0;
  return String(prio + 50000).padStart(5, "0") + String(ts).padStart(13, "0");
}
