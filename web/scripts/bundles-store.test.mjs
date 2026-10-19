// Testes da migração dos BRK Bundles (config JSON único -> metaobjects).
// Uso: node scripts/bundles-store.test.mjs [backup do brk_bundles.config]
// Com backup: simula a migração inteira com um admin falso (copiar -> listar ->
// verificar) e confere que `live` e o config da discount saem byte a byte iguais.
import fs from "node:fs";
import {
  bundleHandle,
  bundleToFields,
  nodeToBundle,
  planMetaobjectWrites,
  upsertMetaobjectBundles,
  listMetaobjectBundles,
  writeMetaobjectBundles,
  compareBundles,
  assignFnKeys,
  planProductFnWrites,
  isProductBundle,
} from "../app/bundles-store.server.js";

let fails = 0;
let passes = 0;
function ok(cond, name) {
  if (cond) passes++;
  else { fails++; console.log("FAIL", name); }
}

// buildLive / buildDiscountConfig da rota (JSX não importável em node): extrai as funções puras.
function routeFns() {
  const src = fs.readFileSync(new URL("../app/routes/app.bundles.jsx", import.meta.url), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`(?:^|\\n)(function ${name}\\b[\\s\\S]*?\\n\\})`));
    if (!m) throw new Error("função não encontrada: " + name);
    return m[1];
  };
  const consts = ["DISCOUNT_MAX_BYTES", "FN_LIST_MAX", "V2_MODE"].map((c) => src.match(new RegExp(`const ${c} = [^;]+;`))[0]).join("\n");
  const fns = ["labelForItem", "buildLive", "liveItem", "excludeOf", "hasExclude", "buildDiscountConfig"].map(grab).join("\n");
  return new Function(`${consts}\n${fns}\nreturn { buildLive, buildDiscountConfig };`)();
}

// Admin falso: guarda os metaobjects em memória, pagina de 250 em 250.
function fakeAdmin() {
  const store = new Map();
  const calls = { up: 0, del: 0, list: 0 };
  return {
    store,
    calls,
    async graphql(q, { variables = {} } = {}) {
      if (q.startsWith("mutation up")) {
        calls.up++;
        const out = {};
        for (const k of Object.keys(variables).filter((x) => x.startsWith("h"))) {
          const i = k.slice(1);
          const h = variables[k].handle;
          const prev = store.get(h);
          store.set(h, { id: prev ? prev.id : "mo_" + h, handle: h, fields: variables["m" + i].fields });
          out["u" + i] = { metaobject: { id: "mo_" + h }, userErrors: [] };
        }
        return { json: async () => ({ data: out }) };
      }
      if (q.startsWith("mutation del")) {
        calls.del++;
        const out = {};
        for (const [k, id] of Object.entries(variables)) {
          for (const [h, n] of store) if (n.id === id) store.delete(h);
          out["d" + k.slice(1)] = { deletedId: id, userErrors: [] };
        }
        return { json: async () => ({ data: out }) };
      }
      calls.list++;
      const all = [...store.values()];
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = all.slice(start, start + 250);
      const end = start + nodes.length;
      return { json: async () => ({ data: { metaobjects: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } }) };
    },
  };
}

// ── sintéticos ──
ok(bundleHandle("bdl_1790708223710_l53rp") === "bdl-1790708223710-l53rp", "handle normaliza");
const b1 = { id: "bdl_1_a", name: "Livro\ninfantil", enabled: true, targets: { type: "products", productIds: [1] }, addons: [{ productId: 9, title: "Livro \"x\"" }] };
const n1 = nodeToBundle({ id: "mo1", fields: bundleToFields(b1, 3) });
ok(JSON.stringify(n1.bundle) === JSON.stringify(b1), "ida e volta preserva o bundle inteiro");
ok(n1.position === 3, "position preservada");
ok(!bundleToFields(b1, 0).find((f) => f.key === "name").value.includes("\n"), "nome em 1 linha (single_line_text)");

{
  const admin = fakeAdmin();
  const list = [b1, { ...b1, id: "bdl_2_b" }, { ...b1, id: "bdl_3_c" }];
  await writeMetaobjectBundles(admin, list, null);
  let mo = await listMetaobjectBundles(admin);
  ok(mo.bundles.map((b) => b.id).join() === "bdl_1_a,bdl_2_b,bdl_3_c", "grava na ordem");
  ok(planMetaobjectWrites(list, mo).upserts.length === 0, "sem mudança = nenhuma gravação");
  const edited = [list[0], { ...list[1], name: "novo" }, list[2], { ...b1, id: "bdl_4_d" }];
  const plan = planMetaobjectWrites(edited, mo);
  ok(plan.upserts.map((u) => u.bundle.id).join() === "bdl_2_b,bdl_4_d", "grava só o alterado e o novo");
  ok(plan.upserts.find((u) => u.bundle.id === "bdl_4_d").position === 3, "novo vai pro fim");
  await writeMetaobjectBundles(admin, edited, mo);
  mo = await listMetaobjectBundles(admin);
  const removed = [edited[1], edited[2], edited[3]]; // apaga o primeiro
  const plan2 = planMetaobjectWrites(removed, mo);
  ok(plan2.upserts.length === 0 && plan2.deletes.length === 1, "excluir o 1º não regrava os outros (posição estável)");
  await writeMetaobjectBundles(admin, removed, mo);
  mo = await listMetaobjectBundles(admin);
  ok(mo.bundles.map((b) => b.id).join() === "bdl_2_b,bdl_3_c,bdl_4_d", "ordem mantida após excluir");
  const cmp = compareBundles(removed, mo.bundles);
  ok(!cmp.missing.length && !cmp.different.length && !cmp.extra.length && cmp.sameOrder, "compareBundles: iguais");
  ok(!compareBundles([removed[1], removed[0], removed[2]], mo.bundles).sameOrder, "compareBundles detecta ordem");
}

// ── motor v3: chaves e diff dos produtos ──
{
  const list = [
    { id: "a", targets: { type: "products" } },
    { id: "b", targets: { type: "collections" } },
    { id: "c", targets: { type: "products" }, fnKey: 5 },
    { id: "d" }, // sem targets = por produto (padrão do editor)
  ];
  const assigned = assignFnKeys(list);
  ok(assigned.join() === "a,d", "chave só p/ por produto sem chave");
  ok(list[0].fnKey === 6 && list[3].fnKey === 7 && list[2].fnKey === 5, "chaves continuam do maior (nunca reaproveita)");
  ok(list[1].fnKey === undefined, "bundle amplo não ganha chave");
  ok(assignFnKeys(list).length === 0, "idempotente");
  ok(isProductBundle({}) && !isProductBundle({ targets: { type: "tags" } }), "isProductBundle");
  const prev = new Map([["1", { a: { k: 1 } }], ["2", { a: { k: 1 } }]]);
  const next = new Map([["2", { a: { k: 1 } }], ["3", { a: { k: 1 } }]]);
  const plan = planProductFnWrites(prev, next);
  ok(plan.sets.map((x) => x.pid).join() === "3", "grava só o produto novo");
  ok(plan.deletes.join() === "1", "apaga o produto que saiu");
  ok(planProductFnWrites(next, next).sets.length === 0, "sem mudança = nada");
}

// ── vitrine: campo `storefront` nos registros ──
{
  const admin = fakeAdmin();
  const list = [b1, { ...b1, id: "bdl_2_b" }];
  await writeMetaobjectBundles(admin, list, null); // sem storefront (como hoje)
  let mo = await listMetaobjectBundles(admin);
  const sfOf = (b) => ({ id: b.id, shown: true });
  ok(planMetaobjectWrites(list, mo, sfOf).upserts.length === 2, "registro sem storefront: regrava todos");
  await writeMetaobjectBundles(admin, list, mo, sfOf);
  mo = await listMetaobjectBundles(admin);
  ok(planMetaobjectWrites(list, mo, sfOf).upserts.length === 0, "storefront igual: nada a gravar");
  ok(planMetaobjectWrites(list, mo).upserts.length === 0, "sem sfOf: só os dados contam");
  ok(mo.snapSf.get("bdl_2_b") === JSON.stringify({ id: "bdl_2_b", shown: true }), "storefront gravado no registro");
}

// ── dados reais ──
const backup = process.argv[2];
if (backup && fs.existsSync(backup)) {
  const legacy = JSON.parse(fs.readFileSync(backup, "utf8"));
  const { buildLive, buildDiscountConfig } = routeFns();
  const admin = fakeAdmin();
  // cópia em páginas de 40, como a tela faz
  for (let off = 0; off < legacy.length; off += 40) {
    const errs = await upsertMetaobjectBundles(admin, legacy.slice(off, off + 40).map((bundle, k) => ({ bundle, position: off + k })));
    ok(errs.length === 0, `cópia página ${off}`);
  }
  const mo = await listMetaobjectBundles(admin);
  const cmp = compareBundles(legacy, mo.bundles);
  ok(mo.bundles.length === legacy.length, `todos copiados (${mo.bundles.length}/${legacy.length})`);
  ok(!cmp.missing.length && !cmp.different.length && !cmp.extra.length, "bundles idênticos");
  ok(cmp.sameOrder, "mesma ordem");
  ok(JSON.stringify(buildLive(legacy)) === JSON.stringify(buildLive(mo.bundles)), "live byte a byte igual");
  ok(buildDiscountConfig(legacy).value === buildDiscountConfig(mo.bundles).value, "config da discount byte a byte igual");
  ok(new Set(legacy.map((b) => bundleHandle(b.id))).size === legacy.length, "handles únicos");
  const maxData = Math.max(...legacy.map((b) => Buffer.byteLength(JSON.stringify(b))));
  ok(maxData < 128 * 1024, `maior bundle ${maxData} B < 128 KB`);
  // depois de ativo: editar 1 bundle grava 1 registro
  const target = Math.min(10, legacy.length - 1);
  const edited = legacy.map((b, i) => (i === target ? { ...b, hidePrice: !b.hidePrice } : b));
  ok(planMetaobjectWrites(edited, mo).upserts.length === 1, "editar 1 bundle = 1 gravação");
  console.log(`dados reais: ${legacy.length} bundles, maior ${maxData} B, mutations de cópia: ${admin.calls.up}`);
}

console.log(fails ? `\n${fails} falha(s), ${passes} ok` : `\n${passes} teste(s) ok`);
process.exit(fails ? 1 : 0);
