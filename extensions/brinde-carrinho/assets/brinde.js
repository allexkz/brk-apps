(function () {
  "use strict";

  const configEl = document.getElementById("brk-brinde-config");
  if (!configEl) return;

  const VARIANT_ID = parseInt(configEl.dataset.variantId, 10);
  const THRESHOLD_CENTS = parseInt(configEl.dataset.threshold, 10);
  if (!VARIANT_ID || !THRESHOLD_CENTS) return;

  const PROGRESS_MSG =
    configEl.dataset.progressMessage ||
    "Falta {value} para ativar um brinde exclusivo!";
  const PB_DESKTOP_SEL = configEl.dataset.pbDesktopSelector || "";
  const PB_DESKTOP_POS = configEl.dataset.pbDesktopPosition || "afterend";
  const PB_MOBILE_SEL  = configEl.dataset.pbMobileSelector  || "";
  const PB_MOBILE_POS  = configEl.dataset.pbMobilePosition  || "afterend";

  // Threshold formatted once for use in the reached message
  const THRESHOLD_FMT = (THRESHOLD_CENTS / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  const _fetch = window.fetch.bind(window);
  let _updating    = false;
  let _ownMutation = false;
  let _stylesInjected = false;

  // ── Cart API ──────────────────────────────────────────────────────────────
  async function getCart() {
    const res = await _fetch("/cart.js");
    return res.json();
  }

  async function addGift() {
    _ownMutation = true;
    try {
      const res = await _fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: VARIANT_ID, quantity: 1 }),
      });
      return res.ok;
    } catch (_) { return false; }
    finally { _ownMutation = false; }
  }

  async function removeGift(lineKey) {
    _ownMutation = true;
    try {
      const res = await _fetch("/cart/change.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lineKey, quantity: 0 }),
      });
      return res.ok;
    } catch (_) { return false; }
    finally { _ownMutation = false; }
  }

  // ── Main check ────────────────────────────────────────────────────────────
  async function checkAndUpdate() {
    if (_updating) return;
    _updating = true;
    try {
      const cart = await getCart();
      const giftLine = cart.items.find((i) => i.variant_id === VARIANT_ID);
      const totalWithoutGift = cart.items
        .filter((i) => i.variant_id !== VARIANT_ID)
        .reduce((sum, i) => sum + i.final_line_price, 0);

      updateProgressBar(totalWithoutGift);

      if (totalWithoutGift >= THRESHOLD_CENTS) {
        if (!giftLine) await addGift();
      } else {
        if (giftLine) await removeGift(giftLine.key);
      }
    } catch (e) {
      console.error("[BRK Brinde]", e);
    } finally {
      _updating = false;
    }
  }

  // ── Progress Bar / Reached Message ────────────────────────────────────────
  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const s = document.createElement("style");
    s.textContent =
      "#brk-brinde-progress{box-sizing:border-box;padding:12px 16px;font-family:inherit;font-size:13px;line-height:1.4}" +
      ".brk-bp-text{text-align:center;margin-bottom:7px;color:#1a6b3c;font-weight:500}" +
      ".brk-bp-track{height:4px;background:#d1e7da;border-radius:2px;overflow:hidden}" +
      ".brk-bp-fill{height:100%;background:linear-gradient(90deg,#2d9b57,#1a6b3c);border-radius:2px;transition:width .45s ease;width:0%}" +

      /* Activated container */
      "#brk-brinde-progress.brk-activated{background:linear-gradient(135deg,#edfaf2,#d6f0e1);border-radius:8px;border:1px solid #8ecba0;margin:0 0 2px;animation:brk-glow 2.5s ease-in-out infinite}" +
      "@keyframes brk-glow{0%,100%{box-shadow:0 0 0 0 rgba(45,155,87,.25)}50%{box-shadow:0 0 10px 3px rgba(45,155,87,.12)}}" +

      /* Activated text */
      ".brk-bp-reached{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;color:#1a6b3c;font-size:13px;line-height:1.5}" +
      ".brk-bp-reached-emoji{font-size:24px;line-height:1;animation:brk-bounce .8s ease infinite alternate}" +
      "@keyframes brk-bounce{from{transform:translateY(0)}to{transform:translateY(-4px)}}" +
      ".brk-bp-reached-text{font-weight:500}" +
      ".brk-bp-reached-text strong{color:#0d5c2e;font-weight:700}";
    document.head.appendChild(s);
  }

  function isMobile() { return window.innerWidth < 768; }

  function placeProgressBar(el) {
    const sel = isMobile() ? PB_MOBILE_SEL : PB_DESKTOP_SEL;
    const pos = isMobile() ? PB_MOBILE_POS : PB_DESKTOP_POS;
    if (sel) {
      const anchor = document.querySelector(sel);
      if (anchor) { anchor.insertAdjacentElement(pos, el); return; }
    }
    const drawer = document.querySelector(".minicart__wrapper");
    if (drawer) { drawer.prepend(el); return; }
    document.body.prepend(el);
  }

  function updateProgressBar(totalWithoutGift) {
    if (totalWithoutGift <= 0) {
      const existing = document.getElementById("brk-brinde-progress");
      if (existing) existing.style.display = "none";
      return;
    }

    injectStyles();

    let bar = document.getElementById("brk-brinde-progress");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "brk-brinde-progress";
      placeProgressBar(bar);
    } else if (!bar.isConnected) {
      placeProgressBar(bar);
    }
    bar.style.display = "";

    if (totalWithoutGift >= THRESHOLD_CENTS) {
      // ── Activated state ──────────────────────────────────────────────────
      bar.classList.add("brk-activated");
      bar.innerHTML =
        '<div class="brk-bp-reached">' +
          '<span class="brk-bp-reached-emoji">🎁</span>' +
          '<span class="brk-bp-reached-text">' +
            'Você atingiu o valor de ' + THRESHOLD_FMT + ' e ' +
            '<strong>ativou um brinde!</strong> ' +
            'Siga para o checkout para validar.' +
          '</span>' +
        '</div>';
    } else {
      // ── Progress state ────────────────────────────────────────────────────
      bar.classList.remove("brk-activated");
      const pct = Math.min((totalWithoutGift / THRESHOLD_CENTS) * 100, 100);
      const remaining = THRESHOLD_CENTS - totalWithoutGift;
      const remainingFmt = (remaining / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      });
      const msg = PROGRESS_MSG.replace("{value}", remainingFmt);
      bar.innerHTML =
        '<div class="brk-bp-text">' + msg + '</div>' +
        '<div class="brk-bp-track"><div class="brk-bp-fill" style="width:' + pct + '%"></div></div>';
    }
  }

  // ── Intercept cart mutations from the theme ───────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const isCartMutation =
      url.includes("/cart/add") ||
      url.includes("/cart/change") ||
      url.includes("/cart/update") ||
      url.includes("/cart/clear");
    const promise = _origFetch.apply(this, args);
    if (isCartMutation && !_ownMutation) {
      promise.then(() => setTimeout(checkAndUpdate, 600));
    }
    return promise;
  };

  // XHR fallback
  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._brkUrl = String(url);
    return _xhrOpen.call(this, method, url, ...rest);
  };
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._brkUrl || "";
    if (
      !_ownMutation &&
      (url.includes("/cart/add") ||
        url.includes("/cart/change") ||
        url.includes("/cart/update") ||
        url.includes("/cart/clear"))
    ) {
      this.addEventListener("load", () => setTimeout(checkAndUpdate, 600));
    }
    return _xhrSend.apply(this, args);
  };

  document.addEventListener("cart:refresh", function () {
    if (!_ownMutation) setTimeout(checkAndUpdate, 100);
  });
  document.addEventListener("cart:updated", function () {
    if (!_ownMutation) setTimeout(checkAndUpdate, 100);
  });

  checkAndUpdate();
})();
