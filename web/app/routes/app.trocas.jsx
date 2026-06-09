import { json } from "@remix-run/cloudflare";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { useState, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  Select,
  BlockStack,
  InlineStack,
  EmptyState,
  Pagination,
  Banner,
  Box,
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "next";

  try {
    const queryField =
      direction === "prev"
        ? `last: 50, before: "${cursor}"`
        : cursor
          ? `first: 50, after: "${cursor}"`
          : `first: 50`;

    const response = await admin.graphql(`
      query {
        orders(${queryField}, query: "discount_code:*TROCA*", sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              customer {
                displayName
                email
              }
              discountCodes
              totalShippingPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              shippingLines(first: 5) {
                edges {
                  node {
                    title
                    originalPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    discountedPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    discountAllocations {
                      allocatedAmountSet {
                        shopMoney {
                          amount
                        }
                      }
                      discountApplication {
                        ... on AutomaticDiscountApplication {
                          title
                        }
                        ... on DiscountCodeApplication {
                          code
                        }
                        ... on ScriptDiscountApplication {
                          title
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `);

    const data = await response.json();

    if (!data.data?.orders) {
      return json({
        orders: [],
        pageInfo: null,
        error: `Erro ao buscar pedidos: ${JSON.stringify(data.errors || "resposta vazia")}`,
      });
    }

    const orders = data.data.orders.edges.map((edge) => {
      const order = edge.node;

      // Find the TROCA discount code
      const trocaCode =
        order.discountCodes.find((code) =>
          code.toUpperCase().includes("TROCA")
        ) || order.discountCodes[0] || "—";

      const shippingLines = order.shippingLines.edges.map((e) => e.node);

      // Calculate shipping amounts
      const totalShippingOriginal = shippingLines.reduce((sum, line) => {
        return sum + parseFloat(line.originalPriceSet?.shopMoney?.amount || "0");
      }, 0);

      const totalShippingCharged = shippingLines.reduce((sum, line) => {
        return sum + parseFloat(line.discountedPriceSet?.shopMoney?.amount || "0");
      }, 0);

      // Check discount allocations on shipping
      const shippingDiscounts = shippingLines.flatMap((line) =>
        (line.discountAllocations || []).map((alloc) => ({
          amount: parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount || "0"),
          source:
            alloc.discountApplication?.code ||
            alloc.discountApplication?.title ||
            "desconhecido",
        }))
      );

      const freeShippingApplied =
        totalShippingOriginal > 0 && totalShippingCharged === 0;
      const noShipping = shippingLines.length === 0;

      // Determine status and error details
      let status = "ok";
      let errorDetail = null;

      if (noShipping) {
        status = "no_shipping";
        errorDetail = "Pedido sem método de envio selecionado";
      } else if (!freeShippingApplied && totalShippingOriginal > 0) {
        status = "error";
        if (shippingDiscounts.length === 0) {
          errorDetail =
            "Frete grátis NÃO foi aplicado — nenhum desconto de frete detectado. Possível causa: o cupom não ativou a function de frete grátis.";
        } else {
          errorDetail = `Desconto de frete parcial: ${shippingDiscounts.map((d) => `${d.source}: R$${d.amount.toFixed(2)}`).join(", ")}`;
        }
      }

      return {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        customer:
          order.customer?.displayName || order.customer?.email || "—",
        trocaCode,
        shippingOriginal: totalShippingOriginal,
        shippingCharged: totalShippingCharged,
        shippingMethod:
          shippingLines.map((l) => l.title).join(", ") || "—",
        freeShippingApplied,
        noShipping,
        status,
        errorDetail,
        shippingDiscounts,
      };
    });

    return json({
      orders,
      pageInfo: data.data.orders.pageInfo,
      error: null,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("Trocas loader error:", error?.message, error?.stack);
    return json({
      orders: [],
      pageInfo: null,
      error: `Erro ao carregar pedidos: ${error?.message || "erro desconhecido"}`,
    });
  }
};

export default function Trocas() {
  const { orders, pageInfo, error } = useLoaderData();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");

  const filteredOrders = useMemo(() => {
    if (filter === "all") return orders;
    if (filter === "errors") return orders.filter((o) => o.status === "error");
    if (filter === "ok") return orders.filter((o) => o.status === "ok");
    if (filter === "no_shipping")
      return orders.filter((o) => o.status === "no_shipping");
    return orders;
  }, [orders, filter]);

  const stats = useMemo(() => {
    const total = orders.length;
    const ok = orders.filter((o) => o.status === "ok").length;
    const errors = orders.filter((o) => o.status === "error").length;
    const noShipping = orders.filter((o) => o.status === "no_shipping").length;
    return { total, ok, errors, noShipping };
  }, [orders]);

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(amount);
  };

  const getStatusBadge = (order) => {
    if (order.status === "no_shipping") {
      return <Badge tone="attention">Sem frete</Badge>;
    }
    if (order.status === "ok") {
      return <Badge tone="success">Frete grátis OK</Badge>;
    }
    return <Badge tone="critical">Erro no frete</Badge>;
  };

  const handlePagination = (direction) => {
    const cursor =
      direction === "next" ? pageInfo.endCursor : pageInfo.startCursor;
    navigate(`/app/trocas?cursor=${cursor}&direction=${direction}`);
  };

  const rowMarkup = filteredOrders.map((order, index) => {
    const orderId = order.id.replace("gid://shopify/Order/", "");
    return (
      <IndexTable.Row id={order.id} key={order.id} position={index}>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="bold">
            {order.name}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{formatDate(order.createdAt)}</IndexTable.Cell>
        <IndexTable.Cell>{order.customer}</IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">
            {order.trocaCode}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{order.shippingMethod}</IndexTable.Cell>
        <IndexTable.Cell>
          {order.shippingOriginal > 0 ? (
            <Text
              as="span"
              tone={order.shippingCharged > 0 ? "critical" : "success"}
            >
              {formatCurrency(order.shippingCharged)}
              {order.shippingCharged > 0 &&
                ` (original: ${formatCurrency(order.shippingOriginal)})`}
            </Text>
          ) : (
            <Text as="span" tone="subdued">—</Text>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>{getStatusBadge(order)}</IndexTable.Cell>
        <IndexTable.Cell>
          {order.errorDetail ? (
            <Text as="span" variant="bodySm" tone="critical">
              {order.errorDetail}
            </Text>
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">—</Text>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Trocas - Frete Grátis">
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical">
            <p>{error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Total</Text>
                <Text as="p" variant="headingLg">{stats.total}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Frete grátis OK</Text>
                <Text as="p" variant="headingLg" tone="success">
                  {stats.ok}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Com erro</Text>
                <Text as="p" variant="headingLg" tone="critical">
                  {stats.errors}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card padding="0">
              <BlockStack>
                <Box padding="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Pedidos com cupom TROCA
                    </Text>
                    <Box minWidth="200px">
                      <Select
                        label="Filtrar"
                        labelHidden
                        options={[
                          { label: `Todos (${stats.total})`, value: "all" },
                          {
                            label: `Com erro (${stats.errors})`,
                            value: "errors",
                          },
                          { label: `OK (${stats.ok})`, value: "ok" },
                          {
                            label: `Sem frete (${stats.noShipping})`,
                            value: "no_shipping",
                          },
                        ]}
                        value={filter}
                        onChange={setFilter}
                      />
                    </Box>
                  </InlineStack>
                </Box>

                {filteredOrders.length === 0 ? (
                  <Box padding="400">
                    <EmptyState heading="Nenhum pedido encontrado" image="">
                      <p>
                        {filter === "all"
                          ? "Não há pedidos com cupons TROCA."
                          : "Nenhum pedido corresponde ao filtro selecionado."}
                      </p>
                    </EmptyState>
                  </Box>
                ) : (
                  <IndexTable
                    resourceName={{
                      singular: "pedido",
                      plural: "pedidos",
                    }}
                    itemCount={filteredOrders.length}
                    headings={[
                      { title: "Pedido" },
                      { title: "Data" },
                      { title: "Cliente" },
                      { title: "Cupom" },
                      { title: "Envio" },
                      { title: "Frete Cobrado" },
                      { title: "Status" },
                      { title: "Detalhe do Erro" },
                    ]}
                    selectable={false}
                  >
                    {rowMarkup}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {pageInfo && (
            <Layout.Section>
              <InlineStack align="center">
                <Pagination
                  hasPrevious={pageInfo.hasPreviousPage}
                  onPrevious={() => handlePagination("prev")}
                  hasNext={pageInfo.hasNextPage}
                  onNext={() => handlePagination("next")}
                />
              </InlineStack>
            </Layout.Section>
          )}
        </Layout>
      </BlockStack>
    </Page>
  );
}
