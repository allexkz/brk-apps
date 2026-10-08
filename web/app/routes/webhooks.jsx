import { getShopify } from "../shopify.server";
import { loadSellers } from "../vendedores";
import { buildPersoFromRestOrder, ingestPersoOrder, orderHasPersoLine } from "../personalizados.server";
import { collectDiscountTags, tagsAddToOrder } from "../order-tags.server";

// Webhook orders/create (motors — sem BRK Bundles). Cada etapa só faz trabalho quando o
// pedido precisa dela (ver app/order-tags.server.js) — custo por pedido fixo e baixo:
//   1) campanhas de desconto: só as ativas (na tela Descontos e na Shopify);
//   2) personalização: só se o pedido tem PE1198 (ou, sem o D1 de personalizados, vendedor).
export const action = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { topic, session, admin, payload, shop } =
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
        const tags = await collectDiscountTags(admin, order);
        if (tags.length > 0) {
          await tagsAddToOrder(admin, orderGid, tags);
        }
      } catch (e) {
        // Não relança: um erro aqui não deve fazer o Shopify reentregar em loop.
        console.error("[webhooks ORDERS_CREATE]", e?.message, e?.stack);
      }

      // Personalização → Sankhya: ingestão do pedido novo (best-effort; o dreno reprocessa
      // até o NUNOTA existir). Isolado num try próprio.
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
