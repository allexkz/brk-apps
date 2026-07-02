import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { useState, useCallback } from "react";
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
  Divider,
  InlineCode,
  Badge,
  Box,
  Checkbox,
  DataTable,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";

// Config lives on the discount node's app-reserved metafield. The Function
// reads it via `discount.metafield(namespace: "$app:descontos-personalizados",
// key: "config")` and binds `collectionIds` to the `$collectionIds` query
// variable through [extensions.input.variables] in shopify.extension.toml.
const METAFIELD_NAMESPACE = "$app:descontos-personalizados";
const METAFIELD_KEY = "config";
const FUNCTION_TITLE = "Descontos Personalizados";
const DISCOUNT_TITLE = "Descontos Personalizados";
const SHIPPING_DISCOUNT_TITLE = "Frete Grátis por Coleção";

async function findFunction(admin) {
  const res = await admin.graphql(`
    query {
      shopifyFunctions(first: 50) {
        edges { node { id title apiType } }
      }
    }
  `);
  const data = await res.json();
  return data.data.shopifyFunctions.edges.find(
    (e) =>
      (e.node.title === FUNCTION_TITLE ||
        e.node.title === "descontos-personalizados") &&
      e.node.apiType === "discount"
  )?.node;
}

async function findExistingDiscount(admin) {
  const res = await admin.graphql(
    `query ($ns: String!, $key: String!) {
      discountNodes(first: 50, query: "title:${DISCOUNT_TITLE}*") {
        edges {
          node {
            id
            discount {
              ... on DiscountAutomaticApp { title status }
            }
            metafield(namespace: $ns, key: $key) { value }
          }
        }
      }
    }`,
    { variables: { ns: METAFIELD_NAMESPACE, key: METAFIELD_KEY } }
  );
  const data = await res.json();
  return data.data.discountNodes.edges.find(
    (e) => e.node.discount?.title === DISCOUNT_TITLE
  )?.node;
}

// Campanha de frete grátis: desconto automático separado (classe SHIPPING),
// mesma function. Tem seu próprio metafield de config e período nativo.
async function findShippingDiscount(admin) {
  const res = await admin.graphql(
    `query ($ns: String!, $key: String!) {
      discountNodes(first: 50, query: "title:${SHIPPING_DISCOUNT_TITLE}*") {
        edges {
          node {
            id
            discount {
              ... on DiscountAutomaticApp { title status startsAt endsAt }
            }
            metafield(namespace: $ns, key: $key) { value }
          }
        }
      }
    }`,
    { variables: { ns: METAFIELD_NAMESPACE, key: METAFIELD_KEY } }
  );
  const data = await res.json();
  return data.data.discountNodes.edges.find(
    (e) => e.node.discount?.title === SHIPPING_DISCOUNT_TITLE
  )?.node;
}

// Observabilidade: pedidos recentes que tiveram um desconto AUTOMÁTICO de
// frete aplicado. Function não consegue logar; o registro confiável vem dos
// pedidos. Casamos por targetType SHIPPING_LINE + automático (independe do
// título exibido, que pode ser a `message` da function) e olhamos tanto o
// nível do pedido quanto as alocações da linha de frete.
const isShippingAuto = (d) =>
  d &&
  d.__typename === "AutomaticDiscountApplication" &&
  d.targetType === "SHIPPING_LINE";

async function findShippingOrders(admin) {
  const res = await admin.graphql(
    `query ShippingDiscountOrders {
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          customer { displayName defaultEmailAddress { emailAddress } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          discountApplications(first: 15) {
            nodes {
              __typename
              targetType
              ... on AutomaticDiscountApplication { title }
            }
          }
          shippingLines(first: 10) {
            nodes {
              discountAllocations {
                discountApplication {
                  __typename
                  targetType
                  ... on AutomaticDiscountApplication { title }
                }
              }
            }
          }
        }
      }
    }`
  );
  const data = await res.json();
  const nodes = data.data?.orders?.nodes ?? [];

  return nodes
    .map((o) => {
      let matched = (o.discountApplications?.nodes ?? []).find(isShippingAuto);
      if (!matched) {
        for (const sl of o.shippingLines?.nodes ?? []) {
          const da = (sl.discountAllocations ?? []).find((a) =>
            isShippingAuto(a.discountApplication)
          );
          if (da) {
            matched = da.discountApplication;
            break;
          }
        }
      }
      return matched ? { o, matched } : null;
    })
    .filter(Boolean)
    .map(({ o, matched }) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      customer:
        o.customer?.displayName ||
        o.customer?.defaultEmailAddress?.emailAddress ||
        "Visitante",
      discountTitle: matched.title || "Frete grátis",
      shipping: o.totalShippingPriceSet?.shopMoney ?? null,
    }));
}

// ── Loader ────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  const fn = await findFunction(admin);
  const existing = await findExistingDiscount(admin);

  const rawValue = existing?.metafield?.value;
  const config = rawValue ? JSON.parse(rawValue) : null;

  // Campanha de frete grátis (desconto separado + log de pedidos).
  const shipping = await findShippingDiscount(admin);
  const shippingRaw = shipping?.metafield?.value;
  const shippingConfig = shippingRaw ? JSON.parse(shippingRaw) : null;
  const shippingOrders = shipping ? await findShippingOrders(admin) : [];

  return json({
    config,
    hasFn: Boolean(fn),
    hasDiscount: Boolean(existing),
    discountStatus: existing?.discount?.status ?? null,
    shippingConfig,
    hasShipping: Boolean(shipping),
    shippingStatus: shipping?.discount?.status ?? null,
    shippingStartsAt: shipping?.discount?.startsAt ?? null,
    shippingEndsAt: shipping?.discount?.endsAt ?? null,
    shippingOrders,
  });
};

// ── Action ────────────────────────────────────────────────────────────────

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    const buildConfigValue = ({ enabled, percentage, collections }) =>
      JSON.stringify({
        enabled,
        percentage,
        collectionIds: collections.map((c) => c.id),
        collections,
      });

    const upsertDiscount = async (configValue) => {
      const fn = await findFunction(admin);
      const existing = await findExistingDiscount(admin);

      if (!fn && !existing) {
        return {
          warning:
            "Configuração não pôde ser aplicada: a function 'Descontos Personalizados' ainda não foi deployada. Rode `shopify app deploy`.",
        };
      }

      const metafields = [
        {
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: configValue,
        },
      ];

      if (existing) {
        const res = await admin.graphql(
          `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: existing.id,
              automaticAppDiscount: { metafields },
            },
          }
        );
        const data = await res.json();
        const errors = data.data.discountAutomaticAppUpdate.userErrors;
        if (errors.length > 0) {
          return { error: errors.map((e) => e.message).join(", ") };
        }
      } else {
        const res = await admin.graphql(
          `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
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
                combinesWith: {
                  orderDiscounts: true,
                  productDiscounts: true,
                  shippingDiscounts: true,
                },
                metafields,
              },
            },
          }
        );
        const data = await res.json();
        const errors = data.data.discountAutomaticAppCreate.userErrors;
        if (errors.length > 0) {
          return { error: errors.map((e) => e.message).join(", ") };
        }
      }
      return {};
    };

    const buildShippingConfigValue = ({ enabled, collections }) =>
      JSON.stringify({
        enabled,
        collectionIds: collections.map((c) => c.id),
        collections,
      });

    const upsertShippingDiscount = async ({ configValue, startsAt, endsAt }) => {
      const fn = await findFunction(admin);
      const existing = await findShippingDiscount(admin);

      if (!fn && !existing) {
        return {
          warning:
            "Configuração não pôde ser aplicada: a function 'Descontos Personalizados' ainda não foi deployada. Rode `shopify app deploy`.",
        };
      }

      const metafields = [
        {
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: configValue,
        },
      ];

      if (existing) {
        const automaticAppDiscount = { metafields };
        // Só mexe nas datas quando vieram do "salvar" (toggle não passa datas).
        if (typeof startsAt !== "undefined") {
          if (startsAt) automaticAppDiscount.startsAt = startsAt;
          automaticAppDiscount.endsAt = endsAt ?? null;
        }
        const res = await admin.graphql(
          `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              userErrors { field message }
            }
          }`,
          {
            variables: { id: existing.id, automaticAppDiscount },
          }
        );
        const data = await res.json();
        const errors = data.data.discountAutomaticAppUpdate.userErrors;
        if (errors.length > 0) {
          return { error: errors.map((e) => e.message).join(", ") };
        }
      } else {
        const res = await admin.graphql(
          `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              automaticAppDiscount: {
                title: SHIPPING_DISCOUNT_TITLE,
                functionId: fn.id,
                discountClasses: ["SHIPPING"],
                startsAt: startsAt || new Date().toISOString(),
                endsAt: endsAt ?? null,
                combinesWith: {
                  orderDiscounts: true,
                  productDiscounts: true,
                  shippingDiscounts: false,
                },
                metafields,
              },
            },
          }
        );
        const data = await res.json();
        const errors = data.data.discountAutomaticAppCreate.userErrors;
        if (errors.length > 0) {
          return { error: errors.map((e) => e.message).join(", ") };
        }
      }
      return {};
    };

    if (intent === "save") {
      const percentage = parseInt(formData.get("percentage"), 10);
      const collections = JSON.parse(formData.get("collections") || "[]");
      const enabled = formData.get("enabled") === "true";

      if (!collections.length) {
        return json({ success: false, error: "Selecione pelo menos uma coleção." });
      }
      if (!percentage || percentage <= 0 || percentage > 100) {
        return json({ success: false, error: "Informe uma porcentagem entre 1 e 100." });
      }

      const configValue = buildConfigValue({ enabled, percentage, collections });
      const result = await upsertDiscount(configValue);
      if (result.error) return json({ success: false, error: result.error });
      return json({ success: true, action: "save", warning: result.warning });
    }

    if (intent === "toggle") {
      const currentConfig = JSON.parse(formData.get("currentConfig"));
      const newEnabled = !currentConfig.enabled;
      const configValue = buildConfigValue({
        enabled: newEnabled,
        percentage: currentConfig.percentage,
        collections: currentConfig.collections || [],
      });
      const result = await upsertDiscount(configValue);
      if (result.error) return json({ success: false, error: result.error });
      return json({ success: true, action: "toggle", enabled: newEnabled, warning: result.warning });
    }

    if (intent === "save-shipping") {
      const collections = JSON.parse(formData.get("collections") || "[]");
      const enabled = formData.get("enabled") === "true";
      const startsAt = formData.get("startsAt") || null;
      const endsAt = formData.get("endsAt") || null;

      if (!collections.length) {
        return json({
          success: false,
          error: "Selecione pelo menos uma coleção para o frete grátis.",
        });
      }

      const configValue = buildShippingConfigValue({ enabled, collections });
      const result = await upsertShippingDiscount({ configValue, startsAt, endsAt });
      if (result.error) return json({ success: false, error: result.error });
      return json({ success: true, action: "save-shipping", warning: result.warning });
    }

    if (intent === "toggle-shipping") {
      const currentConfig = JSON.parse(formData.get("currentConfig"));
      const newEnabled = !currentConfig.enabled;
      const configValue = buildShippingConfigValue({
        enabled: newEnabled,
        collections: currentConfig.collections || [],
      });
      const result = await upsertShippingDiscount({ configValue });
      if (result.error) return json({ success: false, error: result.error });
      return json({
        success: true,
        action: "toggle-shipping",
        enabled: newEnabled,
        warning: result.warning,
      });
    }

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[descontos action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ─────────────────────────────────────────────────────────────

// ISO (UTC) → valor de <input type="datetime-local"> no fuso do navegador.
function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export default function Descontos() {
  const {
    config,
    hasFn,
    hasDiscount,
    discountStatus,
    shippingConfig,
    hasShipping,
    shippingStatus,
    shippingStartsAt,
    shippingEndsAt,
    shippingOrders,
  } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";

  const [collections, setCollections] = useState(config?.collections ?? []);
  const [percentage, setPercentage] = useState(
    config ? String(config.percentage) : "20"
  );
  const [shipColls, setShipColls] = useState(shippingConfig?.collections ?? []);
  const [shipEnabled, setShipEnabled] = useState(
    shippingConfig?.enabled ?? true
  );
  const [shipStart, setShipStart] = useState(isoToLocalInput(shippingStartsAt));
  const [shipEnd, setShipEnd] = useState(isoToLocalInput(shippingEndsAt));

  const handlePickCollections = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (!selected || selected.length === 0) return;
    setCollections(
      selected.map((c) => ({
        id: c.id,
        title: c.title,
        image: c.image?.originalSrc ?? c.image?.url ?? null,
      }))
    );
  }, [shopify, collections]);

  const handleRemoveCollection = useCallback((id) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleSave = useCallback(() => {
    const pct = parseInt(percentage, 10);
    if (!collections.length || !pct || pct <= 0 || pct > 100) return;
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("percentage", String(pct));
    fd.set("collections", JSON.stringify(collections));
    fd.set("enabled", config?.enabled ? "true" : "false");
    submit(fd, { method: "post" });
  }, [collections, percentage, config, submit]);

  const handleToggle = useCallback(() => {
    if (!config) return;
    const fd = new FormData();
    fd.set("intent", "toggle");
    fd.set("currentConfig", JSON.stringify(config));
    submit(fd, { method: "post" });
  }, [config, submit]);

  // ── Frete grátis ──────────────────────────────────────────────────────
  const handlePickShipColls = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
      selectionIds: shipColls.map((c) => ({ id: c.id })),
    });
    if (!selected || selected.length === 0) return;
    setShipColls(
      selected.map((c) => ({
        id: c.id,
        title: c.title,
        image: c.image?.originalSrc ?? c.image?.url ?? null,
      }))
    );
  }, [shopify, shipColls]);

  const handleRemoveShipColl = useCallback((id) => {
    setShipColls((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleSaveShipping = useCallback(() => {
    if (!shipColls.length) return;
    const fd = new FormData();
    fd.set("intent", "save-shipping");
    fd.set("collections", JSON.stringify(shipColls));
    fd.set("enabled", shipEnabled ? "true" : "false");
    if (shipStart) fd.set("startsAt", new Date(shipStart).toISOString());
    if (shipEnd) fd.set("endsAt", new Date(shipEnd).toISOString());
    submit(fd, { method: "post" });
  }, [shipColls, shipEnabled, shipStart, shipEnd, submit]);

  const handleToggleShipping = useCallback(() => {
    if (!shippingConfig) return;
    const fd = new FormData();
    fd.set("intent", "toggle-shipping");
    fd.set("currentConfig", JSON.stringify(shippingConfig));
    submit(fd, { method: "post" });
  }, [shippingConfig, submit]);

  const isEnabled = Boolean(config?.enabled);
  const pctNum = parseInt(percentage, 10);
  const canSave =
    collections.length > 0 && pctNum > 0 && pctNum <= 100 && !isSubmitting;

  return (
    <Page
      title="Descontos Personalizados"
      subtitle="Aplica uma % de desconto a cada PAR de itens das coleções escolhidas. Em quantidade ímpar, a unidade mais barata fica sem desconto."
    >
      <BlockStack gap="500">
        {!hasFn && (
          <Banner tone="warning" title="Function ainda não deployada">
            <p>
              Rode <InlineCode>shopify app deploy</InlineCode> para publicar a
              extension "Descontos Personalizados" antes de ativar a campanha.
            </p>
          </Banner>
        )}

        {hasDiscount && config && (
          <Banner
            tone={isEnabled ? "success" : "warning"}
            title={isEnabled ? "Campanha ativa" : "Campanha desativada"}
          >
            <InlineStack gap="300" blockAlign="center">
              <Text as="p">
                {isEnabled
                  ? `${config.percentage}% OFF a cada par de itens em ${
                      (config.collections || []).length
                    } coleção(ões).`
                  : "A campanha está salva mas não está aplicando descontos."}
              </Text>
              <Button
                variant={isEnabled ? "plain" : "primary"}
                tone={isEnabled ? "critical" : undefined}
                onClick={handleToggle}
                loading={
                  isSubmitting &&
                  navigation.formData?.get("intent") === "toggle"
                }
              >
                {isEnabled ? "Desativar" : "Ativar"}
              </Button>
            </InlineStack>
          </Banner>
        )}

        {actionData?.success && actionData.action === "save" && (
          <Banner tone="success" title="Configuração salva com sucesso!">
            {actionData.warning && <p>{actionData.warning}</p>}
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Erro">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Coleções elegíveis
                </Text>
                <Text as="p" tone="subdued">
                  Selecione uma ou mais coleções. Itens de qualquer uma delas
                  contam juntos para formar os pares.
                </Text>

                {collections.length > 0 && (
                  <BlockStack gap="200">
                    {collections.map((c) => (
                      <Box
                        key={c.id}
                        padding="300"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                      >
                        <InlineStack gap="400" blockAlign="center" align="space-between">
                          <InlineStack gap="300" blockAlign="center">
                            {c.image && (
                              <Thumbnail source={c.image} alt={c.title} size="small" />
                            )}
                            <Text as="span" variant="bodyMd">
                              {c.title}
                            </Text>
                          </InlineStack>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => handleRemoveCollection(c.id)}
                          >
                            Remover
                          </Button>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                <Button onClick={handlePickCollections}>
                  {collections.length > 0
                    ? "Editar coleções"
                    : "Selecionar coleções"}
                </Button>

                <Divider />

                <Text as="h2" variant="headingMd">
                  Porcentagem de desconto
                </Text>
                <TextField
                  label="Desconto por par (%)"
                  type="number"
                  value={percentage}
                  onChange={setPercentage}
                  suffix="%"
                  autoComplete="off"
                  min={1}
                  max={100}
                  helpText="Aplicado às unidades que formam pares completos. Padrão: 20%."
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Como funciona
                </Text>
                <Text as="p" variant="bodySm">
                  1. Escolha as coleções participantes.
                </Text>
                <Text as="p" variant="bodySm">
                  2. Defina a porcentagem de desconto.
                </Text>
                <Text as="p" variant="bodySm">
                  3. Salve e ative a campanha.
                </Text>
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">
                  A cada 2 itens elegíveis (mesma ou coleções diferentes), o
                  desconto é aplicado. Em quantidade ímpar, a unidade de menor
                  preço fica sem desconto.
                </Text>
                {hasDiscount && (
                  <InlineStack gap="200">
                    <Text as="span" variant="bodySm">
                      Status do desconto:
                    </Text>
                    <Badge tone={discountStatus === "ACTIVE" ? "success" : undefined}>
                      {discountStatus ?? "—"}
                    </Badge>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={handleSave}
            loading={isSubmitting && navigation.formData?.get("intent") === "save"}
            disabled={!canSave}
          >
            Salvar configuração
          </Button>
        </InlineStack>

        <Divider />

        {/* ── Campanha de Frete Grátis ───────────────────────────────── */}
        <Text as="h2" variant="headingLg">
          Campanha de Frete Grátis
        </Text>
        <Text as="p" tone="subdued">
          Se o carrinho tiver qualquer item das coleções escolhidas, a opção de
          entrega mais barata fica grátis. O período é controlado pelas datas
          abaixo (a Shopify encerra automaticamente no fim).
        </Text>

        {hasShipping && shippingConfig && (
          <Banner
            tone={shippingConfig.enabled ? "success" : "warning"}
            title={
              shippingConfig.enabled
                ? "Frete grátis ativo"
                : "Frete grátis desativado"
            }
          >
            <InlineStack gap="300" blockAlign="center">
              <Text as="p">
                {shippingConfig.enabled
                  ? `Frete grátis na opção mais barata para ${
                      (shippingConfig.collections || []).length
                    } coleção(ões).`
                  : "A campanha está salva mas não está zerando o frete."}
              </Text>
              <Button
                variant={shippingConfig.enabled ? "plain" : "primary"}
                tone={shippingConfig.enabled ? "critical" : undefined}
                onClick={handleToggleShipping}
                loading={
                  isSubmitting &&
                  navigation.formData?.get("intent") === "toggle-shipping"
                }
              >
                {shippingConfig.enabled ? "Desativar" : "Ativar"}
              </Button>
            </InlineStack>
          </Banner>
        )}

        {actionData?.success && actionData.action === "save-shipping" && (
          <Banner tone="success" title="Campanha de frete salva!">
            {actionData.warning && <p>{actionData.warning}</p>}
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">
                  Coleções com frete grátis
                </Text>
                {shipColls.length > 0 && (
                  <BlockStack gap="200">
                    {shipColls.map((c) => (
                      <Box
                        key={c.id}
                        padding="300"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                      >
                        <InlineStack gap="400" blockAlign="center" align="space-between">
                          <InlineStack gap="300" blockAlign="center">
                            {c.image && (
                              <Thumbnail source={c.image} alt={c.title} size="small" />
                            )}
                            <Text as="span" variant="bodyMd">
                              {c.title}
                            </Text>
                          </InlineStack>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => handleRemoveShipColl(c.id)}
                          >
                            Remover
                          </Button>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                <Button onClick={handlePickShipColls}>
                  {shipColls.length > 0
                    ? "Editar coleções"
                    : "Selecionar coleções"}
                </Button>

                <Divider />

                <Text as="h3" variant="headingMd">
                  Período da campanha
                </Text>
                <InlineStack gap="400">
                  <TextField
                    label="Início"
                    type="datetime-local"
                    value={shipStart}
                    onChange={setShipStart}
                    autoComplete="off"
                    helpText="Deixe em branco para começar agora."
                  />
                  <TextField
                    label="Fim"
                    type="datetime-local"
                    value={shipEnd}
                    onChange={setShipEnd}
                    autoComplete="off"
                    helpText="Ex.: hoje 23:59 (a Shopify encerra sozinha)."
                  />
                </InlineStack>

                <Checkbox
                  label="Ativar campanha ao salvar"
                  checked={shipEnabled}
                  onChange={setShipEnabled}
                />

                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleSaveShipping}
                    loading={
                      isSubmitting &&
                      navigation.formData?.get("intent") === "save-shipping"
                    }
                    disabled={shipColls.length === 0 || isSubmitting}
                  >
                    Salvar campanha de frete
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Como funciona
                </Text>
                <Text as="p" variant="bodySm">
                  1. Escolha as coleções participantes.
                </Text>
                <Text as="p" variant="bodySm">
                  2. Defina o período (início e fim).
                </Text>
                <Text as="p" variant="bodySm">
                  3. Salve e ative a campanha.
                </Text>
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">
                  O frete grátis é aplicado na opção de entrega de menor custo
                  de cada grupo de entrega.
                </Text>
                {hasShipping && (
                  <BlockStack gap="100">
                    <InlineStack gap="200">
                      <Text as="span" variant="bodySm">
                        Status:
                      </Text>
                      <Badge tone={shippingStatus === "ACTIVE" ? "success" : undefined}>
                        {shippingStatus ?? "—"}
                      </Badge>
                    </InlineStack>
                    {shippingEndsAt && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Encerra: {new Date(shippingEndsAt).toLocaleString("pt-BR")}
                      </Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── Log de pedidos com frete grátis ────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">
                Pedidos com frete grátis ({shippingOrders?.length ?? 0})
              </Text>
              <Button
                onClick={() => revalidator.revalidate()}
                loading={revalidator.state === "loading"}
              >
                Atualizar
              </Button>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Pedidos recentes que receberam o desconto de frete desta campanha.
            </Text>
            {shippingOrders && shippingOrders.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Pedido", "Cliente", "Data/Hora", "Desconto"]}
                rows={shippingOrders.map((o) => [
                  o.name,
                  o.customer,
                  new Date(o.createdAt).toLocaleString("pt-BR"),
                  o.discountTitle,
                ])}
              />
            ) : (
              <Text as="p" tone="subdued">
                {hasShipping
                  ? "Nenhum pedido com frete grátis ainda."
                  : "Crie a campanha de frete para começar a registrar pedidos."}
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
