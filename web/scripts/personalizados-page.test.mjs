// Testes da dashboard paginada (app/personalizados-page.server.js) — sem rede.
// Uso: node scripts/run-page-test.mjs
import assert from "node:assert/strict";
import {
  basePersoQuery,
  searchClause,
  dateClause,
  tabClause,
  buildPageQuery,
  mapStore,
  loadPersoPage,
  setOrderClickupMetafields,
  syncClickupChunk,
  SYNC_CHUNK,
} from "../app/personalizados-page.server.js";

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

const sellers = [
  { name: "Ana Caroline", tags: ["Ana Caroline"] },
  { name: "Francisca Aparecida", tags: ["Francisca Aparecida"] },
];
const nunotaIds = ["7371328192578"]; // ids resolvidos pelo índice de Nº Sankhya (D1)

// ── Montagem da busca ──

await test("base = SKU PE1198 desde a entrada do sistema", () => {
  assert.equal(basePersoQuery(), "sku:PE1198 AND created_at:>='2026-06-26T00:00:00-03:00'");
});

await test("busca numérica: nome do pedido + Nº Sankhya → id", () => {
  assert.equal(searchClause("1619183", { sellers, nunotaIds }), `(name:#1619183 OR id:7371328192578 OR "1619183")`);
  assert.equal(searchClause("#11535", { sellers }), `(name:#11535 OR "#11535")`);
});

await test("busca numérica longa também procura por id", () => {
  assert.match(searchClause("7371328192578", { sellers }), /id:7371328192578/);
});

await test("busca por vendedor (sem acento/caixa) vira tag", () => {
  const c = searchClause("francisca", { sellers });
  assert.match(c, /tag:'Francisca Aparecida'/);
  assert.doesNotMatch(c, /Ana Caroline/);
});

await test("busca de 1 palavra inclui SKU; com espaço não", () => {
  assert.match(searchClause("CASUAL441G", { sellers }), /sku:CASUAL441G/);
  assert.doesNotMatch(searchClause("maria silva", { sellers }), /sku:/);
});

await test("busca remove caracteres que quebram a sintaxe", () => {
  const c = searchClause(`maria" OR (x)'`, { sellers });
  assert.doesNotMatch(c, /maria"/);
  assert.equal((c.match(/\(/g) || []).length, (c.match(/\)/g) || []).length);
});

await test("busca vazia → sem cláusula", () => {
  assert.equal(searchClause("   ", { sellers }), null);
});

await test("período: 'até' inclui o dia inteiro; 'de' antes do piso é ignorado", () => {
  assert.equal(dateClause("2026-10-01", "2026-10-07"), "created_at:>='2026-10-01T00:00:00-03:00' AND created_at:<'2026-10-08T00:00:00-03:00'");
  assert.equal(dateClause("2026-01-01", ""), null);
  assert.equal(dateClause("lixo", "2026-12-31"), "created_at:<'2027-01-01T00:00:00-03:00'");
});

await test("abas Shopify: pendentes/enviados por metafield (presos/sem atributos vêm do D1)", () => {
  assert.equal(tabClause("pendentes"), "-metafields.brk_perso.clickup_enviado:true");
  assert.equal(tabClause("enviados"), "metafields.brk_perso.clickup_enviado:true");
  assert.equal(tabClause("presos"), null);
  assert.equal(tabClause("todos"), null);
});

await test("query completa combina base + aba + período + busca", () => {
  const q = buildPageQuery({ tab: "pendentes", q: "ana", de: "2026-10-01", ate: "", sellers });
  assert.equal(
    q,
    `sku:PE1198 AND created_at:>='2026-06-26T00:00:00-03:00' AND -metafields.brk_perso.clickup_enviado:true AND created_at:>='2026-10-01T00:00:00-03:00' AND (tag:'Ana Caroline' OR sku:ana OR "ana")`
  );
});

// ── Fallback sem D1 (mapStore) ──

await test("mapStore: contadores ignoram 'seller' sem personalização; presos e Nº", async () => {
  const map = {
    a: { status: "sent", personalizations: [{ nome: "x" }] },
    b: { status: "pending", at: "2026-10-08T11:00:00Z", personalizations: [{ nome: "y" }] },
    c: { status: "pending", at: "2026-10-08T11:50:00Z", personalizations: [{ nome: "z" }] },
    d: { status: "seller", personalizations: [] },
    e: { status: "error", personalizations: [] },
  };
  const s = mapStore(map, { a: 10, b: 20 });
  assert.deepEqual(await s.counters(), { sent: 1, pending: 2, error: 1, seller: 0, hold: 0, done: 0 });
  assert.deepEqual(await s.stuck("2026-10-08T11:15:00Z"), { count: 1, oldestAt: "2026-10-08T11:00:00Z" });
  assert.deepEqual(await s.idsByNunota(20), ["b"]);
  assert.deepEqual((await s.listIds("semAtributos", { size: 25 })).ids, ["e"]);
});

// ── Admin simulado ──

function mockAdmin(handler) {
  const calls = [];
  return {
    calls,
    graphql: async (query, opts = {}) => {
      calls.push({ query, variables: opts.variables });
      const body = await handler(query, opts.variables || {}, calls.length);
      return new Response(JSON.stringify(body));
    },
  };
}

const orderNode = (id, { sku = "C0492G", attrs = true, clickup = null, fin = "PAID" } = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  legacyResourceId: String(id),
  createdAt: "2026-10-07T12:00:00Z",
  note: "",
  tags: ["Nome Personalizado", "Ana Caroline"],
  displayFinancialStatus: fin,
  customer: { displayName: "Cliente" },
  lineItems: {
    edges: [
      { node: { sku, title: "Camisa Feminina", quantity: 1, customAttributes: [], product: { id: "gid://shopify/Product/9", handle: "camisa", onlineStoreUrl: null } } },
      {
        node: {
          sku: "PE1198",
          title: "Personalização Nome",
          quantity: 1,
          customAttributes: attrs
            ? [
                { key: "Produto", value: sku },
                { key: "Nome", value: "Maria" },
                { key: "Local", value: "Frente" },
                { key: "Posição", value: "Peito" },
              ]
            : [],
          product: null,
        },
      },
    ],
  },
  clickup: clickup ? { value: JSON.stringify(clickup) } : null,
});

await test("loadPersoPage: linhas enxutas, ClickUp do metafield, Sankhya/Nº do KV, contadores", async () => {
  const admin = mockAdmin((query, vars) => {
    if (query.includes("PersoPage")) {
      return {
        data: {
          shop: { primaryDomain: { url: "https://loja.com" }, migracao: { value: JSON.stringify({ clickupAt: "x" }) } },
          total: { count: 2 },
          base: { count: 624 },
          pendentes: { count: 600 },
          orders: {
            edges: [
              { node: orderNode(1, { clickup: { url: "https://cu/t/1", sentAt: "2026-10-07T13:00:00Z", taskId: "t1" } }) },
              { node: orderNode(2, { sku: "C0492GFULL", attrs: false }) },
            ],
            pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "s", endCursor: "e" },
          },
        },
      };
    }
    // getFullProductIds
    return { data: { nodes: [{ id: "gid://shopify/Product/9", variants: { nodes: [{ sku: "C0492GFULL" }] } }] } };
  });
  const statusMap = { "1": { status: "sent", written: 1, personalizations: [{}] }, "9999": { status: "seller", personalizations: [] } };
  const page = await loadPersoPage(admin, {
    tab: "todos", q: "", de: "", ate: "", size: 25, cursor: {}, sellers, store: mapStore(statusMap, { "1": 555 }), nowTs: Date.now(),
  });
  assert.equal(page.rows.length, 2);
  const [r1, r2] = page.rows;
  assert.deepEqual(r1.clickup, { url: "https://cu/t/1", sentAt: "2026-10-07T13:00:00Z" });
  assert.equal(r1.nunota, 555);
  assert.equal(r1.sankhya.status, "sent");
  assert.equal(r1.seller, "Ana Caroline");
  assert.equal(r1.hasAttributes, true);
  assert.equal(r2.hasAttributes, false);
  assert.equal(r2.clickup, null);
  assert.equal(r1.hasFull, true); // produto 9 tem variante FULL
  // linha enxuta: nada de description/garmentProductIds/tags
  assert.equal(r1.description, undefined);
  assert.equal(r1.garmentProductIds, undefined);
  assert.equal(page.total, 2);
  assert.equal(page.counts.clickupPendentes, 600);
  assert.equal(page.counts.sankhya.seller, 0); // vendedor sem personalização não conta
  assert.equal(page.counts.sankhya.naoEnviado, 624 - 1);
  assert.deepEqual(page.migracao, { clickupAt: "x", scanAt: null }); // só o necessário
  assert.equal(page.pageInfo.endCursor, "e");
  // A busca enviada usa o tamanho pedido e a base correta
  const v = admin.calls[0].variables;
  assert.equal(v.first, 25);
  assert.equal(v.last, null);
  assert.match(v.pend, /-metafields\.brk_perso\.clickup_enviado:true/);
  assert.equal(v.sellerQ, undefined); // sem listas de ids que crescem
});

await test("loadPersoPage: página anterior usa last/before", async () => {
  const admin = mockAdmin(() => ({
    data: {
      shop: { primaryDomain: { url: "u" }, migracao: null },
      total: { count: 0 }, base: { count: 0 }, pendentes: { count: 0 },
      orders: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
    },
  }));
  await loadPersoPage(admin, { tab: "todos", size: 50, cursor: { before: "abc" }, sellers, store: mapStore() });
  const v = admin.calls[0].variables;
  assert.equal(v.first, null);
  assert.equal(v.last, 50);
  assert.equal(v.before, "abc");
});

await test("loadPersoPage: abas do D1 (sem atributos) paginam pelo banco e buscam só os ids da página", async () => {
  const admin = mockAdmin((query, vars) => ({
    data: {
      shop: { primaryDomain: { url: "u" }, migracao: null },
      base: { count: 624 }, pendentes: { count: 0 },
      nodes: vars.ids.map((gid) => orderNode(Number(gid.split("/").pop()), { attrs: false })),
    },
  }));
  const fake = {
    ...mapStore(),
    async listIds(kind, { older, newer, size }) {
      assert.equal(kind, "semAtributos");
      assert.equal(older, "7000000000009");
      assert.equal(newer, null);
      assert.equal(size, 25);
      return { ids: ["7000000000008", "7000000000007"], hasNext: false, hasPrev: true };
    },
    async countList() { return 11; },
  };
  const page = await loadPersoPage(admin, { tab: "semAtributos", size: 25, cursor: { after: "7000000000009" }, sellers, store: fake });
  assert.match(admin.calls[0].query, /PersoIds/);
  assert.deepEqual(admin.calls[0].variables.ids, ["gid://shopify/Order/7000000000008", "gid://shopify/Order/7000000000007"]);
  assert.equal(page.total, 11);
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.pageInfo, { hasNextPage: false, hasPreviousPage: true, startCursor: "7000000000008", endCursor: "7000000000007" });
});

// ── Gravação no pedido ──

await test("setOrderClickupMetafields: lotes de 12 pedidos (24 metafields <= 25), flag + json", async () => {
  const admin = mockAdmin(() => ({ data: { metafieldsSet: { userErrors: [] } } }));
  const entries = Array.from({ length: 30 }, (_, i) => ({ orderGid: `gid://shopify/Order/${i}`, info: { taskId: `t${i}`, url: `u${i}`, name: `#${i}`, sentAt: "s" } }));
  const r = await setOrderClickupMetafields(admin, entries);
  assert.equal(r.written, 30);
  assert.equal(admin.calls.length, 3); // 12 + 12 + 6
  for (const c of admin.calls) assert.ok(c.variables.metafields.length <= 25);
  const mf = admin.calls[0].variables.metafields;
  assert.deepEqual(mf[0], { ownerId: "gid://shopify/Order/0", namespace: "brk_perso", key: "clickup_enviado", type: "boolean", value: "true" });
  assert.equal(mf[1].key, "clickup");
  assert.deepEqual(JSON.parse(mf[1].value), { taskId: "t0", url: "u0", name: "#0", sentAt: "s" });
});

await test("setOrderClickupMetafields: userErrors viram erro e não contam como gravado", async () => {
  const admin = mockAdmin(() => ({ data: { metafieldsSet: { userErrors: [{ field: "x", message: "ruim" }] } } }));
  const r = await setOrderClickupMetafields(admin, [{ orderGid: "gid://shopify/Order/1", info: {} }]);
  assert.equal(r.written, 0);
  assert.deepEqual(r.errors, ["ruim"]);
});

// ── Sincronização única ──

function legacyAdmin(n, { failSet = false } = {}) {
  const sent = {};
  for (let i = 0; i < n; i++) sent[`gid://shopify/Order/${1000 + i}`] = { taskId: `t${i}`, url: `u${i}`, name: `#${i}`, sentAt: "s" };
  return mockAdmin((query, vars) => {
    if (query.includes("legacy:")) {
      return { data: { shop: { id: "gid://shopify/Shop/1", legacy: { value: JSON.stringify(sent) }, migracao: null } } };
    }
    if (query.includes("metafieldsSet")) {
      // NUNCA pode gravar no metafield antigo (clickup_sent)
      for (const m of vars.metafields) assert.notEqual(m.key, "clickup_sent");
      return { data: { metafieldsSet: { userErrors: failSet ? [{ message: "x" }] : [] } } };
    }
    throw new Error("query inesperada");
  });
}

await test("sync dry-run: só conta, não grava nada", async () => {
  const admin = legacyAdmin(620);
  const r = await syncClickupChunk(admin, { offset: 0, dryRun: true });
  assert.equal(r.total, 620);
  assert.equal(admin.calls.filter((c) => c.query.includes("metafieldsSet")).length, 0);
});

await test("sync: fatias retomáveis cobrem todos e só marcam concluído no fim", async () => {
  const admin = legacyAdmin(620);
  let offset = 0;
  let written = 0;
  let rounds = 0;
  while (offset != null) {
    const r = await syncClickupChunk(admin, { offset });
    written += r.written;
    offset = r.next;
    rounds++;
    assert.ok(rounds < 10);
  }
  assert.equal(written, 620);
  assert.equal(rounds, Math.ceil(620 / SYNC_CHUNK));
  // marcou a migração (metafield migracao_dashboard) exatamente 1x, no fim
  const migr = admin.calls.filter((c) => c.query.includes("metafieldsSet") && c.variables.metafields.some((m) => m.key === "migracao_dashboard"));
  assert.equal(migr.length, 1);
  // subrequests por fatia dentro do limite do Worker Free (50)
  const perChunk = Math.ceil(SYNC_CHUNK / 12) + 1 + 1;
  assert.ok(perChunk < 50, `fatia usa ${perChunk} subrequests`);
});

await test("sync com erro: não marca a migração como concluída", async () => {
  const admin = legacyAdmin(5, { failSet: true });
  const r = await syncClickupChunk(admin, { offset: 0 });
  assert.equal(r.next, null);
  assert.equal(r.errors.length, 1);
  const migr = admin.calls.filter((c) => c.query.includes("metafieldsSet") && c.variables.metafields.some((m) => m.key === "migracao_dashboard"));
  assert.equal(migr.length, 0);
});

console.log(`\n${passed} teste(s) ok${process.exitCode ? " — COM FALHAS" : ""}`);
