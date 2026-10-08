// Dashboard de personalizados — custo CONSTANTE por acesso (independe do histórico).
//
// - Pedidos: só a página pedida, direto da Admin API (a Shopify filtra/ordena/pagina).
// - Envio ao ClickUp: metafields DO PEDIDO (filtráveis):
//     brk_perso.clickup_enviado (boolean) → abas Pendentes/Enviados
//     brk_perso.clickup         (json {taskId,url,name,sentAt}) → coluna/link da tarefa
// - Estado do Sankhya / Nº Sankhya: D1 (perso-store.server.js) — linhas da página por
//   índice, contadores mantidos por triggers, abas "Presos"/"Sem atributos" paginadas no D1.
//
// Não destrutivo: o cache antigo `personalizados:orders:*` e os mapas do KV ficam intactos;
// o metafield antigo da LOJA `brk_perso.clickup_sent` fica congelado (ver LEGACY_CLICKUP_DUAL_WRITE).
//
// IMPORTANTE: módulo sem React (importado só por rotas).

import { normalizeStr, findSellerForTags } from "./vendedores";
import {
  ORDER_FIELDS,
  PERSO_SKU,
  PERSO_SINCE,
  buildOrderData,
  getFullProductIds,
  numericId,
} from "./personalizados.server";
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, STUCK_MIN, D1_TABS } from "./personalizados-shared";

export const CU_NS = "brk_perso";
export const CU_KEY = "clickup"; // json por pedido
export const CU_FLAG = "clickup_enviado"; // boolean por pedido (filtrável)
export const LEGACY_SENT_KEY = "clickup_sent"; // json da loja (formato antigo)
export const MIGRATION_KEY = "migracao_dashboard"; // json da loja: estado da sincronização única

// Gravação dupla no mapa antigo da LOJA (`clickup_sent`) a cada envio ao ClickUp.
// DESLIGADA: o mapa fica congelado e intacto (cresce com o histórico → custo crescente).
// Para voltar à versão anterior: ligar (true) e/ou usar a ação de manutenção
// "Exportar para o formato antigo", que regera o mapa a partir dos metafields de pedido.
export const LEGACY_CLICKUP_DUAL_WRITE = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
function nextDay(ymd) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
// Início do dia no fuso da loja (Brasília). Data "pura" na busca da Shopify não é confiável
// (`created_at:<2026-10-08` trazia pedidos do próprio dia 08) — sempre com hora + fuso.
const SHOP_TZ_OFFSET = "-03:00";
const dayStart = (ymd) => `'${ymd}T00:00:00${SHOP_TZ_OFFSET}'`;
// Remove caracteres que quebram a sintaxe de busca da Shopify.
const safeTerm = (s) => String(s ?? "").replace(/["'\\()]/g, " ").replace(/\s+/g, " ").trim();

// ── Montagem da busca (sintaxe de search da Shopify) ──

// Universo da dashboard: pedidos com a linha de personalização (SKU PE1198) desde que o
// sistema entrou (equivale ao filtro antigo `rawPersoCount > 0`).
export function basePersoQuery() {
  return `sku:${PERSO_SKU} AND created_at:>=${dayStart(PERSO_SINCE)}`;
}

// Busca de texto → cláusulas OR suportadas pela Shopify: nº do pedido, id, Nº Sankhya
// (`nunotaIds`: ids resolvidos no D1), vendedor (→ tags), SKU e texto livre.
export function searchClause(q, { sellers = [], nunotaIds = [] } = {}) {
  const t = safeTerm(q);
  if (!t) return null;
  const clauses = [];
  const digits = t.replace(/^#/, "");
  if (/^\d+$/.test(digits)) {
    clauses.push(`name:#${digits}`);
    if (digits.length >= 10) clauses.push(`id:${digits}`);
    for (const id of nunotaIds || []) clauses.push(`id:${String(id).replace(/\D/g, "")}`);
  } else {
    const n = normalizeStr(t);
    for (const s of sellers || []) {
      const hit = normalizeStr(s.name).includes(n) || (s.tags || []).some((tag) => normalizeStr(tag).includes(n));
      if (!hit) continue;
      for (const tag of s.tags || []) {
        const st = safeTerm(tag);
        if (st) clauses.push(`tag:'${st}'`);
      }
    }
    if (!/\s/.test(t)) clauses.push(`sku:${t}`);
  }
  clauses.push(`"${t}"`);
  return `(${[...new Set(clauses)].join(" OR ")})`;
}

// Cláusula de período (created_at, fuso da loja). `ate` inclui o dia inteiro.
export function dateClause(de, ate) {
  const parts = [];
  if (isDate(de) && de > PERSO_SINCE) parts.push(`created_at:>=${dayStart(de)}`);
  if (isDate(ate)) parts.push(`created_at:<${dayStart(nextDay(ate))}`);
  return parts.length ? parts.join(" AND ") : null;
}

export function tabClause(tab) {
  if (tab === "pendentes") return `-metafields.${CU_NS}.${CU_FLAG}:true`;
  if (tab === "enviados") return `metafields.${CU_NS}.${CU_FLAG}:true`;
  return null;
}


export function buildPageQuery({ tab, q, de, ate, sellers, nunotaIds }) {
  return [basePersoQuery(), tabClause(tab), dateClause(de, ate), searchClause(q, { sellers, nunotaIds })]
    .filter(Boolean)
    .join(" AND ");
}

// ── Leitura de uma página ──

const SHOP_AND_COUNTS = `
  shop {
    primaryDomain { url }
    migracao: metafield(namespace: "${CU_NS}", key: "${MIGRATION_KEY}") { value }
  }
  base: ordersCount(query: $base, limit: null) { count }
  pendentes: ordersCount(query: $pend, limit: null) { count }`;

const PAGE_QUERY = `query PersoPage($q: String!, $base: String!, $pend: String!, $first: Int, $last: Int, $after: String, $before: String) {
  ${SHOP_AND_COUNTS}
  total: ordersCount(query: $q, limit: null) { count }
  orders(first: $first, last: $last, after: $after, before: $before, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node { ${ORDER_FIELDS} clickup: metafield(namespace: "${CU_NS}", key: "${CU_KEY}") { value } } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
  }
}`;

const IDS_QUERY = `query PersoIds($ids: [ID!]!, $base: String!, $pend: String!) {
  ${SHOP_AND_COUNTS}
  nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} clickup: metafield(namespace: "${CU_NS}", key: "${CU_KEY}") { value } } }
}`;

async function graphqlWithRetry(admin, query, variables) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await admin.graphql(query, { variables });
    const data = await res.json();
    const throttled = data.errors?.some?.((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      const cost = data.extensions?.cost;
      const restoreRate = cost?.throttleStatus?.restoreRate || 100;
      const needed = cost?.requestedQueryCost || 100;
      await sleep(Math.min(2000, Math.ceil((needed / restoreRate) * 1000)));
      continue;
    }
    if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join(", "));
    return data.data;
  }
  throw new Error("Rate limit da Shopify Admin API. Tente novamente em instantes.");
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

// Linha enxuta para o client (só o que a tabela e o modal usam).
function toRow(od, { clickup, nunota, sankhya, seller }) {
  return {
    id: od.id,
    legacyId: od.legacyId,
    name: od.name,
    createdAt: od.createdAt,
    customer: od.customer,
    expired: od.expired,
    persoCount: od.persoCount,
    hasAttributes: od.hasAttributes,
    hasFull: od.hasFull,
    variacao: od.variacao,
    note: od.note,
    personalizations: od.personalizations,
    seller: seller?.name || null,
    nunota: nunota ?? null,
    clickup: clickup ? { url: clickup.url || null, sentAt: clickup.sentAt || null } : null,
    sankhya: sankhya
      ? {
          status: sankhya.status || null,
          written: sankhya.written || null,
          reason: sankhya.reason || null,
          nunotaManual: Boolean(sankhya.nunotaManual),
        }
      : null,
  };
}

// Uma página da dashboard.
//   store: d1Store (perso-store.server.js) ou mapStore (fallback sem D1).
//   cursor: { after } | { before } | {} — opaco (Shopify) ou id do pedido (abas do D1).
export async function loadPersoPage(admin, { tab, q, de, ate, size, cursor, sellers, store, nowTs }) {
  const nowMs = nowTs ?? Date.now();
  const cutoffIso = new Date(nowMs - STUCK_MIN * 60000).toISOString();
  const pageSize = PAGE_SIZES.includes(Number(size)) ? Number(size) : DEFAULT_PAGE_SIZE;

  const digits = safeTerm(q).replace(/^#/, "");
  const [counters, stuckRaw, nunotaIds] = await Promise.all([
    store.counters(),
    store.stuck(cutoffIso),
    /^\d+$/.test(digits) && digits.length <= 9 ? store.idsByNunota(Number(digits)) : Promise.resolve([]),
  ]);

  const base = basePersoQuery();
  const common = { base, pend: `${base} AND ${tabClause("pendentes")}` };

  // Loja nova (antes da 1ª sincronização): as definições dos metafields do ClickUp ainda não
  // existem e a busca por `metafields.brk_perso.clickup_enviado` é recusada pela Shopify →
  // cria as definições e tenta de novo (uma vez).
  const run = async (query, vars) => {
    try {
      return await graphqlWithRetry(admin, query, vars);
    } catch (e) {
      if (!/no definition with namespace/i.test(String(e?.message))) throw e;
      await ensureClickupDefinitions(admin);
      return graphqlWithRetry(admin, query, vars);
    }
  };

  let data;
  let nodes;
  let pageInfo;
  let total;
  if (D1_TABS.includes(tab)) {
    const listed = await store.listIds(tab, {
      cutoffIso,
      older: cursor?.after || null,
      newer: cursor?.before || null,
      size: pageSize,
    });
    total = await store.countList(tab, { cutoffIso });
    data = await run(IDS_QUERY, {
      ...common,
      ids: listed.ids.map((id) => `gid://shopify/Order/${id}`),
    });
    nodes = (data.nodes || []).filter(Boolean);
    pageInfo = {
      hasNextPage: listed.hasNext,
      hasPreviousPage: listed.hasPrev,
      startCursor: listed.ids[0] || null,
      endCursor: listed.ids[listed.ids.length - 1] || null,
    };
  } else {
    data = await run(PAGE_QUERY, {
      ...common,
      q: buildPageQuery({ tab, q, de, ate, sellers, nunotaIds }),
      first: cursor?.before ? null : pageSize,
      last: cursor?.before ? pageSize : null,
      after: cursor?.after || null,
      before: cursor?.before || null,
    });
    nodes = data.orders.edges.map((e) => e.node);
    pageInfo = data.orders.pageInfo;
    total = data.total.count;
  }

  const shopDomain = data.shop.primaryDomain.url;
  const migracao = parseJson(data.shop.migracao?.value, null);

  const ods = nodes.map((n) => {
    const od = buildOrderData(n, shopDomain);
    od.clickup = parseJson(n.clickup?.value, null);
    return od;
  });
  const ids = ods.map((o) => o.legacyId);

  // Estado do Sankhya e Nº só das linhas da página (2 queries indexadas) + FULL (1–3 subrequests).
  const garmentIds = [...new Set(ods.flatMap((o) => o.garmentProductIds))];
  const [jobs, nunotas, fullSet] = await Promise.all([
    store.getJobs(ids),
    store.getNunotas(ids),
    garmentIds.length ? getFullProductIds(admin, garmentIds) : Promise.resolve(new Set()),
  ]);

  const rows = ods.map((od) => {
    od.hasFull = od.garmentProductIds.some((id) => fullSet.has(id));
    return toRow(od, {
      clickup: od.clickup,
      nunota: nunotas[od.legacyId],
      sankhya: jobs[od.legacyId],
      seller: findSellerForTags(od.tags, sellers),
    });
  });

  const baseCount = data.base.count;
  const c = counters;
  const inStore = c.sent + c.pending + c.error + c.seller + c.hold + c.done;

  return {
    rows,
    pageInfo,
    pageSize,
    total,
    counts: {
      base: baseCount,
      clickupPendentes: data.pendentes.count,
      sankhya: { ...c, naoEnviado: Math.max(0, baseCount - inStore) },
    },
    stuck: {
      count: stuckRaw.count,
      oldestMin: stuckRaw.oldestAt ? Math.floor((nowMs - Date.parse(stuckRaw.oldestAt)) / 60000) : 0,
    },
    // Só o que a tela usa (nunca listas que crescem).
    migracao: migracao ? { clickupAt: migracao.clickupAt || null, scanAt: migracao.scanAt || null } : null,
  };
}

// Fallback sem D1 (desenvolvimento / antes do binding): mesma interface sobre os mapas
// antigos do KV (O(N) — só usado se PERSO_DB não existir).
export function mapStore(statusMap = {}, nunotasMap = {}) {
  const entries = () => Object.entries(statusMap || {});
  return {
    kind: "map",
    async getJobs(ids) {
      const out = {};
      for (const id of ids || []) if (statusMap[id]?.status) out[id] = statusMap[id];
      return out;
    },
    async getNunotas(ids) {
      const out = {};
      for (const id of ids || []) if (nunotasMap[id] != null) out[id] = Number(nunotasMap[id]);
      return out;
    },
    async idsByNunota(n) {
      return Object.entries(nunotasMap || {}).filter(([, v]) => String(v) === String(n)).map(([k]) => k);
    },
    async counters() {
      const out = { sent: 0, pending: 0, error: 0, seller: 0, hold: 0, done: 0 };
      for (const [, e] of entries()) {
        if (e?.status === "seller" && !(e.personalizations || []).length) continue;
        if (e?.status in out) out[e.status]++;
      }
      return out;
    },
    async stuck(cutoffIso) {
      let count = 0;
      let oldestAt = null;
      for (const [, e] of entries()) {
        if (e?.status === "pending" && e.at && e.at <= cutoffIso) {
          count++;
          if (!oldestAt || e.at < oldestAt) oldestAt = e.at;
        }
      }
      return { count, oldestAt };
    },
    async listIds(kind, { cutoffIso, older, newer, size }) {
      let ids = entries()
        .filter(([, e]) =>
          kind === "presos"
            ? e?.status === "pending" && e.at && e.at <= cutoffIso
            : e?.status === "error" && !(e.personalizations || []).length
        )
        .map(([id]) => id)
        .sort((a, b) => (a < b ? 1 : -1));
      if (older) ids = ids.filter((id) => id < older);
      if (newer) ids = ids.filter((id) => id > newer).slice(-size - 1);
      return { ids: ids.slice(0, size), hasNext: ids.length > size, hasPrev: Boolean(older || newer) };
    },
    async countList(kind, { cutoffIso }) {
      return (await this.listIds(kind, { cutoffIso, size: 1e9 })).ids.length;
    },
  };
}

// ── Gravação do envio ao ClickUp (metafields do pedido) ──

// Grava os metafields de pedido de vários envios (lotes de 12 pedidos = 24 metafields;
// limite do metafieldsSet = 25 por chamada). entries: [{ orderGid, info }].
export async function setOrderClickupMetafields(admin, entries) {
  const errors = [];
  let written = 0;
  for (let i = 0; i < entries.length; i += 12) {
    const batch = entries.slice(i, i + 12);
    const metafields = batch.flatMap(({ orderGid, info }) => [
      { ownerId: orderGid, namespace: CU_NS, key: CU_FLAG, type: "boolean", value: "true" },
      {
        ownerId: orderGid,
        namespace: CU_NS,
        key: CU_KEY,
        type: "json",
        value: JSON.stringify({
          taskId: info.taskId || null,
          url: info.url || null,
          name: info.name || null,
          sentAt: info.sentAt || null,
        }),
      },
    ]);
    const res = await admin.graphql(
      `mutation set($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
      { variables: { metafields } }
    );
    const data = await res.json();
    const ue = data.data?.metafieldsSet?.userErrors || [];
    if (data.errors?.length) errors.push(data.errors.map((e) => e.message).join(", "));
    else if (ue.length) errors.push(ue.map((e) => e.message).join(", "));
    else written += batch.length;
  }
  return { written, errors };
}

// ── Sincronização única (migração não destrutiva) ──
//
// 1) Envios antigos ao ClickUp: lê o mapa da LOJA `clickup_sent` (intocado) e grava os
//    metafields de pedido. Idempotente e retomável (fatias por `offset`).
// 2) Varredura dos pedidos com PE1198 (fatias retomáveis por cursor da Shopify): marca no
//    D1 os "sem atributos" e registra os pedidos de vendedor (jeito antigo) que o mapa do
//    KV misturava com pedidos sem personalização.
export const SYNC_CHUNK = 240; // pedidos por fatia (20 chamadas de metafieldsSet)
export const SCAN_PAGES_PER_CHUNK = 5; // 5 × 100 pedidos por fatia da varredura

export async function loadLegacySent(admin) {
  const data = await graphqlWithRetry(
    admin,
    `query { shop { id legacy: metafield(namespace: "${CU_NS}", key: "${LEGACY_SENT_KEY}") { value } migracao: metafield(namespace: "${CU_NS}", key: "${MIGRATION_KEY}") { value } } }`,
    {}
  );
  return {
    shopId: data.shop.id,
    sent: parseJson(data.shop.legacy?.value, {}) || {},
    migracao: parseJson(data.shop.migracao?.value, {}) || {},
  };
}

async function loadMigration(admin) {
  const data = await graphqlWithRetry(
    admin,
    `query { shop { id migracao: metafield(namespace: "${CU_NS}", key: "${MIGRATION_KEY}") { value } } }`,
    {}
  );
  return { shopId: data.shop.id, migracao: parseJson(data.shop.migracao?.value, {}) || {} };
}

export async function saveMigration(admin, shopId, value) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: CU_NS, key: MIGRATION_KEY, type: "json", value: JSON.stringify(value) }] } }
  );
  const data = await res.json();
  return data.data?.metafieldsSet?.userErrors || [];
}

// Definições dos metafields de pedido do ClickUp (idempotente: só cria as que faltam).
// `clickup_enviado` precisa do filtro habilitado (adminFilterable) para as abas
// Pendentes/Enviados funcionarem pela busca da Shopify.
export async function ensureClickupDefinitions(admin) {
  const data = await graphqlWithRetry(
    admin,
    `query { metafieldDefinitions(ownerType: ORDER, namespace: "${CU_NS}", first: 10) { nodes { key } } }`,
    {}
  );
  const have = new Set((data.metafieldDefinitions?.nodes || []).map((n) => n.key));
  const wanted = [
    {
      key: CU_FLAG,
      name: "ClickUp enviado (BRK Personalizados)",
      description: "Marca do app BRK Apps: pedido personalizado já enviado ao ClickUp. Usada para filtrar Pendentes/Enviados.",
      type: "boolean",
      capabilities: { adminFilterable: { enabled: true } },
    },
    {
      key: CU_KEY,
      name: "ClickUp (BRK Personalizados)",
      description: "Dados do envio ao ClickUp feitos pelo app BRK Apps: taskId, url, name, sentAt.",
      type: "json",
    },
  ].filter((d) => !have.has(d.key));
  const errors = [];
  for (const d of wanted) {
    const res = await admin.graphql(
      `mutation create($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { code message } }
      }`,
      { variables: { definition: { ownerType: "ORDER", namespace: CU_NS, ...d } } }
    );
    const ue = (await res.json()).data?.metafieldDefinitionCreate?.userErrors || [];
    // "TAKEN" = já existe (corrida) → ok
    for (const e of ue) if (e.code !== "TAKEN") errors.push(`${d.key}: ${e.message}`);
  }
  return { created: wanted.map((d) => d.key), errors };
}

// Fatia da migração dos envios. dryRun=true só conta (não grava nada).
export async function syncClickupChunk(admin, { offset = 0, dryRun = false } = {}) {
  const { shopId, sent, migracao } = await loadLegacySent(admin);
  const entries = Object.entries(sent)
    .filter(([gid, info]) => gid.startsWith("gid://shopify/Order/") && info)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = entries.length;
  const slice = entries.slice(offset, offset + SYNC_CHUNK);
  if (dryRun) return { dryRun: true, total, offset, next: null, written: 0, errors: [] };

  const { written, errors } = await setOrderClickupMetafields(
    admin,
    slice.map(([orderGid, info]) => ({ orderGid, info }))
  );
  const next = offset + slice.length < total ? offset + slice.length : null;
  if (next == null && errors.length === 0) {
    await saveMigration(admin, shopId, { ...migracao, clickupAt: new Date().toISOString(), clickupCount: total });
  }
  return { dryRun: false, total, offset, next, written, errors };
}

// Fatia da varredura dos pedidos com PE1198 (até SCAN_PAGES_PER_CHUNK páginas de 100).
// Para cada pedido: sem atributos → has_attrs=0 no D1; vendedor (jeito antigo) sem registro
// → registra "seller" (o que o webhook faria). Retorna o cursor da próxima fatia.
export async function syncScanChunk(admin, store, sellers, { after = null } = {}) {
  let cursor = after;
  let pages = 0;
  let scanned = 0;
  let noAttrs = 0;
  let sellersAdded = 0;
  do {
    const data = await graphqlWithRetry(
      admin,
      `query ($q: String!, $after: String) {
        orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
          edges { node { id name legacyResourceId createdAt tags lineItems(first: 50) { edges { node { sku title customAttributes { key value } } } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: basePersoQuery(), after: cursor }
    );
    const ods = data.orders.edges.map((e) => buildOrderData({ ...e.node, note: "", customer: null }, ""));
    scanned += ods.length;
    const without = ods.filter((o) => !o.hasAttributes);
    if (without.length) {
      const existing = await store.getJobs(without.map((o) => o.legacyId));
      const sellerRows = {};
      for (const o of without) {
        const seller = findSellerForTags(o.tags, sellers);
        if (seller && !existing[o.legacyId]) {
          sellerRows[o.legacyId] = { name: o.name, orderCreatedAt: o.createdAt, status: "seller", retry: false, seller: seller.name, personalizations: [], hasAttrs: false };
        }
      }
      if (Object.keys(sellerRows).length) {
        await store.saveJobs(sellerRows);
        sellersAdded += Object.keys(sellerRows).length;
      }
      await store.markNoAttrs(without.map((o) => o.legacyId));
      noAttrs += without.length;
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < SCAN_PAGES_PER_CHUNK);
  return { scanned, noAttrs, sellersAdded, next: cursor };
}

export async function markScanDone(admin) {
  const { shopId, migracao } = await loadMigration(admin);
  await saveMigration(admin, shopId, { ...migracao, scanAt: new Date().toISOString() });
}

// ── Rollback do ClickUp: regera o mapa antigo da LOJA a partir dos metafields de pedido ──
// (botão de manutenção; mescla — nunca remove entradas do mapa antigo).
export async function exportClickupLegacy(admin) {
  const { shopId, sent } = await loadLegacySent(admin);
  let after = null;
  let pages = 0;
  let merged = 0;
  do {
    const data = await graphqlWithRetry(
      admin,
      `query ($q: String!, $after: String) {
        orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
          edges { node { id clickup: metafield(namespace: "${CU_NS}", key: "${CU_KEY}") { value } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: `metafields.${CU_NS}.${CU_FLAG}:true`, after }
    );
    for (const e of data.orders.edges) {
      const info = parseJson(e.node.clickup?.value, null);
      if (info && !sent[e.node.id]) {
        sent[e.node.id] = info;
        merged++;
      }
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    pages++;
  } while (after && pages < 40);
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`,
    { variables: { metafields: [{ ownerId: shopId, namespace: CU_NS, key: LEGACY_SENT_KEY, type: "json", value: JSON.stringify(sent) }] } }
  );
  const ue = (await res.json()).data?.metafieldsSet?.userErrors || [];
  return { merged, total: Object.keys(sent).length, complete: !after, errors: ue.map((e) => e.message) };
}

export { numericId };
