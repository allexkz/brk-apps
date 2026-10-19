// Cenários da função de desconto dos BRK Bundles (ver brk-apps/BUNDLES-CENARIOS.md).
// Roda direto sobre o JS (sem build/wasm): `npx vitest run tests/scenarios.test.js`
// a partir de extensions/brk-bundles-discount.
import { describe, test, expect } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";

const COLL = "gid://shopify/Collection/500"; // coleção do bundle
const SHIRT_A = 101;
const SHIRT_B = 102;
const OTHER = 300; // produto fora da coleção
const BOOK = 900; // add-on (livro)
const BUNDLE = "bdl_x";

let seq = 0;
function shirt(pid, qty = 1, price = "129.90", inColl = true) {
  return {
    id: "gid://shopify/CartLine/" + ++seq,
    quantity: qty,
    cost: { amountPerQuantity: { amount: price } },
    bundle: null,
    item: null,
    trigger: null,
    merchandise: {
      __typename: "ProductVariant",
      product: { id: "gid://shopify/Product/" + pid, inCollections: [{ collectionId: COLL, isMember: inColl }], hasTags: [] },
    },
  };
}
function book(trigger, qty = 1, bundle = BUNDLE) {
  return {
    id: "gid://shopify/CartLine/" + ++seq,
    quantity: qty,
    cost: { amountPerQuantity: { amount: "39.90" } },
    bundle: { value: bundle },
    item: { value: String(BOOK) },
    trigger: trigger ? { value: String(trigger) } : null,
    merchandise: {
      __typename: "ProductVariant",
      product: { id: "gid://shopify/Product/" + BOOK, inCollections: [{ collectionId: COLL, isMember: false }], hasTags: [] },
    },
  };
}
function config({ perTrigger = false, exemption = true, maxQty = 1, targets = true, extraBundles = [] } = {}) {
  const entry = () => {
    const e = { i: { [BOOK]: { m: "p", v: 100, l: 0, q: maxQty, ...(exemption ? { a: 1 } : {}) } } };
    if (targets) e.t = { k: "c", ids: [500] };
    if (perTrigger) e.u = 1;
    return e;
  };
  const b = { [BUNDLE]: entry() };
  for (const id of extraBundles) b[id] = entry();
  return { v: 2, L: ["BRINDE LIVRO"], collectionIds: [COLL], tags: [], b };
}
function run(lines, cfg) {
  return cartLinesDiscountsGenerateRun({
    discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: cfg } },
    cart: { lines },
  });
}
// Resumo legível: "pid:valor" por candidate (livro marcado com "(livro)").
function summary(lines, cfg) {
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  const cands = run(lines, cfg).operations[0]?.productDiscountsAdd?.candidates || [];
  return cands.map((c) => {
    const l = byId[c.targets[0].cartLine.id];
    const pid = l.merchandise.product.id.split("/").pop();
    const v = c.value.fixedAmount ? "R$" + c.value.fixedAmount.amount : c.value.percentage.value + "%";
    const q = c.targets[0].cartLine.quantity;
    return `${pid}${l.bundle ? "(livro)" : ""}:${v}${q ? " x" + q : ""}`;
  });
}

describe("limite por carrinho (opção desligada) — comportamento de produção", () => {
  test("D-2 isenção: 1 camisa + 1 livro abate da camisa", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A)], config())).toEqual(["101:R$39.90"]);
  });
  test("B6 2 camisas + 1 livro: só o livro da camisa A", () => {
    expect(summary([shirt(SHIRT_A), shirt(SHIRT_B), book(SHIRT_A)], config())).toEqual(["101:R$39.90"]);
  });
  test("C6 tirou a camisa que puxou o livro: sem desconto", () => {
    expect(summary([shirt(SHIRT_B), book(SHIRT_A)], config())).toEqual([]);
  });
  test("C1 livro q3 com máx 1: só 1 unidade", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A, 3)], config())).toEqual(["101:R$39.90"]);
  });
  test("C2 máx 0 = ilimitado: livro q3 todo grátis", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A, 3)], config({ maxQty: 0 }))).toEqual(["101:R$119.70"]);
  });
  test("D-1 sem isenção: desconto no próprio livro", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A)], config({ exemption: false }))).toEqual(["900(livro):100% x1"]);
  });
  test("D-10 config slim (sem segmentação): vale o gatilho gravado", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A)], config({ targets: false }))).toEqual(["101:R$39.90"]);
  });
  test("D-3 isenção maior que a camisa: abate só o valor dela", () => {
    expect(summary([shirt(SHIRT_A, 1, "20.00"), book(SHIRT_A)], config())).toEqual(["101:R$20.00"]);
  });
  test("D-6 dois bundles na mesma camisa: teto compartilhado", () => {
    const lines = [shirt(SHIRT_A, 1, "50.00"), book(SHIRT_A), book(SHIRT_A, 1, "bdl_y")];
    expect(summary(lines, config({ extraBundles: ["bdl_y"] }))).toEqual(["101:R$50.00"]);
  });
});

describe("limite por produto do bundle (perTrigger)", () => {
  const P = { perTrigger: true };
  test("1 camisa + 1 livro", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A)], config(P))).toEqual(["101:R$39.90"]);
  });
  test("B6 2 camisas + 2 livros: cada livro abate da própria camisa", () => {
    const lines = [shirt(SHIRT_A), book(SHIRT_A), shirt(SHIRT_B), book(SHIRT_B)];
    expect(summary(lines, config(P))).toEqual(["101:R$39.90", "102:R$39.90"]);
  });
  test("C5 tirou a camisa A: livro de A vale pela camisa B", () => {
    expect(summary([shirt(SHIRT_B), book(SHIRT_A)], config(P))).toEqual(["102:R$39.90"]);
  });
  test("C5 camisa B + livros de A e B: só 1 com desconto", () => {
    expect(summary([shirt(SHIRT_B), book(SHIRT_A), book(SHIRT_B)], config(P))).toEqual(["102:R$39.90"]);
  });
  test("C1 1 camisa + livro q3: só 1 com desconto", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A, 3)], config(P))).toEqual(["101:R$39.90"]);
  });
  test("B7 mesma camisa q2 + livro q2", () => {
    expect(summary([shirt(SHIRT_A, 2), book(SHIRT_A, 2)], config(P))).toEqual(["101:R$79.80"]);
  });
  test("produto fora da coleção não conta como camisa", () => {
    const lines = [shirt(SHIRT_A), shirt(OTHER, 1, "50.00", false), book(SHIRT_A, 2)];
    expect(summary(lines, config(P))).toEqual(["101:R$39.90"]);
  });
  test("só produto fora da coleção: nada", () => {
    expect(summary([shirt(OTHER, 1, "50.00", false), book(OTHER)], config(P))).toEqual([]);
  });
  test("D-3 camisa barata: não passa do preço dela", () => {
    expect(summary([shirt(SHIRT_A, 1, "20.00"), book(SHIRT_A)], config(P))).toEqual(["101:R$20.00"]);
  });
  test("sem isenção: desconto no livro, 2 camisas", () => {
    const lines = [shirt(SHIRT_A), shirt(SHIRT_B), book(SHIRT_A, 2)];
    expect(summary(lines, config({ ...P, exemption: false }))).toEqual(["900(livro):100% x2"]);
  });
  test("D-10 sem segmentação: só gatilhos gravados nas linhas contam", () => {
    const lines = [shirt(SHIRT_A), shirt(SHIRT_B), book(SHIRT_A, 2)];
    expect(summary(lines, config({ ...P, targets: false }))).toEqual(["101:R$39.90"]);
  });
  test("máx 0 continua ilimitado", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A, 2)], config({ ...P, maxQty: 0 }))).toEqual(["101:R$79.80"]);
  });
  test("D-6 dois bundles na mesma camisa: teto compartilhado", () => {
    const lines = [shirt(SHIRT_A, 1, "50.00"), book(SHIRT_A), book(SHIRT_A, 1, "bdl_y")];
    expect(summary(lines, config({ ...P, extraBundles: ["bdl_y"] }))).toEqual(["101:R$50.00"]);
  });
});

describe("D-9 properties forjadas", () => {
  test("livro de bundle sem nenhuma camisa", () => {
    expect(summary([book(SHIRT_A)], config())).toEqual([]);
    expect(summary([book(SHIRT_A)], config({ perTrigger: true }))).toEqual([]);
  });
  test("props de bundle na própria camisa (linha não é do add-on)", () => {
    const fake = { ...shirt(SHIRT_A), bundle: { value: BUNDLE }, item: { value: String(BOOK) }, trigger: { value: String(SHIRT_A) } };
    expect(summary([fake], config())).toEqual([]);
  });
  test("bundle inexistente", () => {
    expect(summary([shirt(SHIRT_A), book(SHIRT_A, 1, "bdl_falso")], config())).toEqual([]);
  });
  test("livro sem gatilho com segmentação: sem desconto", () => {
    expect(summary([shirt(SHIRT_A), book(null)], config())).toEqual([]);
  });
  test("gatilho fora da segmentação: sem desconto", () => {
    expect(summary([shirt(OTHER, 1, "50.00", false), book(OTHER)], config())).toEqual([]);
  });
});

// Exclusões (`x`): camisa da coleção do bundle, mas excluída por produto,
// collection ou tag (ex.: camisas Halloween fora do "Camisas Infantis + Livrinho").
const XCOLL = "gid://shopify/Collection/600";
const HALLOWEEN = 201;
function shirtX(pid, { inX = false, tag = null, qty = 1, price = "129.90" } = {}) {
  const l = shirt(pid, qty, price);
  l.merchandise.product.inCollections = [
    { collectionId: COLL, isMember: true },
    { collectionId: XCOLL, isMember: inX },
  ];
  l.merchandise.product.hasTags = [{ tag: "halloween", hasTag: tag === "halloween" }];
  return l;
}
function excluding(x, opts) {
  const cfg = config(opts);
  for (const e of Object.values(cfg.b)) e.x = x;
  cfg.collectionIds = [...cfg.collectionIds, XCOLL];
  cfg.tags = ["halloween"];
  return cfg;
}

describe("exclusões da segmentação", () => {
  const byProduct = { p: [HALLOWEEN] };
  const byColl = { c: [600] };
  const byTag = { g: ["Halloween"] };
  test("excluído por produto: sem desconto", () => {
    expect(summary([shirtX(HALLOWEEN), book(HALLOWEEN)], excluding(byProduct))).toEqual([]);
  });
  test("excluído por collection: sem desconto", () => {
    expect(summary([shirtX(HALLOWEEN, { inX: true }), book(HALLOWEEN)], excluding(byColl))).toEqual([]);
  });
  test("excluído por tag (sem diferenciar maiúsculas): sem desconto", () => {
    expect(summary([shirtX(HALLOWEEN, { tag: "halloween" }), book(HALLOWEEN)], excluding(byTag))).toEqual([]);
  });
  test("camisa não excluída continua com desconto", () => {
    expect(summary([shirtX(SHIRT_A), book(SHIRT_A)], excluding(byColl))).toEqual(["101:R$39.90"]);
  });
  test("perTrigger: camisa excluída não conta nem recebe a isenção", () => {
    const lines = [shirtX(HALLOWEEN, { inX: true }), shirtX(SHIRT_A), book(SHIRT_A, 2)];
    expect(summary(lines, excluding(byColl, { perTrigger: true }))).toEqual(["101:R$39.90"]);
  });
  test("perTrigger: só camisa excluída no carrinho: nada", () => {
    const lines = [shirtX(HALLOWEEN, { tag: "halloween" }), book(HALLOWEEN)];
    expect(summary(lines, excluding(byTag, { perTrigger: true }))).toEqual([]);
  });
  test("sem segmentação (slim): exclusão por produto ainda vale", () => {
    expect(summary([shirtX(HALLOWEEN), book(HALLOWEEN)], excluding(byProduct, { targets: false }))).toEqual([]);
    expect(summary([shirtX(HALLOWEEN), book(HALLOWEEN)], excluding(byProduct, { targets: false, perTrigger: true }))).toEqual([]);
  });
  test("x vazio = comportamento de hoje", () => {
    expect(summary([shirtX(SHIRT_A), book(SHIRT_A)], excluding({}))).toEqual(["101:R$39.90"]);
    expect(summary([shirtX(SHIRT_A), book(SHIRT_A)], excluding({}, { perTrigger: true }))).toEqual(["101:R$39.90"]);
  });
});

// v3: bundles por produto específico com as regras no metafield `fn` do produto-gatilho
// (a config da discount só guarda as chaves ativas em `a`). Tem que dar EXATAMENTE o
// mesmo resultado do v2 (regras na config da discount) em todos os carrinhos.
function v2Products({ perTrigger = false, exemption = true, maxQty = 1, ids = [SHIRT_A, SHIRT_B] } = {}) {
  const e = { i: { [BOOK]: { m: "p", v: 100, l: 0, q: maxQty, ...(exemption ? { a: 1 } : {}) } }, t: { k: "p", ids } };
  if (perTrigger) e.u = 1;
  return { v: 2, L: ["BRINDE LIVRO"], collectionIds: [], tags: [], b: { [BUNDLE]: e } };
}
// Converte a config v2 acima p/ v3: regra no `fn` de cada produto da lista + chave em `a`.
function toV3(cfg, { active = true } = {}) {
  const fn = {};
  const a = [];
  const b = {};
  let k = 1;
  for (const [id, e] of Object.entries(cfg.b)) {
    if (!e.t || e.t.k !== "p") { b[id] = e; continue; }
    const key = k++;
    if (active) a.push(key);
    const i = {};
    for (const [pid, it] of Object.entries(e.i)) i[pid] = { ...it, l: cfg.L[it.l] };
    const entry = { k: key, i, ...(e.u ? { u: 1 } : {}) };
    for (const pid of e.t.ids) (fn[pid] = fn[pid] || {})[id] = entry;
  }
  return { cfg: { v: 3, L: cfg.L, collectionIds: cfg.collectionIds, tags: cfg.tags, b, a }, fn };
}
function withFn(lines, fn) {
  return lines.map((l) => {
    const pid = l.merchandise.product.id.split("/").pop();
    return { ...l, merchandise: { ...l.merchandise, product: { ...l.merchandise.product, fn: fn[pid] ? { jsonValue: fn[pid] } : null } } };
  });
}

describe("v3 (regras no produto) = v2 (regras na discount)", () => {
  const carts = {
    "1 camisa + 1 livro": () => [shirt(SHIRT_A), book(SHIRT_A)],
    "2 camisas + 1 livro": () => [shirt(SHIRT_A), shirt(SHIRT_B), book(SHIRT_A)],
    "2 camisas + 2 livros": () => [shirt(SHIRT_A), book(SHIRT_A), shirt(SHIRT_B), book(SHIRT_B)],
    "tirou a camisa que puxou o livro": () => [shirt(SHIRT_B), book(SHIRT_A)],
    "livro q3": () => [shirt(SHIRT_A), book(SHIRT_A, 3)],
    "camisa q2 + livro q2": () => [shirt(SHIRT_A, 2), book(SHIRT_A, 2)],
    "camisa barata": () => [shirt(SHIRT_A, 1, "20.00"), book(SHIRT_A)],
    "produto fora da lista": () => [shirt(OTHER, 1, "50.00", false), book(OTHER)],
    "fora da lista + camisa": () => [shirt(SHIRT_A), shirt(OTHER, 1, "50.00", false), book(SHIRT_A, 2)],
    "livro sem gatilho": () => [shirt(SHIRT_A), book(null)],
    "livro sem camisa": () => [book(SHIRT_A)],
    "bundle inexistente": () => [shirt(SHIRT_A), book(SHIRT_A, 1, "bdl_falso")],
  };
  const variants = {
    "isenção": {},
    "sem isenção": { exemption: false },
    "perTrigger": { perTrigger: true },
    "perTrigger sem isenção": { perTrigger: true, exemption: false },
    "máx 0": { maxQty: 0 },
    "perTrigger máx 0": { perTrigger: true, maxQty: 0 },
  };
  for (const [vName, opts] of Object.entries(variants)) {
    for (const [cName, make] of Object.entries(carts)) {
      test(`${vName} · ${cName}`, () => {
        const v2 = v2Products(opts);
        const { cfg, fn } = toV3(v2);
        const lines = make();
        expect(summary(withFn(lines, fn), cfg)).toEqual(summary(lines, v2));
      });
    }
  }
  test("bundle desativado (chave fora de `a`): sem desconto mesmo com `fn` no produto", () => {
    const { cfg, fn } = toV3(v2Products(), { active: false });
    expect(summary(withFn([shirt(SHIRT_A), book(SHIRT_A)], fn), cfg)).toEqual([]);
  });
  test("exclusão em bundle por produto vale igual no v3", () => {
    // regra por produto excluindo SHIRT_B por produto: v2 e v3 dão o mesmo
    const v2 = v2Products({ perTrigger: true });
    v2.b[BUNDLE].x = { p: [SHIRT_B] };
    const { cfg, fn } = toV3(v2);
    for (const pid of Object.keys(fn)) fn[pid][BUNDLE].x = { p: [SHIRT_B] };
    const lines = [shirt(SHIRT_A), shirt(SHIRT_B), book(SHIRT_A, 2)];
    expect(summary(withFn(lines, fn), cfg)).toEqual(summary(lines, v2));
    expect(summary(lines, v2)).toEqual(["101:R$39.90"]);
  });
  test("bundle amplo (coleção) continua na config v3 junto dos por produto", () => {
    const broad = config(); // bundle por coleção, isenção
    const mixed = { ...broad, b: { ...broad.b, bdl_p: v2Products().b[BUNDLE] } };
    const { cfg, fn } = toV3(mixed);
    expect(cfg.b.bdl_p).toBeUndefined();
    const lines = [shirt(SHIRT_A), book(SHIRT_A)];
    expect(summary(withFn(lines, fn), cfg)).toEqual(summary(lines, mixed));
  });
  test("`fn` com id igual a um bundle amplo SEM segmentação (slim) não quebra nem sobrescreve", () => {
    const slim = config({ targets: false });
    const cfg = { ...slim, v: 3, a: [99] };
    const fake = { [BUNDLE]: { k: 99, i: { [BOOK]: { m: "p", v: 100, l: "X", q: 9 } } } };
    const lines = withFn([shirt(SHIRT_A), book(SHIRT_A)], { [SHIRT_A]: fake });
    expect(summary(lines, cfg)).toEqual(summary([shirt(SHIRT_A), book(SHIRT_A)], slim));
  });
  test("`fn` com id igual a um bundle amplo não sobrescreve o amplo", () => {
    const broad = config();
    const fake = { [BUNDLE]: { k: 99, i: { [BOOK]: { m: "p", v: 100, l: "X", q: 9 } } } };
    const cfg = { ...broad, v: 3, a: [99] };
    const lines = withFn([shirt(SHIRT_A), book(SHIRT_A)], { [SHIRT_A]: fake });
    expect(summary(lines, cfg)).toEqual(summary([shirt(SHIRT_A), book(SHIRT_A)], broad));
  });
});
