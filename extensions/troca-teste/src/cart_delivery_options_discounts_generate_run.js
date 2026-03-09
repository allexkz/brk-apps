// @ts-check

import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
} from "../generated/api";

/**
 * @typedef {import("../generated/api").Input} Input
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

/**
 * @param {Input} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes(DiscountClass.Shipping)) {
    return { operations: [] };
  }

  const hasTrocaCode = input.enteredDiscountCodes.some(({ code }) =>
    code.toUpperCase().includes("TROCA")
  );

  if (!hasTrocaCode) {
    return { operations: [] };
  }

  const targets = [];

  for (const group of input.cart.deliveryGroups) {
    for (const option of group.deliveryOptions) {
      targets.push({
        deliveryOption: {
          handle: option.handle,
        },
      });
    }
  }

  if (targets.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
          candidates: [
            {
              message: "Frete grátis para troca",
              targets,
              value: {
                percentage: {
                  value: 100,
                },
              },
            },
          ],
        },
      },
    ],
  };
}