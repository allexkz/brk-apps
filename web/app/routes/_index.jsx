import { redirect } from "@remix-run/cloudflare";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // Preserve Shopify query params (shop, host, embedded, etc.)
  return redirect(`/app${url.search}`);
};
