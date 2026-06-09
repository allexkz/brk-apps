// @ts-check

import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from "../generated/api";

/**
 * @typedef {import("../generated/api").Input} Input
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {Input} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  // Identify gift lines by the _brk_gift_progress property set by the theme
  const giftLines = input.cart.lines.filter((line) =>
    line.attribute && line.attribute.value === "true"
  );

  if (giftLines.length === 0) {
    return { operations: [] };
  }

  // Apply 100% discount to all gift lines in a single operation
  return {
    operations: [
      {
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.All,
          candidates: giftLines.map((line) => ({
            message: "Brinde",
            targets: [{ cartLine: { id: line.id } }],
            value: { percentage: { value: 100 } },
          })),
        },
      },
    ],
  };
}
