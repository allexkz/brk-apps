// Armazenamento dos Grupos de Produtos.
//
// Fonte nova: 1 metaobject `$app:brk_group` por grupo (definição declarada no
// shopify.app.toml). Fonte antiga: o shop metafield `brk_groups.index`, um JSON
// único com todos os grupos — a Shopify não aceita mais gravá-lo (> 128 KB na
// Admin API 2026-04+), mas continua lendo. Ele nunca é gravado nem apagado aqui:
// fica como backup legível.
//
// Qual fonte vale é o shop metafield `brk_groups.storage`: "metaobjects" = nova;
// ausente = antiga. Só é ligado depois de migrar e verificar (ver a rota).
//
// Sem imports: as funções puras são testadas direto em scripts/grupos-store.test.mjs.

export const NS = "brk_groups";
export const KEY_INDEX = "index"; // legado (somente leitura)
export const KEY_STORAGE = "storage";
export const STORAGE_METAOBJECTS = "metaobjects";
export const MO_TYPE = "$app:brk_group";

const UPSERT_BATCH = 10; // aliases por mutation
const DELETE_BATCH = 25;

// Handle do metaobject a partir do id do grupo (g_123_abc -> g-123-abc).
export function groupHandle(id) {
  return String(id || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function groupToFields(g, position) {
  return [
    { key: "group_id", value: String(g.id) },
    { key: "name", value: String(g.name || g.id) },
    { key: "option_name", value: String(g.optionName || "") },
    { key: "status", value: String(g.status || "active") },
    { key: "swatch_source", value: String(g.swatchSource || "first") },
    { key: "position", value: String(Number.isFinite(position) ? position : 0) },
    { key: "products", value: JSON.stringify(g.products || []) },
  ];
}

// Nó do metaobject ({ id, fields:[{key,value}] }) -> grupo no formato do admin.
export function fieldsToGroup(node) {
  const f = {};
  for (const x of node.fields || []) f[x.key] = x.value;
  let products = [];
  try {
    products = f.products ? JSON.parse(f.products) : [];
  } catch {
    products = [];
  }
  return {
    group: {
      id: f.group_id || node.handle,
      name: f.name || f.group_id || node.handle,
      optionName: f.option_name || "",
      status: f.status || "active",
      swatchSource: f.swatch_source || "first",
      products,
    },
    position: Number(f.position) || 0,
    metaobjectId: node.id,
  };
}

// Mesmo grupo, campo a campo (verificação da migração).
export function sameGroup(a, b) {
  const norm = (g) => JSON.stringify({
    id: g.id, name: g.name || g.id, optionName: g.optionName || "", status: g.status || "active",
    swatchSource: g.swatchSource || "first", products: g.products || [],
  });
  return norm(a) === norm(b);
}

// ── Leitura ─────────────────────────────────────────────────────────────────

// Lê shop id, a chave de fonte e (se pedido) o índice legado numa query só.
export async function loadShopState(admin, { withIndex = false } = {}) {
  const res = await admin.graphql(
    `query {
      shop {
        id
        storage: metafield(namespace: "${NS}", key: "${KEY_STORAGE}") { value }
        ${withIndex ? `index: metafield(namespace: "${NS}", key: "${KEY_INDEX}") { value }` : ""}
      }
    }`
  );
  const shop = (await res.json()).data.shop;
  let legacy = [];
  if (withIndex) {
    try {
      legacy = shop.index?.value ? JSON.parse(shop.index.value) : [];
    } catch {
      legacy = [];
    }
  }
  return { shopId: shop.id, source: shop.storage?.value === STORAGE_METAOBJECTS ? "metaobjects" : "index", legacy };
}

// Todos os grupos dos metaobjects, na ordem de `position`. `ids`: group_id -> id do metaobject.
export async function listMetaobjectGroups(admin) {
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
    for (const n of conn.nodes) rows.push(fieldsToGroup(n));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  rows.sort((a, b) => a.position - b.position);
  const ids = new Map(rows.map((r) => [r.group.id, r.metaobjectId]));
  const positions = new Map(rows.map((r) => [r.group.id, r.position]));
  return { groups: rows.map((r) => r.group), ids, positions };
}

// Grupos da fonte ativa, no formato do admin. `ctx` é reaproveitado nas gravações.
// Com a fonte nova ligada, o índice legado (430 KB) nem é baixado.
export async function loadGroups(admin) {
  const state = await loadShopState(admin);
  if (state.source === "metaobjects") {
    const mo = await listMetaobjectGroups(admin);
    return { ...state, groups: mo.groups, ctx: { ids: mo.ids, positions: mo.positions } };
  }
  const withIndex = await loadShopState(admin, { withIndex: true });
  return { ...withIndex, groups: withIndex.legacy, ctx: null };
}

// ── Gravação ────────────────────────────────────────────────────────────────

// Upsert de vários grupos (idempotente pelo handle). items: [{ group, position }].
// Retorna as mensagens de erro (vazio = ok).
export async function upsertMetaobjectGroups(admin, items) {
  const errors = [];
  for (let i = 0; i < items.length; i += UPSERT_BATCH) {
    const slice = items.slice(i, i + UPSERT_BATCH);
    const vars = {};
    const decl = [];
    const body = [];
    slice.forEach(({ group, position }, k) => {
      decl.push(`$h${k}: MetaobjectHandleInput!`, `$m${k}: MetaobjectUpsertInput!`);
      body.push(`u${k}: metaobjectUpsert(handle: $h${k}, metaobject: $m${k}) { metaobject { id } userErrors { field message } }`);
      vars[`h${k}`] = { type: MO_TYPE, handle: groupHandle(group.id) };
      vars[`m${k}`] = { fields: groupToFields(group, position) };
    });
    const res = await admin.graphql(`mutation up(${decl.join(", ")}) { ${body.join("\n")} }`, { variables: vars });
    const data = await res.json();
    if (data.errors?.length) errors.push(...data.errors.map((e) => e.message));
    slice.forEach(({ group }, k) => {
      for (const e of data.data?.[`u${k}`]?.userErrors || []) errors.push(`${group.name || group.id}: ${e.message}`);
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

export async function setStorage(admin, shopId, value) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_STORAGE, type: "single_line_text_field", value }] } }
  );
  return (await res.json()).data.metafieldsSet.userErrors.map((e) => e.message);
}

export async function clearStorage(admin, shopId) {
  const res = await admin.graphql(
    `mutation del($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { userErrors { field message } }
    }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: NS, key: KEY_STORAGE }] } }
  );
  return (await res.json()).data.metafieldsDelete.userErrors.map((e) => e.message);
}
