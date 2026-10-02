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
 *     "items": { "<addonProductId>": { "mode": "gift"|"percent"|"fixed", "value": 10, "label": "..", "maxQty": 1, "applyTo": "addon"|"trigger" } },
 *     "targets": { "type": "products"|"collections"|"tags", "productIds": ["1"], "collectionIds": ["2"], "tags": ["x"] }
 *   } },
 *   "collectionIds": ["gid://shopify/Collection/2"], "tags": ["x"] }  // variables do input query
 *
 * Formato compacto (v2, gravado pelo admin p/ caber no limite de 10 KB):
 * { "v": 2, "L": ["label", ...], "collectionIds": [...], "tags": [...],
 *   "b": { "<bundleId>": {
 *     "i": { "<addonProductId>": { "m": "g"|"p"|"f", "v": 10, "l": <índice em L>, "q": 1, "a": 1 } },  // a=1 → isenção
 *     "t": { "k": "p"|"c"|"g", "ids": [1, 2] }   // produtos / collections (ids numéricos) / tags
 *   } } }
 * Ambos são normalizados p/ o formato acima por `normalizeBundles`.
 *
 * Regras:
 *   - a linha precisa ser do próprio produto add-on (`_brk_bundle_item`);
 *   - bundle com `targets`: o gatilho é obrigatório e precisa ser elegível
 *     (produto / collection / tag). Sem `targets` (config antiga, ou validação
 *     desligada pelo admin) vale só a regra abaixo;
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

  const bundles = normalizeBundles(input.discount.metafield?.jsonValue);

  // Presença de cada produto no carrinho (anti-exploit do trigger) e linhas
  // "normais" (fora de bundle) de cada produto, alvo da isenção.
  const productQty = {};
  const triggerLines = {};
  const productInfo = {}; // pid -> { colls: Set(id numérico), tags: Set(tag) }
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m && m.__typename === "ProductVariant" && m.product && m.product.id) {
      const pid = numericId(m.product.id);
      productQty[pid] = (productQty[pid] || 0) + line.quantity;
      if (!productInfo[pid]) productInfo[pid] = membershipOf(m.product);
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

    // Anti-exploit: a linha precisa ser do próprio produto add-on.
    const m = line.merchandise;
    const linePid = m && m.__typename === "ProductVariant" && m.product ? numericId(m.product.id) : null;
    if (linePid !== String(itemKey)) continue;

    // Anti-exploit: produto-gatilho precisa estar no carrinho.
    const trig = line.trigger && line.trigger.value;
    if (trig && !(productQty[String(trig)] > 0)) continue;

    // Segmentação: com `targets`, o gatilho é obrigatório e precisa ser elegível.
    if (bundleCfg.targets) {
      if (!trig || !isEligible(bundleCfg.targets, String(trig), productInfo[String(trig)])) continue;
    }

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

const V2_MODES = { g: "gift", p: "percent", f: "fixed" };
const V2_KINDS = { p: ["products", "productIds"], c: ["collections", "collectionIds"], g: ["tags", "tags"] };

/**
 * Config da discount (formato antigo `bundles` ou compacto v2) → bundles no
 * formato antigo.
 * @param {any} config
 */
function normalizeBundles(config) {
  if (!config) return {};
  if (config.v !== 2) return config.bundles || {};
  const labels = config.L || [];
  /** @type {Record<string, any>} */
  const out = {};
  for (const id of Object.keys(config.b || {})) {
    const e = config.b[id] || {};
    /** @type {Record<string, any>} */
    const items = {};
    for (const pid of Object.keys(e.i || {})) {
      const it = e.i[pid] || {};
      items[pid] = {
        mode: V2_MODES[it.m] || it.m,
        value: it.v,
        label: labels[it.l],
        maxQty: it.q,
        applyTo: it.a ? "trigger" : "addon",
      };
    }
    /** @type {any} */
    const entry = { enabled: true, items };
    const kind = e.t && V2_KINDS[e.t.k];
    if (kind) entry.targets = { type: kind[0], [kind[1]]: (e.t.ids || []).map(String) };
    out[id] = entry;
  }
  return out;
}

/** Extrai o id numérico de um GID. */
function numericId(gid) {
  return String(gid).split("/").pop();
}

/**
 * Collections e tags (dentre as consultadas via variables) que o produto tem.
 * @param {any} product
 */
function membershipOf(product) {
  const colls = new Set();
  for (const c of product.inCollections || []) {
    if (c && c.isMember) colls.add(numericId(c.collectionId));
  }
  const tags = new Set();
  for (const t of product.hasTags || []) {
    if (t && t.hasTag) tags.add(String(t.tag).toLowerCase());
  }
  return { colls, tags };
}

/**
 * O produto-gatilho está na segmentação do bundle?
 * Tipo desconhecido (ex.: metafield) não é validável aqui → elegível.
 * @param {{type?: string, productIds?: string[], collectionIds?: string[], tags?: string[]}} targets
 * @param {string} pid
 * @param {{colls: Set<string>, tags: Set<string>} | undefined} info
 */
function isEligible(targets, pid, info) {
  if (targets.type === "products") {
    return (targets.productIds || []).some((id) => String(id) === pid);
  }
  if (targets.type === "collections") {
    return !!info && (targets.collectionIds || []).some((id) => info.colls.has(String(id)));
  }
  if (targets.type === "tags") {
    return !!info && (targets.tags || []).some((t) => info.tags.has(String(t).toLowerCase()));
  }
  return true;
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
