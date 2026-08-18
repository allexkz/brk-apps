import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";

// Block compacto (read-only): resumo das personalizações do rascunho. A edição é
// feita no modal (Admin Action) em "Mais ações → Personalização (PE1198)".
const PERSO_SKU = "PE1198";

async function adminQuery(query, variables = {}) {
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(", "));
  return body.data;
}

const DRAFT_QUERY = `
  query GetDraft($id: ID!) {
    draftOrder(id: $id) {
      lineItems(first: 100) {
        nodes { sku variant { sku } customAttributes { key value } }
      }
    }
  }
`;

function attrsToObj(list) {
  const o = {};
  for (const a of list || []) o[a.key] = a.value;
  return o;
}
function isPerso(node) {
  return (node.sku || node.variant?.sku || "").toUpperCase() === PERSO_SKU;
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const draftId = shopify?.data?.selected?.[0]?.id ?? null;
  const [status, setStatus] = useState("loading");
  const [items, setItems] = useState([]);

  const load = useCallback(async () => {
    if (!draftId) { setStatus("error"); return; }
    setStatus("loading");
    try {
      const data = await adminQuery(DRAFT_QUERY, { id: draftId });
      const perso = (data?.draftOrder?.lineItems?.nodes || []).filter(isPerso);
      setItems(perso.map((p) => attrsToObj(p.customAttributes)));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [draftId]);

  useEffect(() => { load(); }, [load]);

  return (
    <s-admin-block heading="Personalização (PE1198)">
      <s-stack direction="block" gap="base">
        {status === "loading" && <s-text color="subdued">Carregando…</s-text>}
        {status === "error" && <s-text color="subdued">Não foi possível ler o rascunho.</s-text>}

        {status === "ready" && items.length === 0 && (
          <s-text color="subdued">
            Nenhuma personalização. Use “Mais ações → Personalização (PE1198)” para adicionar.
          </s-text>
        )}

        {status === "ready" && items.length > 0 && (
          <>
            {items.map((a, i) => (
              <s-text key={i}>
                {`${i + 1}. `}
                <s-text fontWeight="bold">{a["Nome"] || "(sem nome)"}</s-text>
                {` — ${a["Produto"] || "?"} · ${a["Local"] || "?"}/${a["Posição"] || "?"} · ${a["Tipo"] || "?"}${a["Arte"] ? " · arte ✓" : ""}`}
              </s-text>
            ))}
            <s-text color="subdued">Editar em “Mais ações → Personalização (PE1198)”.</s-text>
          </>
        )}
      </s-stack>
    </s-admin-block>
  );
}
