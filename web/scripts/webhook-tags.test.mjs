// Testes das etapas do webhook orders/create fora da personalização (app/order-tags.server.js):
// atribuição de bundles e tags de campanha. Sem rede (admin simulado).
// Uso: node scripts/run-webhook-test.mjs
import assert from "node:assert/strict";
import {
  bundleAttribution,
  orderHasBundleLines,
  campaignsFromNodes,
  collectDiscountTags,
  loadCampaignMembership,
  tagsForCampaigns,
  thresholdFor,
} from "../app/order-tags.server.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FALHOU  ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

function mockAdmin(handler) {
  const calls = [];
  return {
    calls,
    graphql: async (query, opts = {}) => {
      calls.push({ query, variables: opts.variables });
      return new Response(JSON.stringify(await handler(query, opts.variables || {})));
    },
  };
}

const C1 = "gid://shopify/Collection/1";
const C2 = "gid://shopify/Collection/2";
const line = (product_id, quantity, props = []) => ({ product_id, quantity, price: "100.00", total_discount: "0.00", variant_id: product_id * 10, properties: props });
const order = (lines) => ({ id: 555, name: "#555", created_at: "2026-10-08T12:00:00Z", line_items: lines });
const node = (title, status, cfg) => ({ discount: { title, status }, metafield: cfg == null ? null : { value: JSON.stringify(cfg) } });

// ── Bundles ──

await test("pedido sem linha de bundle: nenhuma consulta e nada a gravar", async () => {
  const admin = mockAdmin(() => { throw new Error("não devia consultar"); });
  const r = await bundleAttribution(admin, order([line(1, 1)]));
  assert.deepEqual(r, { rows: [], tags: [] });
  assert.equal(admin.calls.length, 0);
});

await test("pedido com bundle: lê a config 1x, monta a linha do D1 e as tags do bundle", async () => {
  const cfg = [{ id: "bdl_1", mode: "gift", orderTags: ["Livro-Infantil", ""] }];
  const admin = mockAdmin(() => ({ data: { shop: { metafield: { value: JSON.stringify(cfg) } } } }));
  const o = order([line(1, 1), { ...line(2, 2, [{ name: "_brk_bundle", value: "bdl_1" }]), price: "39.90", total_discount: "79.80" }]);
  assert.equal(orderHasBundleLines(o), true);
  const r = await bundleAttribution(admin, o);
  assert.equal(admin.calls.length, 1);
  assert.deepEqual(r.tags, ["Livro-Infantil"]);
  assert.deepEqual(r.rows, [
    { bundleId: "bdl_1", orderId: "555", orderName: "#555", variantId: "20", quantity: 2, grossCents: 7980, discountCents: 7980, netCents: 0, mode: "gift", createdAt: "2026-10-08T12:00:00Z" },
  ]);
});

await test("bundle sem config (removido) ainda é registrado, sem tag (igual ao antigo)", async () => {
  const admin = mockAdmin(() => ({ data: { shop: { metafield: { value: "[]" } } } }));
  const r = await bundleAttribution(admin, order([line(2, 1, [{ name: "_brk_bundle", value: "bdl_x" }])]));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].mode, null);
  assert.deepEqual(r.tags, []);
});

// ── Campanhas ──

await test("campanha só vale se ATIVADA na tela (enabled true) E ATIVA na Shopify, com tags", () => {
  const cfg = { enabled: true, orderTags: ["campanha-pares"], collectionIds: [C1] };
  const nodes = [
    node("Descontos Personalizados", "ACTIVE", cfg), // vale
    node("Descontos Personalizados", "ACTIVE", { ...cfg, enabled: false }), // desativada na tela
    node("Descontos Personalizados", "ACTIVE", { ...cfg, enabled: undefined }), // sem flag → não vale
    node("Frete Grátis por Coleção", "EXPIRED", { ...cfg, orderTags: ["frete"] }), // expirada
    node("Desconto Progressivo por Coleção", "SCHEDULED", { ...cfg, orderTags: ["prog"] }), // agendada
    node("Descontos Personalizados X", "ACTIVE", cfg), // título parecido (busca é ampla) → ignora
    node("Descontos Personalizados", "ACTIVE", { ...cfg, orderTags: [] }), // sem tags
    node("Descontos Personalizados", "ACTIVE", null), // sem config
  ];
  const c = campaignsFromNodes(nodes);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "pairs");
  assert.deepEqual(c[0].tags, ["campanha-pares"]);
});

await test("nenhuma campanha ativa (situação atual): 1 consulta e NENHUMA consulta de coleções", async () => {
  const admin = mockAdmin((q) => {
    assert.match(q, /discountNodes/);
    return { data: { discountNodes: { nodes: [node("Descontos Personalizados", "ACTIVE", { enabled: false, orderTags: ["x"], collectionIds: [C1] })] } } };
  });
  const tags = await collectDiscountTags(admin, order([line(1, 5)]));
  assert.deepEqual(tags, []);
  assert.equal(admin.calls.length, 1);
  // busca as campanhas pelo título (não os 100 primeiros descontos da loja)
  assert.match(admin.calls[0].variables.q, /title:'Descontos Personalizados'/);
  assert.match(admin.calls[0].variables.q, /title:'Frete Grátis por Coleção'/);
  assert.match(admin.calls[0].variables.q, /title:'Desconto Progressivo por Coleção'/);
});

await test("campanha ativa: pergunta só as coleções da campanha (inCollection) e aplica a tag", async () => {
  const admin = mockAdmin((q, v) => {
    if (q.includes("discountNodes")) {
      return { data: { discountNodes: { nodes: [node("Descontos Personalizados", "ACTIVE", { enabled: true, orderTags: ["pares-ok"], collectionIds: [C1] })] } } };
    }
    assert.match(q, /c0: inCollection\(id: "gid:\/\/shopify\/Collection\/1"\)/);
    assert.doesNotMatch(q, /collections\(first/);
    return { data: { nodes: v.ids.map((id) => ({ id, c0: id.endsWith("/1") })) } };
  });
  // produto 1 está na coleção; 2 unidades → par → tag
  assert.deepEqual(await collectDiscountTags(admin, order([line(1, 2), line(2, 3)])), ["pares-ok"]);
});

// Lógica ANTIGA de elegibilidade (cópia literal) para comparar com a nova.
function oldTags(order, campaigns, prodColls) {
  const tags = new Set();
  for (const camp of campaigns) {
    const wanted = new Set(camp.config.collectionIds || []);
    let units = 0;
    if (wanted.size) {
      for (const li of order.line_items || []) {
        if (li.product_id == null) continue;
        const colls = prodColls.get(`gid://shopify/Product/${li.product_id}`);
        if (!colls) continue;
        let inAny = false;
        for (const c of colls) if (wanted.has(c)) { inAny = true; break; }
        if (inAny) units += Number(li.quantity || 0);
      }
    }
    let thr = 1;
    if (camp.kind === "progressive") {
      const mins = (camp.config.tiers || []).map((t) => Number(t.minQty)).filter((n) => Number.isFinite(n) && n >= 1);
      thr = mins.length ? Math.min(...mins) : Infinity;
    } else if (camp.kind === "pairs") thr = 2;
    if (units >= thr) for (const t of camp.tags) tags.add(t);
  }
  return [...tags];
}

await test("regras de elegibilidade iguais às antigas (pares, progressivo, frete) em vários pedidos", () => {
  const campaigns = [
    { kind: "pairs", config: { collectionIds: [C1] }, tags: ["pares"] },
    { kind: "progressive", config: { collectionIds: [C2], tiers: [{ minQty: 3 }, { minQty: 5 }] }, tags: ["prog"] },
    { kind: "shipping", config: { collectionIds: [C1, C2] }, tags: ["frete"] },
    { kind: "progressive", config: { collectionIds: [C1], tiers: [] }, tags: ["nunca"] },
  ];
  // antigo: todas as coleções do produto (inclui coleções fora da campanha)
  const full = new Map([
    ["gid://shopify/Product/1", new Set([C1, "gid://shopify/Collection/99"])],
    ["gid://shopify/Product/2", new Set([C2])],
    ["gid://shopify/Product/3", new Set(["gid://shopify/Collection/98"])],
  ]);
  // novo: só as coleções da campanha que o produto contém (o que o inCollection devolve)
  const only = new Map([...full].map(([p, s]) => [p, new Set([...s].filter((c) => c === C1 || c === C2))]));
  const orders = [
    order([line(1, 1)]),
    order([line(1, 2)]),
    order([line(2, 2)]),
    order([line(2, 3)]),
    order([line(1, 1), line(2, 4)]),
    order([line(3, 10)]),
    order([{ ...line(1, 1), product_id: null }]),
    order([]),
  ];
  for (const o of orders) assert.deepEqual(tagsForCampaigns(o, campaigns, only).sort(), oldTags(o, campaigns, full).sort());
  assert.equal(thresholdFor("progressive", { tiers: [{ minQty: 0 }, { minQty: "2" }] }), 2);
});

await test("membership: ignora ids inválidos e não consulta sem produtos/coleções", async () => {
  const admin = mockAdmin(() => ({ data: { nodes: [] } }));
  assert.equal((await loadCampaignMembership(admin, [], [C1])).size, 0);
  assert.equal((await loadCampaignMembership(admin, ["gid://shopify/Product/1"], ["lixo"])).size, 0);
  assert.equal(admin.calls.length, 0);
});

console.log(`\n${passed} teste(s) ok${process.exitCode ? " — COM FALHAS" : ""}`);
