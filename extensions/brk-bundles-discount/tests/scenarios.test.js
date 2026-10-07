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
