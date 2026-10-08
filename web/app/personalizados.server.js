// Núcleo (sem React) da automação de personalizados → Sankhya.
//
// Compartilhado por 3 pontos de entrada:
//   1. Webhook orders/create (app/routes/webhooks.jsx)  — ingestão de cada pedido novo.
//   2. Cron scheduled (worker.js)                        — dreno: reprocessa pendentes.
//   3. Dashboard (app/routes/app.personalizados.jsx)     — display + botão reprocessar/backfill.
//
// Estado em KV (mapa por legacyId da Shopify):  personalizados:sankhya:<shop>
//   { name, status, retry, reason, nunota, written, personalizations, at }
//   status: "pending" | "sent" | "error" | "seller" | "hold" | "done"
//   - "sent"    terminal, nunca reescrito pelo automático (idempotente)
//   - "pending" aguardando NUNOTA ou erro transitório → cron reprocessa (retry=true)
//   - "error"   permanente (produto não casa) → só reprocesso manual (retry=false)
//   - "seller"  pedido de vendedor → não enviado por ora (retry=false)
//   - "hold"    "em análise" (manual) → fora do alerta/cron (retry=false)
//   - "done"    concluído/encerrado manualmente → fora do alerta/cron (retry=false).
//               NÃO significa "gravado no Sankhya" — é só "resolvido, não me cobre mais".
//
// IMPORTANTE: manter este módulo livre de React/Polaris — o worker.js o importa direto.

import { findSellerForTags } from "./vendedores";
import { fetchCabByNunota, fetchNunotasByShopifyIds, sendPersonalizationsToSankhya } from "./sankhya.server";
import { getD1Store } from "./perso-store.server";

// ── Pipeline no D1 (custo constante) ──
// Com o binding PERSO_DB (e a cópia KV → D1 feita), o estado de cada pedido vive numa
// linha do D1 e cada operação toca só os pedidos envolvidos. Sem PERSO_DB, as funções
// abaixo seguem pelo caminho antigo (mapas do KV), intacto.
export const QUEUE_LIMIT = 15; // pedidos por ciclo do envio automático (≤ ~31 subrequests)
export const GIVE_UP_DAYS = 7; // após isso sem conseguir gravar, para de tentar sozinho
const DAY_MS_PIPE = 86400000;
const STALLED_PREFIX = `Parado: há mais de ${GIVE_UP_DAYS} dias sem conseguir gravar — envio automático encerrado (use "Vincular Nº", "Enviar Sankhya" ou "Concluir").`;

// Espera crescente entre tentativas: 15 min, 30, 60, ... até 24 h.
function backoffNextISO(attempts, nowMs) {
  const mins = Math.min(15 * 2 ** Math.max(0, attempts - 1), 24 * 60);
  return new Date(nowMs + mins * 60000).toISOString();
}

export const ORDER_TAG = "Nome Personalizado";
export const PERSO_SKU = "PE1198";
// Data em que o sistema de personalização entrou. A dashboard NÃO considera
// pedidos anteriores a isso (evita puxar todo o histórico ao filtrar por SKU).
export const PERSO_SINCE = "2026-06-26";

// Sankhya: filtro por empresa (CODEMP) DESLIGADO — o id da Shopify já é único
// globalmente, então o match por AD_PEDECOMMERCE basta. (as 3 lojas são CODEMP 2.)
export const SANKHYA_EMPRESA = null;

// Paginação server-side: buscamos TODOS os pedidos com a tag (não só os 50 mais
// recentes). Sem isso, pedidos antigos somem da dashboard conforme entram novos.
const ORDERS_PAGE_SIZE = 50; // pedidos por request ao Shopify
export const MAX_ORDERS = 2000; // trava de segurança (CPU / subrequests do Worker)

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Helpers de pedido (puros) ──

export function numericId(gid) {
  return gid ? String(gid).split("/").pop() : "";
}

// Classifica uma peça (camisa). Precedência: Feminina > Infantil > Masculina.
function classifyGarment(sku, title) {
  const s = (sku || "").toUpperCase();
  const t = (title || "").toLowerCase();
  if (s.includes("BL") || t.includes("fem")) return "Feminina";
  if (s.includes("I") && t.startsWith("camis")) return "Infantil";
  return "Masculina";
}

// Atributos de line item no formato GraphQL (customAttributes: [{key,value}]).
function attrsToObj(customAttributes) {
  const o = {};
  for (const a of customAttributes || []) o[a.key] = a.value;
  return o;
}

// Atributos de line item no formato REST/webhook (properties: [{name,value}]).
function restPropsToObj(properties) {
  const o = {};
  for (const p of properties || []) o[p.name] = p.value;
  return o;
}

// Um PE1198 só conta como personalização "nossa" se tiver os atributos que o modal
// cria. Vendedores externos podem adicionar o PE1198 sem esses atributos.
function hasAttrs(o) {
  return Boolean((o["Nome"] || "").trim() && (o["Local"] || "").trim() && (o["Posição"] || "").trim());
}

// Uma linha é a personalização (PE1198) se o SKU for PE1198 OU se for uma linha
// custom com título "PE1198" (vendedor adiciona sem SKU, via draft order).
function isPersoLine(sku, title) {
  return sku === PERSO_SKU || String(title || "").trim().toUpperCase() === PERSO_SKU;
}

// O pedido (formato REST/webhook) tem alguma linha de personalização (PE1198)?
export function orderHasPersoLine(order) {
  return (order?.line_items || []).some((li) => isPersoLine(li.sku, li.title));
}

// Só os campos gravados no Sankhya (mantém o job em KV enxuto).
function slimPerso(p) {
  return { sku: p.sku || "", tipo: p.tipo || "", nome: p.nome || "", local: p.local || "", posicao: p.posicao || "" };
}

// A partir dos line items (GraphQL) de uma order, monta o que a dashboard precisa.
export function buildOrderData(order, shopDomain) {
  const lineItems = (order.lineItems?.edges || []).map((e) => e.node);

  // mapa SKU -> { url, title } das peças (não-PE1198)
  const skuMap = {};
  for (const li of lineItems) {
    if (!li.sku || isPersoLine(li.sku, li.title)) continue;
    const url =
      li.product?.onlineStoreUrl ||
      (li.product?.handle ? `${shopDomain}/products/${li.product.handle}` : "");
    skuMap[li.sku] = { url, title: li.title || "", productId: li.product?.id || null };
  }

  const persosAll = lineItems.filter((li) => isPersoLine(li.sku, li.title));
  const persos = persosAll.filter((li) => hasAttrs(attrsToObj(li.customAttributes)));
  const blocks = [];
  const variacoes = new Set();
  const garmentProductIds = new Set();
  const personalizations = [];
  for (const p of persos) {
    const props = attrsToObj(p.customAttributes);
    const garmentSku = props["Produto"] || "";
    const ref = skuMap[garmentSku] || {};
    blocks.push(
      [
        `${garmentSku} ${ref.url || ""}`.trim(),
        `Nome: ${props["Nome"] || ""}`,
        `Local: ${props["Local"] || ""}`,
        `Posição: ${props["Posição"] || ""}`,
        `Arte Referência: ${props["Arte"] || ""}`,
      ].join("\n")
    );
    if (garmentSku) variacoes.add(classifyGarment(garmentSku, ref.title));
    if (ref.productId) garmentProductIds.add(ref.productId);
    personalizations.push({
      sku: garmentSku,
      title: ref.title || "",
      url: ref.url || "",
      tipo: props["Tipo"] || "",
      nome: props["Nome"] || "",
      local: props["Local"] || "",
      posicao: props["Posição"] || "",
      arte: props["Arte"] || "",
    });
  }

  // Fallback para pedidos com PE1198 sem os atributos do modal (inclusão por vendedor).
  let description = blocks.join("\n\n");
  if (persos.length === 0 && persosAll.length > 0) {
    const itens = Object.entries(skuMap).map(([sku, ref]) => {
      if (ref.title) variacoes.add(classifyGarment(sku, ref.title));
      if (ref.productId) garmentProductIds.add(ref.productId);
      return `${sku} ${ref.title || ""} ${ref.url || ""}`.trim();
    });
    description = [
      `PE1198 sem atributos do modal (quantidade: ${persosAll.length}) — provável inclusão manual por vendedor externo.`,
      `Verificar personalização diretamente no pedido.`,
      itens.length ? `Itens do pedido:\n${itens.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }
  const variacaoList = ["Masculina", "Feminina", "Infantil"].filter((v) => variacoes.has(v));

  return {
    id: order.id,
    legacyId: order.legacyResourceId || numericId(order.id),
    name: order.name,
    createdAt: order.createdAt,
    note: order.note || "",
    tags: order.tags || [],
    // Status financeiro Shopify. "EXPIRED" = pagamento (Pix/boleto) expirou sem
    // ser pago — pode gravar no Sankhya, mas NÃO deve virar tarefa no ClickUp.
    financialStatus: order.displayFinancialStatus || null,
    expired: order.displayFinancialStatus === "EXPIRED",
    customer: order.customer?.displayName || "",
    persoCount: persos.length,
    rawPersoCount: persosAll.length,
    hasAttributes: persos.length > 0,
    garmentProductIds: [...garmentProductIds],
    personalizations,
    description,
    variacao: variacaoList,
  };
}

// Extrai as personalizações de um pedido no formato REST (payload do webhook
// orders/create). Espelha buildOrderData mas em line_items[].properties.
export function buildPersoFromRestOrder(order, sellers) {
  const lineItems = order.line_items || [];
  const tags =
    typeof order.tags === "string"
      ? order.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : order.tags || [];
  const seller = findSellerForTags(tags, sellers);

  const persoLines = lineItems.filter((li) => isPersoLine(li.sku, li.title));
  const personalizations = [];
  for (const p of persoLines) {
    const props = restPropsToObj(p.properties);
    if (!hasAttrs(props)) continue;
    personalizations.push({
      sku: props["Produto"] || "",
      tipo: props["Tipo"] || "",
      nome: props["Nome"] || "",
      local: props["Local"] || "",
      posicao: props["Posição"] || "",
    });
  }

  return {
    legacyId: String(order.id),
    name: order.name || `#${order.order_number ?? ""}`,
    createdAt: order.created_at || null,
    seller: seller?.name || null,
    rawPerso: persoLines.length,
    personalizations,
  };
}

const ORDER_FIELDS = `
  id
  name
  legacyResourceId
  createdAt
  note
  tags
  displayFinancialStatus
  customer { displayName }
  lineItems(first: 100) {
    edges {
      node {
        sku
        title
        quantity
        customAttributes { key value }
        product { id handle onlineStoreUrl }
      }
    }
  }
`;
export { ORDER_FIELDS };

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Produtos (por id) que têm QUALQUER variante com 'FULL' no SKU = envio imediato.
export async function getFullProductIds(admin, productIds) {
  const set = new Set();
  for (const ids of chunkArr(productIds, 15)) {
    const res = await admin.graphql(
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id variants(first: 50) { nodes { sku } } }
        }
      }`,
      { variables: { ids } }
    );
    const data = await res.json();
    for (const n of data.data.nodes || []) {
      if (!n) continue;
      const hasFull = (n.variants?.nodes || []).some((v) => (v.sku || "").toUpperCase().includes("FULL"));
      if (hasFull) set.add(n.id);
    }
  }
  return set;
}

// Uma página de pedidos, com retry em caso de rate limit (THROTTLED) da Admin API.
async function fetchOrdersPage(admin, q, cursor) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await admin.graphql(
      `query ($q: String!, $cursor: String) {
        orders(first: ${ORDERS_PAGE_SIZE}, query: $q, sortKey: CREATED_AT, reverse: true, after: $cursor) {
          edges { node { ${ORDER_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { q, cursor } }
    );
    const data = await res.json();

    const throttled = data.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      const cost = data.extensions?.cost;
      const restoreRate = cost?.throttleStatus?.restoreRate || 100;
      const needed = cost?.requestedQueryCost || 100;
      await sleep(Math.min(2000, Math.ceil((needed / restoreRate) * 1000)));
      continue;
    }
    if (data.errors?.length) {
      throw new Error(data.errors.map((e) => e.message).join(", "));
    }
    return data.data.orders;
  }
  throw new Error("Rate limit da Shopify Admin API ao paginar pedidos. Tente novamente.");
}

// Query de busca: PE1198 por SKU + tag "Nome Personalizado" + tags dos vendedores.
// `since`/`until` (YYYY-MM-DD) delimitam a JANELA por created_at. A dashboard atualiza
// por janela pequena (não re-pagina o histórico inteiro, que estourava o limite de
// subrequests do Worker). Piso sempre em PERSO_SINCE.
export function buildPersoQuery(sellers, { since = PERSO_SINCE, until = null } = {}) {
  const clauses = [`sku:${PERSO_SKU}`, `tag:'${ORDER_TAG}'`];
  const seen = new Set();
  for (const s of sellers || []) {
    for (const t of s.tags || []) {
      const safe = String(t).trim().replace(/['"\\]/g, "");
      const key = safe.toLowerCase();
      if (safe && !seen.has(key)) { seen.add(key); clauses.push(`tag:'${safe}'`); }
    }
  }
  const start = since && String(since) > PERSO_SINCE ? since : PERSO_SINCE;
  let q = `(${clauses.join(" OR ")}) AND created_at:>=${start}`;
  if (until) q += ` AND created_at:<=${until}`;
  return q;
}

// Mescla pedidos recém-buscados (janela) na lista em cache, casando por legacyId: os
// que vieram na janela SOBRESCREVEM os antigos (dados atualizados vencem) e os que não
// vieram permanecem. Ordena por data de criação desc (dashboard espera novos no topo).
// Assim a atualização custa só a janela recente, mas a lista mantém todo o histórico.
export function mergePersoOrders(prevOrders, freshOrders) {
  const byId = new Map();
  for (const o of prevOrders || []) byId.set(o.legacyId || o.id, o);
  for (const o of freshOrders || []) byId.set(o.legacyId || o.id, o);
  return [...byId.values()].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

export async function buildOrdersPayload(admin, q) {
  const domRes = await admin.graphql(`query { shop { primaryDomain { url } } }`);
  const shopDomain = (await domRes.json()).data.shop.primaryDomain.url;

  const nodes = [];
  let cursor = null;
  let hasNext = true;
  let truncated = false;
  while (hasNext) {
    const conn = await fetchOrdersPage(admin, q, cursor);
    for (const e of conn.edges) nodes.push(e.node);
    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
    if (nodes.length >= MAX_ORDERS) {
      truncated = hasNext;
      break;
    }
  }

  const orders = nodes
    .map((n) => buildOrderData(n, shopDomain))
    .filter((o) => o.rawPersoCount > 0);

  const allGarmentIds = [...new Set(orders.flatMap((o) => o.garmentProductIds))];
  const fullSet = allGarmentIds.length ? await getFullProductIds(admin, allGarmentIds) : new Set();
  for (const o of orders) o.hasFull = o.garmentProductIds.some((id) => fullSet.has(id));

  return { orders, truncated };
}

// ── Estado durável em KV ──

// Nº Sankhya (NUNOTA) por pedido — mapa { legacyId: nunota }.
const nunotasKey = (shop) => `personalizados:nunotas:${shop}`;
export async function loadNunotas(kv, shop) {
  if (!kv) return {};
  try { return (await kv.get(nunotasKey(shop), "json")) || {}; } catch { return {}; }
}
export async function saveNunotas(kv, shop, map) {
  if (!kv) return;
  // PUT é o recurso escasso do KV (1.000/dia por conta); só grava se o conteúdo mudou.
  const serialized = JSON.stringify(map);
  const current = await kv.get(nunotasKey(shop));
  if (current !== serialized) await kv.put(nunotasKey(shop), serialized);
}

// Status do envio ao Sankhya — mapa { legacyId: {status, retry, ...} }.
const sankhyaStatusKey = (shop) => `personalizados:sankhya:${shop}`;
export async function loadSankhyaStatus(kv, shop) {
  if (!kv) return {};
  try { return (await kv.get(sankhyaStatusKey(shop), "json")) || {}; } catch { return {}; }
}

export async function saveSankhyaStatus(kv, shop, map) {
  if (!kv) return;
  // PUT é o recurso escasso do KV (1.000/dia por conta); só grava se o conteúdo mudou.
  const serialized = JSON.stringify(map);
  const current = await kv.get(sankhyaStatusKey(shop));
  if (current !== serialized) await kv.put(sankhyaStatusKey(shop), serialized);
}

// Escrita por MERGE: relê o mapa mais recente e aplica só as chaves alteradas. Reduz
// a janela de lost-update entre webhook e cron (ambos fazem read-modify-write da mesma
// chave KV) — sem isso, um poderia sobrescrever a adição do outro e uma perso sumiria.
async function updateSankhyaStatus(kv, shop, updates) {
  if (!kv) return updates;
  const latest = await loadSankhyaStatus(kv, shop);
  Object.assign(latest, updates);
  await saveSankhyaStatus(kv, shop, latest);
  return latest;
}

// ── Motor de processamento ──

// Erro de "produto não encontrado" é permanente (só resolve corrigindo o cadastro),
// então NÃO deve ser re-tentado pelo cron. Os demais (API/rede) são transitórios.
function isPermanentError(msg) {
  return /n[ãa]o encontrados/i.test(String(msg || ""));
}

// Razão padrão de um job aguardando a NUNOTA sincronizar no Sankhya. Constante (não muda
// entre ciclos) para o mapa de status ficar byte-idêntico quando nada progride — assim
// saveSankhyaStatus pula o PUT e o cron não gasta write à toa.
const PENDING_NUNOTA_REASON = "Aguardando sincronização no Sankhya (sem Nº Sankhya).";

// Razão de um pedido concluído/encerrado manualmente. Vira status "done" (retry:false).
// NÃO significa gravado no Sankhya — é só "resolvido, fora da fila". Reversível via reprocesso.
const DONE_REASON = "Concluído manualmente (marcado como resolvido).";

// Processa jobs (grava no Sankhya) e atualiza o status em KV.
//   legacyIds = lista específica; null = todos com retry===true (uso do cron).
// Retorna { processed, sent, pending, errors }.
export async function processPersoJobs(env, kv, shop, legacyIds = null) {
  const store = await getD1Store(env, kv, shop);
  if (store) return processPersoJobsD1(env, kv, store, legacyIds);
  return processPersoJobsKV(env, kv, shop, legacyIds);
}

// Versão D1: lê só os jobs pedidos (ou a fila vencida, LIMIT QUEUE_LIMIT) e grava só eles.
async function processPersoJobsD1(env, kv, store, legacyIds = null) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const jobs = legacyIds ? await store.getJobs(legacyIds) : await store.getQueue(nowIso, QUEUE_LIMIT);
  const targetIds = (legacyIds ? legacyIds.map(String) : Object.keys(jobs)).filter((id) => jobs[id]);
  if (targetIds.length === 0) return { processed: 0, sent: 0, pending: 0, errors: [], full: false };

  // Nº Sankhya: o que já temos + busca em lote só dos que faltam (limitado aos alvos).
  const nunotas = await store.getNunotas(targetIds);
  const needNunota = targetIds.filter((id) => nunotas[id] == null);
  if (needNunota.length) {
    try {
      const fetched = await fetchNunotasByShopifyIds(env, kv, needNunota, { empresa: SANKHYA_EMPRESA });
      const found = {};
      for (const [id, nu] of Object.entries(fetched)) if (nu != null) found[id] = nu;
      if (Object.keys(found).length) {
        await store.saveNunotas(found);
        Object.assign(nunotas, found);
      }
    } catch (e) {
      console.error("[perso sankhya nunota]", e?.message || e);
    }
  }

  // Pendente: mantém o `at` (início da pendência) enquanto continua pendente — base do
  // prazo de GIVE_UP_DAYS. Passado o prazo, sai da fila (retry=false) e fica em "Presos".
  const updates = {};
  const pendingUpdate = (job, reason, attempts) => {
    const since = job.status === "pending" && job.at ? job.at : nowIso;
    const expired = nowMs - Date.parse(since) >= GIVE_UP_DAYS * DAY_MS_PIPE;
    return expired
      ? { ...job, status: "pending", retry: false, reason: `${STALLED_PREFIX} Último motivo: ${reason}`, attempts, nextTryAt: null, at: since }
      : { ...job, status: "pending", retry: true, reason, attempts, nextTryAt: backoffNextISO(attempts, nowMs), at: since };
  };

  const toSend = [];
  for (const id of targetIds) {
    const job = jobs[id];
    const nunota = nunotas[id] ?? null;
    if (nunota == null) {
      updates[id] = pendingUpdate(job, PENDING_NUNOTA_REASON, (job.attempts || 0) + 1);
      continue;
    }
    toSend.push({ legacyId: id, name: job.name, nunota, personalizations: job.personalizations || [] });
  }

  let sent = 0;
  const errors = [];
  if (toSend.length) {
    const results = await sendPersonalizationsToSankhya(env, kv, toSend);
    for (const r of results) {
      const job = jobs[r.legacyId] || {};
      if (r.ok) {
        updates[r.legacyId] = { ...job, status: "sent", retry: false, reason: null, nunota: r.nunota, written: r.written, attempts: 0, nextTryAt: null, at: nowIso };
        sent++;
      } else if (isPermanentError(r.error)) {
        updates[r.legacyId] = { ...job, status: "error", retry: false, reason: r.error || "erro", nunota: r.nunota ?? job.nunota ?? null, nextTryAt: null, at: nowIso };
        errors.push(`${job.name || r.legacyId}: ${r.error}`);
      } else {
        updates[r.legacyId] = { ...pendingUpdate(job, r.error || "erro", (job.attempts || 0) + 1), nunota: r.nunota ?? job.nunota ?? null };
        errors.push(`${job.name || r.legacyId}: ${r.error}`);
      }
    }
  }

  await store.saveJobs(updates);
  const pending = targetIds.filter((id) => updates[id]?.status === "pending").length;
  return { processed: targetIds.length, sent, pending, errors, full: !legacyIds && targetIds.length >= QUEUE_LIMIT };
}

// Versão KV (caminho anterior, inalterado) — usada sem PERSO_DB ou antes da cópia KV → D1.
async function processPersoJobsKV(env, kv, shop, legacyIds = null) {
  const status = await loadSankhyaStatus(kv, shop);
  const nunotas = await loadNunotas(kv, shop);

  const targetIds = legacyIds
    ? legacyIds.filter((id) => status[id])
    : Object.keys(status).filter((id) => status[id]?.retry === true);
  if (targetIds.length === 0) return { processed: 0, sent: 0, pending: 0, errors: [] };

  // Resolve NUNOTA em lote para os que ainda não têm.
  const needNunota = targetIds.filter((id) => nunotas[id] == null);
  if (needNunota.length) {
    try {
      const fetched = await fetchNunotasByShopifyIds(env, kv, needNunota, { empresa: SANKHYA_EMPRESA });
      let changed = false;
      for (const [id, nu] of Object.entries(fetched)) {
        if (nu != null) { nunotas[id] = nu; changed = true; }
      }
      if (changed) await saveNunotas(kv, shop, nunotas);
    } catch (e) {
      // Falha de lookup: não aborta — os sem NUNOTA caem em "pending" abaixo.
      console.error("[perso sankhya nunota]", e?.message || e);
    }
  }

  const toSend = [];
  for (const id of targetIds) {
    const job = status[id] || {};
    const nunota = nunotas[id] ?? null;
    if (nunota == null) {
      // Preserva o `at` se o job já estava neste MESMO estado pendente — mantém o mapa
      // byte-idêntico entre ciclos do cron (senão gera 1 PUT/ciclo à toa no KV).
      const unchanged =
        job.status === "pending" && job.retry === true && job.reason === PENDING_NUNOTA_REASON;
      status[id] = {
        ...job,
        status: "pending",
        retry: true,
        reason: PENDING_NUNOTA_REASON,
        at: unchanged ? job.at : nowISO(),
      };
      continue;
    }
    toSend.push({ legacyId: id, name: job.name, nunota, personalizations: job.personalizations || [] });
  }

  let sent = 0;
  const errors = [];
  if (toSend.length) {
    const results = await sendPersonalizationsToSankhya(env, kv, toSend);
    for (const r of results) {
      const job = status[r.legacyId] || {};
      if (r.ok) {
        status[r.legacyId] = { ...job, status: "sent", retry: false, reason: null, nunota: r.nunota, written: r.written, at: nowISO() };
        sent++;
      } else {
        const permanent = isPermanentError(r.error);
        const nextStatus = permanent ? "error" : "pending";
        const nextReason = r.error || "erro";
        const nextNunota = r.nunota ?? job.nunota ?? null;
        // Preserva o `at` se o estado (status/retry/reason/nunota) não mudou — evita PUT à
        // toa quando o mesmo erro transitório se repete ciclo após ciclo.
        const unchanged =
          job.status === nextStatus &&
          job.retry === !permanent &&
          job.reason === nextReason &&
          (job.nunota ?? null) === nextNunota;
        status[r.legacyId] = {
          ...job,
          status: nextStatus,
          retry: !permanent,
          reason: nextReason,
          nunota: nextNunota,
          at: unchanged ? job.at : nowISO(),
        };
        errors.push(`${job.name || r.legacyId}: ${r.error}`);
      }
    }
  }

  // Grava por merge só as chaves que processamos (não sobrescreve adições concorrentes).
  const updates = {};
  for (const id of targetIds) updates[id] = status[id];
  await updateSankhyaStatus(kv, shop, updates);

  const pending = targetIds.filter((id) => status[id]?.status === "pending").length;
  return { processed: targetIds.length, sent, pending, errors };
}

// Ingestão de UM pedido novo (webhook orders/create): grava o job e tenta gravar na
// hora (best-effort; normalmente cai em "pending" por falta de NUNOTA → cron reprocessa).
export async function ingestPersoOrder(env, kv, shop, perso) {
  if (!perso || !perso.legacyId) return;
  // Sem PE1198 e sem vendedor: nada a gravar (os ramos abaixo só agem com um dos dois).
  // Sai ANTES de ler/parsear o mapa de status — a maioria dos pedidos cai aqui e o
  // parse do mapa inteiro custava CPU do Worker em todo webhook orders/create.
  if (!perso.rawPerso && !perso.seller) return;
  const store = await getD1Store(env, kv, shop);
  if (store) return ingestPersoOrderD1(env, kv, store, perso);
  const id = perso.legacyId;
  const status = await loadSankhyaStatus(kv, shop);

  // Já gravado: idempotente, não mexe (não sobrescreve edição manual posterior no Sankhya).
  if (status[id]?.status === "sent") return;

  // Vendedor no jeito ANTIGO (personalização na nota, sem atributos estruturados):
  // mantém "seller" (manual). COM atributos (block/site): flui normal, guardando o
  // nome do vendedor apenas para exibição/atribuição.
  if (perso.seller && !perso.personalizations?.length) {
    await updateSankhyaStatus(kv, shop, { [id]: { name: perso.name, status: "seller", retry: false, seller: perso.seller, personalizations: [], at: nowISO() } });
    return;
  }
  if (!perso.rawPerso) return; // sem PE1198 — não é pedido de personalização
  if (!perso.personalizations?.length) {
    await updateSankhyaStatus(kv, shop, { [id]: { name: perso.name, status: "error", retry: false, reason: "PE1198 sem atributos do modal.", personalizations: [], at: nowISO() } });
    return;
  }

  await updateSankhyaStatus(kv, shop, { [id]: { name: perso.name, status: "pending", retry: true, reason: PENDING_NUNOTA_REASON, seller: perso.seller || null, personalizations: perso.personalizations.map(slimPerso), at: nowISO() } });

  try {
    await processPersoJobs(env, kv, shop, [id]);
  } catch (e) {
    console.error("[perso ingest process]", e?.message || e);
  }
}

// Versão D1 da ingestão: lê/grava só a linha deste pedido.
async function ingestPersoOrderD1(env, kv, store, perso) {
  const id = String(perso.legacyId);
  const cur = (await store.getJobs([id]))[id];
  if (cur?.status === "sent") return; // idempotente (reentrega do webhook)
  const base = { name: perso.name, orderCreatedAt: perso.createdAt || null, at: nowISO() };

  // Sem PE1198 = fora do universo da dashboard (pedido de vendedor sem personalização):
  // no D1 não registramos (no KV antigo esses ~95% dos "seller" inflavam o mapa à toa).
  if (!perso.rawPerso) return;
  if (perso.seller && !perso.personalizations?.length) {
    await store.saveJobs({ [id]: { ...base, status: "seller", retry: false, seller: perso.seller, personalizations: [], hasAttrs: false } });
    return;
  }
  if (!perso.personalizations?.length) {
    await store.saveJobs({ [id]: { ...base, status: "error", retry: false, reason: "PE1198 sem atributos do modal.", personalizations: [], hasAttrs: false } });
    return;
  }
  await store.saveJobs({
    [id]: {
      ...base,
      status: "pending",
      retry: true,
      reason: PENDING_NUNOTA_REASON,
      seller: perso.seller || null,
      personalizations: perso.personalizations.map(slimPerso),
      attempts: 0,
      nextTryAt: base.at,
      hasAttrs: true,
    },
  });
  try {
    await processPersoJobsD1(env, kv, store, [id]);
  } catch (e) {
    console.error("[perso ingest process]", e?.message || e);
  }
}

// Dreno do cron: reprocessa os jobs pendentes/transitórios (retry===true). Quando NÃO
// há nada pendente, processPersoJobs retorna sem NENHUMA escrita no KV (só 2 leituras,
// que são praticamente ilimitadas) — ou seja, o cron só "gasta" quando existe pedido
// real a enviar. A saúde é medida pela idade dos pendentes (não por heartbeat).
export async function drainSankhyaQueue(env, kv, shop) {
  // D1: só a fila vencida (índice + LIMIT). Ocioso = 1 query que volta vazia.
  // `full` = lote cheio → o alarme roda de novo em 1 min (vazão em picos).
  const store = await getD1Store(env, kv, shop);
  if (store) return processPersoJobsD1(env, kv, store, null);

  // ANTES de qualquer escrita: só há trabalho se existir job com retry===true. A leitura
  // do status é barata (KV read ~ilimitado no free tier); o PUT é o recurso escasso. Sem
  // essa guarda, cada ciclo do cron forçava um token novo no KV mesmo ocioso — o que
  // estourava o limite diário de PUTs sem existir nenhum pedido a enviar.
  const status = await loadSankhyaStatus(kv, shop);
  const hasPending = Object.values(status).some((j) => j?.retry === true);
  if (!hasPending) return { processed: 0, sent: 0, pending: 0, errors: [] };

  // Há pedido para subir: o token é resolvido sob demanda (cache em memória em
  // sankhya.server.js; withAuth reautentica se expirar). Não gravamos mais token no KV.
  return processPersoJobs(env, kv, shop, null);
}

// Reprocesso/backfill manual a partir de order-data (buildOrderData) dos pedidos
// selecionados na dashboard. Faz upsert dos jobs (pula vendedores) e processa já.
// Retorna { processed, sent, pending, errors, sellers, noAttr }.
export async function reprocessOrders(env, kv, shop, orderDatas, sellers) {
  const store = await getD1Store(env, kv, shop);
  if (store) return reprocessOrdersD1(env, kv, store, orderDatas, sellers);
  const status = await loadSankhyaStatus(kv, shop);
  const updates = {};
  const targets = [];
  let sellerCount = 0;
  let noAttr = 0;
  for (const od of orderDatas || []) {
    if (!od.legacyId) continue;
    const seller = findSellerForTags(od.tags, sellers);
    // Vendedor SEM atributos estruturados (nota) → "seller" manual. COM atributos
    // (block/site) → flui normal, guardando o nome do vendedor.
    if (seller && !od.personalizations?.length) {
      updates[od.legacyId] = { name: od.name, status: "seller", retry: false, seller: seller.name, personalizations: [], at: nowISO() };
      sellerCount++;
      continue;
    }
    if (!od.personalizations?.length) {
      updates[od.legacyId] = { name: od.name, status: "error", retry: false, reason: "PE1198 sem atributos do modal.", personalizations: [], at: nowISO() };
      noAttr++;
      continue;
    }
    // Força reprocesso: limpa estado terminal e marca para processar agora.
    updates[od.legacyId] = { ...(status[od.legacyId] || {}), name: od.name, status: "pending", retry: true, reason: null, seller: seller?.name || null, personalizations: od.personalizations.map(slimPerso), at: nowISO() };
    targets.push(od.legacyId);
  }
  await updateSankhyaStatus(kv, shop, updates);
  const res = await processPersoJobs(env, kv, shop, targets);
  return { ...res, sellers: sellerCount, noAttr };
}

// Versão D1 do reprocesso manual (só os pedidos selecionados).
async function reprocessOrdersD1(env, kv, store, orderDatas, sellers) {
  const ids = (orderDatas || []).map((od) => od.legacyId).filter(Boolean);
  const existing = await store.getJobs(ids);
  const now = nowISO();
  const updates = {};
  const targets = [];
  let sellerCount = 0;
  let noAttr = 0;
  for (const od of orderDatas || []) {
    if (!od.legacyId) continue;
    const id = String(od.legacyId);
    const seller = findSellerForTags(od.tags, sellers);
    const base = { name: od.name, orderCreatedAt: od.createdAt || null, at: now };
    if (seller && !od.personalizations?.length) {
      updates[id] = { ...base, status: "seller", retry: false, seller: seller.name, personalizations: [], hasAttrs: false };
      sellerCount++;
      continue;
    }
    if (!od.personalizations?.length) {
      updates[id] = { ...base, status: "error", retry: false, reason: "PE1198 sem atributos do modal.", personalizations: [], hasAttrs: false };
      noAttr++;
      continue;
    }
    // Força reprocesso: reinicia a pendência (prazo de GIVE_UP_DAYS conta de novo).
    updates[id] = {
      ...(existing[id] || {}),
      ...base,
      status: "pending",
      retry: true,
      reason: null,
      seller: seller?.name || null,
      personalizations: od.personalizations.map(slimPerso),
      attempts: 0,
      nextTryAt: now,
      hasAttrs: true,
    };
    targets.push(id);
  }
  await store.saveJobs(updates);
  const res = await processPersoJobsD1(env, kv, store, targets);
  return { ...res, sellers: sellerCount, noAttr };
}

// Marca pedidos como CONCLUÍDOS/encerrados manualmente: status "done" (retry:false), tirando-os
// do alerta de pendências e do reenvio automático. NÃO marca como "sent"/gravado no Sankhya nem
// toca no ClickUp — é só "resolvido, não me cobre mais". Reversível via reprocessOrders. { done }.
export async function completeOrders(kv, shop, legacyIds = [], env = null) {
  const store = env ? await getD1Store(env, kv, shop) : null;
  if (store) {
    const jobs = await store.getJobs(legacyIds);
    const now = nowISO();
    const updates = {};
    for (const id of legacyIds) {
      updates[id] = { ...(jobs[id] || {}), status: "done", retry: false, manual: true, reason: DONE_REASON, nextTryAt: null, at: now };
    }
    if (legacyIds.length) await store.saveJobs(updates);
    return { done: legacyIds.length };
  }
  const status = await loadSankhyaStatus(kv, shop);
  const updates = {};
  let done = 0;
  for (const id of legacyIds) {
    const job = status[id] || {};
    updates[id] = { ...job, status: "done", retry: false, manual: true, reason: DONE_REASON, at: nowISO() };
    done++;
  }
  if (done) await updateSankhyaStatus(kv, shop, updates);
  return { done };
}

// Vínculo MANUAL do Nº Sankhya (NUNOTA) a um pedido — para pedidos lançados no Sankhya sem o
// AD_PEDECOMMERCE (o lookup automático nunca os acha e o job fica "pending" para sempre).
// Confere o NUNOTA no Sankhya antes de gravar no mapa durável; NÃO grava a personalização
// (o chamador reprocessa em seguida). Retorna { ok, error } ou { ok, cab }.
export async function setManualNunota(env, kv, shop, legacyId, nunota) {
  const id = String(legacyId || "").trim();
  const n = Number(String(nunota ?? "").trim());
  if (!id) return { ok: false, error: "Pedido inválido." };
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Nº Sankhya inválido (use só números)." };

  const cab = await fetchCabByNunota(env, kv, n);
  if (!cab) return { ok: false, error: `Nº Sankhya ${n} não encontrado no Sankhya.` };
  if (cab.pedEcommerce && cab.pedEcommerce !== id) {
    return { ok: false, error: `Nº Sankhya ${n} já está vinculado a outro pedido da Shopify (id ${cab.pedEcommerce}).` };
  }

  // D1: checagem de duplicidade pelo índice de Nº Sankhya (não carrega o histórico).
  const store = await getD1Store(env, kv, shop);
  if (store) {
    const owner = await store.findNunotaOwner(n, id);
    if (owner) {
      return { ok: false, error: `Nº Sankhya ${n} já está vinculado a outro pedido na dashboard (id ${owner}).` };
    }
    await store.saveNunotas({ [id]: n });
    await store.markNunotaManual(id);
    return { ok: true, cab };
  }

  const nunotas = await loadNunotas(kv, shop);
  const other = Object.entries(nunotas).find(([k, v]) => k !== id && String(v) === String(n));
  if (other) {
    return { ok: false, error: `Nº Sankhya ${n} já está vinculado a outro pedido na dashboard (id ${other[0]}).` };
  }

  nunotas[id] = n;
  await saveNunotas(kv, shop, nunotas);

  // Marca no job (se existir) que o Nº veio manual — só para exibição.
  const status = await loadSankhyaStatus(kv, shop);
  if (status[id] && !status[id].nunotaManual) {
    await updateSankhyaStatus(kv, shop, { [id]: { ...status[id], nunotaManual: true } });
  }
  return { ok: true, cab };
}
