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
    if (group.deliveryOptions.length === 0) continue;

    const cheapest = group.deliveryOptions.reduce((min, opt) =>
      parseFloat(opt.cost.amount) < parseFloat(min.cost.amount) ? opt : min
    );

    targets.push({
      deliveryOption: {
        handle: cheapest.handle,
      },
    });
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