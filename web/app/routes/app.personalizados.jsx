import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useNavigate,
} from "@remix-run/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  Box,
  Link,
  EmptyState,
  IndexTable,
  useIndexResourceState,
  Modal,
  Thumbnail,
  Divider,
  ButtonGroup,
  Select,
  Pagination,
  TextField,
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";
import { loadSellers, findSellerForTags, normalizeStr } from "../vendedores";
import { fetchNunotasByShopifyIds } from "../sankhya.server";
import {
  SANKHYA_EMPRESA,
  ORDER_FIELDS,
  numericId,
  buildOrderData,
  buildPersoQuery,
  buildOrdersPayload,
  loadNunotas,
  saveNunotas,
  loadSankhyaStatus,
  reprocessOrders,
} from "../personalizados.server";

// Constantes de EXIBIÇÃO (usadas no componente/client). Não podem vir do módulo
// `.server` (Remix o remove do bundle client). Fonte de verdade da lógica está lá.
const ORDER_TAG = "Nome Personalizado";
const MAX_ORDERS = 2000;

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
const CU_CANAL = "BRKFISHING"; // label do "Canal" desta loja
const CU_FIELD_VENDEDOR_NAME = "Vendedores E-commerce";

const SENT_NS = "brk_perso";
const SENT_KEY = "clickup_sent";

// ── Helpers ClickUp / metafield ──

function parseJsonMetafield(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

// Shop id + mapa de status do ClickUp (lido fresco a cada request).
async function loadSent(admin) {
  const res = await admin.graphql(
    `query { shop { id metafield(namespace: "${SENT_NS}", key: "${SENT_KEY}") { value } } }`
  );
  const data = await res.json();
  return { shopId: data.data.shop.id, sent: parseJsonMetafield(data.data.shop.metafield?.value) };
}

async function saveSent(admin, shopId, sent) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      variables: {
        metafields: [{
          ownerId: shopId,
          namespace: SENT_NS,
          key: SENT_KEY,
          type: "json",
          value: JSON.stringify(sent),
        }],
      },
    }
  );
  const data = await res.json();
  return data.data.metafieldsSet.userErrors;
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

// ── Loader ──

// Cache do fetch pesado (paginação de todos os pedidos + lookup de FULL) em KV, com
// stale-while-revalidate: a dashboard SEMPRE abre com os dados persistidos e, se
// estiverem velhos, o worker refaz o fetch em segundo plano para a próxima visita.
const ORDERS_REVALIDATE_AFTER = 300; // s: idade a partir da qual revalida em background
// (5 min: cada revalidação regrava o cache no KV — 1 PUT. Como PUT é o recurso escasso do
// free tier, revalidamos com menos frequência; a dashboard segue abrindo instantânea via
// cache, e o botão "Atualizar" (?refresh=1) força o fetch imediato quando preciso.)

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin, session } = await shopify.authenticate.admin(request);

  // `?refresh=1` ignora o cache e refaz o fetch pesado na hora.
  const forceRefresh = new URL(request.url).searchParams.has("refresh");

  const { sellers } = await loadSellers(admin);
  const ordersQuery = buildPersoQuery(sellers);

  // Status "enviado" ao ClickUp (fresco): usado para puxar o Nº Sankhya SÓ dos pendentes.
  const { sent } = await loadSent(admin);

  const kv = context.env.SESSIONS;
  const kvKey = `personalizados:orders:${session.shop}`;
  const waitUntil = context.cloudflare?.ctx?.waitUntil?.bind(context.cloudflare.ctx);

  const refetchAndStore = async () => {
    const fresh = { ...(await buildOrdersPayload(admin, ordersQuery)), fetchedAt: Date.now() };
    if (kv) await kv.put(kvKey, JSON.stringify(fresh));
    return fresh;
  };

  let payload = null;
  if (kv && !forceRefresh) {
    try {
      payload = await kv.get(kvKey, "json");
    } catch {
      payload = null;
    }
  }

  if (payload) {
    // Serve o cache imediatamente; se estiver velho, revalida em background.
    const ageMs = Date.now() - (payload.fetchedAt || 0);
    if (ageMs > ORDERS_REVALIDATE_AFTER * 1000 && waitUntil) {
      waitUntil(refetchAndStore().catch((e) => console.error("[personalizados revalidate]", e)));
    }
  } else {
    // Primeiro acesso de todos (ou refresh manual): fetch síncrono.
    payload = await refetchAndStore();
  }

  // Nº Sankhya durável (KV): a coluna SEMPRE lê daqui, então nunca some ao enviar.
  const nunotas = await loadNunotas(kv, session.shop);
  let sankhyaError = null;
  // No "Atualizar" manual, puxa o Nº Sankhya dos PENDENTES que ainda não têm, e persiste.
  if (forceRefresh) {
    try {
      const pendingIds = payload.orders
        .filter((o) => !sent[o.id] && nunotas[o.legacyId] == null)
        .map((o) => o.legacyId)
        .filter(Boolean);
      if (pendingIds.length) {
        const fetched = await fetchNunotasByShopifyIds(context.env, kv, pendingIds, { empresa: SANKHYA_EMPRESA });
        if (Object.keys(fetched).length) {
          Object.assign(nunotas, fetched);
          await saveNunotas(kv, session.shop, nunotas);
        }
      }
    } catch (e) {
      console.error("[personalizados sankhya]", e);
      sankhyaError = e?.message || String(e);
    }
  }
  for (const o of payload.orders) o.nunota = nunotas[o.legacyId] ?? null;

  // Status do envio ao Sankhya (KV) — alimenta a coluna "Sankhya" + contadores + saúde.
  const sankhyaStatus = await loadSankhyaStatus(kv, session.shop);

  return json({
    orders: payload.orders,
    truncated: payload.truncated,
    fetchedAt: payload.fetchedAt || null,
    sankhyaError,
    sent,
    sankhyaStatus,
    sellers,
    hasToken: Boolean(context.env.CLICKUP_TOKEN),
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

    // "Atualizar Banco": puxa o Nº Sankhya de TODOS os pedidos e grava no mapa durável.
    // NÃO altera o status (não mexe em "enviado"). Uso pontual para backfill do histórico.
    if (intent === "refreshNunotas") {
      const { sellers } = await loadSellers(admin);
      const { orders } = await buildOrdersPayload(admin, buildPersoQuery(sellers));
      const nunotas = await loadNunotas(kv, session.shop);
      const ids = orders.map((o) => o.legacyId).filter(Boolean);
      let matched = 0;
      try {
        const fetched = await fetchNunotasByShopifyIds(context.env, kv, ids, { empresa: SANKHYA_EMPRESA });
        for (const [legacyId, nu] of Object.entries(fetched)) {
          if (nu != null) { nunotas[legacyId] = nu; matched++; }
        }
        await saveNunotas(kv, session.shop, nunotas);
      } catch (e) {
        return json({ success: false, error: `Sankhya: ${e?.message || e}` });
      }
      return json({ success: true, action: "refreshNunotas", matched, total: orders.length });
    }

    // "Enviar Sankhya" (reprocessar/backfill manual): busca os pedidos selecionados,
    // faz upsert dos jobs (pulando vendedores) e grava a personalização no Sankhya já.
    // O envio automático (webhook + cron) cobre os pedidos novos; este botão serve para
    // pedidos antigos e retentativa de erro. Independe do ClickUp.
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

    const token = context.env.CLICKUP_TOKEN;
    if (!token) return json({ success: false, error: "CLICKUP_TOKEN não configurado no worker." });

    if (intent !== "send" && intent !== "sendForce") {
      return json({ success: false, error: "Ação inválida." });
    }
    const force = intent === "sendForce";
    const ids = JSON.parse(formData.get("ids") || "[]");
    if (ids.length === 0) return json({ success: false, error: "Nenhum pedido selecionado." });

    const { shopId, sent } = await loadSent(admin);
    const { sellers } = await loadSellers(admin);

    // Busca os pedidos selecionados em lote
    const res = await admin.graphql(
      `query ($ids: [ID!]!) {
        shop { primaryDomain { url } }
        nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } }
      }`,
      { variables: { ids } }
    );
    const data = await res.json();
    const shopDomain = data.data.shop.primaryDomain.url;
    const orders = (data.data.nodes || []).filter(Boolean);

    let created = 0;
    let skipped = 0;
    let skippedExpired = 0;
    const errors = [];

    // Nº Sankhya dos selecionados: puxa fresco do Sankhya e PERSISTE no mapa durável
    // (assim NÃO some ao enviar). Se a busca falhar, usa o que já está salvo no mapa.
    const nunotas = await loadNunotas(kv, session.shop);
    try {
      const legacyIds = orders.map((n) => n.legacyResourceId || numericId(n.id)).filter(Boolean);
      const fetched = await fetchNunotasByShopifyIds(context.env, kv, legacyIds, { empresa: SANKHYA_EMPRESA });
      if (Object.keys(fetched).length) {
        Object.assign(nunotas, fetched);
        await saveNunotas(kv, session.shop, nunotas);
      }
    } catch (e) {
      errors.push(`Sankhya: ${e.message}`);
    }

    // Custom fields do ClickUp resolvidos por nome (uma leitura, reaproveitada no lote):
    // "Vendedores E-commerce", "Data de Entrada" e "Nº Sankhya".
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
    // "Canal" (label da loja) — resolvido uma vez (constante por app).
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
      if (!force && sent[od.id]) { skipped++; continue; }
      if (od.rawPersoCount === 0) { skipped++; continue; }

      const seller = findSellerForTags(od.tags, sellers);
      const nunota = nunotas[od.legacyId] ?? null;

      const variacaoIds = od.variacao.map((v) => CU_OPT_VARIACAO[v]).filter(Boolean);
      const custom_fields = [
        { id: CU_FIELD_OS, value: `${od.legacyId}` },
        { id: CU_FIELD_MODALIDADE, value: [CU_OPT_ECOMMERCE] },
        { id: CU_FIELD_VARIACAO, value: variacaoIds },
      ];

      // "Data de Entrada" = data de criação do pedido (ClickUp date = epoch ms).
      if (dataEntradaField) {
        custom_fields.push({ id: dataEntradaField.id, value: new Date(od.createdAt).getTime() });
      }
      // "Nº Sankhya" = NUNOTA. Field Number recebe número; texto recebe string.
      if (sankhyaField && nunota != null) {
        const value = sankhyaField.type === "number" ? Number(nunota) : String(nunota);
        custom_fields.push({ id: sankhyaField.id, value });
      }
      // "Canal" = loja (label).
      if (canalField && canalOptId) {
        custom_fields.push({ id: canalField.id, value: [canalOptId] });
      }

      // Pedido de vendedor: descrição vem da nota do pedido e atribuímos a label
      // "Vendedores E-commerce" à option correspondente ao vendedor.
      let description = od.description;
      if (seller) {
        description = od.note.trim() || od.description || "(pedido de vendedor sem nota)";
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

      // Título: pedido normal = "Pedido {NUNOTA}" (fallback pro #pedido se ainda não
      // sincronizou no Sankhya); venda de vendedor = texto fixo. A loja vai no "Canal".
      const taskName = seller
        ? "Pedido Personalizado (Vendedor Ecommerce)"
        : `Pedido ${nunota ?? od.name}`;
      const payload = {
        name: taskName,
        status: CU_STATUS,
        description,
        custom_fields,
      };

      try {
        const task = await clickupCreateTask(token, payload);
        sent[od.id] = { taskId: task.id, url: task.url, name: od.name, sentAt: new Date().toISOString() };
        created++;
      } catch (err) {
        errors.push(`${od.name}: ${err.message}`);
      }
    }

    const metaErrs = await saveSent(admin, shopId, sent);
    if (metaErrs.length) errors.push(metaErrs.map((e) => e.message).join(", "));

    return json({ success: true, action: "send", created, skipped, skippedExpired, errors });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[personalizados action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ──

const VARIACAO_TONE = { Masculina: "info", Feminina: "magic", Infantil: "attention" };

// Badge de status do envio ao Sankhya (usa o mapa KV por legacyId).
function sankhyaBadge(st) {
  let badge;
  if (!st) {
    badge = <Badge>Não enviado</Badge>;
  } else if (st.status === "sent") {
    badge = <Badge tone="success">{st.written ? `Gravado (${st.written})` : "Gravado"}</Badge>;
  } else if (st.status === "seller") {
    badge = <Badge tone="info">Vendedor (n/e)</Badge>;
  } else if (st.status === "error") {
    badge = <Badge tone="critical">Erro</Badge>;
  } else {
    badge = <Badge tone="attention">Pendente</Badge>;
  }
  return st?.reason ? <span title={st.reason}>{badge}</span> : badge;
}

export default function Personalizados() {
  const { orders, sent, sankhyaStatus, sellers, hasToken, truncated, sankhyaError } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Navegando para o próprio dashboard com ?refresh=1 = atualização em andamento.
  const isRefreshing =
    navigation.state === "loading" &&
    (navigation.location?.search || "").includes("refresh");

  const [activeOrder, setActiveOrder] = useState(null);
  const [filter, setFilter] = useState("todos"); // todos | enviados | pendentes | semAtributos
  const [pageSize, setPageSize] = useState("25");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filteredOrders = useMemo(() => {
    const q = normalizeStr(search.trim());
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return orders.filter((o) => {
      // status (segmented)
      if (filter === "enviados" && !sent[o.id]) return false;
      if (filter === "pendentes" && sent[o.id]) return false;
      if (filter === "semAtributos" && o.hasAttributes) return false;
      // intervalo de datas (por data de criação do pedido)
      if (fromTs || toTs) {
        const ts = new Date(o.createdAt).getTime();
        if (fromTs && ts < fromTs) return false;
        if (toTs && ts > toTs) return false;
      }
      // busca textual (pedido, cliente, nome, SKU, vendedor, nota, variação)
      if (q) {
        const seller = findSellerForTags(o.tags, sellers);
        const hay = normalizeStr(
          [
            o.name,
            o.customer,
            o.legacyId,
            String(o.nunota ?? ""),
            o.note,
            (o.tags || []).join(" "),
            (o.variacao || []).join(" "),
            seller?.name || "",
            (o.personalizations || []).map((p) => `${p.sku} ${p.nome} ${p.title}`).join(" "),
          ].join(" ")
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, sent, sellers, filter, search, dateFrom, dateTo]);

  const size = Number(pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / size));
  const safePage = Math.min(page, totalPages - 1);
  const pagedOrders = filteredOrders.slice(safePage * size, safePage * size + size);

  const setFilterAndReset = useCallback((f) => { setFilter(f); setPage(0); }, []);

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(pagedOrders);

  const doSend = useCallback((force) => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.set("intent", force ? "sendForce" : "send");
    fd.set("ids", JSON.stringify(selectedResources));
    submit(fd, { method: "post" });
    clearSelection();
  }, [selectedResources, submit, clearSelection]);

  const doRefreshBanco = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "refreshNunotas");
    submit(fd, { method: "post" });
  }, [submit]);

  const doSendSankhya = useCallback(() => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "sendSankhya");
    fd.set("ids", JSON.stringify(selectedResources));
    submit(fd, { method: "post" });
    clearSelection();
  }, [selectedResources, submit, clearSelection]);

  const pendingCount = useMemo(
    () => orders.filter((o) => !sent[o.id]).length,
    [orders, sent]
  );

  // Quantos pendentes já têm Nº Sankhya (visibilidade da sincronização).
  const nunotaPend = useMemo(() => {
    const pend = orders.filter((o) => !sent[o.id]);
    return { com: pend.filter((o) => o.nunota != null).length, total: pend.length };
  }, [orders, sent]);

  // Contadores do envio ao Sankhya (sobre os pedidos exibidos).
  const sankhyaCounts = useMemo(() => {
    const c = { sent: 0, pending: 0, error: 0, seller: 0, naoEnviado: 0 };
    for (const o of orders) {
      const st = sankhyaStatus[o.legacyId]?.status;
      if (st === "sent") c.sent++;
      else if (st === "error") c.error++;
      else if (st === "seller") c.seller++;
      else if (st === "pending") c.pending++;
      else c.naoEnviado++; // sem entrada no mapa → nunca ingerido (precisa de backfill)
    }
    return c;
  }, [orders, sankhyaStatus]);

  // Saúde do envio: pedidos "pendentes" há muito tempo indicam que o envio automático
  // pode estar travado (cron parado / integração fora). Medimos pela IDADE do job — não
  // por heartbeat —, então o cron não precisa escrever nada quando está ocioso.
  // `mounted` gateia a parte dependente de Date.now() (1º render do client == SSR →
  // evita hydration mismatch); recalcula a cada "Atualizar".
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const STUCK_MIN = 45; // ~3 ciclos do cron
  const stuck = useMemo(() => {
    const now = Date.now();
    let count = 0;
    let oldestMin = 0;
    for (const o of orders) {
      const st = sankhyaStatus[o.legacyId];
      if (st?.status === "pending" && st.at) {
        const ageMin = Math.floor((now - new Date(st.at).getTime()) / 60000);
        if (ageMin >= STUCK_MIN) { count++; if (ageMin > oldestMin) oldestMin = ageMin; }
      }
    }
    return { count, oldestMin };
  }, [orders, sankhyaStatus]);
  const showStuck = mounted && stuck.count > 0;

  // Vendedor (por tag) de cada pedido, para exibir na tabela e no modal.
  const sellerByOrder = useMemo(() => {
    const map = {};
    for (const o of orders) {
      const s = findSellerForTags(o.tags, sellers);
      if (s) map[o.id] = s.name;
    }
    return map;
  }, [orders, sellers]);

  const rows = pagedOrders.map((o, index) => {
    const sentInfo = sent[o.id];
    return (
      <IndexTable.Row id={o.id} key={o.id} position={index} selected={selectedResources.includes(o.id)}>
        <IndexTable.Cell>
          <InlineStack gap="150" blockAlign="center">
            <div
              role="presentation"
              onClick={(e) => { e.stopPropagation(); setActiveOrder(o); }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button variant="plain" onClick={() => setActiveOrder(o)}>{o.name}</Button>
            </div>
            {o.expired && <Badge tone="critical">Expirado</Badge>}
          </InlineStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {o.nunota != null ? <Text as="span" variant="bodyMd" fontWeight="semibold">{o.nunota}</Text> : "—"}
        </IndexTable.Cell>
        <IndexTable.Cell>{o.customer}</IndexTable.Cell>
        <IndexTable.Cell>{new Date(o.createdAt).toLocaleDateString("pt-BR")}</IndexTable.Cell>
        <IndexTable.Cell>{o.persoCount}</IndexTable.Cell>
        <IndexTable.Cell>
          {o.hasAttributes ? <Badge tone="success">Sim</Badge> : <Badge tone="critical">Não</Badge>}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {o.hasFull ? <Badge tone="critical">Sim</Badge> : <Badge tone="success">Não</Badge>}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <InlineStack gap="100">
            {o.variacao.map((v) => (
              <Badge key={v} tone={VARIACAO_TONE[v]}>{v}</Badge>
            ))}
          </InlineStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {sellerByOrder[o.id] ? <Badge tone="info">{sellerByOrder[o.id]}</Badge> : "—"}
        </IndexTable.Cell>
        <IndexTable.Cell>{sankhyaBadge(sankhyaStatus[o.legacyId])}</IndexTable.Cell>
        <IndexTable.Cell>
          {sentInfo ? (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">Enviado</Badge>
              {sentInfo.url && <Link url={sentInfo.url} target="_blank">tarefa</Link>}
            </InlineStack>
          ) : o.expired ? (
            <Badge tone="critical">Expirado — não enviar</Badge>
          ) : (
            <Badge>Pendente</Badge>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {sentInfo?.sentAt ? (
            <Text as="span" variant="bodySm">
              {new Date(sentInfo.sentAt).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                year: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          ) : (
            "—"
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      fullWidth
      title="Pedidos personalizados"
      subtitle={`Pedidos com a tag "${ORDER_TAG}" — personalização gravada no Sankhya automaticamente; envio ao ClickUp é manual.`}
      secondaryActions={[
        {
          content: isRefreshing ? "Atualizando…" : "Atualizar",
          loading: isRefreshing,
          disabled: isRefreshing,
          onAction: () => navigate("/app/personalizados?refresh=1"),
        },
        {
          content: "Cadastro de vendedores",
          onAction: () => navigate("/app/personalizados/cadastro-de-vendedores"),
        },
        {
          content: isSubmitting && navigation.formData?.get("intent") === "refreshNunotas" ? "Atualizando banco…" : "Atualizar Banco",
          onAction: doRefreshBanco,
          loading: isSubmitting && navigation.formData?.get("intent") === "refreshNunotas",
          disabled: isSubmitting && navigation.formData?.get("intent") === "refreshNunotas",
        },
      ]}
    >
      <BlockStack gap="500">
        {!hasToken && (
          <Banner tone="critical" title="CLICKUP_TOKEN não configurado">
            <p>Rode <code>wrangler secret put CLICKUP_TOKEN</code> no worker antes de enviar.</p>
          </Banner>
        )}

        {sankhyaError && (
          <Banner tone="warning" title="Não foi possível puxar o Nº Sankhya">
            <p>{sankhyaError}</p>
          </Banner>
        )}

        {showStuck && (
          <Banner tone="warning" title={`${stuck.count} pedido(s) aguardando envio ao Sankhya há mais de ${STUCK_MIN} min`}>
            <p>
              O mais antigo está há ~{stuck.oldestMin} min pendente. Pode ser atraso do
              Sankhya em receber o pedido, ou o envio automático (cron) travado. Se
              persistir, verifique os Cron Triggers do worker no Cloudflare — ou envie
              manualmente com o botão "Enviar Sankhya".
            </p>
          </Banner>
        )}

        {truncated && (
          <Banner tone="warning" title={`Exibindo os ${MAX_ORDERS} pedidos mais recentes`}>
            <p>
              Há mais pedidos com a tag "{ORDER_TAG}" do que o limite carregado. Os
              mais antigos não estão listados — aumente <code>MAX_ORDERS</code> se
              precisar de todo o histórico.
            </p>
          </Banner>
        )}

        {actionData?.success && actionData.action === "send" && (
          <Banner tone={actionData.errors?.length ? "warning" : "success"} title={`${actionData.created} tarefa(s) criada(s) no ClickUp.`}>
            <BlockStack gap="100">
              {actionData.skipped > 0 && <Text as="p" variant="bodySm">{actionData.skipped} ignorado(s) (já enviados ou sem personalização).</Text>}
              {actionData.skippedExpired > 0 && <Text as="p" variant="bodySm">{actionData.skippedExpired} bloqueado(s) por estarem expirados (não enviados ao ClickUp).</Text>}
              {actionData.errors?.length > 0 && <Text as="p" variant="bodySm">Erros: {actionData.errors.join(" · ")}</Text>}
            </BlockStack>
          </Banner>
        )}
        {actionData?.success && actionData.action === "refreshNunotas" && (
          <Banner tone="success" title={`Banco atualizado: ${actionData.matched} de ${actionData.total} pedido(s) com Nº Sankhya (status inalterado).`} />
        )}
        {actionData?.success && actionData.action === "sendSankhya" && (
          <Banner tone={actionData.errors?.length ? "warning" : "success"} title={`Sankhya: ${actionData.sent} gravado(s), ${actionData.pending} pendente(s)${actionData.sellers ? `, ${actionData.sellers} vendedor(es) ignorado(s)` : ""}.`}>
            {actionData.errors?.length > 0 && (
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">Erros: {actionData.errors.join(" · ")}</Text>
              </BlockStack>
            )}
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Erro"><p>{actionData.error}</p></Banner>
        )}

        {orders.length === 0 ? (
          <Card>
            <EmptyState heading="Nenhum pedido personalizado" image="https://cdn.shopify.com/shopifycloud/web/assets/v1/vite/client/en/assets/personalized-empty-state-Bu4xlcHV0rQu.svg">
              <p>Pedidos com a tag "{ORDER_TAG}" aparecerão aqui.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <ButtonGroup variant="segmented">
                      <Button pressed={filter === "todos"} onClick={() => setFilterAndReset("todos")}>Todos</Button>
                      <Button pressed={filter === "enviados"} onClick={() => setFilterAndReset("enviados")}>Enviados</Button>
                      <Button pressed={filter === "pendentes"} onClick={() => setFilterAndReset("pendentes")}>Pendentes</Button>
                      <Button pressed={filter === "semAtributos"} onClick={() => setFilterAndReset("semAtributos")}>Sem atributos</Button>
                    </ButtonGroup>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {filteredOrders.length} pedido(s) · Sankhya: {sankhyaCounts.sent} gravados · {sankhyaCounts.pending} pendentes · {sankhyaCounts.error} erros{sankhyaCounts.naoEnviado ? ` · ${sankhyaCounts.naoEnviado} não enviados` : ""}{sankhyaCounts.seller ? ` · ${sankhyaCounts.seller} vendedor(es)` : ""} · ClickUp: {pendingCount} pendente(s){selectedResources.length > 0 ? ` · ${selectedResources.length} selecionado(s)` : ""}
                    </Text>
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      disabled={selectedResources.length === 0}
                      loading={isSubmitting && navigation.formData?.get("intent") === "send"}
                      onClick={() => doSend(false)}
                    >
                      Enviar para ClickUp
                    </Button>
                    <Button
                      disabled={selectedResources.length === 0}
                      loading={isSubmitting && navigation.formData?.get("intent") === "sendSankhya"}
                      onClick={doSendSankhya}
                    >
                      Enviar Sankhya
                    </Button>
                    <Button
                      tone="critical"
                      disabled={selectedResources.length === 0}
                      loading={isSubmitting && navigation.formData?.get("intent") === "sendForce"}
                      onClick={() => doSend(true)}
                    >
                      Forçar reenvio
                    </Button>
                  </InlineStack>
                </InlineStack>
                <InlineStack gap="200" blockAlign="end" wrap>
                  <div style={{ flexGrow: 1, minWidth: "240px" }}>
                    <TextField
                      label="Buscar"
                      labelHidden
                      placeholder="Buscar por pedido, cliente, nome, SKU, vendedor, nota…"
                      value={search}
                      onChange={(v) => { setSearch(v); setPage(0); }}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => { setSearch(""); setPage(0); }}
                    />
                  </div>
                  <TextField
                    label="De"
                    labelInline
                    type="date"
                    value={dateFrom}
                    onChange={(v) => { setDateFrom(v); setPage(0); }}
                    autoComplete="off"
                  />
                  <TextField
                    label="Até"
                    labelInline
                    type="date"
                    value={dateTo}
                    onChange={(v) => { setDateTo(v); setPage(0); }}
                    autoComplete="off"
                  />
                  {(search || dateFrom || dateTo) && (
                    <Button
                      variant="plain"
                      onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); setPage(0); }}
                    >
                      Limpar
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "pedido", plural: "pedidos" }}
              itemCount={pagedOrders.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Pedido" },
                { title: "Nº Sankhya" },
                { title: "Cliente" },
                { title: "Data" },
                { title: "Persos" },
                { title: "Atributos" },
                { title: "Envio Imediato" },
                { title: "Variação" },
                { title: "Vendedor" },
                { title: "Sankhya" },
                { title: "ClickUp" },
                { title: "Enviado em" },
              ]}
            >
              {rows}
            </IndexTable>
            <Box padding="300" borderBlockStartWidth="025" borderColor="border">
              <InlineStack align="space-between" blockAlign="center">
                <Select
                  label="Itens por página"
                  labelInline
                  options={["10", "25", "50", "100", "200"].map((v) => ({ label: v, value: v }))}
                  value={pageSize}
                  onChange={(v) => { setPageSize(v); setPage(0); }}
                />
                <Pagination
                  hasPrevious={safePage > 0}
                  onPrevious={() => setPage(safePage - 1)}
                  hasNext={safePage < totalPages - 1}
                  onNext={() => setPage(safePage + 1)}
                  label={`Página ${safePage + 1} de ${totalPages}`}
                />
              </InlineStack>
            </Box>
          </Card>
        )}
        <Box paddingBlockEnd="800" />
      </BlockStack>

      {activeOrder && (
        <Modal
          open
          onClose={() => setActiveOrder(null)}
          title={`Pedido ${activeOrder.name}`}
          size="large"
        >
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center" wrap>
                <Text as="span" variant="bodyMd" fontWeight="bold">{activeOrder.customer || "—"}</Text>
                <Text as="span" tone="subdued">{new Date(activeOrder.createdAt).toLocaleDateString("pt-BR")}</Text>
                {activeOrder.nunota != null && <Badge tone="info">Nº Sankhya: {activeOrder.nunota}</Badge>}
                {activeOrder.variacao.map((v) => <Badge key={v} tone={VARIACAO_TONE[v]}>{v}</Badge>)}
                {sellerByOrder[activeOrder.id] && <Badge tone="info">Vendedor: {sellerByOrder[activeOrder.id]}</Badge>}
                {activeOrder.hasFull && <Badge tone="critical">Envio Imediato (FULL)</Badge>}
                {activeOrder.expired && <Badge tone="critical">Expirado</Badge>}
                {sent[activeOrder.id]
                  ? <Badge tone="success">ClickUp: enviado</Badge>
                  : activeOrder.expired
                    ? <Badge tone="critical">ClickUp: bloqueado (expirado)</Badge>
                    : <Badge>ClickUp: pendente</Badge>}
                {sent[activeOrder.id]?.url && <Link url={sent[activeOrder.id].url} target="_blank">tarefa no ClickUp</Link>}
                {(() => {
                  const st = sankhyaStatus[activeOrder.legacyId];
                  const label = !st ? "Sankhya: não enviado"
                    : st.status === "sent" ? `Sankhya: gravado${st.written ? ` (${st.written} item(ns))` : ""}`
                    : st.status === "seller" ? "Sankhya: vendedor (não enviado)"
                    : st.status === "error" ? "Sankhya: erro"
                    : "Sankhya: pendente";
                  const tone = !st ? undefined
                    : st.status === "sent" ? "success"
                    : st.status === "error" ? "critical"
                    : st.status === "seller" ? "info"
                    : "attention";
                  return <Badge tone={tone}>{label}</Badge>;
                })()}
              </InlineStack>

              {sankhyaStatus[activeOrder.legacyId]?.reason && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Sankhya: {sankhyaStatus[activeOrder.legacyId].reason}
                </Text>
              )}

              {activeOrder.note && (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="bold">Nota do pedido</Text>
                    <Text as="p" variant="bodySm">{activeOrder.note}</Text>
                  </BlockStack>
                </Box>
              )}

              <Divider />

              {activeOrder.personalizations.length === 0 ? (
                <Text as="p" tone="subdued">Este pedido tem o PE1198 mas sem os atributos do nosso modal (provável inclusão por vendedor externo).</Text>
              ) : (
                activeOrder.personalizations.map((p, i) => (
                  <Box key={i} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <InlineStack gap="400" blockAlign="start" wrap={false}>
                      {p.arte && (
                        <Link url={p.arte} target="_blank">
                          <Thumbnail source={p.arte} alt="Arte de referência" size="large" />
                        </Link>
                      )}
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center" wrap>
                          <Text as="span" variant="bodyMd" fontWeight="bold">{p.sku || "—"}</Text>
                          {p.url && <Link url={p.url} target="_blank">ver produto</Link>}
                        </InlineStack>
                        {p.title && <Text as="span" variant="bodySm" tone="subdued">{p.title}</Text>}
                        {p.tipo && <Text as="span" variant="bodySm"><strong>Tipo:</strong> {p.tipo}</Text>}
                        <Text as="span" variant="bodySm"><strong>Nome:</strong> {p.nome}</Text>
                        <Text as="span" variant="bodySm"><strong>Local:</strong> {p.local}</Text>
                        <Text as="span" variant="bodySm"><strong>Posição:</strong> {p.posicao}</Text>
                        {p.arte && <Link url={p.arte} target="_blank">Abrir arte em tamanho real</Link>}
                      </BlockStack>
                    </InlineStack>
                  </Box>
                ))
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
