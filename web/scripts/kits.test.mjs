// Testes das regras puras dos kits (app/kits.js) — sem rede.
// Uso: node scripts/kits.test.mjs
import assert from "node:assert/strict";
import { kitPrice, kitVariantPrice, shortName, kitTitle } from "../app/kits.js";

// Preço: soma × 0,9 arredondado para baixo terminando em 9,90 (desconto ≥ 10%).
assert.equal(kitPrice(169.9 + 219.9, 10), "349.90"); // 350,82
assert.equal(kitPrice(169.9 + 359.9, 10), "469.90"); // 476,82
assert.equal(kitPrice(152.91 + 359.9, 10), "459.90"); // 461,53 (camisa em promoção)
assert.equal(kitPrice(99.9 + 219.9, 10), "279.90"); // 287,82
for (const sum of [319.8, 389.8, 512.81, 529.8, 600]) {
  const p = Number(kitPrice(sum, 10));
  assert.ok(p <= sum * 0.9 + 1e-9, `desconto mínimo em ${sum}`);
  assert.ok(Math.abs((p * 100) % 1000 - 990) < 1e-6, `termina em 9,90: ${p}`);
}
assert.equal(kitPrice(5, 10), "4.50"); // sem espaço para 9,90: usa o valor bruto

// Preço fixo por botina: vale quando é menor que a soma; senão cai no %.
assert.equal(kitVariantPrice(169.9 + 219.9, 10, 329.9), "329.90"); // camisa 169,90 + Chocolate
assert.equal(kitVariantPrice(169.9 + 359.9, 10, 479.9), "479.90"); // camisa 169,90 + Stella
assert.equal(kitVariantPrice(152.91 + 359.9, 10, 479.9), "479.90"); // NS em promoção + Stella
assert.equal(kitVariantPrice(99.9 + 219.9, 10, 329.9), "279.90"); // camiseta: fixo > soma → 10%
assert.equal(kitVariantPrice(99.9 + 359.9, 10, 479.9), "409.90"); // camiseta fem.: idem
assert.equal(kitVariantPrice(389.8, 10, null), "349.90"); // sem fixo → %

// Título
assert.equal(shortName("Camisa Agro Brk Brasil com Proteção Solar UV50+"), "Camisa Agro Brk Brasil");
assert.equal(shortName("Camisa Apache Bege Azul com UV50"), "Camisa Apache Bege Azul");
assert.equal(shortName("Camiseta Agro Brk Patriota Branca com Proteção Solar UV50+"), "Camiseta Agro Brk Patriota Branca");
assert.equal(
  kitTitle({ title: "Camisa Agro Brk São Bento Medalhão Preto com Proteção UV50+" }, { legacyResourceId: "9587666616617", title: "x" }),
  "Kit Camisa Agro Brk São Bento Medalhão Preto + Botina Couro Legítimo Chocolate",
);
assert.equal(
  kitTitle({ title: "Camisa Feminina Nossa Senhora Floral Dourada com UV50" }, { legacyResourceId: "10091739676969", title: "x" }),
  "Kit Camisa Feminina Nossa Senhora Floral Dourada + Botina Feminina Stella Chocolate",
);

console.log("kits.test: ok");
