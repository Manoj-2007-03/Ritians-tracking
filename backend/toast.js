/*
 * ============================================================
 * toast.js — Ritians Transport
 * Premium toast notification engine.
 * Shared across: index.html, tracking.html, driver.html
 *
 * Public API: window.RitiansToast.show(titleOrOpts, type?)
 *
 * Backward compatible with the site's existing call sites:
 *   toast('Route deleted')
 *   toast('Invalid credentials', 'error')
 *   showToast('GPS not supported on this device!', 'error')
 * These keep working unchanged — each page's toast()/showToast()
 * wrapper just forwards to RitiansToast.show().
 *
 * Also supports a richer form for new call sites:
 *   RitiansToast.show({
 *     title: 'Trip Started',
 *     subtitle: 'Bus 18 has departed successfully.',
 *     type: 'success',
 *     busIcon: true
 *   });
 * ============================================================
 */

(function () {
  "use strict";

  const MAX_VISIBLE       = 3;
  const DEFAULT_DURATION  = 3500;
  const VALID_TYPES       = ["success", "info", "warning", "error"];
  const ICONS = {
    success: "fa-circle-check",
    info:    "fa-circle-info",
    warning: "fa-triangle-exclamation",
    error:   "fa-circle-exclamation",
  };

  const queue = [];
  let activeCount = 0;
  let containerEl = null;

  function getContainer() {
    if (containerEl && document.body.contains(containerEl)) return containerEl;
    containerEl = document.getElementById("toastContainer");
    if (!containerEl) {
      containerEl = document.createElement("div");
      containerEl.id = "toastContainer";
      containerEl.className = "toast-container";
      document.body.appendChild(containerEl);
    }
    containerEl.classList.add("toast-container");
    containerEl.setAttribute("role", "region");
    containerEl.setAttribute("aria-live", "polite");
    containerEl.setAttribute("aria-label", "Notifications");
    return containerEl;
  }

  function nowStamp() {
    return new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  function buildCard(opts) {
    const isPremium = !!(opts.meta || opts.liveLabel || opts.cta);

    const card = document.createElement("div");
    card.className = `toast-card toast-${opts.type}` + (isPremium ? " toast-premium" : "");
    card.setAttribute("role", "status");
    card.setAttribute("tabindex", "0");

    if (isPremium) {
      const metaRows = (opts.meta || [])
        .map(
          (m) =>
            `<span class="toast-meta-row"><span class="toast-meta-label">${escapeHtml(m.label)}</span>` +
            `<span class="toast-meta-value">${escapeHtml(m.value)}</span></span>`
        )
        .join("");

      const liveRow = opts.liveLabel
        ? `<span class="toast-live"><span class="toast-live-dot"></span>${escapeHtml(opts.liveLabel)}</span>`
        : "";

      const cta = opts.cta
        ? `<a class="toast-cta" href="${escapeHtml(opts.cta.href || "#")}" target="_blank" rel="noopener">` +
          `${escapeHtml(opts.cta.label)} <span class="toast-cta-arrow">→</span></a>`
        : "";

      card.innerHTML =
        `<span class="toast-badge toast-badge--bus"><i class="fas fa-bus"></i></span>` +
        `<span class="toast-body">` +
          `<span class="toast-title">${escapeHtml(opts.title)}</span>` +
          metaRows +
          liveRow +
          (cta ? `<span class="toast-divider"></span>${cta}` : "") +
        `</span>` +
        `<span class="toast-progress"><span class="toast-progress-fill"></span></span>`;

      // Clicking the CTA (or anything inside it) shouldn't also trigger the
      // card's own click-to-dismiss handler.
      card.addEventListener("click", (e) => {
        if (e.target.closest(".toast-cta")) e.stopPropagation();
      });
    } else {
      card.innerHTML =
        `<span class="toast-badge"><i class="fas ${ICONS[opts.type]}"></i></span>` +
        `<span class="toast-body">` +
          `<span class="toast-title">${escapeHtml(opts.title)}</span>` +
          (opts.subtitle ? `<span class="toast-subtitle">${escapeHtml(opts.subtitle)}</span>` : "") +
          `<span class="toast-time">${nowStamp()}</span>` +
        `</span>` +
        (opts.busIcon ? `<span class="toast-bus"><i class="fas fa-bus"></i></span>` : "");
    }

    return card;
  }

  function showNext() {
    if (activeCount >= MAX_VISIBLE || queue.length === 0) return;
    const opts = queue.shift();
    activeCount++;

    const container = getContainer();
    const card = buildCard(opts);
    card.style.setProperty("--toast-duration", `${opts.duration}ms`);
    container.appendChild(card);

    // Double rAF so the browser commits the initial (pre-transition) state
    // before we flip the class that triggers the transition.
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add("toast-in")));

    let dismissed = false;
    let timer = null;
    let remaining = opts.duration;
    let startedAt = Date.now();

    function cleanupAndAdvance() {
      if (card.parentNode) card.remove();
      activeCount--;
      showNext();
    }

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      card.classList.remove("toast-in");
      card.classList.add("toast-out");

      let done = false;
      card.addEventListener("animationend", finish, { once: true });
      card.addEventListener("transitionend", finish, { once: true });
      // Fallback in case neither event fires (e.g. reduced-motion, hidden tab)
      const fallback = setTimeout(finish, 350);

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(fallback);
        cleanupAndAdvance();
      }
    }

    function startTimer(ms) {
      startedAt = Date.now();
      remaining = ms;
      timer = setTimeout(dismiss, ms);
    }
    startTimer(remaining);

    card.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      remaining -= Date.now() - startedAt;
      card.classList.add("toast-paused");
    });
    card.addEventListener("mouseleave", () => {
      card.classList.remove("toast-paused");
      startTimer(Math.max(remaining, 600));
    });

    card.addEventListener("click", dismiss);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dismiss(); }
    });

    // Swipe-to-dismiss (touch devices)
    let touchStartX = null;
    card.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
      clearTimeout(timer);
    }, { passive: true });

    card.addEventListener("touchmove", (e) => {
      if (touchStartX === null) return;
      const dx = e.touches[0].clientX - touchStartX;
      card.style.transition = "none";
      card.style.transform = `translateX(${dx}px)`;
      card.style.opacity = String(Math.max(0.15, 1 - Math.abs(dx) / 140));
    }, { passive: true });

    card.addEventListener("touchend", (e) => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      card.style.transition = "";
      card.style.transform = "";
      card.style.opacity = "";
      touchStartX = null;
      if (Math.abs(dx) > 80) {
        dismiss();
      } else {
        remaining -= Date.now() - startedAt;
        startTimer(Math.max(remaining, 600));
      }
    });
  }

  function normalize(arg1, arg2) {
    let opts;
    if (typeof arg1 === "object" && arg1 !== null) {
      opts = Object.assign({}, arg1);
    } else {
      opts = { title: arg1, type: arg2 };
    }
    if (!VALID_TYPES.includes(opts.type)) opts.type = "success";
    opts.title = opts.title == null ? "" : String(opts.title);
    opts.subtitle = opts.subtitle || null;
    opts.duration = typeof opts.duration === "number" ? opts.duration : DEFAULT_DURATION;
    opts.busIcon = !!opts.busIcon;
    opts.meta = Array.isArray(opts.meta) ? opts.meta : null;
    opts.liveLabel = opts.liveLabel || null;
    opts.cta = opts.cta && opts.cta.label ? opts.cta : null;
    return opts;
  }

  window.RitiansToast = {
    show(arg1, arg2) {
      queue.push(normalize(arg1, arg2));
      showNext();
    },
  };
})();