import { useNavigation } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineGrid, Text, Button } from "@shopify/polaris";

// Home estática: só atalhos para os módulos. Sem loader — o app.jsx já autentica,
// então abrir o app não dispara nenhuma chamada à API da Shopify/KV.
const MODULES = [
  {
    title: "Grupos de Produtos",
    url: "/app/grupos-de-produtos",
    description:
      "Agrupa produtos relacionados (ex: Masculino / Feminino / Infantil) e mostra swatches clicáveis na página de produto.",
  },
  {
    title: "Personalizados",
    url: "/app/personalizados",
    description:
      "Acompanha os pedidos personalizados: grava a personalização no Sankhya e permite o envio manual ao ClickUp.",
  },
  {
    title: "Cadastro de vendedores",
    url: "/app/personalizados/cadastro-de-vendedores",
    description:
      "Associa as tags de pedido a cada vendedor, para atribuir o vendedor na tarefa do ClickUp.",
  },
  {
    title: "BRK Bundles",
    url: "/app/bundles",
    description:
      "Add-ons de upsell, cross-sell e brinde na página de produto, com o desconto aplicado no checkout.",
  },
  {
    title: "Descontos",
    url: "/app/descontos",
    description:
      "Campanha de % de desconto a cada par de itens das coleções escolhidas.",
  },
  {
    // Fora do NavMenu de propósito: a tela consulta pedidos na Shopify a cada
    // abertura, então só é acessada por aqui, sob demanda.
    title: "Trocas",
    url: "/app/trocas",
    description:
      "Lista os pedidos com cupom de TROCA e verifica se o frete grátis foi aplicado corretamente.",
  },
];

export default function Index() {
  // As telas carregam dados no servidor antes de renderizar (pode levar alguns
  // segundos); mostra o spinner no botão clicado enquanto isso.
  const navigation = useNavigation();
  const pendingPath =
    navigation.state === "loading" ? navigation.location?.pathname : null;

  return (
    <Page title="BRK Apps">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {MODULES.map((m) => (
              <Card key={m.url}>
                <BlockStack gap="200" inlineAlign="start">
                  <Button
                    url={m.url}
                    variant="primary"
                    loading={pendingPath === m.url}
                    disabled={Boolean(pendingPath) && pendingPath !== m.url}
                  >
                    {m.title}
                  </Button>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {m.description}
                  </Text>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
