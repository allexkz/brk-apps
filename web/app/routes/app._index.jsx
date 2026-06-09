import { redirect } from "@remix-run/cloudflare";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  return redirect(`/app/trocas${url.search}`);
};
