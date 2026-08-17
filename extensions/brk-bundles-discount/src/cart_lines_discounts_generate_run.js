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
 * BRK Bundles — desconto POR ITEM do add-on.
 *
 * Cada linha de add-on carrega:
 *   - `_brk_bundle`        = id do bundle
 *   - `_brk_bundle_item`   = id do produto add-on (chave do desconto do item)
 *   - `_brk_bundle_trigger`= id do produto que disparou (anti-exploit)
 *
 * Config (jsonValue do metafield brk-bundles/config):
 * { "bundles": { "<bundleId>": {
 *     "enabled": true,
 *     "items": { "<addonProductId>": { "mode": "gift"|"percent"|"fixed", "value": 10, "label": "..", "maxQty": 1 } }
 * } } }
 *
 * Regras:
 *   - só aplica se o produto-gatilho ainda está no carrinho;
 *   - limita a qtd descontada por item ao `maxQty` do item (padrão 1; 0 = ilimitado).
 *
 * @param {Input} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  const config = input.discount.metafield?.jsonValue;
  const bundles = (config && config.bundles) || {};

  // Presença de cada produto no carrinho (anti-exploit do trigger).
  const productQty = {};
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m && m.__typename === "ProductVariant" && m.product && m.product.id) {
      const pid = numericId(m.product.id);
      productQty[pid] = (productQty[pid] || 0) + line.quantity;
    }
  }

  // Orçamento de unidades com desconto por (bundle + item).
  const budgets = {};
  const candidates = [];

  for (const line of input.cart.lines) {
    const bundleId = line.bundle && line.bundle.value;
    if (!bundleId) continue;

    const bundleCfg = bundles[bundleId];
    if (!bundleCfg || bundleCfg.enabled === false) continue;

    const itemKey = line.item && line.item.value;
    const items = bundleCfg.items || {};
    const itemCfg = itemKey ? items[itemKey] : null;
    if (!itemCfg) continue;

    // Anti-exploit: produto-gatilho precisa estar no carrinho.
    const trig = line.trigger && line.trigger.value;
    if (trig && !(productQty[String(trig)] > 0)) continue;

    const budgetKey = bundleId + "::" + itemKey;
    if (budgets[budgetKey] === undefined) {
      const mq = Number(itemCfg.maxQty);
      budgets[budgetKey] = mq === 0 ? Infinity : Number.isFinite(mq) && mq > 0 ? mq : 1;
    }
    const remaining = budgets[budgetKey];
    if (remaining <= 0) continue;

    const qty = Math.min(line.quantity, remaining);
    if (qty <= 0) continue;

    const value = discountValue(itemCfg);
    if (!value) continue;

    budgets[budgetKey] = remaining - qty;
    candidates.push({
      message: itemCfg.label || "Bundle",
      targets: [{ cartLine: { id: line.id, quantity: qty } }],
      value,
    });
  }

  if (candidates.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.All,
          candidates,
        },
      },
    ],
  };
}

/** Extrai o id numérico de um GID. */
function numericId(gid) {
  return String(gid).split("/").pop();
}

/**
 * Converte a config do item no shape de value do candidate.
 * @param {{mode?: string, value?: number}} cfg
 */
function discountValue(cfg) {
  const mode = cfg.mode;
  const raw = Number(cfg.value);

  if (mode === "gift") return { percentage: { value: 100 } };
  if (mode === "percent") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return { percentage: { value: Math.min(raw, 100) } };
  }
  if (mode === "fixed") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return { fixedAmount: { amount: raw.toFixed(2), appliesToEachItem: true } };
  }
  return null;
}
