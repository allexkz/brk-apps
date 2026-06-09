import { json } from "@remix-run/cloudflare";
import { Form, useActionData } from "@remix-run/react";
import { useState } from "react";

import { getShopify } from "../../shopify.server";

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const errors = await shopify.login(request);
  return json({ errors: errors?.errors || {} });
};

export const action = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const errors = await shopify.login(request);
  return json({ errors: errors?.errors || {} });
};

export default function AuthLogin() {
  const actionData = useActionData();
  const [shop, setShop] = useState("");

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "400px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Log in</h1>
      <Form method="post">
        {actionData?.errors?.shop && (
          <p style={{ color: "red", marginBottom: "1rem" }}>{actionData.errors.shop}</p>
        )}
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Domínio da loja
        </label>
        <input
          type="text"
          name="shop"
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          placeholder="ex: minha-loja.myshopify.com"
          style={{ width: "100%", padding: "0.5rem", marginBottom: "1rem", border: "1px solid #ccc", borderRadius: "4px" }}
        />
        <button
          type="submit"
          style={{ padding: "0.5rem 1rem", background: "#008060", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          Log in
        </button>
      </Form>
    </div>
  );
}
