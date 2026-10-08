// Dashboard de pedidos personalizados — paginada pela Shopify + Polaris web components.
//
// Cada acesso busca só a página pedida direto da Admin API (ver personalizados-page.server.js):
// sem o cache de ~1 MB no KV que estourava a CPU do Worker (Error 1102). Abas, busca e
// período viram parâmetros de URL (a Shopify filtra/ordena/pagina).
//
// UI: Polaris web components (<s-*>, carregados em app.jsx). Regras p/ React 18:
//   - nunca passar `false` em prop booleana (use `cond || undefined`);
//   - valores/eventos via `e.currentTarget.value|checked` (eventos nativos).

import { json } from "@remix-run/cloudflare";
import {
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getShopify } from "../shopify.server";
import { loadSellers, findSellerForTags, normalizeStr } from "../vendedores";
import { fetchNunotasByShopifyIds } from "../sankhya.server";
import {
  SANKHYA_EMPRESA,
  ORDER_FIELDS,
  numericId,
  buildOrderData,
  loadNunotas,
  saveNunotas,
  loadSankhyaStatus,
  reprocessOrders,
  completeOrders,
  setManualNunota,
} from "../personalizados.server";
import { TABS, D1_TABS, PAGE_SIZES, DEFAULT_PAGE_SIZE, STUCK_MIN, BULK_CHUNK } from "../personalizados-shared";
import {
  CU_NS,
  CU_KEY,
  LEGACY_CLICKUP_DUAL_WRITE,
  loadPersoPage,
  mapStore,
  loadLegacySent,
  setOrderClickupMetafields,
  syncClickupChunk,
  ensureClickupDefinitions,
  syncScanChunk,
  markScanDone,
  exportClickupLegacy,
} from "../personalizados-page.server";
import { getD1Store, exportToKv, reimportFromKv } from "../perso-store.server";

// Store do estado Sankhya: D1 (custo constante) ou, sem PERSO_DB, os mapas antigos do KV.
async function storeFor(env, kv, shop) {
  const d1 = await getD1Store(env, kv, shop);
  if (d1) return d1;
  const [statusMap, nunotas] = await Promise.all([loadSankhyaStatus(kv, shop), loadNunotas(kv, shop)]);
  const s = mapStore(statusMap, nunotas);
  s.saveNunotas = async (found) => saveNunotas(kv, shop, { ...nunotas, ...found });
  return s;
}

// ── ClickUp (board "FORMATAÇÃO 2026", grupo "entrada diária") ──
const CLICKUP_LIST_ID = "901306145937";
const CU_STATUS = "entrada diária";
const CU_FIELD_OS = "1f68f46f-4569-4e37-9958-aace1b9cfdf8"; // short_text
const CU_FIELD_MODALIDADE = "159c6b1f-4768-4dc6-b821-72093b760cc2"; // labels
const CU_OPT_ECOMMERCE = "53b618d5-b1f3-4eb9-b71d-0b8cbd941c1b";
const CU_FIELD_VARIACAO = "34f07de1-6e6c-43ec-8c6c-b8558e2a91e9"; // labels
const CU_OPT_VARIACAO = {
  Masculina: "90513c40-69cb-45e7-b0b7-a5c510e381c7",
  Feminina: "9d847e91-8473-4937-853c-ed766a405009",
  Infantil: "13b37142-1a07-48af-9199-ec7e51806045",
};
// Fields resolvidos por NOME (id não hardcoded — gerenciados no ClickUp).
const CU_FIELD_DATA_ENTRADA_NAME = "Data de Entrada"; // date — recebe o createdAt do pedido
const CU_FIELD_SANKHYA_NAME = "Nº Sankhya"; // number/texto — recebe o NUNOTA do Sankhya
const CU_FIELD_CANAL_NAME = "Canal"; // labels — recebe a loja (BRKAGRO/BRKFISHING/BRKMOTORS)
const CU_CANAL = "BRKAGRO"; // label do "Canal" desta loja
const CU_FIELD_VENDEDOR_NAME = "Vendedores E-commerce";

const ORDER_TAG = "Nome Personalizado";

// ── Helpers ClickUp / metafield ──

async function saveLegacySent(admin, shopId, sent) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      variables: {
        metafields: [{ ownerId: shopId, namespace: CU_NS, key: "clickup_sent", type: "json", value: JSON.stringify(sent) }],
      },
    }
  );
  const data = await res.json();
  return data.data?.metafieldsSet?.userErrors || [];
}

async function clickupCreateTask(token, payload) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.err || body?.error || `ClickUp HTTP ${res.status}`);
  }
  return body; // { id, url, ... }
}

// Busca TODOS os custom fields da lista, indexados por nome normalizado. Os ids não
// são hardcoded porque os fields/options são gerenciados no ClickUp; casamos por nome.
async function clickupFields(token) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/field`, {
    headers: { Authorization: token },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.err || body?.error || `ClickUp fields HTTP ${res.status}`);
  }
  const byName = {};
  for (const f of body?.fields || []) byName[normalizeStr(f.name)] = f;
  return byName;
}

// id da option (de um field do tipo labels/drop_down) pelo nome da option.
function clickupOptionId(field, optionName) {
  for (const o of field?.type_config?.options || []) {
    if (normalizeStr(o.name ?? o.label) === normalizeStr(optionName)) return o.id;
  }
  return null;
}

// Pedidos selecionados (com o metafield do ClickUp) — usado pelas actions.
const NODES_QUERY = `query ($ids: [ID!]!) {
  shop { primaryDomain { url } }
  nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} clickup: metafield(namespace: "${CU_NS}", key: "${CU_KEY}") { value } } }
}`;

// ── Loader ──

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin, session } = await shopify.authenticate.admin(request);
  const kv = context.env.SESSIONS;
  const p = new URL(request.url).searchParams;

  const filters = {
    tab: TABS.includes(p.get("tab")) ? p.get("tab") : "todos",
    q: (p.get("q") || "").slice(0, 100),
    de: isDate(p.get("de")) ? p.get("de") : "",
    ate: isDate(p.get("ate")) ? p.get("ate") : "",
    size: PAGE_SIZES.includes(Number(p.get("size"))) ? Number(p.get("size")) : DEFAULT_PAGE_SIZE,
  };
  const cursor = p.get("before") ? { before: p.get("before") } : p.get("after") ? { after: p.get("after") } : {};

  const [{ sellers }, store] = await Promise.all([loadSellers(admin), storeFor(context.env, kv, session.shop)]);

  let page = null;
  let error = null;
  try {
    page = await loadPersoPage(admin, { ...filters, cursor, sellers, store, nowTs: Date.now() });
  } catch (e) {
    if (e instanceof Response) throw e;
    console.error("[personalizados page]", e);
    error = e?.message || String(e);
  }

  // "Atualizar" (?refresh=1): puxa o Nº Sankhya dos pedidos DA PÁGINA ainda não enviados ao
  // ClickUp e sem Nº, e grava (só esses). O resto da página é relido da Shopify.
  let sankhyaError = null;
  if (p.has("refresh") && page?.rows?.length) {
    const pendingIds = page.rows.filter((r) => !r.clickup && r.nunota == null).map((r) => r.legacyId);
    if (pendingIds.length) {
      try {
        const fetched = await fetchNunotasByShopifyIds(context.env, kv, pendingIds, { empresa: SANKHYA_EMPRESA });
        const found = {};
        for (const [id, nu] of Object.entries(fetched)) if (nu != null) found[id] = nu;
        if (Object.keys(found).length) {
          await store.saveNunotas(found);
          for (const r of page.rows) if (found[r.legacyId] != null) r.nunota = found[r.legacyId];
        }
      } catch (e) {
        console.error("[personalizados sankhya]", e);
        sankhyaError = e?.message || String(e);
      }
    }
  }

  return json({
    filters,
    page,
    error,
    sankhyaError,
    hasToken: Boolean(context.env.CLICKUP_TOKEN),
    storeKind: store.kind, // "d1" (custo constante) | "map" (fallback sem PERSO_DB)
  });
};

// ── Action ──

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin, session } = await shopify.authenticate.admin(request);
    const kv = context.env.SESSIONS;

    const formData = await request.formData();
    const intent = formData.get("intent");

    // Sincronização única (não destrutiva): copia os envios antigos (metafield da LOJA, que
    // fica intacto) para os metafields de cada pedido, em fatias retomáveis.
    if (intent === "syncClickup") {
      const offset = Math.max(0, Number(formData.get("offset")) || 0);
      const dryRun = formData.get("dryRun") === "1";
      // 1ª fatia: repassa KV → D1 (só acrescenta o que faltar) — cobre pedidos gravados no
      // KV pela versão anterior durante a troca de versão do deploy.
      if (offset === 0 && !dryRun && (await getD1Store(context.env, kv, session.shop))) {
        await reimportFromKv(context.env, kv, session.shop);
      }
      // 1ª fatia: garante as definições dos metafields de pedido do ClickUp (lojas novas).
      if (offset === 0 && !dryRun) {
        const defs = await ensureClickupDefinitions(admin);
        if (defs.errors.length) return json({ success: false, error: `Definições de metafield: ${defs.errors.join(", ")}` });
      }
      const r = await syncClickupChunk(admin, { offset, dryRun });
      return json({ success: true, action: "syncClickup", ...r });
    }

    // Sincronização única (2ª etapa): varre os pedidos com PE1198 em fatias (cursor da
    // Shopify) e registra no D1 os "sem atributos" e os pedidos de vendedor (jeito antigo).
    if (intent === "syncScan") {
      const store = await getD1Store(context.env, kv, session.shop);
      if (!store) return json({ success: true, action: "syncScan", next: null, skipped: true });
      const { sellers } = await loadSellers(admin);
      const r = await syncScanChunk(admin, store, sellers, { after: formData.get("after") || null });
      if (r.next == null) await markScanDone(admin);
      return json({ success: true, action: "syncScan", ...r });
    }

    // "Atualizar Banco": puxa o Nº Sankhya dos pedidos que ainda não têm, em LOTES de 200
    // (os mais novos primeiro); clicar de novo continua. NÃO altera o status.
    if (intent === "refreshNunotas") {
      const store = await getD1Store(context.env, kv, session.shop);
      let ids;
      if (store) {
        ids = await store.idsWithoutNunota(200, formData.get("before") || null);
      } else {
        const statusMap = await loadSankhyaStatus(kv, session.shop);
        const nunotas = await loadNunotas(kv, session.shop);
        ids = Object.keys(statusMap).filter((id) => statusMap[id]?.status !== "seller" && nunotas[id] == null).slice(0, 200);
      }
      let matched = 0;
      try {
        const fetched = await fetchNunotasByShopifyIds(context.env, kv, ids, { empresa: SANKHYA_EMPRESA });
        const found = {};
        for (const [legacyId, nu] of Object.entries(fetched)) if (nu != null) { found[legacyId] = nu; matched++; }
        if (store) await store.saveNunotas(found);
        else await saveNunotas(kv, session.shop, { ...(await loadNunotas(kv, session.shop)), ...found });
      } catch (e) {
        return json({ success: false, error: `Sankhya: ${e?.message || e}` });
      }
      return json({ success: true, action: "refreshNunotas", matched, total: ids.length, more: ids.length === 200 });
    }

    // ── Manutenção (raro, só por botão) ──
    // Recalcula os contadores do D1 a partir das linhas (corrige qualquer divergência).
    if (intent === "recountCounters") {
      const store = await getD1Store(context.env, kv, session.shop);
      if (!store) return json({ success: false, error: "D1 (PERSO_DB) não configurado." });
      await store.recountCounters();
      return json({ success: true, action: "maintenance", message: "Contadores recalculados." });
    }
    // Rollback: regera os mapas antigos do KV (status + Nº Sankhya) a partir do D1, para a
    // versão anterior do app voltar com os dados atuais. Guarda cópia dos valores anteriores.
    if (intent === "exportKv") {
      if (!(await getD1Store(context.env, kv, session.shop))) return json({ success: false, error: "D1 (PERSO_DB) não configurado." });
      const r = await exportToKv(context.env, kv, session.shop);
      return json({ success: true, action: "maintenance", message: `Formato antigo (KV) regerado: ${r.jobs} pedidos, ${r.nunotas} Nº Sankhya.` });
    }
    // Rollback do ClickUp: regera o mapa antigo da loja (`clickup_sent`) a partir dos
    // metafields de pedido (só acrescenta; nunca remove entradas).
    if (intent === "exportClickupLegacy") {
      const r = await exportClickupLegacy(admin);
      if (r.errors.length) return json({ success: false, error: r.errors.join(", ") });
      return json({ success: true, action: "maintenance", message: `Mapa antigo do ClickUp regerado: +${r.merged} envio(s), ${r.total} no total${r.complete ? "" : " (parcial — clique de novo)"}.` });
    }

    // "Enviar Sankhya" (reprocessar/backfill manual): busca os pedidos selecionados,
    // faz upsert dos jobs (pulando vendedores) e grava a personalização no Sankhya já.
    if (intent === "sendSankhya") {
      const ids = JSON.parse(formData.get("ids") || "[]");
      if (ids.length === 0) return json({ success: false, error: "Nenhum pedido selecionado." });

      const { sellers } = await loadSellers(admin);
      const res = await admin.graphql(
        `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`,
        { variables: { ids } }
      );
      const data = await res.json();
      const ods = (data.data.nodes || []).filter(Boolean).map((n) => buildOrderData(n, ""));

      let summary;
      try {
        summary = await reprocessOrders(context.env, kv, session.shop, ods, sellers);
      } catch (e) {
        return json({ success: false, error: `Sankhya: ${e?.message || e}` });
      }
      return json({ success: true, action: "sendSankhya", ...summary });
    }

    // "Concluir": marca os selecionados como RESOLVIDOS/encerrados (status Sankhya "done").
    if (intent === "markDone") {
      const ids = JSON.parse(formData.get("ids") || "[]");
      if (ids.length === 0) return json({ success: false, error: "Nenhum pedido selecionado." });
      const legacyIds = ids.map((g) => numericId(g)).filter(Boolean);
      const { done } = await completeOrders(kv, session.shop, legacyIds, context.env);
      return json({ success: true, action: "markDone", done });
    }

    // "Vincular Nº Sankhya": confere o NUNOTA, grava no mapa durável e reprocessa o pedido.
    if (intent === "setNunota") {
      const id = formData.get("id");
      const legacyId = numericId(id);
      if (!legacyId) return json({ success: false, error: "Pedido inválido." });

      let link;
      try {
        link = await setManualNunota(context.env, kv, session.shop, legacyId, formData.get("nunota"));
      } catch (e) {
        return json({ success: false, error: `Sankhya: ${e?.message || e}` });
      }
      if (!link.ok) return json({ success: false, error: link.error });

      const { sellers } = await loadSellers(admin);
      const res = await admin.graphql(
        `query ($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } } }`,
        { variables: { ids: [id] } }
      );
      const data = await res.json();
      const ods = (data.data.nodes || []).filter(Boolean).map((n) => buildOrderData(n, ""));

      let summary;
      try {
        summary = await reprocessOrders(context.env, kv, session.shop, ods, sellers);
      } catch (e) {
        return json({ success: true, action: "setNunota", nunota: link.cab.nunota, sent: 0, errors: [`Sankhya: ${e?.message || e}`] });
      }
      return json({ success: true, action: "setNunota", nunota: link.cab.nunota, ...summary });
    }

    const token = context.env.CLICKUP_TOKEN;
    if (!token) return json({ success: false, error: "CLICKUP_TOKEN não configurado no worker." });

    if (intent !== "send" && intent !== "sendForce") {
      return json({ success: false, error: "Ação inválida." });
    }
    const force = intent === "sendForce";
    const ids = JSON.parse(formData.get("ids") || "[]");
    if (ids.length === 0) return json({ success: false, error: "Nenhum pedido selecionado." });

    const { sellers } = await loadSellers(admin);
    // Formato antigo (mapa da loja): só é lido/regravado com a gravação dupla LIGADA
    // (LEGACY_CLICKUP_DUAL_WRITE). Desligada, "já enviado" vem só do metafield do pedido e o
    // custo do envio não depende do histórico.
    const legacy = LEGACY_CLICKUP_DUAL_WRITE ? await loadLegacySent(admin) : { shopId: null, sent: {} };

    const res = await admin.graphql(NODES_QUERY, { variables: { ids } });
    const data = await res.json();
    const shopDomain = data.data.shop.primaryDomain.url;
    const orders = (data.data.nodes || []).filter(Boolean);

    let created = 0;
    let skipped = 0;
    let skippedExpired = 0;
    const errors = [];
    const newlySent = []; // [{ orderGid, info }]

    // Nº Sankhya dos selecionados: o que já temos + fresco do Sankhya (persiste só esses).
    const store = await storeFor(context.env, kv, session.shop);
    const legacyIdsSel = orders.map((n) => n.legacyResourceId || numericId(n.id)).filter(Boolean);
    const nunotas = await store.getNunotas(legacyIdsSel);
    try {
      const fetched = await fetchNunotasByShopifyIds(context.env, kv, legacyIdsSel, { empresa: SANKHYA_EMPRESA });
      const found = {};
      for (const [id, nu] of Object.entries(fetched)) if (nu != null) found[id] = nu;
      if (Object.keys(found).length) {
        Object.assign(nunotas, found);
        await store.saveNunotas(found);
      }
    } catch (e) {
      errors.push(`Sankhya: ${e.message}`);
    }

    // Custom fields do ClickUp resolvidos por nome (uma leitura, reaproveitada no lote).
    let cuFields = null;
    let cuFieldsError = null;
    try {
      cuFields = await clickupFields(token);
    } catch (e) {
      cuFieldsError = e.message;
    }
    const vendedorField = cuFields?.[normalizeStr(CU_FIELD_VENDEDOR_NAME)] || null;
    const dataEntradaField = cuFields?.[normalizeStr(CU_FIELD_DATA_ENTRADA_NAME)] || null;
    const sankhyaField = cuFields?.[normalizeStr(CU_FIELD_SANKHYA_NAME)] || null;
    if (cuFields && !sankhyaField) {
      errors.push(`Campo "${CU_FIELD_SANKHYA_NAME}" não existe no ClickUp — Nro Único não enviado. Crie o field na lista.`);
    }
    const canalField = cuFields?.[normalizeStr(CU_FIELD_CANAL_NAME)] || null;
    const canalOptId = canalField ? clickupOptionId(canalField, CU_CANAL) : null;
    if (cuFields && !canalField) {
      errors.push(`Field "${CU_FIELD_CANAL_NAME}" não existe no ClickUp.`);
    } else if (canalField && !canalOptId) {
      errors.push(`Canal "${CU_CANAL}" sem option no field "${CU_FIELD_CANAL_NAME}" do ClickUp.`);
    }

    for (const node of orders) {
      const od = buildOrderData(node, shopDomain);
      // Pedido expirado (pagamento não concluído) nunca vira tarefa no ClickUp —
      // vale inclusive para "Forçar reenvio". Pode continuar indo ao Sankhya.
      if (od.expired) { skippedExpired++; continue; }
      const alreadySent = Boolean(node.clickup?.value) || Boolean(legacy.sent[od.id]);
      if (!force && alreadySent) { skipped++; continue; }
      if (od.rawPersoCount === 0) { skipped++; continue; }

      const seller = findSellerForTags(od.tags, sellers);
      const nunota = nunotas[od.legacyId] ?? null;

      const variacaoIds = od.variacao.map((v) => CU_OPT_VARIACAO[v]).filter(Boolean);
      const custom_fields = [
        { id: CU_FIELD_OS, value: `${od.legacyId}` },
        { id: CU_FIELD_MODALIDADE, value: [CU_OPT_ECOMMERCE] },
        { id: CU_FIELD_VARIACAO, value: variacaoIds },
      ];
      if (dataEntradaField) {
        custom_fields.push({ id: dataEntradaField.id, value: new Date(od.createdAt).getTime() });
      }
      if (sankhyaField && nunota != null) {
        const value = sankhyaField.type === "number" ? Number(nunota) : String(nunota);
        custom_fields.push({ id: sankhyaField.id, value });
      }
      if (canalField && canalOptId) {
        custom_fields.push({ id: canalField.id, value: [canalOptId] });
      }

      // Descrição: com atributos estruturados usa os blocos; só o vendedor no jeito ANTIGO
      // (personalização na nota, sem atributos) usa a nota.
      let description;
      if (od.hasAttributes) {
        description = od.description;
      } else if (seller) {
        description = od.note.trim() || od.description || "(pedido de vendedor sem nota)";
      } else {
        description = od.description;
      }

      if (seller) {
        if (vendedorField) {
          const optId = clickupOptionId(vendedorField, seller.name);
          if (optId) {
            custom_fields.push({ id: vendedorField.id, value: [optId] });
          } else {
            errors.push(`${od.name}: vendedor "${seller.name}" sem option no campo "${CU_FIELD_VENDEDOR_NAME}" do ClickUp.`);
          }
        } else {
          errors.push(`${od.name}: não foi possível ler o campo de vendedor no ClickUp (${cuFieldsError || "campo não encontrado"}).`);
        }
      }

      const payload = {
        name: `Pedido ${nunota ?? od.name}`,
        status: CU_STATUS,
        description,
        custom_fields,
      };

      try {
        const task = await clickupCreateTask(token, payload);
        const info = { taskId: task.id, url: task.url, name: od.name, sentAt: new Date().toISOString() };
        newlySent.push({ orderGid: od.id, info });
        legacy.sent[od.id] = info;
        created++;
      } catch (err) {
        errors.push(`${od.name}: ${err.message}`);
      }
    }

    if (newlySent.length) {
      // 1) Metafields do pedido (fonte da dashboard: abas Pendentes/Enviados).
      const mf = await setOrderClickupMetafields(admin, newlySent);
      if (mf.errors.length) errors.push(`Marcação no pedido: ${mf.errors.join(", ")}`);
      // 2) Gravação dupla no formato antigo (mapa da loja) — só se ligada (rollback).
      if (LEGACY_CLICKUP_DUAL_WRITE) {
        const legacyErrs = await saveLegacySent(admin, legacy.shopId, legacy.sent);
        if (legacyErrs.length) errors.push(legacyErrs.map((e) => e.message).join(", "));
      }
    }

    return json({ success: true, action: "send", created, skipped, skippedExpired, errors });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[personalizados action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ──

const TZ = "America/Sao_Paulo"; // SSR (UTC) e navegador formatam igual → sem hydration mismatch
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: TZ }) : "—");
const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";

const VARIACAO_TONE = { Masculina: "info", Feminina: "caution", Infantil: "warning" };
const TAB_LABELS = {
  todos: "Todos",
  pendentes: "Pendentes",
  enviados: "Enviados",
  semAtributos: "Sem atributos",
  presos: "Presos no Sankhya",
};

function SankhyaBadge({ st }) {
  let tone = "neutral";
  let label = "Não enviado";
  if (st?.status === "sent") { tone = "success"; label = st.written ? `Gravado (${st.written})` : "Gravado"; }
  else if (st?.status === "done") { label = "Concluído"; }
  else if (st?.status === "seller") { tone = "info"; label = "Vendedor (n/e)"; }
  else if (st?.status === "hold") { label = "Em análise"; }
  else if (st?.status === "error") { tone = "critical"; label = "Erro"; }
  else if (st) { tone = "warning"; label = "Pendente"; }
  return <s-badge tone={tone} title={st?.reason || undefined}>{label}</s-badge>;
}

function ClickupBadge({ row }) {
  if (row.clickup) return <s-badge tone="success">Enviado</s-badge>;
  if (row.expired) return <s-badge tone="critical">Expirado — não enviar</s-badge>;
  return <s-badge tone="neutral">Pendente</s-badge>;
}

const post = (submit, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.set(k, String(v));
  submit(fd, { method: "post" });
};

// Sincronização única em 2 etapas, cada uma em fatias até `next` == null:
//   1) envios antigos ao ClickUp → metafields de pedido (offset)
//   2) varredura dos pedidos com PE1198 → "sem atributos"/vendedores no D1 (cursor)
function useSync() {
  const submit = useSubmit();
  const actionData = useActionData();
  const seen = useRef(null);
  const [st, setSt] = useState({ phase: null, done: 0, total: 0, scanned: 0, errors: [], finished: false });

  useEffect(() => {
    const d = actionData;
    if (!st.phase || !d || seen.current === d) return;
    if (d.action !== "syncClickup" && d.action !== "syncScan") return;
    seen.current = d;
    if (d.action === "syncClickup") {
      setSt((s) => ({ ...s, done: s.done + (d.written || 0), total: d.total, errors: [...s.errors, ...(d.errors || [])] }));
      if (d.next != null) post(submit, { intent: "syncClickup", offset: d.next });
      else {
        setSt((s) => ({ ...s, phase: "scan" }));
        post(submit, { intent: "syncScan" });
      }
    } else {
      setSt((s) => ({ ...s, scanned: s.scanned + (d.scanned || 0) }));
      if (d.next) post(submit, { intent: "syncScan", after: d.next });
      else setSt((s) => ({ ...s, phase: null, finished: true }));
    }
  }, [actionData, st.phase, submit]);

  const start = useCallback(() => {
    setSt({ phase: "clickup", done: 0, total: 0, scanned: 0, errors: [], finished: false });
    post(submit, { intent: "syncClickup", offset: 0 });
  }, [submit]);

  return { ...st, running: Boolean(st.phase), start };
}

// Ações em lote em fatias de BULK_CHUNK pedidos (uma request por fatia), somando os resultados.
function useBulk() {
  const submit = useSubmit();
  const actionData = useActionData();
  const seen = useRef(null);
  const [bulk, setBulk] = useState(null); // { intent, queue, agg, total, done, finished }

  useEffect(() => {
    const d = actionData;
    if (!bulk || bulk.finished || !d || seen.current === d) return;
    seen.current = d;
    setBulk((b) => {
      const agg = { ...b.agg };
      if (d.error) agg.errors = [...agg.errors, d.error];
      for (const k of ["created", "skipped", "skippedExpired", "sent", "pending", "sellers", "done"]) {
        if (typeof d[k] === "number") agg[k] = (agg[k] || 0) + d[k];
      }
      if (Array.isArray(d.errors)) agg.errors = [...agg.errors, ...d.errors];
      const next = b.queue.slice(0, BULK_CHUNK);
      const rest = b.queue.slice(BULK_CHUNK);
      if (next.length) post(submit, { intent: b.intent, ids: JSON.stringify(next) });
      return { ...b, agg, queue: rest, done: b.total - b.queue.length, finished: next.length === 0 };
    });
  }, [actionData, bulk, submit]);

  const start = useCallback(
    (intent, ids) => {
      const first = ids.slice(0, BULK_CHUNK);
      setBulk({ intent, queue: ids.slice(BULK_CHUNK), total: ids.length, done: 0, agg: { errors: [] }, finished: false });
      post(submit, { intent, ids: JSON.stringify(first) });
    },
    [submit]
  );

  return { bulk, start, clear: () => setBulk(null) };
}

export default function Personalizados() {
  const { filters, page, error, sankhyaError, hasToken, storeKind } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const rows = page?.rows || [];
  const pageInfo = page?.pageInfo || {};
  const counts = page?.counts || null;
  const stuck = page?.stuck || { count: 0, oldestMin: 0 };
  const migracao = page?.migracao || null;

  const busyIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;
  const loadingList =
    navigation.state === "loading" && navigation.location?.pathname === location.pathname;

  // ── Filtros na URL (a Shopify filtra/pagina) ──
  const update = useCallback(
    (patch) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      // Mudou filtro → volta à 1ª página (cursor inválido para a nova busca).
      next.delete("after");
      next.delete("before");
      next.delete("refresh");
      setSearchParams(next);
    },
    [searchParams, setSearchParams]
  );
  const goPage = useCallback(
    (dir) => {
      const next = new URLSearchParams(searchParams);
      next.delete("after");
      next.delete("before");
      next.delete("refresh");
      if (dir === "next" && pageInfo.endCursor) next.set("after", pageInfo.endCursor);
      if (dir === "prev" && pageInfo.startCursor) next.set("before", pageInfo.startCursor);
      setSearchParams(next);
    },
    [searchParams, setSearchParams, pageInfo.endCursor, pageInfo.startCursor]
  );

  // Busca: digita livre, aplica ao confirmar (Enter/blur) ou após 500 ms parado.
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const qTimer = useRef(null);
  const commitQ = useCallback(
    (value) => {
      clearTimeout(qTimer.current);
      if ((value || "") !== (filters.q || "")) update({ q: value });
    },
    [filters.q, update]
  );
  const onQInput = (e) => {
    const v = e.currentTarget.value;
    setQ(v);
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => commitQ(v), 500);
  };
  useEffect(() => () => clearTimeout(qTimer.current), []);

  // ── Seleção (só da página atual; limpa ao navegar) ──
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => setSelected(new Set()), [location.search]);
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = !allOnPage && rows.some((r) => selected.has(r.id));
  const togglePage = (checked) => setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
  const toggleRow = (id, checked) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });

  // Lotes vão em fatias de BULK_CHUNK (cada request cabe nos limites do Worker).
  const { bulk, start: startBulk, clear: clearBulk } = useBulk();
  const bulkRunning = Boolean(bulk && !bulk.finished);
  const runBulk = useCallback(
    (intent) => {
      if (selected.size === 0 || bulkRunning) return;
      startBulk(intent, [...selected]);
      setSelected(new Set());
    },
    [selected, startBulk, bulkRunning]
  );
  const refreshBanco = useCallback(() => post(submit, { intent: "refreshNunotas" }), [submit]);
  const maintenance = useCallback(
    (intent, confirmMsg) => {
      if (confirmMsg && typeof window !== "undefined" && !window.confirm(confirmMsg)) return;
      post(submit, { intent });
    },
    [submit]
  );

  // ── Modal de detalhes ──
  const modalRef = useRef(null);
  const [activeId, setActiveId] = useState(null);
  const active = useMemo(() => rows.find((r) => r.id === activeId) || null, [rows, activeId]);
  const [nunotaInput, setNunotaInput] = useState("");
  useEffect(() => {
    if (activeId && modalRef.current?.showOverlay) modalRef.current.showOverlay();
  }, [activeId]);
  const closeModal = () => modalRef.current?.hideOverlay?.();
  const doSetNunota = () => {
    const nunota = nunotaInput.trim();
    if (!active || !nunota) return;
    const fd = new FormData();
    fd.set("intent", "setNunota");
    fd.set("id", active.id);
    fd.set("nunota", nunota);
    submit(fd, { method: "post" });
    closeModal();
  };

  // ── Sincronização única ──
  const sync = useSync();
  const needsSync = (!migracao?.clickupAt || (storeKind === "d1" && !migracao?.scanAt)) && !sync.finished;

  const refreshHref = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.set("refresh", "1");
    return `?${next.toString()}`;
  }, [searchParams]);
  const refreshing = navigation.state === "loading" && (navigation.location?.search || "").includes("refresh");

  const tabTitle = TAB_LABELS[filters.tab];
  const hasFilters = Boolean(filters.q || filters.de || filters.ate);
  const sk = counts?.sankhya;

  return (
    <s-page heading="Pedidos personalizados" inlineSize="large">
      <s-button
        slot="secondary-actions"
        onClick={() => setSearchParams(new URLSearchParams(refreshHref.slice(1)))}
        loading={refreshing || undefined}
        disabled={refreshing || undefined}
      >
        Atualizar
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={refreshBanco}
        loading={busyIntent === "refreshNunotas" || undefined}
        disabled={busyIntent === "refreshNunotas" || undefined}
      >
        Atualizar Banco
      </s-button>
      <s-button slot="secondary-actions" href="/app/personalizados/cadastro-de-vendedores">
        Cadastro de vendedores
      </s-button>

      <s-stack gap="base">
        <s-paragraph color="subdued">
          Pedidos com a personalização (SKU PE1198 / tag "{ORDER_TAG}") — gravada no Sankhya
          automaticamente; o envio ao ClickUp é manual.
        </s-paragraph>

        {!hasToken && (
          <s-banner tone="critical" heading="CLICKUP_TOKEN não configurado">
            Rode wrangler secret put CLICKUP_TOKEN no worker antes de enviar.
          </s-banner>
        )}

        {needsSync && (
          <s-banner tone="warning" heading="Sincronize os dados antigos com o novo sistema (uma vez)">
            <s-stack gap="small">
              <s-paragraph>
                A dashboard agora marca os envios ao ClickUp no próprio pedido e guarda o status do
                Sankhya num banco próprio. Para as abas e contadores ficarem corretos, copie os
                envios já feitos e confira os pedidos sem atributos. Os registros antigos são
                mantidos intactos. Leva alguns segundos.
              </s-paragraph>
              {sync.running ? (
                <s-paragraph>
                  {sync.phase === "clickup"
                    ? `Copiando envios ao ClickUp… ${sync.done} de ${sync.total || "?"} pedido(s).`
                    : `Conferindo pedidos com personalização… ${sync.scanned} verificado(s).`}
                </s-paragraph>
              ) : (
                <s-stack direction="inline" gap="small">
                  <s-button variant="primary" onClick={sync.start}>Sincronizar agora</s-button>
                </s-stack>
              )}
            </s-stack>
          </s-banner>
        )}
        {sync.finished && (
          <s-banner
            tone={sync.errors.length ? "warning" : "success"}
            heading={`Sincronização concluída: ${sync.done} de ${sync.total} envio(s) copiados · ${sync.scanned} pedido(s) conferido(s).`}
          >
            {sync.errors.length > 0 && <s-paragraph>Erros: {sync.errors.join(" · ")}</s-paragraph>}
          </s-banner>
        )}
        {storeKind !== "d1" && (
          <s-banner tone="info" heading="Banco da dashboard (D1) não configurado">
            Usando o modo anterior (KV) para o status do Sankhya — funciona, mas o custo cresce com o
            histórico. Configure o binding PERSO_DB no worker.
          </s-banner>
        )}
        <BulkResult bulk={bulk} onDismiss={clearBulk} />

        {error && (
          <s-banner tone="critical" heading="Não foi possível carregar os pedidos">
            {error} — tente "Atualizar" em instantes.
          </s-banner>
        )}
        {sankhyaError && (
          <s-banner tone="warning" heading="Não foi possível puxar o Nº Sankhya">{sankhyaError}</s-banner>
        )}

        {stuck.count > 0 && filters.tab !== "presos" && (
          <s-banner tone="warning" heading={`${stuck.count} pedido(s) aguardando envio ao Sankhya há mais de ${STUCK_MIN} min`}>
            <s-stack gap="small">
              <s-paragraph>
                O mais antigo está há ~{stuck.oldestMin} min pendente. Pode ser atraso do Sankhya em
                receber o pedido, ou o envio automático travado. Resolva com "Enviar Sankhya"
                (reprocessar) ou "Concluir" (encerrar sem reenviar).
              </s-paragraph>
              <s-stack direction="inline">
                <s-button onClick={() => setSearchParams(new URLSearchParams({ tab: "presos" }))}>Ver pedidos</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {!bulk && !sync.running && <ActionResult data={actionData} />}

        <s-section padding="none" accessibilityLabel="Pedidos personalizados">
          <s-box padding="base">
            <s-stack gap="small">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-button-group gap="none" accessibilityLabel="Visões">
                  {TABS.map((t) => (
                    <s-button
                      key={t}
                      slot="secondary-actions"
                      variant="secondary"
                      icon={filters.tab === t ? "check" : undefined}
                      aria-pressed={filters.tab === t ? "true" : "false"}
                      onClick={() => update({ tab: t === "todos" ? null : t })}
                    >
                      {TAB_LABELS[t]}
                    </s-button>
                  ))}
                </s-button-group>
                {counts && (
                  <s-text color="subdued">
                    {page.total} pedido(s){filters.tab !== "todos" || hasFilters ? ` em "${tabTitle}"${hasFilters ? " (filtrado)" : ""}` : ""}
                    {" · "}ClickUp: {counts.clickupPendentes} pendente(s)
                  </s-text>
                )}
              </s-stack>
              {sk && (
                <s-text color="subdued">
                  Sankhya: {sk.sent} gravados · {sk.pending} pendentes · {sk.error} erros
                  {sk.naoEnviado ? ` · ${sk.naoEnviado} não enviados` : ""}
                  {sk.seller ? ` · ${sk.seller} vendedor(es)` : ""}
                  {sk.hold ? ` · ${sk.hold} em análise` : ""}
                  {sk.done ? ` · ${sk.done} concluído(s)` : ""}
                </s-text>
              )}
            </s-stack>
          </s-box>

          <s-table
            paginate
            loading={loadingList || undefined}
            hasPreviousPage={pageInfo.hasPreviousPage || undefined}
            hasNextPage={pageInfo.hasNextPage || undefined}
            onPreviousPage={() => goPage("prev")}
            onNextPage={() => goPage("next")}
          >
            {selected.size > 0 ? (
              <s-box slot="filters" padding="small" background="strong">
                <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                  <s-text>{selected.size} selecionado(s)</s-text>
                  <s-stack direction="inline" gap="small">
                    <s-button variant="primary" onClick={() => runBulk("send")} loading={busyIntent === "send" || undefined}>
                      Enviar para ClickUp
                    </s-button>
                    <s-button onClick={() => runBulk("sendSankhya")} loading={busyIntent === "sendSankhya" || undefined}>
                      Enviar Sankhya
                    </s-button>
                    <s-button onClick={() => runBulk("markDone")} loading={busyIntent === "markDone" || undefined}>
                      Concluir
                    </s-button>
                    <s-button tone="critical" onClick={() => runBulk("sendForce")} loading={busyIntent === "sendForce" || undefined}>
                      Forçar reenvio
                    </s-button>
                    <s-button variant="tertiary" onClick={() => setSelected(new Set())}>Limpar seleção</s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            ) : D1_TABS.includes(filters.tab) ? (
              <s-box slot="filters" padding="small">
                <s-text color="subdued">
                  {filters.tab === "presos"
                    ? `Pedidos pendentes no Sankhya há mais de ${STUCK_MIN} min (inclui os que o envio automático parou de tentar). `
                    : "Pedidos com o PE1198 sem os atributos do modal. "}
                  Nesta aba a busca e o período não se aplicam.
                </s-text>
              </s-box>
            ) : (
              <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto auto auto" alignItems="end">
                <s-search-field
                  label="Buscar"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Pedido, cliente, Nº Sankhya, vendedor, SKU…"
                  value={q}
                  onInput={onQInput}
                  onChange={(e) => commitQ(e.currentTarget.value)}
                />
                <s-date-field label="De" labelAccessibilityVisibility="exclusive" value={filters.de} onChange={(e) => update({ de: e.currentTarget.value })} />
                <s-date-field label="Até" labelAccessibilityVisibility="exclusive" value={filters.ate} onChange={(e) => update({ ate: e.currentTarget.value })} />
                {hasFilters ? (
                  <s-button variant="tertiary" onClick={() => update({ q: null, de: null, ate: null })}>Limpar</s-button>
                ) : (
                  <span />
                )}
              </s-grid>
            )}

            <s-table-header-row>
              <s-table-header listSlot="primary">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-checkbox
                    accessibilityLabel="Selecionar a página"
                    checked={allOnPage || undefined}
                    indeterminate={someOnPage || undefined}
                    onChange={(e) => togglePage(e.currentTarget.checked)}
                  />
                  <s-text>Pedido</s-text>
                </s-stack>
              </s-table-header>
              <s-table-header listSlot="labeled">Nº Sankhya</s-table-header>
              <s-table-header listSlot="secondary">Cliente</s-table-header>
              <s-table-header listSlot="labeled">Data</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Persos</s-table-header>
              <s-table-header listSlot="labeled">Atributos</s-table-header>
              <s-table-header listSlot="labeled">Envio Imediato</s-table-header>
              <s-table-header listSlot="labeled">Variação</s-table-header>
              <s-table-header listSlot="labeled">Vendedor</s-table-header>
              <s-table-header listSlot="inline">Sankhya</s-table-header>
              <s-table-header listSlot="inline">ClickUp</s-table-header>
              <s-table-header listSlot="labeled">Enviado em</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id} clickDelegate={`sel-${r.legacyId}`}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-checkbox
                        id={`sel-${r.legacyId}`}
                        accessibilityLabel={`Selecionar ${r.name}`}
                        checked={selected.has(r.id) || undefined}
                        onChange={(e) => toggleRow(r.id, e.currentTarget.checked)}
                      />
                      <s-button
                        variant="tertiary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNunotaInput("");
                          setActiveId(r.id);
                          if (activeId === r.id) modalRef.current?.showOverlay?.();
                        }}
                      >
                        {r.name}
                      </s-button>
                      {r.expired && <s-badge tone="critical">Expirado</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.nunota != null ? <s-text type="strong">{r.nunota}</s-text> : "—"}</s-table-cell>
                  <s-table-cell>{r.customer || "—"}</s-table-cell>
                  <s-table-cell>{fmtDate(r.createdAt)}</s-table-cell>
                  <s-table-cell>{r.persoCount}</s-table-cell>
                  <s-table-cell>
                    {r.hasAttributes ? <s-badge tone="success">Sim</s-badge> : <s-badge tone="critical">Não</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    {r.hasFull ? <s-badge tone="critical">Sim</s-badge> : <s-badge tone="success">Não</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300">
                      {r.variacao.map((v) => (
                        <s-badge key={v} tone={VARIACAO_TONE[v]}>{v}</s-badge>
                      ))}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.seller ? <s-badge tone="info">{r.seller}</s-badge> : "—"}</s-table-cell>
                  <s-table-cell><SankhyaBadge st={r.sankhya} /></s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <ClickupBadge row={r} />
                      {r.clickup?.url && (
                        <s-link href={r.clickup.url} target="_blank">tarefa</s-link>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.clickup?.sentAt ? fmtDateTime(r.clickup.sentAt) : "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {rows.length === 0 && !error && (
            <s-box padding="large">
              <s-paragraph color="subdued">
                {hasFilters || filters.tab !== "todos"
                  ? "Nenhum pedido nesta visão/filtro."
                  : `Nenhum pedido personalizado ainda. Pedidos com a tag "${ORDER_TAG}" aparecerão aqui.`}
              </s-paragraph>
            </s-box>
          )}

          <s-box padding="base">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-select
                label="Itens por página"
                value={String(filters.size)}
                onChange={(e) => update({ size: e.currentTarget.value === String(DEFAULT_PAGE_SIZE) ? null : e.currentTarget.value })}
              >
                {PAGE_SIZES.map((n) => (
                  <s-option key={n} value={String(n)} selected={n === filters.size || undefined}>
                    {n}
                  </s-option>
                ))}
              </s-select>
              <s-text color="subdued">
                {rows.length} de {page?.total ?? 0} nesta visão
              </s-text>
            </s-stack>
          </s-box>
        </s-section>

        <s-section heading="Manutenção" accessibilityLabel="Manutenção da dashboard">
          <s-stack gap="small">
            <s-paragraph color="subdued">
              Uso raro. "Recalcular contadores" corrige os números do resumo do Sankhya. As
              exportações regeram os registros no formato antigo, para voltar à versão anterior
              do app com os dados atuais (nada é apagado).
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button onClick={() => maintenance("recountCounters")} disabled={storeKind !== "d1" || undefined}>
                Recalcular contadores
              </s-button>
              <s-button
                onClick={() => maintenance("exportKv", "Regerar o status do Sankhya no formato antigo (KV)? Use só para voltar à versão anterior do app.")}
                disabled={storeKind !== "d1" || undefined}
              >
                Exportar status do Sankhya (formato antigo)
              </s-button>
              <s-button onClick={() => maintenance("exportClickupLegacy", "Regerar o registro antigo de envios ao ClickUp a partir dos pedidos? Use só para voltar à versão anterior do app.")}>
                Exportar envios ao ClickUp (formato antigo)
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>

      <s-modal
        id="perso-detalhe"
        ref={modalRef}
        heading={active ? `Pedido ${active.name}` : "Pedido"}
        size="large"
        onHide={() => {
          setActiveId(null);
          setNunotaInput("");
        }}
      >
        {active && (
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{active.customer || "—"}</s-text>
              <s-text color="subdued">{fmtDate(active.createdAt)}</s-text>
              {active.nunota != null && (
                <s-badge tone="info">{`Nº Sankhya: ${active.nunota}${active.sankhya?.nunotaManual ? " (manual)" : ""}`}</s-badge>
              )}
              {active.variacao.map((v) => (
                <s-badge key={v} tone={VARIACAO_TONE[v]}>{v}</s-badge>
              ))}
              {active.seller && <s-badge tone="info">Vendedor: {active.seller}</s-badge>}
              {active.hasFull && <s-badge tone="critical">Envio Imediato (FULL)</s-badge>}
              {active.expired && <s-badge tone="critical">Expirado</s-badge>}
              {active.clickup ? (
                <s-badge tone="success">ClickUp: enviado</s-badge>
              ) : active.expired ? (
                <s-badge tone="critical">ClickUp: bloqueado (expirado)</s-badge>
              ) : (
                <s-badge tone="neutral">ClickUp: pendente</s-badge>
              )}
              {active.clickup?.url && <s-link href={active.clickup.url} target="_blank">tarefa no ClickUp</s-link>}
              <SankhyaBadge st={active.sankhya} />
            </s-stack>

            {active.sankhya?.reason && <s-paragraph color="subdued">Sankhya: {active.sankhya.reason}</s-paragraph>}

            {active.sankhya?.status !== "sent" && (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack gap="small">
                  <s-text type="strong">{active.nunota == null ? "Vincular Nº Sankhya manualmente" : "Corrigir Nº Sankhya"}</s-text>
                  <s-paragraph color="subdued">
                    Para pedido lançado no Sankhya sem o vínculo com a Shopify. Informe o Nro Único
                    (NUNOTA), não o nº da nota fiscal. O número é conferido no Sankhya e a
                    personalização é gravada em seguida.
                  </s-paragraph>
                  <s-grid gridTemplateColumns="240px auto" gap="small" alignItems="end">
                    <s-text-field
                      label="Nº Sankhya (NUNOTA)"
                      labelAccessibilityVisibility="exclusive"
                      placeholder="Ex.: 1619183"
                      value={nunotaInput}
                      onInput={(e) => setNunotaInput(e.currentTarget.value.replace(/\D/g, ""))}
                    />
                    <s-button onClick={doSetNunota} disabled={!nunotaInput.trim() || Boolean(busyIntent) || undefined}>
                      Vincular e gravar
                    </s-button>
                  </s-grid>
                </s-stack>
              </s-box>
            )}

            {active.note && (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack gap="small-300">
                  <s-text type="strong">Nota do pedido</s-text>
                  <s-paragraph>{active.note}</s-paragraph>
                </s-stack>
              </s-box>
            )}

            <s-divider />

            {active.personalizations.length === 0 ? (
              <s-paragraph color="subdued">
                Este pedido tem o PE1198 mas sem os atributos do nosso modal (provável inclusão por vendedor externo).
              </s-paragraph>
            ) : (
              active.personalizations.map((p, i) => (
                <s-box key={i} padding="base" border="base" borderRadius="base">
                  <s-stack direction="inline" gap="base" alignItems="start">
                    {p.arte && (
                      <s-link href={p.arte} target="_blank">
                        <s-thumbnail src={p.arte} alt="Arte de referência" size="large" />
                      </s-link>
                    )}
                    <s-stack gap="small-300">
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-text type="strong">{p.sku || "—"}</s-text>
                        {p.url && <s-link href={p.url} target="_blank">ver produto</s-link>}
                      </s-stack>
                      {p.title && <s-text color="subdued">{p.title}</s-text>}
                      {p.tipo && <s-text><s-text type="strong">Tipo:</s-text> {p.tipo}</s-text>}
                      <s-text><s-text type="strong">Nome:</s-text> {p.nome}</s-text>
                      <s-text><s-text type="strong">Local:</s-text> {p.local}</s-text>
                      <s-text><s-text type="strong">Posição:</s-text> {p.posicao}</s-text>
                      {p.arte && <s-link href={p.arte} target="_blank">Abrir arte em tamanho real</s-link>}
                    </s-stack>
                  </s-stack>
                </s-box>
              ))
            )}
          </s-stack>
        )}
        <s-button slot="secondary-actions" onClick={closeModal}>Fechar</s-button>
      </s-modal>
    </s-page>
  );
}

// Banner com o resultado da última ação (mesmos textos da versão anterior).
function ActionResult({ data }) {
  if (!data) return null;
  if (data.error) return <s-banner tone="critical" heading="Erro">{data.error}</s-banner>;
  if (!data.success) return null;
  if (data.action === "send") {
    return (
      <s-banner tone={data.errors?.length ? "warning" : "success"} heading={`${data.created} tarefa(s) criada(s) no ClickUp.`}>
        <s-stack gap="small-300">
          {data.skipped > 0 && <s-paragraph>{data.skipped} ignorado(s) (já enviados ou sem personalização).</s-paragraph>}
          {data.skippedExpired > 0 && <s-paragraph>{data.skippedExpired} bloqueado(s) por estarem expirados (não enviados ao ClickUp).</s-paragraph>}
          {data.errors?.length > 0 && <s-paragraph>Erros: {data.errors.join(" · ")}</s-paragraph>}
        </s-stack>
      </s-banner>
    );
  }
  if (data.action === "refreshNunotas") {
    return (
      <s-banner
        tone="success"
        heading={`Banco atualizado: ${data.matched} de ${data.total} pedido(s) sem Nº consultado(s) ganharam Nº Sankhya (status inalterado).`}
      >
        {data.more && <s-paragraph>Ainda há pedidos sem Nº — clique em "Atualizar Banco" de novo para o próximo lote.</s-paragraph>}
      </s-banner>
    );
  }
  if (data.action === "maintenance") {
    return <s-banner tone="success" heading={data.message} />;
  }
  if (data.action === "sendSankhya") {
    return (
      <s-banner
        tone={data.errors?.length ? "warning" : "success"}
        heading={`Sankhya: ${data.sent} gravado(s), ${data.pending} pendente(s)${data.sellers ? `, ${data.sellers} vendedor(es) ignorado(s)` : ""}.`}
      >
        {data.errors?.length > 0 && <s-paragraph>Erros: {data.errors.join(" · ")}</s-paragraph>}
      </s-banner>
    );
  }
  if (data.action === "setNunota") {
    return (
      <s-banner
        tone={data.sent > 0 ? "success" : "warning"}
        heading={data.sent > 0
          ? `Nº Sankhya ${data.nunota} vinculado e personalização gravada.`
          : `Nº Sankhya ${data.nunota} vinculado, mas a personalização não foi gravada.`}
      >
        {data.errors?.length > 0 && <s-paragraph>Erros: {data.errors.join(" · ")}</s-paragraph>}
        {!data.errors?.length && data.sent === 0 && (
          <s-paragraph>Confira o status Sankhya do pedido (vendedor sem atributos ou sem personalização).</s-paragraph>
        )}
      </s-banner>
    );
  }
  if (data.action === "markDone") {
    return <s-banner tone="success" heading={`${data.done} pedido(s) concluído(s) — removidos do alerta de pendências.`} />;
  }
  return null;
}

// Resultado somado de uma ação em lote (enviada em fatias).
const BULK_LABEL = { send: "Envio ao ClickUp", sendForce: "Reenvio forçado ao ClickUp", sendSankhya: "Envio ao Sankhya", markDone: "Concluir" };
function BulkResult({ bulk, onDismiss }) {
  if (!bulk) return null;
  const a = bulk.agg;
  const label = BULK_LABEL[bulk.intent] || "Ação em lote";
  if (!bulk.finished) {
    return (
      <s-banner tone="info" heading={`${label}: processando ${Math.min(bulk.done + BULK_CHUNK, bulk.total)} de ${bulk.total}…`}>
        Não feche a página até terminar.
      </s-banner>
    );
  }
  let heading = `${label} concluído (${bulk.total} pedido(s)).`;
  if (bulk.intent === "send" || bulk.intent === "sendForce") heading = `${a.created || 0} tarefa(s) criada(s) no ClickUp.`;
  if (bulk.intent === "sendSankhya") heading = `Sankhya: ${a.sent || 0} gravado(s), ${a.pending || 0} pendente(s)${a.sellers ? `, ${a.sellers} vendedor(es) ignorado(s)` : ""}.`;
  if (bulk.intent === "markDone") heading = `${a.done || 0} pedido(s) concluído(s) — removidos do alerta de pendências.`;
  return (
    <s-banner tone={a.errors.length ? "warning" : "success"} heading={heading} dismissible onDismiss={onDismiss}>
      <s-stack gap="small-300">
        {a.skipped > 0 && <s-paragraph>{a.skipped} ignorado(s) (já enviados ou sem personalização).</s-paragraph>}
        {a.skippedExpired > 0 && <s-paragraph>{a.skippedExpired} bloqueado(s) por estarem expirados (não enviados ao ClickUp).</s-paragraph>}
        {a.errors.length > 0 && <s-paragraph>Erros: {a.errors.join(" · ")}</s-paragraph>}
      </s-stack>
    </s-banner>
  );
}
