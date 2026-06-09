import { getShopify } from "../shopify.server";

export const action = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { topic, shop, session, admin } = await shopify.authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  switch (topic) {
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
