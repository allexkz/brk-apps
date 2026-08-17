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
      <NavMenu>
        <Link to="/app/trocas" rel="home">Trocas</Link>
        <Link to="/app/grupos-de-produtos">Grupos de Produtos</Link>
        <Link to="/app/personalizados">Personalizados</Link>
        <Link to="/app/bundles">BRK Bundles</Link>
        <Link to="/app/descontos">Descontos</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}
