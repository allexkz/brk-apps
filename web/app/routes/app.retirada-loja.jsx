import { json } from "@remix-run/cloudflare";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useCallback } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineCode,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";
import {
  PICKUP_CEP_RANGE_LABEL,
  PICKUP_SERVICE_NAME,
} from "../pickup-shipping";

const CALLBACK_PATH = "/carrier/rates";
const DELIVERY_CUSTOMIZATION_TITLE = "Retirada em Loja - Ordem";
const DELIVERY_CUSTOMIZATION_FUNCTION_HANDLE = "retirada-loja-ordenacao";

function getCallbackUrl(request, env) {
  const baseUrl = env.SHOPIFY_APP_URL || new URL(request.url).origin;
  return new URL(CALLBACK_PATH, baseUrl).toString();
}

async function getCarrierServices(admin) {
  const response = await admin.graphql(`
    query {
      carrierServices(first: 50) {
        edges {
          node {
            id
            name
            callbackUrl
            active
            supportsServiceDiscovery
          }
        }
      }
    }
  `);
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  return result.data.carrierServices.edges.map((edge) => edge.node);
}

function findPickupCarrierService(carrierServices, callbackUrl) {
  return carrierServices.find(
    (service) =>
      service.name === PICKUP_SERVICE_NAME || service.callbackUrl === callbackUrl
  );
}

async function upsertPickupCarrierService(admin, callbackUrl) {
  const carrierServices = await getCarrierServices(admin);
  const existing = findPickupCarrierService(carrierServices, callbackUrl);
  const input = {
    name: PICKUP_SERVICE_NAME,
    callbackUrl,
    supportsServiceDiscovery: true,
    active: true,
  };

  const response = existing
    ? await admin.graphql(
        `mutation CarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
          carrierServiceUpdate(input: $input) {
            carrierService {
              id
              name
              callbackUrl
              active
              supportsServiceDiscovery
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id: existing.id,
              ...input,
            },
          },
        }
      )
    : await admin.graphql(
        `mutation CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
          carrierServiceCreate(input: $input) {
            carrierService {
              id
              name
              callbackUrl
              active
              supportsServiceDiscovery
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input,
          },
        }
      );

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  const payload = existing
    ? result.data.carrierServiceUpdate
    : result.data.carrierServiceCreate;
  const userErrors = payload.userErrors ?? [];

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((error) => error.message).join(", "));
  }

  return {
    action: existing ? "updated" : "created",
    carrierService: payload.carrierService,
  };
}

async function getDeliveryCustomizations(admin) {
  const response = await admin.graphql(`
    query {
      deliveryCustomizations(first: 50) {
        edges {
          node {
            id
            title
            enabled
            functionId
            shopifyFunction {
              title
              apiType
            }
          }
        }
      }
    }
  `);
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  return result.data.deliveryCustomizations.edges.map((edge) => edge.node);
}

function findPickupDeliveryCustomization(deliveryCustomizations) {
  return deliveryCustomizations.find(
    (customization) => customization.title === DELIVERY_CUSTOMIZATION_TITLE
  );
}

async function getShopifyFunctionId(admin, handle) {
  const response = await admin.graphql(`
    query {
      shopifyFunctions(first: 50) {
        edges {
          node {
            id
            title
            apiType
          }
        }
      }
    }
  `);
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  const functions = result.data?.shopifyFunctions?.edges?.map((e) => e.node) ?? [];
  const fn = functions.find(
    (f) => f.apiType === "delivery_customization"
  );

  if (!fn) {
    throw new Error(
      `Function de delivery customization nao encontrada. Verifique se a extension "${handle}" foi deployada.`
    );
  }

  return fn.id;
}

async function upsertPickupDeliveryCustomization(admin) {
  const deliveryCustomizations = await getDeliveryCustomizations(admin);
  const existing = findPickupDeliveryCustomization(deliveryCustomizations);

  const response = existing
    ? await admin.graphql(
        `mutation DeliveryCustomizationUpdate($id: ID!, $deliveryCustomization: DeliveryCustomizationInput!) {
          deliveryCustomizationUpdate(id: $id, deliveryCustomization: $deliveryCustomization) {
            deliveryCustomization {
              id
              title
              enabled
              functionId
              shopifyFunction {
                title
                apiType
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            id: existing.id,
            deliveryCustomization: {
              title: DELIVERY_CUSTOMIZATION_TITLE,
              enabled: true,
            },
          },
        }
      )
    : await (async () => {
        const functionId = await getShopifyFunctionId(
          admin,
          DELIVERY_CUSTOMIZATION_FUNCTION_HANDLE
        );
        return admin.graphql(
          `mutation DeliveryCustomizationCreate($deliveryCustomization: DeliveryCustomizationInput!) {
            deliveryCustomizationCreate(deliveryCustomization: $deliveryCustomization) {
              deliveryCustomization {
                id
                title
                enabled
                functionId
                shopifyFunction {
                  title
                  apiType
                }
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              deliveryCustomization: {
                title: DELIVERY_CUSTOMIZATION_TITLE,
                functionId,
                enabled: true,
              },
            },
          }
        );
      })();

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  const payload = existing
    ? result.data.deliveryCustomizationUpdate
    : result.data.deliveryCustomizationCreate;
  const userErrors = payload.userErrors ?? [];

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((error) => error.message).join(", "));
  }

  return {
    action: existing ? "updated" : "created",
    deliveryCustomization: payload.deliveryCustomization,
  };
}

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);
  const callbackUrl = getCallbackUrl(request, context.env);

  try {
    const carrierServices = await getCarrierServices(admin);
    const deliveryCustomizations = await getDeliveryCustomizations(admin);
    const carrierService = findPickupCarrierService(carrierServices, callbackUrl);
    const deliveryCustomization =
      findPickupDeliveryCustomization(deliveryCustomizations);

    return json({
      callbackUrl,
      carrierService: carrierService ?? null,
      deliveryCustomization: deliveryCustomization ?? null,
      error: null,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[retirada-loja loader]", error);

    return json({
      callbackUrl,
      carrierService: null,
      deliveryCustomization: null,
      error: error?.message || "Erro ao buscar CarrierServices.",
    });
  }
};

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "disable") {
      const callbackUrl = getCallbackUrl(request, context.env);
      const carrierServices = await getCarrierServices(admin);
      const existing = findPickupCarrierService(carrierServices, callbackUrl);

      if (existing) {
        await admin.graphql(
          `mutation CarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
            carrierServiceUpdate(input: $input) {
              carrierService { id active }
              userErrors { field message }
            }
          }`,
          { variables: { input: { id: existing.id, active: false } } }
        );
      }

      const deliveryCustomizations = await getDeliveryCustomizations(admin);
      const existingDC = findPickupDeliveryCustomization(deliveryCustomizations);

      if (existingDC) {
        await admin.graphql(
          `mutation DeliveryCustomizationUpdate($id: ID!, $deliveryCustomization: DeliveryCustomizationInput!) {
            deliveryCustomizationUpdate(id: $id, deliveryCustomization: $deliveryCustomization) {
              deliveryCustomization { id enabled }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: existingDC.id,
              deliveryCustomization: { title: existingDC.title, enabled: false },
            },
          }
        );
      }

      return json({
        success: true,
        carrierService: existing ? { ...existing, active: false } : null,
        deliveryCustomization: existingDC ? { ...existingDC, enabled: false } : null,
        action: "disabled",
      });
    }

    if (intent !== "upsert") {
      return json({ success: false, error: "Acao invalida." });
    }

    const callbackUrl = getCallbackUrl(request, context.env);
    const carrierResult = await upsertPickupCarrierService(admin, callbackUrl);
    const deliveryCustomizationResult =
      await upsertPickupDeliveryCustomization(admin);

    return json({
      success: true,
      carrierService: carrierResult.carrierService,
      deliveryCustomization:
        deliveryCustomizationResult.deliveryCustomization,
      action:
        carrierResult.action === "created" ||
        deliveryCustomizationResult.action === "created"
          ? "created"
          : "updated",
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[retirada-loja action]", error);

    return json({
      success: false,
      error: error?.message || "Erro ao salvar Retirada em Loja.",
    });
  }
};

export default function RetiradaLoja() {
  const { callbackUrl, carrierService, deliveryCustomization, error } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  const handleUpsert = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "upsert");
    submit(formData, { method: "post" });
  }, [submit]);

  const handleDisable = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "disable");
    submit(formData, { method: "post" });
  }, [submit]);

  const activeCarrierService = actionData?.carrierService ?? carrierService;
  const activeDeliveryCustomization =
    actionData?.deliveryCustomization ?? deliveryCustomization;
  const isActive = Boolean(
    activeCarrierService?.active && activeDeliveryCustomization?.enabled
  );

  return (
    <Page title="Retirada em Loja">
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Nao foi possivel consultar o frete">
            <p>{error}</p>
            <p>
              Confirme se o app foi reinstalado com os scopes de frete e de
              delivery customizations.
            </p>
          </Banner>
        )}

        {actionData?.success && (
          <Banner
            tone="success"
            title={
              actionData.action === "disabled"
                ? "Retirada em Loja desativada"
                : actionData.action === "created"
                  ? "Retirada em Loja criada"
                  : "Retirada em Loja atualizada"
            }
          >
            <p>
              {actionData.action === "disabled"
                ? "O servico de retirada foi desativado no checkout."
                : "Opcao de checkout pronta para os CEPs configurados e movida para o fim da lista."}
            </p>
          </Banner>
        )}

        {actionData?.error && (
          <Banner tone="critical" title="Erro ao salvar Retirada em Loja">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Status
                  </Text>
                  <Badge tone={isActive ? "success" : "attention"}>
                    {isActive ? "Ativo" : "Pendente"}
                  </Badge>
                </InlineStack>

                <BlockStack gap="200">
                  <Text as="p">
                    Nome exibido no checkout:{" "}
                    <InlineCode>{PICKUP_SERVICE_NAME}</InlineCode>
                  </Text>
                  <Text as="p">
                    Faixa de CEP:{" "}
                    <InlineCode>{PICKUP_CEP_RANGE_LABEL}</InlineCode>
                  </Text>
                  <Text as="p">
                    Callback: <InlineCode>{callbackUrl}</InlineCode>
                  </Text>
                  <Text as="p">
                    Ordenacao:{" "}
                    <InlineCode>
                      {activeDeliveryCustomization?.enabled
                        ? "ativa"
                        : "pendente"}
                    </InlineCode>
                  </Text>
                </BlockStack>

                <InlineStack align="end" gap="300">
                  {isActive && (
                    <Button
                      tone="critical"
                      onClick={handleDisable}
                      loading={isSubmitting}
                    >
                      Desativar
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleUpsert}
                    loading={isSubmitting}
                  >
                    Ativar ou atualizar
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Regra aplicada
                </Text>
                <Text as="p" variant="bodySm">
                  O endpoint retorna frete gratis somente quando o destino esta
                  no Brasil e o CEP esta entre {PICKUP_CEP_RANGE_LABEL}.
                </Text>
                <Text as="p" variant="bodySm">
                  A Delivery Customization move a opcao Retirada em Loja para a
                  ultima posicao do grupo de entrega.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Lojas precisam ter frete calculado por terceiros habilitado no
                  plano Shopify para usar CarrierService.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  No perfil de frete da Shopify, adicione uma taxa calculada por
                  app e selecione este servico.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
