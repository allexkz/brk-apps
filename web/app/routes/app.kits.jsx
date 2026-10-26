import { json } from "@remix-run/cloudflare";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Select,
  Checkbox,
  DataTable,
  Badge,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";

// Tela "Kits" (Camisa + Botina): cria bundles fixos NATIVOS da Shopify via a rota de
// recurso app.kits_.api.jsx. O estoque do kit vem dos componentes e a venda dá baixa na
// camisa e na botina originais; o pedido chega com as linhas dos componentes (SKUs reais).
// Atenção: os componentes de um bundle só podem ser editados pelo app que os atribuiu —
// kits criados aqui são mantidos por esta tela/API, não pela interface do app Bundles.
// Publicar no canal "Loja virtual" é feito no admin (o app não tem write_publications).

// Seleção manual do usuário (out/2026): 15 masculinas + 14 femininas (sem SKUs _FULL).
const PRESETS = {
  masculino: {
    boot: "9587666616617",
    shirts: [
      "10130761974057", // C02832 Apache Bege Azul
      "9607972684073", // C01023 Térmica Basic Preta
      "9608744927529", // C01045 Térmica Basic Cinza
      "9609753657641", // C01043 Térmica Basic Areia
      "9876827537705", // C02569 Essência do Agro
      "9607983169833", // C01850 Camu Verde Long Horn
      "9609759523113", // C01458 Básica Preta
      "9616732094761", // C01044 Térmica Basic Azul Naval
      "10109787078953", // C02830 São Bento Medalhão Preto
      "9553346560297", // CASUAL379 Camiseta Patriota Branca (99,90)
      "9656784191785", // C01963 Bandeira do Brasil
      "9650382897449", // C0492 Agro Brk Brasil
      "9650755666217", // C01794 Preta Bandeira do Brasil
      "9553351016745", // C01824 Básica Patriota Bandeira do Brasil Branca
      "9717555364137", // C02260 Azul Trator Bandeira do Brasil
    ],
  },
  feminino: {
    boot: "10091739676969",
    shirts: [
      "10021156258089", // C02685BL Cow Print Marrom
      "10021154193705", // C02647BL Wild Horse Pôr do Sol Laranja
      "9650755961129", // C01794BL Preta Brasil
      "9650382766377", // C0492BL Brasil
      "10021154292009", // C02650BL Wild Horse Bege
      "9635912974633", // C02001BL Camuflado Preto e Rosa Bandeira do Brasil
      "9607982940457", // C01850BL Camu Verde Long Horn
      "9653084029225", // C02047BL Camuflado Long Horn Brasil Azul
      "9609804775721", // C01367BL Nossa Senhora
      "10130895995177", // C02861BL NS Aparecida Aquarela
      "10130895929641", // C02860BL NS Aparecida Portuguesa
      "10021156061481", // C02682BL Cow Print Bege
      "10021156356393", // C02686BL Cow Print Preta
      "9737319088425", // C01824BL Básica Patriota Bandeira do Brasil Branca
    ],
  },
};

export const loader = async ({ request, context }) => {
  await getShopify(context.env).authenticate.admin(request);
  return json({});
};

// ── UI ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const brl = (v) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`;

export default function Kits() {
  const shopify = useAppBridge();
  // Chamada à action desta rota, com o session token do App Bridge.
  const call = useCallback(async (payload) => {
    const token = await shopify.idToken();
    const res = await fetch("/app/kits/api", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: res.status === 401 ? "Sessão expirada: recarregue a página." : `Erro HTTP ${res.status}` };
    return res.json();
  }, [shopify]);
  const [pairsText, setPairsText] = useState("");
  const [pct, setPct] = useState("10");
  // Preço fixo do kit por botina (vale quando é menor que camisa + botina; senão, o %).
  const [fixedBoy, setFixedBoy] = useState("329.90");
  const [fixedGirl, setFixedGirl] = useState("479.90");
  const [active, setActive] = useState(true);
  const [seoHidden, setSeoHidden] = useState(true);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadPreset = useCallback((key) => {
    const p = PRESETS[key];
    setPairsText((t) => [t.trim(), ...p.shirts.map((s) => `${s},${p.boot}`)].filter(Boolean).join("\n"));
  }, []);

  const parsePairs = () =>
    pairsText
      .split(/\n+/)
      .map((l) => l.split(/[,;\s]+/).filter(Boolean))
      .filter((p) => p.length)
      .map(([shirtId, bootId]) => ({ shirtId, bootId }));

  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // A Shopify recusa gravar enquanto outra coisa (ex.: automação do Flow em produto novo)
  // mexe no produto: repete com espera crescente.
  const callRetry = async (payload) => {
    let r;
    for (let t = 0; t < 8; t++) {
      r = await call(payload);
      if (r.ok || !/being modified|try again/i.test(r.error || "")) return r;
      await sleep(3000 + t * 2000);
    }
    return r;
  };

  const finish = async (i, base, productId) => {
    update(i, { state: "completando" });
    const fin = await callRetry({ intent: "finish", ...base, productId, active, seoHidden });
    update(i, fin.ok ? { state: "criado", result: fin, productId } : { state: "erro", msg: fin.error, result: { productId }, productId });
  };

  const run = async (mode) => {
    setError("");
    const pairs = parsePairs();
    if (!pairs.length) return setError("Informe ao menos um par camisa,botina (IDs numéricos).");
    setBusy(true);
    setRows(pairs.map((p) => ({ ...p, state: "aguardando" })));
    for (let i = 0; i < pairs.length; i++) {
      const fixed = { [PRESETS.masculino.boot]: fixedBoy, [PRESETS.feminino.boot]: fixedGirl }[pairs[i].bootId] || null;
      const base = { ...pairs[i], pct: Number(pct), fixed };
      const pv = await call({ intent: "preview", ...base });
      if (!pv.ok) { update(i, { state: "erro", msg: pv.error }); continue; }
      const st0 = pv.existing ? (pv.existingComplete ? "já existe" : "incompleto") : "ok";
      // Campos editáveis da linha: valor atual do kit (se existe) ou o calculado.
      update(i, {
        state: st0,
        preview: pv,
        productId: pv.existing || null,
        editPrice: pv.current?.price ?? pv.price[0],
        editCompare: pv.current?.compareAt ?? pv.compareAt[0],
      });
      if (mode === "reprice") {
        if (!pv.existing) continue;
        update(i, { state: "atualizando" });
        const rp = await callRetry({ intent: "reprice", ...base, productId: pv.existing });
        update(i, rp.ok ? { state: "preço ok", editPrice: rp.price, editCompare: rp.compareAt } : { state: "erro", msg: rp.error });
        continue;
      }
      if (mode !== "create" || st0 === "já existe") continue;
      // Kit criado antes mas sem preço/tags/fotos: só completa (não cria outro).
      if (st0 === "incompleto") { await finish(i, base, pv.existing); continue; }

      update(i, { state: "criando" });
      const cr = await callRetry({ intent: "create", ...base });
      if (!cr.ok) { update(i, { state: "erro", msg: cr.error }); continue; }
      let productId = null;
      let failMsg = "Tempo esgotado aguardando o bundle.";
      for (let t = 0; t < 60 && !productId; t++) {
        await sleep(2000);
        const st = await call({ intent: "status", operationId: cr.operationId });
        if (!st.ok) { failMsg = st.error; break; }
        if (st.status === "COMPLETE") productId = st.productId;
      }
      if (!productId) { update(i, { state: "erro", msg: failMsg }); continue; }
      await sleep(4000); // deixa a automação de produto novo terminar antes de gravar
      await finish(i, base, productId);
    }
    setBusy(false);
  };

  // Salva preço/riscado digitados na linha (todas as variantes daquele kit).
  const saveRow = async (i) => {
    const r = rows[i];
    if (!r?.productId) return;
    update(i, { state: "salvando", msg: "" });
    const fixed = { [PRESETS.masculino.boot]: fixedBoy, [PRESETS.feminino.boot]: fixedGirl }[r.bootId] || null;
    const rp = await callRetry({
      intent: "reprice", shirtId: r.shirtId, bootId: r.bootId, pct: Number(pct), fixed,
      productId: r.productId, price: r.editPrice, compareAt: r.editCompare,
    });
    update(i, rp.ok ? { state: "preço ok", editPrice: rp.price, editCompare: rp.compareAt } : { state: "erro", msg: rp.error });
  };

  const tone = { ok: "info", criado: "success", erro: "critical", "já existe": "attention", incompleto: "warning", "preço ok": "success" };
  const table = rows.map((r, i) => [
    r.preview?.title || `${r.shirtId} + ${r.bootId}`,
    <Badge key="s" tone={tone[r.state]}>{r.state}</Badge>,
    r.preview ? `${r.preview.variants} (${r.preview.shirtSizes.length}×${r.preview.bootSizes.length})` : "",
    r.preview ? `soma ${brl(r.preview.compareAt[0])}${r.preview.compareAt[1] !== r.preview.compareAt[0] ? `–${brl(r.preview.compareAt[1])}` : ""}` : "",
    r.productId ? (
      <InlineStack key="e" gap="200" blockAlign="end" wrap={false}>
        <div style={{ width: 110 }}>
          <TextField label="Preço" labelHidden prefix="R$" value={r.editPrice ?? ""} onChange={(v) => update(i, { editPrice: v })} autoComplete="off" disabled={busy} />
        </div>
        <div style={{ width: 110 }}>
          <TextField label="Riscado" labelHidden prefix="R$" value={r.editCompare ?? ""} onChange={(v) => update(i, { editCompare: v })} autoComplete="off" disabled={busy} />
        </div>
        <Button size="slim" onClick={() => saveRow(i)} disabled={busy || r.state === "salvando"}>Salvar</Button>
      </InlineStack>
    ) : r.preview ? `${brl(r.preview.price[0])} (a criar)` : "",
    r.msg || (r.result?.handle ? `/products/${r.result.handle} (${r.result.status})` : ""),
  ]);

  return (
    <Page title="Kits Camisa + Botina" subtitle="Bundles fixos nativos — a venda dá baixa na camisa e na botina originais">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Banner tone="info">
                Componentes de kits criados aqui só podem ser alterados por esta tela/API (regra da Shopify).
                Depois de criar, inclua os kits no canal <b>Loja virtual</b> pelo admin.
              </Banner>
              <InlineStack gap="200">
                <Button onClick={() => loadPreset("masculino")} disabled={busy}>+ 15 masculinas</Button>
                <Button onClick={() => loadPreset("feminino")} disabled={busy}>+ 14 femininas</Button>
                <Button onClick={() => setPairsText("")} disabled={busy}>Limpar</Button>
              </InlineStack>
              <TextField
                label="Pares (um por linha): ID da camisa, ID da botina"
                value={pairsText}
                onChange={setPairsText}
                multiline={6}
                autoComplete="off"
                helpText="IDs numéricos dos produtos. Botinas: 9587666616617 (Couro Chocolate) e 10091739676969 (Stella)."
              />
              <InlineStack gap="400" blockAlign="end">
                <TextField label="Preço fixo — Botina Chocolate" value={fixedBoy} onChange={setFixedBoy} autoComplete="off" />
                <TextField label="Preço fixo — Botina Stella" value={fixedGirl} onChange={setFixedGirl} autoComplete="off" />
                <TextField label="Desconto (%) quando o fixo não cabe" type="number" value={pct} onChange={setPct} autoComplete="off" />
                <Select
                  label="Status ao criar"
                  options={[{ label: "Ativo", value: "1" }, { label: "Rascunho", value: "" }]}
                  value={active ? "1" : ""}
                  onChange={(v) => setActive(Boolean(v))}
                />
                <Checkbox label="Ocultar da busca/sitemap (teste)" checked={seoHidden} onChange={setSeoHidden} />
              </InlineStack>
              {error && <Banner tone="critical">{error}</Banner>}
              <InlineStack gap="200">
                <Button onClick={() => run("preview")} loading={busy} disabled={busy}>Pré-visualizar (não grava)</Button>
                <Button variant="primary" onClick={() => run("create")} loading={busy} disabled={busy}>Criar / completar kits</Button>
                <Button onClick={() => run("reprice")} loading={busy} disabled={busy}>Atualizar preços (kits existentes)</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        {rows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Resultado</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Kit", "Status", "Variantes", "Camisa + botina", "Preço | Riscado (todas as variantes)", "Detalhe"]}
                  rows={table}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
