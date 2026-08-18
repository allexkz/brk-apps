import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";

// SKU do item de personalização. As chaves de atributo precisam bater 1:1 com o
// modal do site (buildOrderData lê props["Produto"], ["Nome"], etc.).
const PERSO_SKU = "PE1198";
const PERSO_TAG = "Nome Personalizado";

const TIPO_OPTS = ["Nome", "Nome da Empresa"];
const LOCAL_OPTS = ["Frente", "Costas"];
const POSICAO_BY_LOCAL = {
  Frente: ["Peito Esquerdo", "Peito Direito"],
  Costas: ["Costas Cima", "Costas Baixo"],
};

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
      id
      tags
      lineItems(first: 100) {
        nodes {
          uuid
          quantity
          title
          sku
          variant { id sku title product { title } }
          customAttributes { key value }
          requiresShipping
          taxable
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          appliedDiscount { title description value valueType }
        }
      }
    }
  }
`;

const FIND_PERSO_VARIANT = `
  query { productVariants(first: 10, query: "sku:${PERSO_SKU}") { nodes { id sku } } }
`;

const UPDATE_MUTATION = `
  mutation UpdateDraft($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { id }
      userErrors { field message }
    }
  }
`;

function attrsToObj(list) {
  const o = {};
  for (const a of list || []) o[a.key] = a.value;
  return o;
}
function lineSku(node) {
  return (node.sku || node.variant?.sku || "").toUpperCase();
}
function isPerso(node) {
  return lineSku(node) === PERSO_SKU;
}

function reconstructOther(node) {
  const line = { uuid: node.uuid, quantity: node.quantity };
  const attrs = attrsToObj(node.customAttributes);
  line.customAttributes = Object.entries(attrs)
    .filter(([, v]) => v !== "" && v != null)
    .map(([key, value]) => ({ key, value: String(value) }));
  if (node.variant?.id) {
    line.variantId = node.variant.id;
    line.generatePriceOverride = true;
  } else {
    line.title = node.title;
    const amt = node.originalUnitPriceSet?.shopMoney;
    if (amt) line.originalUnitPriceWithCurrency = { amount: amt.amount, currencyCode: amt.currencyCode };
    if (node.requiresShipping != null) line.requiresShipping = node.requiresShipping;
    if (node.taxable != null) line.taxable = node.taxable;
  }
  if (node.appliedDiscount) {
    line.appliedDiscount = {
      title: node.appliedDiscount.title,
      description: node.appliedDiscount.description,
      value: node.appliedDiscount.value,
      valueType: node.appliedDiscount.valueType,
    };
  }
  return line;
}

function persoLineInput(variantId, row) {
  const attrs = { Produto: row.Produto, Nome: row.Nome, Local: row.Local, "Posição": row["Posição"], Tipo: row.Tipo, Arte: row.Arte };
  return {
    variantId,
    quantity: 1,
    customAttributes: Object.entries(attrs)
      .filter(([, v]) => v !== "" && v != null)
      .map(([key, value]) => ({ key, value: String(value) })),
  };
}

let ROW_SEQ = 0;
function makeRow(produto = "", qtd = 1, extra = {}) {
  ROW_SEQ += 1;
  return { id: `r${ROW_SEQ}`, Produto: produto, Nome: "", Tipo: "", Local: "", "Posição": "", Arte: "", Qtd: String(qtd), ...extra };
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const draftId = shopify?.data?.selected?.[0]?.id ?? null;

  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [otherNodes, setOtherNodes] = useState([]);
  const [garments, setGarments] = useState([]);
  const [variantId, setVariantId] = useState(null);
  const [draftTags, setDraftTags] = useState([]);
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!draftId) { setStatus("error"); setError("Sem draft order no contexto."); return; }
    setStatus("loading"); setError("");
    try {
      const data = await adminQuery(DRAFT_QUERY, { id: draftId });
      const all = data?.draftOrder?.lineItems?.nodes || [];
      const perso = all.filter(isPerso);
      const others = all.filter((n) => !isPerso(n));
      const garm = others
        .map((n) => ({ sku: n.sku || n.variant?.sku || "", title: n.variant?.product?.title || n.title || "(sem título)", quantity: n.quantity || 1 }))
        .filter((g) => g.sku);

      let vId = perso[0]?.variant?.id || null;
      if (!vId) {
        const v = await adminQuery(FIND_PERSO_VARIANT);
        vId = (v?.productVariants?.nodes || []).find((n) => (n.sku || "").toUpperCase() === PERSO_SKU)?.id || null;
      }

      let initRows;
      if (perso.length) {
        // Editar: uma linha por PE1198 existente (cada uma qtd 1).
        initRows = perso.map((p) => {
          const a = attrsToObj(p.customAttributes);
          return makeRow(a["Produto"] || "", 1, {
            Nome: a["Nome"] || "", Tipo: a["Tipo"] || "", Local: a["Local"] || "",
            "Posição": a["Posição"] || "", Arte: a["Arte"] || "",
          });
        });
      } else {
        // Novo: pré-preenche uma linha por peça, já com a quantidade da peça.
        initRows = garm.length ? garm.map((g) => makeRow(g.sku, g.quantity)) : [makeRow("", 1)];
      }

      setOtherNodes(others);
      setGarments(garm);
      setVariantId(vId);
      setDraftTags(data?.draftOrder?.tags || []);
      setRows(initRows);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(String(e?.message || e));
    }
  }, [draftId]);

  useEffect(() => { load(); }, [load]);

  const setField = useCallback((id, key, val) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, [key]: val };
      if (key === "Local") {
        const valid = POSICAO_BY_LOCAL[val] || [];
        if (!valid.includes(next["Posição"])) next["Posição"] = "";
      }
      return next;
    }));
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, makeRow(garments.length === 1 ? garments[0].sku : "", 1)]);
  }, [garments]);

  const removeRow = useCallback((id) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const rowQtd = (r) => Math.max(1, parseInt(r.Qtd, 10) || 0);
  const rowValid = (r) => r.Produto && r.Nome.trim() && r.Tipo && r.Local && r["Posição"] && (parseInt(r.Qtd, 10) || 0) >= 1;
  const allValid = rows.length > 0 && rows.every(rowValid);
  const totalCount = rows.reduce((s, r) => s + rowQtd(r), 0);

  const handleSave = useCallback(async () => {
    setSaving(true); setError("");
    try {
      if (!variantId) throw new Error(`Produto ${PERSO_SKU} não encontrado na loja.`);
      const others = otherNodes.map(reconstructOther);
      const persoLines = [];
      for (const r of rows) {
        const n = rowQtd(r);
        for (let i = 0; i < n; i++) persoLines.push(persoLineInput(variantId, r));
      }
      const tags = Array.from(new Set([...(draftTags || []), PERSO_TAG]));
      const data = await adminQuery(UPDATE_MUTATION, { id: draftId, input: { lineItems: [...others, ...persoLines], tags } });
      const errs = data?.draftOrderUpdate?.userErrors || [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
      // Sucesso: fecha o modal → o admin recarrega a página do draft.
      shopify.close();
      return;
    } catch (e) {
      setError(String(e?.message || e));
      setSaving(false);
    }
  }, [variantId, otherNodes, rows, draftTags, draftId]);

  return (
    <s-admin-action heading="Personalização (PE1198)" loading={status === "loading"}>
      <s-stack direction="block" gap="base">
        {status === "error" && <s-banner tone="critical" heading="Erro">{error || "Falha ao carregar."}</s-banner>}

        {status === "ready" && (
          <>
            <s-banner tone="warning">
              Preencha e salve ANTES de enviar a fatura. Após o pagamento o rascunho vira pedido e
              estes atributos não podem mais ser editados aqui.
            </s-banner>

            {garments.length === 0 && (
              <s-banner tone="info">Adicione as peças (camisas) ao rascunho antes de personalizar.</s-banner>
            )}

            {rows.map((r, idx) => {
              const posicaoOpts = POSICAO_BY_LOCAL[r.Local] || [];
              return (
                <s-section key={r.id} heading={`Personalização ${idx + 1}`}>
                  <s-stack direction="block" gap="base">
                    <s-select label="Produto (peça)" value={r.Produto} onChange={(e) => setField(r.id, "Produto", e.currentTarget.value)}>
                      <s-option value="">— selecione a peça —</s-option>
                      {garments.map((g) => (<s-option key={g.sku} value={g.sku}>{g.title} ({g.sku})</s-option>))}
                    </s-select>
                    <s-number-field label="Quantidade (peças com este mesmo nome)" value={r.Qtd} min={1} onInput={(e) => setField(r.id, "Qtd", e.currentTarget.value)} />
                    <s-text-field label="Nome" value={r.Nome} onInput={(e) => setField(r.id, "Nome", e.currentTarget.value)} />
                    <s-select label="Tipo" value={r.Tipo} onChange={(e) => setField(r.id, "Tipo", e.currentTarget.value)}>
                      <s-option value="">— selecione —</s-option>
                      {TIPO_OPTS.map((t) => (<s-option key={t} value={t}>{t}</s-option>))}
                    </s-select>
                    <s-select label="Local" value={r.Local} onChange={(e) => setField(r.id, "Local", e.currentTarget.value)}>
                      <s-option value="">— selecione —</s-option>
                      {LOCAL_OPTS.map((l) => (<s-option key={l} value={l}>{l}</s-option>))}
                    </s-select>
                    <s-select label="Posição" value={r["Posição"]} disabled={!r.Local} onChange={(e) => setField(r.id, "Posição", e.currentTarget.value)}>
                      <s-option value="">{r.Local ? "— selecione —" : "escolha o Local primeiro"}</s-option>
                      {posicaoOpts.map((p) => (<s-option key={p} value={p}>{p}</s-option>))}
                    </s-select>
                    <s-text-field label="Arte (URL, opcional)" value={r.Arte} onInput={(e) => setField(r.id, "Arte", e.currentTarget.value)} />
                    {rows.length > 1 && (
                      <s-button variant="tertiary" tone="critical" onClick={() => removeRow(r.id)}>Remover esta personalização</s-button>
                    )}
                  </s-stack>
                </s-section>
              );
            })}

            <s-button variant="tertiary" onClick={addRow}>Adicionar personalização</s-button>

            {error && <s-banner tone="critical" dismissible onDismiss={() => setError("")}>{error}</s-banner>}
            {!allValid && <s-text color="subdued">Em cada personalização, preencha Produto, Quantidade, Nome, Tipo, Local e Posição.</s-text>}
          </>
        )}
      </s-stack>

      <s-button slot="primary-action" variant="primary" onClick={handleSave} disabled={saving || status !== "ready" || !allValid} loading={saving}>
        {saving ? "Salvando…" : `Salvar ${totalCount} personalização(ões)`}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()} disabled={saving}>Fechar</s-button>
    </s-admin-action>
  );
}
