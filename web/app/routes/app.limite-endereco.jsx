import { json } from "@remix-run/cloudflare";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useCallback, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineCode,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";

const VALIDATION_TITLE = "Limite de caracteres - Rua";
const SHOP_METAFIELD_NAMESPACE = "brk_address_limit";
const VALIDATION_METAFIELD_NAMESPACE = "brk-address-limit";
const METAFIELD_KEY = "config";

const DEFAULTS = {
  maxStreet: 40,
  maxNumber: 6,
  maxComplement: 40,
  messageStreet: "O campo Rua deve ter no maximo {max} caracteres.",
  messageNumber: "O campo Numero deve ter no maximo {max} caracteres.",
  messageComplement: "O campo Complemento deve ter no maximo {max} caracteres.",
};

function parseConfig(rawValue) {
  if (!rawValue) {
    return {
      enabled: false,
      ...DEFAULTS,
      validationId: null,
    };
  }

  try {
    const parsed = JSON.parse(rawValue);

    function posInt(v, fallback) {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : fallback;
    }

    function str(v, fallback) {
      return typeof v === "string" && v.trim() ? v.trim() : fallback;
    }

    return {
      enabled: parsed.enabled === true,
      maxStreet: posInt(parsed.maxStreet, posInt(parsed.maxLength, DEFAULTS.maxStreet)),
      maxNumber: posInt(parsed.maxNumber, DEFAULTS.maxNumber),
      maxComplement: posInt(parsed.maxComplement, DEFAULTS.maxComplement),
      messageStreet: str(parsed.messageStreet, str(parsed.message, DEFAULTS.messageStreet)),
      messageNumber: str(parsed.messageNumber, DEFAULTS.messageNumber),
      messageComplement: str(parsed.messageComplement, DEFAULTS.messageComplement),
      validationId:
        typeof parsed.validationId === "string" ? parsed.validationId : null,
    };
  } catch {
    return {
      enabled: false,
      ...DEFAULTS,
      validationId: null,
    };
  }
}

function sanitizeInt(value, fallback, max = 255) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function sanitizeStr(value, fallback) {
  const s = String(value || "").trim();
  return s || fallback;
}

async function graphqlJson(response) {
  const result = await response.json();

  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(", "));
  }

  return result;
}

async function getShopConfig(admin) {
  const response = await admin.graphql(`
    query AddressLimitConfig {
      shop {
        id
        metafield(namespace: "${SHOP_METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
          value
        }
      }
    }
  `);
  const result = await graphqlJson(response);

  return {
    shopId: result.data.shop.id,
    config: parseConfig(result.data.shop.metafield?.value),
  };
}

async function getValidations(admin) {
  const response = await admin.graphql(`
    query AddressLimitValidations {
      validations(first: 50) {
        edges {
          node {
            id
            title
            enabled
            shopifyFunction {
              title
              apiType
            }
          }
        }
      }
    }
  `);
  const result = await graphqlJson(response);

  return result.data.validations.edges.map((edge) => edge.node);
}

function findAddressLimitValidation(validations, validationId) {
  return validations.find(
    (validation) =>
      validation.id === validationId || validation.title === VALIDATION_TITLE
  );
}

async function saveShopConfig(admin, shopId, config) {
  const response = await admin.graphql(
    `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: SHOP_METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    }
  );
  const result = await graphqlJson(response);
  const userErrors = result.data.metafieldsSet.userErrors ?? [];

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((error) => error.message).join(", "));
  }
}

function buildValidationInput(config) {
  return {
    title: VALIDATION_TITLE,
    enable: true,
    blockOnFailure: false,
    metafields: [
      {
        namespace: VALIDATION_METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value: JSON.stringify({
          enabled: true,
          maxStreet: config.maxStreet,
          maxNumber: config.maxNumber,
          maxComplement: config.maxComplement,
          messageStreet: config.messageStreet,
          messageNumber: config.messageNumber,
          messageComplement: config.messageComplement,
        }),
      },
    ],
  };
}

async function getFunctionId(admin) {
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
  const result = await graphqlJson(response);
  const functions = result.data?.shopifyFunctions?.edges?.map((e) => e.node) ?? [];
  const fn = functions.find(
    (f) =>
      f.title === "Limite Endereco" ||
      f.title === "limite-endereco" ||
      f.apiType === "cart_and_checkout_validation"
  );

  if (!fn) {
    throw new Error(
      `Function nao encontrada. Functions disponiveis: ${functions.map((f) => f.title + " (" + f.apiType + ")").join(", ") || "nenhuma"}`
    );
  }

  return fn.id;
}

async function upsertAddressLimitValidation(admin, existingValidation, config) {
  const validation = buildValidationInput(config);
  const response = existingValidation
    ? await admin.graphql(
        `mutation ValidationUpdate($id: ID!, $validation: ValidationUpdateInput!) {
          validationUpdate(id: $id, validation: $validation) {
            validation {
              id
              title
              enabled
              shopifyFunction {
                title
                apiType
              }
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
        {
          variables: {
            id: existingValidation.id,
            validation,
          },
        }
      )
    : await admin.graphql(
        `mutation ValidationCreate($validation: ValidationCreateInput!) {
          validationCreate(validation: $validation) {
            validation {
              id
              title
              enabled
              shopifyFunction {
                title
                apiType
              }
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
        {
          variables: {
            validation: {
              ...validation,
              functionId: await getFunctionId(admin),
            },
          },
        }
      );

  const result = await graphqlJson(response);
  const payload = existingValidation
    ? result.data.validationUpdate
    : result.data.validationCreate;
  const userErrors = payload.userErrors ?? [];

  if (userErrors.length > 0) {
    throw new Error(
      userErrors
        .map((error) =>
          error.code ? `${error.message} (${error.code})` : error.message
        )
        .join(", ")
    );
  }

  return payload.validation;
}

async function deleteAddressLimitValidation(admin, validation) {
  if (!validation?.id) {
    return null;
  }

  const response = await admin.graphql(
    `mutation ValidationDelete($id: ID!) {
      validationDelete(id: $id) {
        deletedId
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      variables: {
        id: validation.id,
      },
    }
  );
  const result = await graphqlJson(response);
  const userErrors = result.data.validationDelete.userErrors ?? [];

  if (userErrors.length > 0) {
    throw new Error(
      userErrors
        .map((error) =>
          error.code ? `${error.message} (${error.code})` : error.message
        )
        .join(", ")
    );
  }

  return result.data.validationDelete.deletedId;
}

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  try {
    const { shopId, config } = await getShopConfig(admin);
    const validations = await getValidations(admin);
    const validation = findAddressLimitValidation(
      validations,
      config.validationId
    );

    return json({
      shopId,
      config: {
        ...config,
        enabled: Boolean(validation?.enabled),
        validationId: validation?.id ?? config.validationId,
      },
      validation: validation ?? null,
      error: null,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[limite-endereco loader]", error);

    return json({
      shopId: null,
      config: {
        enabled: false,
        ...DEFAULTS,
        validationId: null,
      },
      validation: null,
      error: error?.message || "Erro ao buscar configuracao.",
    });
  }
};

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const enabled = formData.get("enabled") === "true";
    const config = {
      maxStreet: sanitizeInt(formData.get("maxStreet"), DEFAULTS.maxStreet),
      maxNumber: sanitizeInt(formData.get("maxNumber"), DEFAULTS.maxNumber),
      maxComplement: sanitizeInt(formData.get("maxComplement"), DEFAULTS.maxComplement),
      messageStreet: sanitizeStr(formData.get("messageStreet"), DEFAULTS.messageStreet),
      messageNumber: sanitizeStr(formData.get("messageNumber"), DEFAULTS.messageNumber),
      messageComplement: sanitizeStr(formData.get("messageComplement"), DEFAULTS.messageComplement),
    };
    const { shopId, config: currentConfig } = await getShopConfig(admin);
    const validations = await getValidations(admin);
    const existingValidation = findAddressLimitValidation(
      validations,
      currentConfig.validationId
    );

    if (!enabled) {
      const deletedId = await deleteAddressLimitValidation(
        admin,
        existingValidation
      );
      const savedConfig = {
        enabled: false,
        ...config,
        validationId: null,
      };

      await saveShopConfig(admin, shopId, savedConfig);

      return json({
        success: true,
        action: deletedId ? "disabled" : "saved",
        config: savedConfig,
        validation: null,
      });
    }

    const validation = await upsertAddressLimitValidation(
      admin,
      existingValidation,
      config
    );
    const savedConfig = {
      enabled: true,
      ...config,
      validationId: validation.id,
    };

    await saveShopConfig(admin, shopId, savedConfig);

    return json({
      success: true,
      action: existingValidation ? "updated" : "created",
      config: savedConfig,
      validation,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[limite-endereco action]", error);

    return json({
      success: false,
      error: error?.message || "Erro ao salvar limite de endereco.",
    });
  }
};

export default function LimiteEndereco() {
  const { config, validation, error } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";
  const currentConfig = actionData?.config ?? config;
  const currentValidation =
    actionData && "validation" in actionData
      ? actionData.validation
      : validation;
  const [enabled, setEnabled] = useState(currentConfig.enabled);
  const [maxStreet, setMaxStreet] = useState(String(currentConfig.maxStreet));
  const [maxNumber, setMaxNumber] = useState(String(currentConfig.maxNumber));
  const [maxComplement, setMaxComplement] = useState(String(currentConfig.maxComplement));
  const [messageStreet, setMessageStreet] = useState(currentConfig.messageStreet);
  const [messageNumber, setMessageNumber] = useState(currentConfig.messageNumber);
  const [messageComplement, setMessageComplement] = useState(currentConfig.messageComplement);
  const isActive = Boolean(currentValidation?.enabled && currentConfig.enabled);

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.set("enabled", enabled ? "true" : "false");
    formData.set("maxStreet", maxStreet);
    formData.set("maxNumber", maxNumber);
    formData.set("maxComplement", maxComplement);
    formData.set("messageStreet", messageStreet);
    formData.set("messageNumber", messageNumber);
    formData.set("messageComplement", messageComplement);
    submit(formData, { method: "post" });
  }, [enabled, maxStreet, maxNumber, maxComplement, messageStreet, messageNumber, messageComplement, submit]);

  return (
    <Page title="Limite Endereco">
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Nao foi possivel consultar a regra">
            <p>{error}</p>
          </Banner>
        )}

        {actionData?.success && (
          <Banner
            tone="success"
            title={
              actionData.action === "disabled"
                ? "Validacao desativada"
                : actionData.action === "created"
                  ? "Validacao ativada"
                  : "Validacao atualizada"
            }
          >
            <p>Configuracao salva para o checkout.</p>
          </Banner>
        )}

        {actionData?.error && (
          <Banner tone="critical" title="Erro ao salvar limite">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Regra de validacao
                    </Text>
                    <Badge tone={isActive ? "success" : "attention"}>
                      {isActive ? "Ativa" : "Inativa"}
                    </Badge>
                  </InlineStack>

                  <Checkbox
                    label="Ativar validacao no checkout"
                    checked={enabled}
                    onChange={setEnabled}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Rua</Text>
                  <TextField
                    label="Maximo de caracteres"
                    type="number"
                    min={1}
                    max={255}
                    value={maxStreet}
                    onChange={setMaxStreet}
                    autoComplete="off"
                  />
                  <TextField
                    label="Mensagem de erro"
                    value={messageStreet}
                    onChange={setMessageStreet}
                    autoComplete="off"
                    helpText='Use "{max}" para exibir o limite.'
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Numero</Text>
                  <TextField
                    label="Maximo de caracteres"
                    type="number"
                    min={1}
                    max={255}
                    value={maxNumber}
                    onChange={setMaxNumber}
                    autoComplete="off"
                  />
                  <TextField
                    label="Mensagem de erro"
                    value={messageNumber}
                    onChange={setMessageNumber}
                    autoComplete="off"
                    helpText='Use "{max}" para exibir o limite.'
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Complemento</Text>
                  <TextField
                    label="Maximo de caracteres"
                    type="number"
                    min={1}
                    max={255}
                    value={maxComplement}
                    onChange={setMaxComplement}
                    autoComplete="off"
                  />
                  <TextField
                    label="Mensagem de erro"
                    value={messageComplement}
                    onChange={setMessageComplement}
                    autoComplete="off"
                    helpText='Use "{max}" para exibir o limite.'
                  />
                </BlockStack>
              </Card>

              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  loading={isSubmitting}
                >
                  Salvar configuracao
                </Button>
              </InlineStack>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Como funciona
                </Text>
                <Text as="p" variant="bodySm">
                  A Function valida os campos de endereco de entrega no checkout:
                  Rua (<InlineCode>address1</InlineCode>),
                  Numero e Complemento (<InlineCode>address2</InlineCode>).
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Desativar a regra remove a validation ativa da loja.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
