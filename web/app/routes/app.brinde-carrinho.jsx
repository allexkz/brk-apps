import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useFetcher,
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
  Select,
  RadioButton,
  Badge,
  Box,
  Spinner,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";

const METAFIELD_NAMESPACE = "brk_brinde";
const METAFIELD_KEY = "config";
const DISCOUNT_METAFIELD_NS = "brk-brinde";
const DISCOUNT_METAFIELD_KEY = "config";

function numericId(gid) {
  return gid ? gid.split("/").pop() : null;
}

async function findBrindeFunction(admin) {
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
      (e.node.title === "Brinde Desconto" || e.node.title === "brinde-desconto") &&
      e.node.apiType === "discount"
  )?.node;
}

async function findExistingDiscount(admin) {
  const res = await admin.graphql(`
    query {
      discountNodes(first: 50, query: "title:Brinde*") {
        edges {
          node {
            id
            discount {
              ... on DiscountAutomaticApp { title status }
            }
          }
        }
      }
    }
  `);
  const data = await res.json();
  return data.data.discountNodes.edges.find(
    (e) => e.node.discount?.title === "Brinde Automático"
  )?.node;
}

// ── Loader ────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  const res = await admin.graphql(`
    query {
      shop {
        id
        primaryDomain { url }
        metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
          id
          value
        }
      }
      themes(first: 10) {
        edges { node { id name role } }
      }
    }
  `);

  const data = await res.json();
  const rawValue = data.data.shop.metafield?.value;
  const config = rawValue ? JSON.parse(rawValue) : null;
  const shopId = data.data.shop.id;
  const shopUrl = data.data.shop.primaryDomain.url;

  const mainTheme = data.data.themes.edges.find((e) => e.node.role === "MAIN")?.node;
  const themeId = mainTheme ? numericId(mainTheme.id) : null;
  const themeName = mainTheme?.name ?? null;

  const fn = await findBrindeFunction(admin);
  const existingDiscount = await findExistingDiscount(admin);

  return json({
    config,
    shopId,
    shopUrl,
    themeId,
    themeName,
    hasFn: Boolean(fn),
    hasDiscount: Boolean(existingDiscount),
    discountId: existingDiscount?.id ?? null,
  });
};

// ── Action ────────────────────────────────────────────────────────────────

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    // ── Fetch variants for a product ──
    if (intent === "fetchVariants") {
      const productId = formData.get("productId");
      const res = await admin.graphql(
        `query ($id: ID!) {
          product(id: $id) {
            title
            featuredImage { url }
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  image { url }
                }
              }
            }
          }
        }`,
        { variables: { id: productId } }
      );
      const data = await res.json();
      const product = data.data.product;
      return json({
        action: "fetchVariants",
        product: {
          title: product.title,
          image: product.featuredImage?.url ?? null,
          variants: product.variants.edges.map((e) => ({
            id: e.node.id,
            numericId: numericId(e.node.id),
            title: e.node.title,
            sku: e.node.sku || "",
            price: e.node.price,
            image: e.node.image?.url ?? null,
          })),
        },
      });
    }

    const shopRes = await admin.graphql(`query { shop { id } }`);
    const shopData = await shopRes.json();
    const shopId = shopData.data.shop.id;

    // ── Save config ──
    if (intent === "save") {
      const variantId = formData.get("variantId");
      const variantNumericId = numericId(variantId);
      const productTitle = formData.get("productTitle");
      const variantTitle = formData.get("variantTitle");
      const variantSku = formData.get("variantSku") || "";
      const productImage = formData.get("productImage");
      const thresholdCents = parseInt(formData.get("thresholdCents"), 10);
      const progressMessage = formData.get("progressMessage");
      const progressReachedMessage = formData.get("progressReachedMessage");
      const enabled = formData.get("enabled") === "true";
      const desktopSelector = formData.get("desktopSelector") || "";
      const desktopPosition = formData.get("desktopPosition") || "afterend";
      const mobileSelector = formData.get("mobileSelector") || "";
      const mobilePosition = formData.get("mobilePosition") || "afterend";

      if (!variantId || !thresholdCents || thresholdCents <= 0) {
        return json({ success: false, error: "Preencha todos os campos obrigatórios." });
      }

      const configValue = JSON.stringify({
        enabled,
        variantId,
        variantNumericId,
        productTitle,
        variantTitle,
        variantSku,
        productImage,
        thresholdCents,
        progressMessage: progressMessage || "Faltam {value} para ganhar um brinde!",
        progressReachedMessage: progressReachedMessage || "Você ganhou um brinde!",
        progressBar: {
          desktop: { selector: desktopSelector, position: desktopPosition },
          mobile: { selector: mobileSelector, position: mobilePosition },
        },
      });

      const metaRes = await admin.graphql(
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [{
              ownerId: shopId,
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: configValue,
            }],
          },
        }
      );

      const metaData = await metaRes.json();
      const metaErrors = metaData.data.metafieldsSet.userErrors;
      if (metaErrors.length > 0) {
        return json({ success: false, error: metaErrors.map((e) => e.message).join(", ") });
      }

      const fn = await findBrindeFunction(admin);
      if (!fn) {
        return json({
          success: true,
          action: "save",
          warning: "Configuração salva, mas a function 'Brinde Desconto' ainda não foi deployada.",
        });
      }

      const discountMetafield = JSON.stringify({ variantId, thresholdCents, enabled });
      const existing = await findExistingDiscount(admin);

      if (existing) {
        const updateRes = await admin.graphql(
          `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: existing.id,
              automaticAppDiscount: {
                title: "Brinde Automático",
                combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
                metafields: [{ namespace: DISCOUNT_METAFIELD_NS, key: DISCOUNT_METAFIELD_KEY, type: "json", value: discountMetafield }],
              },
            },
          }
        );
        const updateData = await updateRes.json();
        const updateErrors = updateData.data.discountAutomaticAppUpdate.userErrors;
        if (updateErrors.length > 0) {
          return json({ success: false, error: `Metafield salvo, mas erro ao atualizar desconto: ${updateErrors.map((e) => e.message).join(", ")}` });
        }
      } else {
        const createRes = await admin.graphql(
          `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
              automaticAppDiscount { discountId }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              automaticAppDiscount: {
                title: "Brinde Automático",
                functionId: fn.id,
                discountClasses: ["PRODUCT"],
                startsAt: new Date().toISOString(),
                combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
                metafields: [{ namespace: DISCOUNT_METAFIELD_NS, key: DISCOUNT_METAFIELD_KEY, type: "json", value: discountMetafield }],
              },
            },
          }
        );
        const createData = await createRes.json();
        const createErrors = createData.data.discountAutomaticAppCreate.userErrors;
        if (createErrors.length > 0) {
          return json({ success: false, error: `Metafield salvo, mas erro ao criar desconto: ${createErrors.map((e) => e.message).join(", ")}` });
        }
      }

      return json({ success: true, action: "save" });
    }

    // ── Toggle ──
    if (intent === "toggle") {
      const currentEnabled = formData.get("currentEnabled") === "true";
      const currentConfig = JSON.parse(formData.get("currentConfig"));
      const newEnabled = !currentEnabled;
      const newConfig = { ...currentConfig, enabled: newEnabled };

      const metaRes = await admin.graphql(
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [{
              ownerId: shopId,
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: JSON.stringify(newConfig),
            }],
          },
        }
      );
      const metaData = await metaRes.json();
      const metaErrors = metaData.data.metafieldsSet.userErrors;
      if (metaErrors.length > 0) {
        return json({ success: false, error: metaErrors.map((e) => e.message).join(", ") });
      }

      // Update the discount metafield with the new enabled state so the
      // Shopify Function respects the toggle without needing activate/deactivate.
      const existing = await findExistingDiscount(admin);
      if (existing) {
        const discountMetafield = JSON.stringify({
          variantId: newConfig.variantId,
          thresholdCents: newConfig.thresholdCents,
          enabled: newEnabled,
        });
        await admin.graphql(
          `mutation discountAutomaticAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: existing.id,
              automaticAppDiscount: {
                metafields: [{ namespace: DISCOUNT_METAFIELD_NS, key: DISCOUNT_METAFIELD_KEY, type: "json", value: discountMetafield }],
              },
            },
          }
        );
      }

      return json({ success: true, action: "toggle", enabled: newEnabled });
    }

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[brinde-carrinho action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatBRL(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

const POSITION_OPTIONS = [
  { label: "Depois do elemento (afterend)", value: "afterend" },
  { label: "Antes do elemento (beforebegin)", value: "beforebegin" },
  { label: "Dentro — início (afterbegin)", value: "afterbegin" },
  { label: "Dentro — fim (beforeend)", value: "beforeend" },
];

// ── Component ─────────────────────────────────────────────────────────────

export default function BrindeCarrinho() {
  const { config, shopUrl, themeId, themeName, hasFn } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const variantFetcher = useFetcher();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";
  const isFetchingVariants = variantFetcher.state === "submitting";
  const variantData = variantFetcher.data?.action === "fetchVariants" ? variantFetcher.data : null;

  // ── State ──
  const [selectedVariant, setSelectedVariant] = useState(
    config ? {
      id: config.variantId,
      numericId: config.variantNumericId,
      productTitle: config.productTitle,
      variantTitle: config.variantTitle,
      sku: config.variantSku || "",
      image: config.productImage,
    } : null
  );
  const [selectedVariantId, setSelectedVariantId] = useState(null); // temp selection in step 2
  const [thresholdBRL, setThresholdBRL] = useState(config ? String(config.thresholdCents / 100) : "399");
  const [progressMessage, setProgressMessage] = useState(config?.progressMessage ?? "Faltam {value} para ganhar um brinde!");
  const [progressReachedMessage, setProgressReachedMessage] = useState(config?.progressReachedMessage ?? "Você ganhou um brinde!");
  const [desktopSelector, setDesktopSelector] = useState(config?.progressBar?.desktop?.selector ?? "");
  const [desktopPosition, setDesktopPosition] = useState(config?.progressBar?.desktop?.position ?? "afterend");
  const [mobileSelector, setMobileSelector] = useState(config?.progressBar?.mobile?.selector ?? "");
  const [mobilePosition, setMobilePosition] = useState(config?.progressBar?.mobile?.position ?? "afterend");

  // ── Handlers ──

  const handlePickProduct = useCallback(async () => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: false, action: "select" });
    if (!selected || selected.length === 0) return;
    const product = selected[0];
    setSelectedVariantId(null);
    variantFetcher.submit(
      { intent: "fetchVariants", productId: product.id },
      { method: "post" }
    );
  }, [shopify, variantFetcher]);

  const handleConfirmVariant = useCallback(() => {
    if (!variantData || !selectedVariantId) return;
    const variant = variantData.product.variants.find((v) => v.id === selectedVariantId);
    if (!variant) return;
    setSelectedVariant({
      id: variant.id,
      numericId: variant.numericId,
      productTitle: variantData.product.title,
      variantTitle: variant.title,
      sku: variant.sku,
      image: variant.image || variantData.product.image,
    });
    setSelectedVariantId(null);
    // Clear fetcher data by re-submitting a no-op is not needed — we just hide the list
    variantFetcher.load(window.location.pathname + window.location.search);
  }, [variantData, selectedVariantId, variantFetcher]);

  const handleSave = useCallback(() => {
    if (!selectedVariant) return;
    const thresholdCents = Math.round(parseFloat(thresholdBRL) * 100);
    if (!thresholdCents || thresholdCents <= 0) return;

    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("variantId", selectedVariant.id);
    fd.set("productTitle", selectedVariant.productTitle);
    fd.set("variantTitle", selectedVariant.variantTitle);
    fd.set("variantSku", selectedVariant.sku || "");
    fd.set("productImage", selectedVariant.image ?? "");
    fd.set("thresholdCents", String(thresholdCents));
    fd.set("progressMessage", progressMessage);
    fd.set("progressReachedMessage", progressReachedMessage);
    fd.set("enabled", config?.enabled ? "true" : "false");
    fd.set("desktopSelector", desktopSelector);
    fd.set("desktopPosition", desktopPosition);
    fd.set("mobileSelector", mobileSelector);
    fd.set("mobilePosition", mobilePosition);
    submit(fd, { method: "post" });
  }, [selectedVariant, thresholdBRL, progressMessage, progressReachedMessage, config, desktopSelector, desktopPosition, mobileSelector, mobilePosition, submit]);

  const handleToggle = useCallback(() => {
    if (!config) return;
    const fd = new FormData();
    fd.set("intent", "toggle");
    fd.set("currentEnabled", String(config.enabled));
    fd.set("currentConfig", JSON.stringify(config));
    submit(fd, { method: "post" });
  }, [config, submit]);

  const themeEditorUrl = themeId ? `${shopUrl}/admin/themes/${themeId}/editor?context=apps` : null;
  const hasConfig = Boolean(config);
  const isEnabled = hasConfig && config.enabled;
  const showVariantList = Boolean(variantData && !isFetchingVariants);

  return (
    <Page
      title="Brinde no Carrinho"
      subtitle="Adiciona automaticamente um brinde com 100% de desconto quando o carrinho atinge o valor mínimo."
    >
      <BlockStack gap="500">
        {!hasFn && (
          <Banner tone="warning" title="Function ainda não deployada">
            <p>Rode <InlineCode>shopify app deploy</InlineCode> para publicar a extension "Brinde Desconto".</p>
          </Banner>
        )}

        {hasConfig && (
          <Banner
            tone={isEnabled ? "success" : "warning"}
            title={isEnabled ? "Campanha ativa" : "Campanha desativada"}
          >
            <InlineStack gap="300" blockAlign="center">
              <Text as="p">
                {isEnabled
                  ? `Brinde "${config.productTitle}" (100% off) para carrinhos acima de ${formatBRL(config.thresholdCents)}.`
                  : "A campanha está salva mas não está ativa na loja."}
              </Text>
              <Button
                variant={isEnabled ? "plain" : "primary"}
                tone={isEnabled ? "critical" : undefined}
                onClick={handleToggle}
                loading={isSubmitting && navigation.formData?.get("intent") === "toggle"}
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
          <Banner tone="critical" title="Erro"><p>{actionData.error}</p></Banner>
        )}

        <Layout>
          <Layout.Section>
            {/* ── Product selection ── */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Produto brinde</Text>

                {selectedVariant && !showVariantList && (
                  <InlineStack gap="400" blockAlign="center">
                    {selectedVariant.image && (
                      <Thumbnail source={selectedVariant.image} alt={selectedVariant.productTitle} size="medium" />
                    )}
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd" fontWeight="bold">{selectedVariant.productTitle}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{selectedVariant.variantTitle}</Text>
                      {selectedVariant.sku && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          SKU: <InlineCode>{selectedVariant.sku}</InlineCode>
                        </Text>
                      )}
                      <Text as="span" variant="bodySm" tone="subdued">
                        ID: <InlineCode>{selectedVariant.numericId}</InlineCode>
                      </Text>
                    </BlockStack>
                    <Button variant="plain" onClick={handlePickProduct}>Trocar produto</Button>
                  </InlineStack>
                )}

                {!selectedVariant && !showVariantList && !isFetchingVariants && (
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      Nenhum produto selecionado. O produto pode ter qualquer preço — o desconto de 100% é aplicado automaticamente.
                    </Text>
                    <Button onClick={handlePickProduct}>Selecionar produto</Button>
                  </BlockStack>
                )}

                {isFetchingVariants && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text as="p" tone="subdued">Carregando variantes...</Text>
                  </InlineStack>
                )}

                {/* Step 2: choose variant from list */}
                {showVariantList && (
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd" fontWeight="medium">
                        {variantData.product.title} — escolha a variante:
                      </Text>
                      <Button variant="plain" onClick={handlePickProduct}>Trocar produto</Button>
                    </InlineStack>

                    <BlockStack gap="200">
                      {variantData.product.variants.map((v) => (
                        <Box
                          key={v.id}
                          padding="300"
                          background={selectedVariantId === v.id ? "bg-surface-selected" : "bg-surface"}
                          borderWidth="025"
                          borderColor="border"
                          borderRadius="200"
                        >
                          <RadioButton
                            label={
                              <InlineStack gap="400" blockAlign="center">
                                <BlockStack gap="0">
                                  <Text as="span" variant="bodyMd">{v.title}</Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {v.sku ? `SKU: ${v.sku}` : "Sem SKU"} · R$ {parseFloat(v.price).toFixed(2).replace(".", ",")}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                            }
                            checked={selectedVariantId === v.id}
                            id={v.id}
                            name="variantPicker"
                            onChange={() => setSelectedVariantId(v.id)}
                          />
                        </Box>
                      ))}
                    </BlockStack>

                    <InlineStack gap="300">
                      <Button
                        variant="primary"
                        disabled={!selectedVariantId}
                        onClick={handleConfirmVariant}
                      >
                        Confirmar variante
                      </Button>
                      <Button variant="plain" onClick={() => variantFetcher.load(window.location.pathname + window.location.search)}>
                        Cancelar
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}

                <Divider />

                {/* ── Campaign settings ── */}
                <Text as="h2" variant="headingMd">Configurações da campanha</Text>

                <TextField
                  label="Valor mínimo do carrinho (R$)"
                  type="number"
                  value={thresholdBRL}
                  onChange={setThresholdBRL}
                  prefix="R$"
                  autoComplete="off"
                  min={1}
                  helpText="O brinde é adicionado quando o subtotal (excluindo o brinde) atingir esse valor."
                />

                <TextField
                  label="Mensagem de progresso"
                  value={progressMessage}
                  onChange={setProgressMessage}
                  autoComplete="off"
                  helpText='Use {value} para mostrar o valor restante. Ex: "Faltam {value} para ganhar um brinde!"'
                />

                <TextField
                  label="Mensagem quando o brinde é desbloqueado"
                  value={progressReachedMessage}
                  onChange={setProgressReachedMessage}
                  autoComplete="off"
                  helpText='Exibida na barra quando o cliente atingir o threshold.'
                />
              </BlockStack>
            </Card>

            {/* ── Progress bar position ── */}
            <Box paddingBlockStart="400">
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Posição da barra de progresso</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Defina onde a barra aparece no cart drawer. Use o inspetor do navegador para encontrar o seletor CSS correto no seu tema.
                    </Text>
                  </BlockStack>

                  <InlineStack gap="600" align="start" wrap>
                    {/* Desktop */}
                    <Box minWidth="260px">
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="medium">Desktop</Text>
                        <Select
                          label="Posição"
                          options={POSITION_OPTIONS}
                          value={desktopPosition}
                          onChange={setDesktopPosition}
                        />
                        <TextField
                          label="Seletor CSS"
                          value={desktopSelector}
                          onChange={setDesktopSelector}
                          autoComplete="off"
                          placeholder=".cart-header"
                          helpText="Elemento de referência no cart drawer (desktop)"
                        />
                      </BlockStack>
                    </Box>

                    {/* Mobile */}
                    <Box minWidth="260px">
                      <BlockStack gap="300">
                        <Text as="p" variant="bodyMd" fontWeight="medium">Mobile</Text>
                        <Select
                          label="Posição"
                          options={POSITION_OPTIONS}
                          value={mobilePosition}
                          onChange={setMobilePosition}
                        />
                        <TextField
                          label="Seletor CSS"
                          value={mobileSelector}
                          onChange={setMobileSelector}
                          autoComplete="off"
                          placeholder=".cart-header"
                          helpText="Elemento de referência no cart drawer (mobile)"
                        />
                      </BlockStack>
                    </Box>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Box>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Como funciona</Text>
                <Text as="p" variant="bodySm">1. Selecione o produto e a variante do brinde.</Text>
                <Text as="p" variant="bodySm">2. Defina o valor mínimo do carrinho.</Text>
                <Text as="p" variant="bodySm">3. Configure onde a barra de progresso aparece no carrinho.</Text>
                <Text as="p" variant="bodySm">4. Salve e ative a campanha.</Text>
                <Text as="p" variant="bodySm">5. Ative o <strong>App embed "Brinde Carrinho"</strong> no editor de tema.</Text>
                {themeEditorUrl && (
                  <Button variant="plain" url={themeEditorUrl} external>
                    Abrir editor do tema ({themeName})
                  </Button>
                )}
                <Divider />
                <Text as="p" variant="bodySm" tone="subdued">
                  O JS no tema gerencia add/remove do brinde e exibe a barra de progresso. A Shopify Function aplica 100% de desconto no brinde quando o threshold é atingido.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={handleSave}
            loading={isSubmitting && navigation.formData?.get("intent") === "save"}
            disabled={!selectedVariant || !thresholdBRL || parseFloat(thresholdBRL) <= 0 || showVariantList}
          >
            Salvar configuração
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
