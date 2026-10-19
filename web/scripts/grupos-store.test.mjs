// Testes da migração dos Grupos de Produtos (índice JSON -> metaobjects).
// Uso: node scripts/grupos-store.test.mjs [caminho do backup do brk_groups.index]
// Sem backup, roda só os casos sintéticos.
import fs from "node:fs";
import {
  groupHandle,
  groupToFields,
  fieldsToGroup,
  sameGroup,
  upsertMetaobjectGroups,
  listMetaobjectGroups,
} from "../app/grupos-store.server.js";

let fails = 0;
let passes = 0;
function ok(cond, name) {
  if (cond) passes++;
  else { fails++; console.log("FAIL", name); }
}
const node = (g, position) => ({ id: "gid://shopify/Metaobject/1", handle: groupHandle(g.id), fields: groupToFields(g, position) });

// ── sintéticos ──
ok(groupHandle("g_1782497341540_nes4j") === "g-1782497341540-nes4j", "handle normaliza _ para -");
ok(groupHandle("G_ABC__x") === "g-abc-x", "handle minúsculo e sem hífen repetido");
const g1 = { id: "g_1_a", name: "Camisa X", optionName: "Modelo", status: "draft", swatchSource: "custom",
  products: [{ productGid: "gid://shopify/Product/1", handle: "a", title: "A \"aspas\" ç", image: null, value: "Masculino", color: "#fff" }] };
const back = fieldsToGroup(node(g1, 7));
ok(sameGroup(g1, back.group), "ida e volta preserva o grupo");
ok(back.position === 7, "position preservada");
ok(sameGroup({ id: "g_2" }, fieldsToGroup({ handle: "g-2", fields: [{ key: "group_id", value: "g_2" }] }).group), "campos ausentes = defaults");
ok(!sameGroup(g1, { ...g1, products: [] }), "sameGroup detecta diferença");

// upsert em lotes de 10 aliases + list paginado, com admin falso
{
  const calls = [];
  const store = new Map();
  const admin = {
    async graphql(q, { variables } = {}) {
      calls.push(q);
      if (q.startsWith("mutation up")) {
        const out = {};
        for (const k of Object.keys(variables).filter((x) => x.startsWith("h"))) {
          const i = k.slice(1);
          store.set(variables[k].handle, { id: "mo_" + variables[k].handle, handle: variables[k].handle, fields: variables["m" + i].fields });
          out["u" + i] = { metaobject: { id: "mo_" + variables[k].handle }, userErrors: [] };
        }
        return { json: async () => ({ data: out }) };
      }
      const all = [...store.values()];
      const start = variables?.after ? Number(variables.after) : 0;
      const nodes = all.slice(start, start + 250);
      const end = start + nodes.length;
      return { json: async () => ({ data: { metaobjects: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } }) };
    },
  };
  const many = Array.from({ length: 23 }, (_, i) => ({ group: { ...g1, id: `g_9_${i}` }, position: 22 - i }));
  const errs = await upsertMetaobjectGroups(admin, many);
  ok(errs.length === 0, "upsert sem erros");
  ok(calls.filter((q) => q.startsWith("mutation up")).length === 3, "23 grupos = 3 mutations (lotes de 10)");
  const listed = await listMetaobjectGroups(admin);
  ok(listed.groups.length === 23, "list devolve todos");
  ok(listed.groups[0].id === "g_9_22", "list ordena por position");
}

// ── dados reais (backup do índice) ──
const backup = process.argv[2];
if (backup && fs.existsSync(backup)) {
  const groups = JSON.parse(fs.readFileSync(backup, "utf8"));
  const handles = new Set();
  let roundtrip = 0, maxProducts = 0, longText = 0, newlines = 0;
  groups.forEach((g, i) => {
    handles.add(groupHandle(g.id));
    if (sameGroup(g, fieldsToGroup(node(g, i)).group)) roundtrip++;
    const f = groupToFields(g, i);
    const prod = f.find((x) => x.key === "products").value;
    maxProducts = Math.max(maxProducts, Buffer.byteLength(prod));
    for (const x of f) {
      if (x.key === "products") continue;
      if (x.value.length > 255) longText++;
      if (/[\r\n]/.test(x.value)) newlines++;
    }
  });
  ok(handles.size === groups.length, `handles únicos (${handles.size}/${groups.length})`);
  ok(roundtrip === groups.length, `ida e volta idêntica (${roundtrip}/${groups.length})`);
  ok(maxProducts < 128 * 1024, `maior campo products ${maxProducts} B < 128 KB`);
  ok(longText === 0, `textos ≤ 255 caracteres (${longText} acima)`);
  ok(newlines === 0, `textos de 1 linha (${newlines} com quebra)`);
  console.log(`dados reais: ${groups.length} grupos, maior campo products ${maxProducts} B`);
}

console.log(fails ? `\n${fails} falha(s), ${passes} ok` : `\n${passes} teste(s) ok`);
process.exit(fails ? 1 : 0);
