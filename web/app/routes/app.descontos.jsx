import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
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

// ── Loader ────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  const fn = await findFunction(admin);
  const existing = await findExistingDiscount(admin);

  const rawValue = existing?.metafield?.value;
  const config = rawValue ? JSON.parse(rawValue) : null;

  return json({
    config,
    hasFn: Boolean(fn),
    hasDiscount: Boolean(existing),
    discountStatus: existing?.discount?.status ?? null,
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

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[descontos action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ─────────────────────────────────────────────────────────────

export default function Descontos() {
  const { config, hasFn, hasDiscount, discountStatus } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";

  const [collections, setCollections] = useState(config?.collections ?? []);
  const [percentage, setPercentage] = useState(
    config ? String(config.percentage) : "20"
  );

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
      </BlockStack>
    </Page>
  );
}
