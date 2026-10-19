import { getShopify } from "../shopify.server";
import { recordBundleSales } from "../bundles-db.server";
import { loadSellers } from "../vendedores";
import { buildPersoFromRestOrder, ingestPersoOrder, orderHasPersoLine } from "../personalizados.server";
import { bundleAttribution, collectDiscountTags, tagsAddToOrder } from "../order-tags.server";

// Webhook orders/create. Cada etapa só faz trabalho quando o pedido precisa dela
// (ver app/order-tags.server.js) — custo por pedido fixo e baixo:
//   1) bundles: só se o pedido tem linha `_brk_bundle` (lê a config, grava no D1, tags);
//   2) campanhas de desconto: só as ativas (na tela Descontos e na Shopify);
//   3) personalização: só se o pedido tem PE1198 (ou, sem o D1 de personalizados, vendedor).
export const action = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { topic, shop, session, admin, payload } =
    await shopify.authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  switch (topic) {
    case "ORDERS_CREATE": {
      try {
        const order = payload;
        const orderGid =
          order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;
        const tagSet = new Set();

        // 1) Bundles: atribuição de vendas (D1) + tags de bundle.
        const { rows, tags: bundleTags } = await bundleAttribution(admin, order);
        if (rows.length > 0) {
          await recordBundleSales(context.env.BUNDLES_DB, shop, rows);
        }
        for (const t of bundleTags) tagSet.add(t);

        // 2) Campanhas de desconto: tag por elegibilidade de coleção (só campanhas ativas).
        for (const t of await collectDiscountTags(admin, order)) tagSet.add(t);

        if (tagSet.size > 0) {
          await tagsAddToOrder(admin, orderGid, [...tagSet]);
        }
      } catch (e) {
        // Não relança: um erro aqui não deve fazer o Shopify reentregar em loop.
        console.error("[webhooks ORDERS_CREATE]", e?.message, e?.stack);
      }

      // Personalização → Sankhya: ingestão do pedido novo (best-effort; o dreno reprocessa
      // até o NUNOTA existir). Isolado num try próprio para não interferir no bloco acima.
      // Sem PE1198 e com o D1 de personalizados, não há nada a registrar → nem lê vendedores.
      try {
        if (orderHasPersoLine(payload) || !context.env.PERSO_DB) {
          const { sellers } = await loadSellers(admin);
          const perso = buildPersoFromRestOrder(payload, sellers);
          await ingestPersoOrder(context.env, context.env.SESSIONS, shop, perso);
        }
      } catch (e) {
        console.error("[webhooks ORDERS_CREATE perso]", e?.message, e?.stack);
      }
      break;
    }

    case "APP_UNINSTALLED":
      if (session) {
        // Clean up session data when the app is uninstalled
      }
      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
