import { json } from "@remix-run/cloudflare";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Thumbnail,
  Badge,
  Spinner,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";

// Fetch all products in a collection (paginated)
async function fetchCollectionProducts(admin, collectionId) {
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const res = await admin.graphql(`
      query {
        collection(id: "${collectionId}") {
          title
          sortOrder
          image { url }
          products(first: 250${afterClause}) {
            edges {
              node {
                id
                title
                featuredImage { url }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `);
    const data = await res.json();
    const collection = data.data.collection;
    if (!collection) return { products: [], title: "", sortOrder: "" };

    for (const edge of collection.products.edges) {
      products.push(edge.node);
    }

    hasNext = collection.products.pageInfo.hasNextPage;
    cursor = collection.products.pageInfo.endCursor;

    if (products.length === 0) break;

    // Return collection metadata from the first page
    if (!cursor || !hasNext) {
      return {
        products,
        title: collection.title,
        sortOrder: collection.sortOrder,
      };
    }
  }

  return { products, title: "", sortOrder: "" };
}

// Fisher-Yates shuffle
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Action ────────────────────────────────────────────────────────────────

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "shuffle") {
      const collectionId = formData.get("collectionId");
      if (!collectionId) {
        return json({ success: false, error: "Nenhuma coleção selecionada." });
      }

      // 1. Fetch all products
      const { products, sortOrder } = await fetchCollectionProducts(admin, collectionId);

      if (products.length < 2) {
        return json({ success: false, error: "A coleção precisa ter pelo menos 2 produtos para embaralhar." });
      }

      // 2. If sort order is not MANUAL, set it to MANUAL first
      if (sortOrder !== "MANUAL") {
        const updateRes = await admin.graphql(
          `mutation collectionUpdate($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              collection { id sortOrder }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              input: {
                id: collectionId,
                sortOrder: "MANUAL",
              },
            },
          }
        );
        const updateData = await updateRes.json();
        const updateErrors = updateData.data.collectionUpdate.userErrors;
        if (updateErrors.length > 0) {
          return json({
            success: false,
            error: `Erro ao definir ordenação manual: ${updateErrors.map((e) => e.message).join(", ")}`,
          });
        }
      }

      // 3. Shuffle and build moves
      const shuffled = shuffle(products);
      const moves = shuffled.map((product, index) => ({
        id: product.id,
        newPosition: String(index),
      }));

      // 4. Reorder products
      const reorderRes = await admin.graphql(
        `mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            job { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            id: collectionId,
            moves,
          },
        }
      );

      const reorderData = await reorderRes.json();
      const reorderErrors = reorderData.data.collectionReorderProducts.userErrors;
      if (reorderErrors.length > 0) {
        return json({
          success: false,
          error: `Erro ao embaralhar: ${reorderErrors.map((e) => e.message).join(", ")}`,
        });
      }

      return json({
        success: true,
        productCount: products.length,
        wasManual: sortOrder === "MANUAL",
      });
    }

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[embaralhar action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ─────────────────────────────────────────────────────────────

export default function Embaralhar() {
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSubmitting = navigation.state === "submitting";

  const [selectedCollection, setSelectedCollection] = useState(null);

  const handlePickCollection = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: false,
      action: "select",
    });
    if (!selected || selected.length === 0) return;
    const collection = selected[0];
    setSelectedCollection({
      id: collection.id,
      title: collection.title,
      image: collection.image?.originalSrc ?? null,
      productsCount: collection.productsCount ?? null,
    });
  }, [shopify]);

  const handleShuffle = useCallback(() => {
    if (!selectedCollection) return;
    const fd = new FormData();
    fd.set("intent", "shuffle");
    fd.set("collectionId", selectedCollection.id);
    submit(fd, { method: "post" });
  }, [selectedCollection, submit]);

  return (
    <Page
      title="Embaralhar Coleção"
      subtitle="Reordena aleatoriamente os produtos de uma coleção."
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title="Coleção embaralhada!">
            <p>
              {actionData.productCount} produtos foram reordenados aleatoriamente.
              {!actionData.wasManual && " A ordenação da coleção foi alterada para manual."}
            </p>
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
                <Text as="h2" variant="headingMd">Coleção</Text>

                {selectedCollection ? (
                  <InlineStack gap="400" blockAlign="center">
                    {selectedCollection.image && (
                      <Thumbnail
                        source={selectedCollection.image}
                        alt={selectedCollection.title}
                        size="medium"
                      />
                    )}
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd" fontWeight="bold">
                        {selectedCollection.title}
                      </Text>
                      {selectedCollection.productsCount != null && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {selectedCollection.productsCount} produtos
                        </Text>
                      )}
                    </BlockStack>
                    <Button variant="plain" onClick={handlePickCollection}>
                      Trocar coleção
                    </Button>
                  </InlineStack>
                ) : (
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      Selecione a coleção cujos produtos serão embaralhados.
                    </Text>
                    <Button onClick={handlePickCollection}>
                      Selecionar coleção
                    </Button>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <div style={{ marginTop: "16px" }}>
              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleShuffle}
                  loading={isSubmitting}
                  disabled={!selectedCollection}
                >
                  Embaralhar
                </Button>
              </InlineStack>
            </div>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Como funciona</Text>
                <Text as="p" variant="bodySm">
                  1. Selecione uma coleção.
                </Text>
                <Text as="p" variant="bodySm">
                  2. Clique em "Embaralhar" para reordenar os produtos aleatoriamente.
                </Text>
                <Text as="p" variant="bodySm">
                  3. A ordenação da coleção será alterada para <strong>manual</strong> automaticamente, caso ainda não esteja.
                </Text>
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    Você pode embaralhar quantas vezes quiser. Cada clique gera uma nova ordem aleatória.
                  </Text>
                </Banner>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
