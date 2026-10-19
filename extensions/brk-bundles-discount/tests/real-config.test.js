// v3 == v2 com a config REAL de uma loja (backup do brk_bundles.config).
// Monta, p/ cada bundle ativo, carrinhos com o produto-gatilho + add-on(s) e compara
// a saída da function com a config v2 (tudo na discount) e com a v3 (bundles por
// produto no `fn` do produto). Também um carrinho com todos os bundles juntos.
// Uso: BRK_REAL_CONFIG=<caminho do backup> npx vitest run tests/real-config.test.js
// Sem a variável, o teste é pulado.
import fs from "node:fs";
import { describe, test, expect } from "vitest";
import { cartLinesDiscountsGenerateRun } from "../src/cart_lines_discounts_generate_run.js";
import { isProductBundle, assignFnKeys, bundleHandle, orderKey } from "../../../web/app/bundles-store.server.js";

const PATH = process.env.BRK_REAL_CONFIG;

function routeFns() {
  const src = fs.readFileSync(new URL("../../../web/app/routes/app.bundles.jsx", import.meta.url), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`(?:^|\\n)(function ${name}\\b[\\s\\S]*?\\n\\})`));
    if (!m) throw new Error("função não encontrada: " + name);
    return m[1];
  };
  const consts = ["DISCOUNT_MAX_BYTES", "FN_LIST_MAX", "V2_MODE"].map((c) => src.match(new RegExp(`const ${c} = [^;]+;`))[0]).join("\n");
  const fns = ["labelForItem", "excludeOf", "hasExclude", "buildDiscountConfig", "buildProductFn", "buildDiscountConfigV3"].map(grab).join("\n");
  const bytes = (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)).length;
  return new Function("isProductBundle", "bytes", "bundleHandle", "orderKey", `${consts}\n${fns}\nreturn { buildDiscountConfig, buildProductFn, buildDiscountConfigV3 };`)(isProductBundle, bytes, bundleHandle, orderKey);
}

let seq = 0;
function line(pid, { qty = 1, price = "129.90", bundle = null, item = null, trigger = null, colls = [], tags = [], allColls, allTags } = {}) {
  return {
    id: "gid://shopify/CartLine/" + ++seq,
    quantity: qty,
    cost: { amountPerQuantity: { amount: price } },
    bundle: bundle ? { value: bundle } : null,
    item: item ? { value: String(item) } : null,
    trigger: trigger ? { value: String(trigger) } : null,
    merchandise: {
      __typename: "ProductVariant",
      product: {
        id: "gid://shopify/Product/" + pid,
        inCollections: allColls.map((c) => ({ collectionId: c, isMember: colls.includes(c) })),
        hasTags: allTags.map((t) => ({ tag: t, hasTag: tags.includes(t) })),
      },
    },
  };
}
function run(lines, cfg, fnMap) {
  const withFn = lines.map((l) => {
    const pid = l.merchandise.product.id.split("/").pop();
    const fn = fnMap ? fnMap.get(pid) : null;
    return { ...l, merchandise: { ...l.merchandise, product: { ...l.merchandise.product, fn: fn ? { jsonValue: fn } : null } } };
  });
  return cartLinesDiscountsGenerateRun({ discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: cfg } }, cart: { lines: withFn } });
}

describe.skipIf(!PATH)("config real: v3 == v2", () => {
  const bundles = PATH ? JSON.parse(fs.readFileSync(PATH, "utf8")) : [];
  assignFnKeys(bundles);
  const { buildDiscountConfig, buildProductFn, buildDiscountConfigV3 } = routeFns();
  const v2 = PATH ? JSON.parse(buildDiscountConfig(bundles).value) : null;
  const v3 = PATH ? JSON.parse(buildDiscountConfigV3(bundles).value) : null;
  const fn = PATH ? buildProductFn(bundles) : null;
  const allColls = v2 ? v2.collectionIds : [];
  const allTags = v2 ? v2.tags : [];

  // gatilho de cada bundle: o 1º produto (por produto) ou um produto fictício na
  // 1ª collection / com a 1ª tag (amplos)
  function triggerOf(b, n = 0) {
    const t = b.targets || {};
    if (isProductBundle(b)) return { pid: String((t.productIds || [])[n] ?? (t.productIds || [])[0]), opts: {} };
    if (t.type === "collections") return { pid: String(900000000 + n), opts: { colls: [`gid://shopify/Collection/${t.collectionIds[0]}`] } };
    if (t.type === "tags") return { pid: String(900000100 + n), opts: { tags: [String(t.tags[0])] } };
    return { pid: String(900000200 + n), opts: {} };
  }
  const active = bundles.filter((b) => b.enabled && (b.addons || []).length);

  test("tamanhos", () => {
    const s2 = JSON.stringify(v2).length, s3 = JSON.stringify(v3).length;
    console.log(`bundles ativos ${active.length} | v2 ${s2} B | v3 ${s3} B | produtos com fn ${fn.size}`);
    expect(s3).toBeLessThan(s2);
  });

  for (const b of active) {
    test(`${b.name}`, () => {
      const T = triggerOf(b);
      const T2 = triggerOf(b, 1);
      const L = (pid, o) => line(pid, { allColls, allTags, ...o });
      const addonLines = (trig, qty = 1) => b.addons.map((a) => L(a.productId, { qty, price: ((a.variants?.[0]?.priceCents || 3990) / 100).toFixed(2), bundle: b.id, item: a.productId, trigger: trig }));
      const carts = [
        [L(T.pid, T.opts), ...addonLines(T.pid)],
        [L(T.pid, { ...T.opts, qty: 2 }), ...addonLines(T.pid, 2)],
        [L(T.pid, T.opts), L(T2.pid, T2.opts), ...addonLines(T.pid, 2)],
        [L(T2.pid, T2.opts), ...addonLines(T.pid)], // tirou o gatilho original
        [...addonLines(T.pid)], // sem gatilho
        [L("123", {}), ...addonLines("123")], // gatilho forjado
      ];
      for (const c of carts) expect(run(c, v3, fn)).toEqual(run(c, v2, null));
      // o carrinho normal tem que dar desconto de verdade (senão a comparação seria vazia)
      expect(run(carts[0], v2, null).operations.length).toBeGreaterThan(0);
    });
  }

  test("todos os bundles no mesmo carrinho", () => {
    const L = (pid, o) => line(pid, { allColls, allTags, ...o });
    const c = [];
    for (const b of active) {
      const T = triggerOf(b);
      c.push(L(T.pid, T.opts));
      for (const a of b.addons) c.push(L(a.productId, { bundle: b.id, item: a.productId, trigger: T.pid, price: "39.90" }));
    }
    expect(run(c, v3, fn)).toEqual(run(c, v2, null));
  });
});
