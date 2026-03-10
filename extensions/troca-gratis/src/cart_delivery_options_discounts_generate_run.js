// @ts-check

import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
} from "../generated/api";

/**
 * @param {import("../generated/api").Input} input
 * @returns {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult}
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
              message: "TROCA GRÁTIS",
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