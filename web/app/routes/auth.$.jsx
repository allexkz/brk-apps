import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  await shopify.authenticate.admin(request);
  return null;
};
