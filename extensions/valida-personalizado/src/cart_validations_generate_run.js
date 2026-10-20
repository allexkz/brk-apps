// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// SKU do item de personalizacao "nome na camisa".
const PERSO_SKU = "PE1198";

// Mensagem exibida no carrinho e no checkout quando o PE1198 esta avulso.
const ERROR_MESSAGE =
  'O item de personalizacao (nome na camisa) nao pode ser comprado separadamente. Use o botao "Quero meu nome na Camisa" na pagina do produto.';

/**
 * Bloqueia o checkout se houver uma linha com o PE1198 sem os atributos de
 * personalizacao. O modal de personalizacao SEMPRE adiciona o PE1198 junto de
 * Nome + Local (e Posicao/Arte); uma inclusao avulsa (permalink de carrinho ou
 * botao escondido) vem sem esses atributos, e e o que barramos aqui.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const errors = [];

  // So bloqueamos na interacao de CARRINHO da loja (CART_INTERACTION), que e
  // por onde passa qualquer inclusao avulsa do PE1198 no site (permalink de
  // carrinho ou botao escondido). Draft orders no admin avaliam em
  // CHECKOUT_INTERACTION (confirmado), sem passar pelo CART_INTERACTION, entao
  // o vendedor consegue adicionar e finalizar o PE1198 normalmente.
  if (input.buyerJourney?.step !== "CART_INTERACTION") {
    return { operations: [{ validationAdd: { errors } }] };
  }

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;

    const sku = (merchandise.sku || "").toUpperCase();
    if (sku !== PERSO_SKU) continue;

    const nome = (line.nome?.value || "").trim();
    const local = (line.local?.value || "").trim();

    if (!nome || !local) {
      errors.push({ message: ERROR_MESSAGE, target: "$.cart" });
      break; // uma mensagem por carrinho basta
    }
  }

  return { operations: [{ validationAdd: { errors } }] };
}
