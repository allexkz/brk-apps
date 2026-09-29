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
 *     "items": { "<addonProductId>": { "mode": "gift"|"percent"|"fixed", "value": 10, "label": "..", "maxQty": 1, "applyTo": "addon"|"trigger" } }
 * } } }
 *
 * Regras:
 *   - só aplica se o produto-gatilho ainda está no carrinho;
 *   - limita a qtd descontada por item ao `maxQty` do item (padrão 1; 0 = ilimitado);
 *   - `applyTo: "trigger"` (isenção fiscal): o add-on fica a preço cheio e o valor
 *     em R$ do desconto dele é abatido da(s) linha(s) do produto-gatilho, somado por
 *     gatilho e limitado ao subtotal dessas linhas.
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

  // Presença de cada produto no carrinho (anti-exploit do trigger) e linhas
  // "normais" (fora de bundle) de cada produto, alvo da isenção.
  const productQty = {};
  const triggerLines = {};
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m && m.__typename === "ProductVariant" && m.product && m.product.id) {
      const pid = numericId(m.product.id);
      productQty[pid] = (productQty[pid] || 0) + line.quantity;
      if (!(line.bundle && line.bundle.value)) {
        (triggerLines[pid] = triggerLines[pid] || []).push(line);
      }
    }
  }

  // Orçamento de unidades com desconto por (bundle + item).
  const budgets = {};
  const candidates = [];
  const onTrigger = {}; // pid do gatilho -> { cents, labels }

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

    // Isenção: acumula o valor do desconto no gatilho em vez de descontar o add-on.
    if (itemCfg.applyTo === "trigger" && trig && triggerLines[String(trig)]) {
      const cents = discountCentsPerUnit(itemCfg, unitCents(line)) * qty;
      if (cents <= 0) continue;
      budgets[budgetKey] = remaining - qty;
      const acc = (onTrigger[String(trig)] = onTrigger[String(trig)] || { cents: 0, labels: [] });
      acc.cents += cents;
      const label = itemCfg.label || "Bundle";
      if (!acc.labels.includes(label)) acc.labels.push(label);
      continue;
    }

    const value = discountValue(itemCfg);
    if (!value) continue;

    budgets[budgetKey] = remaining - qty;
    candidates.push({
      message: itemCfg.label || "Bundle",
      targets: [{ cartLine: { id: line.id, quantity: qty } }],
      value,
    });
  }

  // Distribui o desconto acumulado de cada gatilho pelas linhas dele (um
  // candidate por linha, limitado ao subtotal da linha).
  for (const pid of Object.keys(onTrigger)) {
    let left = onTrigger[pid].cents;
    const message = onTrigger[pid].labels.join(" + ");
    for (const line of triggerLines[pid]) {
      if (left <= 0) break;
      const cap = unitCents(line) * line.quantity;
      const cents = Math.min(left, cap);
      if (cents <= 0) continue;
      left -= cents;
      candidates.push({
        message,
        targets: [{ cartLine: { id: line.id } }],
        value: { fixedAmount: { amount: (cents / 100).toFixed(2), appliesToEachItem: false } },
      });
    }
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

/** Preço unitário da linha em centavos. */
function unitCents(line) {
  const amt = line.cost && line.cost.amountPerQuantity && line.cost.amountPerQuantity.amount;
  const n = Math.round(Number(amt) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Valor do desconto do item por unidade, em centavos (para a isenção).
 * @param {{mode?: string, value?: number}} cfg
 * @param {number} baseCents
 */
function discountCentsPerUnit(cfg, baseCents) {
  const raw = Number(cfg.value);
  if (cfg.mode === "gift") return baseCents;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (cfg.mode === "percent") return Math.round((baseCents * Math.min(raw, 100)) / 100);
  if (cfg.mode === "fixed") return Math.min(Math.round(raw * 100), baseCents);
  return 0;
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
