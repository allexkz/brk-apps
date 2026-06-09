import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

const EMPTY = { operations: [] };

/**
 * Desconto configurável por coleção, aplicado em PARES.
 *
 * Regra: para cada par completo de itens elegíveis (que pertencem a alguma das
 * coleções configuradas), aplica X% de desconto. A quantidade descontada é
 * floor(Q / 2) * 2, onde Q é a quantidade total de itens elegíveis no carrinho.
 * Quando sobra 1 unidade (Q ímpar), a unidade de MENOR preço unitário fica sem
 * desconto (maximiza o benefício do cliente).
 *
 * Configuração (metafield "$app:descontos-personalizados/config", JSON):
 *   { "enabled": true, "collectionIds": ["gid://shopify/Collection/123"], "percentage": 20 }
 * `collectionIds` também alimenta a variável $collectionIds do input query.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const { cart, discount } = input;

  // Só atuamos sobre a classe de desconto de produto.
  if (!discount.discountClasses.includes(DiscountClass.Product)) {
    return EMPTY;
  }

  // Configuração vinda do metafield do desconto.
  const config = discount.metafield?.jsonValue ?? null;
  if (!config || config.enabled === false) {
    return EMPTY;
  }

  const percentage =
    typeof config.percentage === 'number' ? config.percentage : 20;
  if (percentage <= 0) {
    return EMPTY;
  }

  // Linhas elegíveis: variantes que pertencem a alguma coleção configurada.
  const eligible = cart.lines.filter(
    (line) =>
      line.merchandise.__typename === 'ProductVariant' &&
      line.merchandise.product?.inAnyCollection === true,
  );
  if (eligible.length === 0) {
    return EMPTY;
  }

  // Quantidade total elegível e quantas unidades entram no desconto (pares).
  const totalQty = eligible.reduce((sum, line) => sum + line.quantity, 0);
  const discountedUnits = Math.floor(totalQty / 2) * 2;
  if (discountedUnits === 0) {
    return EMPTY;
  }

  // Preço unitário de cada linha para decidir a sobra ímpar.
  const lines = eligible.map((line) => ({
    id: line.id,
    quantity: line.quantity,
    unitPrice: parseFloat(line.cost.subtotalAmount.amount) / line.quantity,
  }));

  // Por padrão, descontamos a quantidade inteira de cada linha elegível.
  const targetQty = new Map(lines.map((l) => [l.id, l.quantity]));

  // Sobra ímpar (0 ou 1): remove 1 unidade do desconto na linha de menor preço.
  if (totalQty - discountedUnits === 1) {
    const cheapest = lines.reduce(
      (min, l) => (l.unitPrice < min.unitPrice ? l : min),
      lines[0],
    );
    targetQty.set(cheapest.id, targetQty.get(cheapest.id) - 1);
  }

  // Um único candidato com um target por linha (cada um com sua quantidade).
  const targets = [];
  for (const l of lines) {
    const qty = targetQty.get(l.id);
    if (qty > 0) {
      targets.push({ cartLine: { id: l.id, quantity: qty } });
    }
  }
  if (targets.length === 0) {
    return EMPTY;
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.All,
          candidates: [
            {
              message: `${percentage}% OFF`,
              targets,
              value: { percentage: { value: percentage } },
            },
          ],
        },
      },
    ],
  };
}
