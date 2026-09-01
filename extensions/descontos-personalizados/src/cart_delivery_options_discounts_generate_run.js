import {
  DiscountClass,
  DeliveryDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").DeliveryInput} RunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

const EMPTY = { operations: [] };

/**
 * Frete grátis por coleção OU por valor mínimo do carrinho.
 *
 * Regra: zera (100% OFF) a opção de entrega de MENOR custo de cada grupo de
 * entrega quando QUALQUER uma das condições abaixo é satisfeita:
 *   1. O carrinho tem algum item de alguma das coleções configuradas; OU
 *   2. O subtotal dos PRODUTOS atinge o valor mínimo configurado (`minSubtotal`).
 *
 * As duas condições são independentes: a de valor vale para o carrinho inteiro,
 * qualquer produto, mesmo sem coleção elegível.
 *
 * O valor usado é a soma do `cost.totalAmount` de cada linha — o valor dos
 * produtos APÓS descontos. Assim um cupom que derrube o carrinho abaixo do
 * limite tira o frete grátis (ex.: R$210 com um cupom de −R$20 vira R$190, e
 * se o mínimo for R$199 o cliente NÃO ganha frete).
 *
 * Configuração (metafield "$app:descontos-personalizados/config", JSON):
 *   { "enabled": true,
 *     "collectionIds": ["gid://shopify/Collection/123"],
 *     "minSubtotal": 299 }
 * `collectionIds` também alimenta a variável $collectionIds do input query
 * (via [extensions.input.variables] no shopify.extension.toml).
 *
 * IMPORTANTE: o PERÍODO da campanha (início/fim) é controlado pelos campos
 * nativos startsAt/endsAt do desconto — Shopify functions não acessam data/hora.
 * Aqui só checamos `enabled` (liga/desliga instantâneo) e a elegibilidade.
 *
 * @param {RunInput} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  const { cart, discount } = input;

  // Só atuamos sobre a classe de desconto de frete.
  if (!discount.discountClasses.includes(DiscountClass.Shipping)) {
    return EMPTY;
  }

  // Configuração vinda do metafield do desconto.
  const config = discount.metafield?.jsonValue ?? null;
  if (!config || config.enabled === false) {
    return EMPTY;
  }

  // Condição 1: há algum item de alguma coleção configurada no carrinho?
  const hasEligibleCollection = cart.lines.some(
    (line) =>
      line.merchandise.__typename === 'ProductVariant' &&
      line.merchandise.product?.inAnyCollection === true,
  );

  // Condição 2: o valor dos produtos (APÓS descontos) atinge o mínimo?
  const minSubtotal = Number(config.minSubtotal) || 0;
  let meetsMinSubtotal = false;
  if (minSubtotal > 0) {
    const productTotal = cart.lines.reduce(
      (sum, line) => sum + parseFloat(line.cost?.totalAmount?.amount ?? '0'),
      0,
    );
    meetsMinSubtotal = productTotal >= minSubtotal;
  }

  if (!hasEligibleCollection && !meetsMinSubtotal) {
    return EMPTY;
  }

  // Para cada grupo de entrega, zera a opção de menor custo.
  const operations = [];
  for (const group of cart.deliveryGroups) {
    const options = group.deliveryOptions || [];
    if (options.length === 0) continue;

    const cheapest = options.reduce((min, o) =>
      parseFloat(o.cost.amount) < parseFloat(min.cost.amount) ? o : min,
    );

    operations.push({
      deliveryDiscountsAdd: {
        candidates: [
          {
            message: 'Frete grátis',
            targets: [{ deliveryOption: { handle: cheapest.handle } }],
            value: { percentage: { value: 100 } },
          },
        ],
        selectionStrategy: DeliveryDiscountSelectionStrategy.All,
      },
    });
  }

  return operations.length ? { operations } : EMPTY;
}
