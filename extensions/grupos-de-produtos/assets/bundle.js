/* BRK Bundles — storefront runtime.
 *
 * - Add-ons inline marcados entram no carrinho e o PRÓPRIO tema faz o add do
 *   produto base (re-submit) — preserva loading/minicart/personalização nativos.
 * - Modo popup: o produto base só é adicionado DEPOIS que o cliente confirma
 *   (aceitar = base + upsell; recusar = só base; fechar = cancela).
 * - Limite por carrinho: `maxQty` do item (0 = ilimitado) impede adicionar mais
 *   unidades do add-on do que o permitido (checando /cart.js antes).
 * (Funciona na página de produto; a Compra Rápida/quick view não é suportada.)
 *
 * Properties da linha do add-on: `_brk_bundle`, `_brk_bundle_item` (id do produto
 * add-on), `_brk_bundle_trigger` (id do produto que disparou).
 */
(function () {
  "use strict";

  function readConfig() {
    try {
      var el = document.getElementById("brk-bundles-config");
      return el ? JSON.parse(el.textContent) : {};
    } catch (_) {
      return {};
    }
  }

  function readBundles(root) {
    var out = [];
    (root || document).querySelectorAll("script.brk-bundle-data").forEach(function (el) {
      try { out.push(JSON.parse(el.textContent)); } catch (_) {}
    });
    return out;
  }

  var CONFIG = readConfig();

  // Registro global (mesclado à medida que modais carregam) só para o maxQty.
  var MAX_BY_KEY = {};
  function register(root) {
    readBundles(root).forEach(function (b) {
      (b.addons || []).forEach(function (a) {
        MAX_BY_KEY[b.id + "::" + a.productId] = a.maxQty == null ? 1 : Number(a.maxQty);
      });
    });
  }
  register(document);

  var cartEl =
    document.querySelector("cart-notification") || document.querySelector("cart-drawer");
  var addUrl = (window.routes && window.routes.cart_add_url) || "/cart/add";

  // ── Escopo (página de produto) ───────────────────────────────────────────────

  function scopeFor(form) {
    return form.closest(".product-detail__information, .product-detail, main") || document;
  }
  function triggerFor(scope) {
    var el = (scope || document).querySelector("brk-bundles[data-product-id]");
    return el ? el.getAttribute("data-product-id") : "";
  }

  // ── Preço / desconto ─────────────────────────────────────────────────────────

  function computeFinal(baseCents, mode, value) {
    var v = Number(value) || 0;
    if (mode === "gift") return 0;
    if (mode === "percent") return Math.max(0, Math.round(baseCents - (baseCents * v) / 100));
    if (mode === "fixed") return Math.max(0, baseCents - Math.round(v * 100));
    return baseCents;
  }
  function money(cents) {
    return "R$ " + (Number(cents) / 100).toFixed(2).replace(".", ",");
  }
  function priceHTML(baseCents, mode, value) {
    var final = computeFinal(baseCents, mode, value);
    if (final !== baseCents) {
      return "<s>" + money(baseCents) + "</s> <strong>" + money(final) + "</strong>";
    }
    return money(baseCents);
  }

  // ── Cart ──────────────────────────────────────────────────────────────────

  function addItemsSilent(items) {
    return fetch(addUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/javascript" },
      body: JSON.stringify({ items: items }),
    }).then(function (r) { return r.json(); });
  }

  function addonItem(bundleId, itemId, variantId, triggerId) {
    var props = { _brk_bundle: bundleId, _brk_bundle_item: String(itemId) };
    if (triggerId) props._brk_bundle_trigger = String(triggerId);
    return { id: Number(variantId), quantity: 1, properties: props };
  }

  function itemMaxQty(bundleId, itemId) {
    var v = MAX_BY_KEY[bundleId + "::" + itemId];
    return v == null ? 1 : Number(v);
  }

  // Remove os add-ons que já atingiram o limite (maxQty) no carrinho. 0 = ilimitado.
  function filterByCartLimit(items) {
    if (!items.length) return Promise.resolve(items);
    return fetch("/cart.js")
      .then(function (r) { return r.json(); })
      .then(function (cart) {
        var counts = {};
        (cart.items || []).forEach(function (li) {
          var p = li.properties || {};
          if (p._brk_bundle && p._brk_bundle_item) {
            var k = p._brk_bundle + "::" + p._brk_bundle_item;
            counts[k] = (counts[k] || 0) + li.quantity;
          }
        });
        var out = [];
        items.forEach(function (it) {
          var b = it.properties._brk_bundle, id = it.properties._brk_bundle_item;
          var max = itemMaxQty(b, id);
          var k = b + "::" + id;
          var have = counts[k] || 0;
          if (max <= 0 || have < max) { out.push(it); counts[k] = have + 1; }
        });
        return out;
      })
      .catch(function () { return items; });
  }

  // ── Popup ─────────────────────────────────────────────────────────────────

  function interpolateLabel(item) {
    var lbl = item.label || "";
    if (item.mode === "percent") lbl = lbl.replace("{{brk_discount_percentage}}", item.value);
    else if (item.mode === "fixed") lbl = lbl.replace("{{brk_discount_flat}}", item.value);
    return lbl;
  }
  function firstAvailableVariant(addon) {
    var vs = addon.variants || [];
    for (var i = 0; i < vs.length; i++) if (vs[i].available) return vs[i];
    return vs[0];
  }

  // Resolve com { action: 'accept'|'decline'|'dismiss', items: [] }
  function showPopup(popupBundles, triggerId) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "brk-bd-popup";
      var card = document.createElement("div");
      card.className = "brk-bd-popup__card";

      var chosen = {};

      popupBundles.forEach(function (bundle) {
        // título do popup = título do bundle (subtítulo abaixo, se houver)
        var h = document.createElement("p");
        h.className = "brk-bd-popup__title";
        h.textContent = bundle.title || CONFIG.popupTitle || "Aproveite esta oferta!";
        card.appendChild(h);
        if (bundle.subtitle) {
          var st = document.createElement("p");
          st.className = "brk-bd__subtitle";
          st.textContent = bundle.subtitle;
          card.appendChild(st);
        }
        var list = document.createElement("ul");
        list.className = "brk-bd__list";

        (bundle.addons || []).forEach(function (addon, ai) {
          var sel = firstAvailableVariant(addon);
          if (!sel) return;
          var key = bundle.id + ":" + ai;
          var state = { bundleId: bundle.id, itemId: addon.productId, variantId: sel.variantId };

          var li = document.createElement("li");
          li.className = "brk-bd__item";
          var row = document.createElement("label");
          row.className = "brk-bd__row";

          var check = document.createElement("input");
          check.type = "checkbox";
          check.className = "brk-bd__check";
          check.checked = !!addon.preselected;
          if (check.checked) chosen[key] = state;
          check.addEventListener("change", function () {
            if (check.checked) chosen[key] = state; else delete chosen[key];
          });
          row.appendChild(check);

          if (addon.image) {
            var img = document.createElement("span");
            img.className = "brk-bd__img";
            img.style.backgroundImage = "url(" + addon.image + ")";
            row.appendChild(img);
          }

          var info = document.createElement("span");
          info.className = "brk-bd__info";
          var name = document.createElement("span");
          name.className = "brk-bd__name";
          name.textContent = addon.title || "";
          info.appendChild(name);
          var price = document.createElement("span");
          price.className = "brk-bd__price";
          price.innerHTML = priceHTML(sel.priceCents, addon.mode, addon.value);
          info.appendChild(price);

          if ((addon.variants || []).length > 1) {
            var pillWrap = document.createElement("span");
            pillWrap.className = "brk-bd__variants";
            addon.variants.forEach(function (v) {
              var pill = document.createElement("button");
              pill.type = "button";
              pill.className = "brk-bd__pill" + (v.variantId === sel.variantId ? " is-active" : "") + (v.available ? "" : " is-unavailable");
              pill.textContent = v.title;
              if (!v.available) pill.disabled = true;
              pill.addEventListener("click", function (e) {
                e.preventDefault();
                if (!v.available) return;
                pillWrap.querySelectorAll(".brk-bd__pill").forEach(function (p) { p.classList.remove("is-active"); });
                pill.classList.add("is-active");
                state.variantId = v.variantId;
                price.innerHTML = priceHTML(v.priceCents, addon.mode, addon.value);
                if (check.checked) chosen[key] = state;
              });
              pillWrap.appendChild(pill);
            });
            info.appendChild(pillWrap);
          }
          row.appendChild(info);

          var lbl = interpolateLabel(addon);
          if (lbl) {
            var badge = document.createElement("span");
            badge.className = "brk-bd__label";
            badge.textContent = lbl;
            row.appendChild(badge);
          }
          li.appendChild(row);
          list.appendChild(li);
        });
        card.appendChild(list);
      });

      var actions = document.createElement("div");
      actions.className = "brk-bd-popup__actions";
      var decline = document.createElement("button");
      decline.type = "button";
      decline.className = "brk-bd-popup__btn brk-bd-popup__btn--decline";
      decline.textContent = CONFIG.popupDecline || "Não, obrigado";
      var accept = document.createElement("button");
      accept.type = "button";
      accept.className = "brk-bd-popup__btn brk-bd-popup__btn--accept";
      accept.textContent = CONFIG.popupAccept || "Adicionar";
      actions.appendChild(decline);
      actions.appendChild(accept);
      card.appendChild(actions);

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function close(result) { overlay.remove(); resolve(result); }
      decline.addEventListener("click", function () { close({ action: "decline", items: [] }); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close({ action: "dismiss", items: [] }); });
      accept.addEventListener("click", function () {
        var items = Object.keys(chosen).map(function (k) {
          return addonItem(chosen[k].bundleId, chosen[k].itemId, chosen[k].variantId, triggerId);
        });
        close({ action: "accept", items: items });
      });
    });
  }

  // ── Inline (pills + limite de escolha) ───────────────────────────────────────

  function bindInline(root) {
    (root || document).querySelectorAll(".brk-bd").forEach(function (bd) {
      var chooseMax = Number(bd.getAttribute("data-choose-max")) || 0;
      bd.querySelectorAll(".brk-bd__item").forEach(function (item) {
        var mode = item.getAttribute("data-mode");
        var value = item.getAttribute("data-value");
        var check = item.querySelector(".brk-bd__check");

        if (check && !check.__brkBound) {
          check.__brkBound = true;
          check.addEventListener("change", function () {
            if (!check.checked || chooseMax <= 0) return;
            var checked = Array.prototype.slice.call(bd.querySelectorAll(".brk-bd__check:checked"));
            while (checked.length > chooseMax) {
              var victim = null;
              for (var i = 0; i < checked.length; i++) if (checked[i] !== check) { victim = checked[i]; break; }
              victim = victim || checked[0];
              victim.checked = false;
              checked = checked.filter(function (c) { return c !== victim; });
            }
          });
        }

        var pills = item.querySelectorAll(".brk-bd__pill");
        if (!pills.length) return;
        var priceEl = item.querySelector(".brk-bd__price");
        pills.forEach(function (pill) {
          if (pill.__brkBound) return;
          pill.__brkBound = true;
          pill.addEventListener("click", function (e) {
            e.preventDefault();
            if (pill.hasAttribute("disabled")) return;
            item.querySelectorAll(".brk-bd__pill").forEach(function (p) { p.classList.remove("is-active"); });
            pill.classList.add("is-active");
            if (check) check.setAttribute("data-variant-id", pill.getAttribute("data-variant-id"));
            if (priceEl) priceEl.innerHTML = priceHTML(Number(pill.getAttribute("data-price")), mode, value);
          });
        });
      });
    });
  }

  function inlineSelectedItems(scope, triggerId) {
    var items = [];
    scope.querySelectorAll(".brk-bd[data-display='inline'] .brk-bd__check").forEach(function (chk) {
      if (!chk.checked) return;
      var bundleId = chk.getAttribute("data-bundle-id");
      var itemId = chk.getAttribute("data-item");
      var variantId = chk.getAttribute("data-variant-id");
      if (bundleId && variantId) items.push(addonItem(bundleId, itemId, variantId, triggerId));
    });
    return items;
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  var bypass = false;

  function submitMain(form, btn) {
    setTimeout(function () {
      bypass = true;
      try {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      } catch (err) {
        bypass = false;
        if (btn) btn.classList.remove("loading");
      }
    }, 0);
  }

  // Adiciona os add-ons (respeitando o limite) e deixa o tema adicionar o base.
  function proceed(form, addonItems) {
    var btn = form.querySelector('[type="submit"]');
    if (btn) btn.classList.add("loading");
    filterByCartLimit(addonItems).then(function (items) {
      var pre = items.length ? addItemsSilent(items) : Promise.resolve();
      pre.catch(function () {}).then(function () { submitMain(form, btn); });
    });
  }

  function onSubmit(e) {
    var form = e.currentTarget;
    if (bypass) { bypass = false; return; } // 2ª passada → tema segue

    var scope = scopeFor(form);
    var triggerId = triggerFor(scope);
    var inlineItems = inlineSelectedItems(scope, triggerId);
    var popupBundles = readBundles(scope).filter(function (b) {
      return b.display === "popup" && b.addons && b.addons.length;
    });
    if (inlineItems.length === 0 && popupBundles.length === 0) return;

    e.preventDefault();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

    if (popupBundles.length) {
      // NÃO adiciona nada até o cliente confirmar
      showPopup(popupBundles, triggerId).then(function (res) {
        if (res.action === "dismiss") return; // cancela: nada é adicionado
        proceed(form, inlineItems.concat(res.items || []));
      });
    } else {
      proceed(form, inlineItems);
    }
  }

  function bindForms(root) {
    var selector = CONFIG.productFormSelector || 'form[action*="/cart/add"]';
    (root || document).querySelectorAll(selector).forEach(function (form) {
      if (form.__brkBundlesBound) return;
      form.__brkBundlesBound = true;
      form.addEventListener("submit", onSubmit, true); // capture: antes do tema
    });
  }

  function scan(root) {
    register(root);
    bindForms(root);
    bindInline(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { scan(document); });
  } else {
    scan(document);
  }
  document.addEventListener("shopify:section:load", function (e) { scan(e.target || document); });
})();
