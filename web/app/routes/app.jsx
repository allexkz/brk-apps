import { json } from "@remix-run/cloudflare";
import { Link, Outlet, useLoaderData } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { getShopify } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  await shopify.authenticate.admin(request);
  return json({ apiKey: context.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      {/* Polaris web components (<s-*>), logo após o app-bridge.js (ordem documentada).
          Canal "polaris-1" fixo na v1 (a v2 não entra sozinha). Convive com o Polaris
          React das outras telas (Shadow DOM, sem conflito de CSS). */}
      <script src="https://cdn.shopify.com/shopifycloud/polaris-1.js" />
      <NavMenu>
        <Link to="/app" rel="home">Início</Link>
        <Link to="/app/grupos-de-produtos">Grupos de Produtos</Link>
        <Link to="/app/personalizados">Personalizados</Link>
        <Link to="/app/bundles">BRK Bundles</Link>
        <Link to="/app/descontos">Descontos</Link>
        <Link to="/app/skus-sankhya">SKUs Sankhya</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}
