import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
import { useState, useCallback, useMemo } from "react";
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
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";

// ── ClickUp (board "FORMATAÇÃO (ECOMMERCE) 2026") ──
const CLICKUP_LIST_ID = "901327635943";
const CU_STATUS = "para formatar";
const CU_FIELD_OS = "1f68f46f-4569-4e37-9958-aace1b9cfdf8"; // short_text
const CU_FIELD_MODALIDADE = "159c6b1f-4768-4dc6-b821-72093b760cc2"; // labels
const CU_OPT_ECOMMERCE = "53b618d5-b1f3-4eb9-b71d-0b8cbd941c1b";
const CU_FIELD_FORMATADOR = "0a71d8c5-8f5f-4461-b624-cf7bd19f898c"; // labels
const CU_OPT_FERNANDA = "cdeb3412-a737-42e8-bb12-b87c800ed78a";
const CU_FIELD_VARIACAO = "34f07de1-6e6c-43ec-8c6c-b8558e2a91e9"; // labels
const CU_OPT_VARIACAO = {
  Masculina: "90513c40-69cb-45e7-b0b7-a5c510e381c7",
  Feminina: "9d847e91-8473-4937-853c-ed766a405009",
  Infantil: "13b37142-1a07-48af-9199-ec7e51806045",
};

const ORDER_TAG = "Nome Personalizado";
const PERSO_SKU = "PE1198";
const SENT_NS = "brk_perso";
const SENT_KEY = "clickup_sent";

// ── Helpers ──

function numericId(gid) {
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

function attrsToObj(customAttributes) {
  const o = {};
  for (const a of customAttributes || []) o[a.key] = a.value;
  return o;
}

// Um PE1198 só conta como personalização "nossa" se tiver os atributos que o modal
// cria. Vendedores externos podem adicionar o PE1198 sem esses atributos.
function hasOurAttributes(persoNode) {
  const o = attrsToObj(persoNode.customAttributes);
  return Boolean((o["Nome"] || "").trim() && (o["Local"] || "").trim() && (o["Posição"] || "").trim());
}

// A partir dos line items de uma order, monta o que a tarefa precisa.
function buildOrderData(order, shopDomain) {
  const lineItems = (order.lineItems?.edges || []).map((e) => e.node);

  // mapa SKU -> { url, title } das peças (não-PE1198)
  const skuMap = {};
  for (const li of lineItems) {
    if (!li.sku || li.sku === PERSO_SKU) continue;
    const url =
      li.product?.onlineStoreUrl ||
      (li.product?.handle ? `${shopDomain}/products/${li.product.handle}` : "");
    skuMap[li.sku] = { url, title: li.title || "", productId: li.product?.id || null };
  }

  // personalizações: só as que têm os atributos do nosso modal (ignora PE1198
  // adicionado por vendedor externo sem atributos)
  const persosAll = lineItems.filter((li) => li.sku === PERSO_SKU);
  const persos = persosAll.filter(hasOurAttributes);
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

  const description = blocks.join("\n\n");
  const variacaoList = ["Masculina", "Feminina", "Infantil"].filter((v) => variacoes.has(v));

  return {
    id: order.id,
    legacyId: order.legacyResourceId || numericId(order.id),
    name: order.name,
    createdAt: order.createdAt,
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

async function loadSent(admin) {
  const res = await admin.graphql(
    `query { shop { id metafield(namespace: "${SENT_NS}", key: "${SENT_KEY}") { value } } }`
  );
  const data = await res.json();
  const shopId = data.data.shop.id;
  let sent = {};
  try {
    sent = data.data.shop.metafield?.value ? JSON.parse(data.data.shop.metafield.value) : {};
  } catch {
    sent = {};
  }
  return { shopId, sent };
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

const ORDER_FIELDS = `
  id
  name
  legacyResourceId
  createdAt
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

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Produtos (por id) que têm QUALQUER variante com 'FULL' no SKU = envio imediato
// (não personalizáveis). Usado só para sinalizar na dashboard.
async function getFullProductIds(admin, productIds) {
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

// ── Loader ──

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  const res = await admin.graphql(
    `query ($q: String!) {
      shop { primaryDomain { url } }
      orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { variables: { q: `tag:'${ORDER_TAG}'` } }
  );
  const data = await res.json();
  const shopDomain = data.data.shop.primaryDomain.url;
  const orders = data.data.orders.edges.map((e) => buildOrderData(e.node, shopDomain));

  // marca pedidos cuja peça personalizada é produto FULL (envio imediato)
  const allGarmentIds = [...new Set(orders.flatMap((o) => o.garmentProductIds))];
  const fullSet = allGarmentIds.length ? await getFullProductIds(admin, allGarmentIds) : new Set();
  for (const o of orders) o.hasFull = o.garmentProductIds.some((id) => fullSet.has(id));

  const { sent } = await loadSent(admin);

  return json({
    orders,
    sent,
    hasToken: Boolean(context.env.CLICKUP_TOKEN),
  });
};

// ── Action ──

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const token = context.env.CLICKUP_TOKEN;
    if (!token) return json({ success: false, error: "CLICKUP_TOKEN não configurado no worker." });

    const formData = await request.formData();
    const intent = formData.get("intent");
    if (intent !== "send" && intent !== "sendForce") {
      return json({ success: false, error: "Ação inválida." });
    }
    const force = intent === "sendForce";
    const ids = JSON.parse(formData.get("ids") || "[]");
    if (ids.length === 0) return json({ success: false, error: "Nenhum pedido selecionado." });

    const { shopId, sent } = await loadSent(admin);

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
    const errors = [];

    for (const node of orders) {
      const od = buildOrderData(node, shopDomain);
      if (!force && sent[od.id]) { skipped++; continue; }
      if (od.persoCount === 0) { skipped++; continue; }

      const variacaoIds = od.variacao.map((v) => CU_OPT_VARIACAO[v]).filter(Boolean);
      const payload = {
        name: `MOTORS | Personalizado ${od.name}`,
        status: CU_STATUS,
        description: od.description,
        custom_fields: [
          { id: CU_FIELD_OS, value: `PEDIDO ${od.legacyId}` },
          { id: CU_FIELD_MODALIDADE, value: [CU_OPT_ECOMMERCE] },
          { id: CU_FIELD_FORMATADOR, value: [CU_OPT_FERNANDA] },
          { id: CU_FIELD_VARIACAO, value: variacaoIds },
        ],
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

    return json({ success: true, action: "send", created, skipped, errors });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[personalizados action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ──

const VARIACAO_TONE = { Masculina: "info", Feminina: "magic", Infantil: "attention" };

export default function Personalizados() {
  const { orders, sent, hasToken } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [activeOrder, setActiveOrder] = useState(null);

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(orders);

  const doSend = useCallback((force) => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.set("intent", force ? "sendForce" : "send");
    fd.set("ids", JSON.stringify(selectedResources));
    submit(fd, { method: "post" });
    clearSelection();
  }, [selectedResources, submit, clearSelection]);

  const pendingCount = useMemo(
    () => orders.filter((o) => !sent[o.id]).length,
    [orders, sent]
  );

  const rows = orders.map((o, index) => {
    const sentInfo = sent[o.id];
    return (
      <IndexTable.Row id={o.id} key={o.id} position={index} selected={selectedResources.includes(o.id)}>
        <IndexTable.Cell>
          <div
            role="presentation"
            onClick={(e) => { e.stopPropagation(); setActiveOrder(o); }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Button variant="plain" onClick={() => setActiveOrder(o)}>{o.name}</Button>
          </div>
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
          {sentInfo ? (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">Enviado</Badge>
              {sentInfo.url && <Link url={sentInfo.url} target="_blank">tarefa</Link>}
            </InlineStack>
          ) : (
            <Badge>Pendente</Badge>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      fullWidth
      title="Pedidos personalizados"
      subtitle={`Pedidos com a tag "${ORDER_TAG}" — envie para a board de Formatação no ClickUp.`}
    >
      <BlockStack gap="500">
        {!hasToken && (
          <Banner tone="critical" title="CLICKUP_TOKEN não configurado">
            <p>Rode <code>wrangler secret put CLICKUP_TOKEN</code> no worker antes de enviar.</p>
          </Banner>
        )}

        {actionData?.success && actionData.action === "send" && (
          <Banner tone={actionData.errors?.length ? "warning" : "success"} title={`${actionData.created} tarefa(s) criada(s) no ClickUp.`}>
            <BlockStack gap="100">
              {actionData.skipped > 0 && <Text as="p" variant="bodySm">{actionData.skipped} ignorado(s) (já enviados ou sem personalização).</Text>}
              {actionData.errors?.length > 0 && <Text as="p" variant="bodySm">Erros: {actionData.errors.join(" · ")}</Text>}
            </BlockStack>
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
              <InlineStack align="space-between" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  {orders.length} pedido(s) · {pendingCount} pendente(s){selectedResources.length > 0 ? ` · ${selectedResources.length} selecionado(s)` : ""}
                </Text>
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
                    tone="critical"
                    disabled={selectedResources.length === 0}
                    loading={isSubmitting && navigation.formData?.get("intent") === "sendForce"}
                    onClick={() => doSend(true)}
                  >
                    Forçar reenvio
                  </Button>
                </InlineStack>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "pedido", plural: "pedidos" }}
              itemCount={orders.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Pedido" },
                { title: "Cliente" },
                { title: "Data" },
                { title: "Persos" },
                { title: "Atributos" },
                { title: "Envio Imediato" },
                { title: "Variação" },
                { title: "Status" },
              ]}
            >
              {rows}
            </IndexTable>
          </Card>
        )}
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
                {activeOrder.variacao.map((v) => <Badge key={v} tone={VARIACAO_TONE[v]}>{v}</Badge>)}
                {activeOrder.hasFull && <Badge tone="critical">Envio Imediato (FULL)</Badge>}
                {sent[activeOrder.id] ? <Badge tone="success">Enviado</Badge> : <Badge>Pendente</Badge>}
                {sent[activeOrder.id]?.url && <Link url={sent[activeOrder.id].url} target="_blank">tarefa no ClickUp</Link>}
              </InlineStack>

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
