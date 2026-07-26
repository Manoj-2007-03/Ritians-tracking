/**
 * ============================================================
 * mobile.js  —  Ritians Transport
 * View-Mode System + Mobile Navigation
 *
 * Responsibilities:
 *   1. Auto-detect screen size → set initial mode
 *   2. Load persisted user preference from localStorage
 *   3. Inject hamburger button + drawer into existing nav
 *   4. Inject view-toggle floating button into page
 *   5. Handle drawer open/close + backdrop
 *   6. Handle mode switching (.mode-mobile / .mode-desktop)
 *   7. Sync drawer clock with existing clock elements
 *   8. Provide "Enable Alerts" on mobile via the full-text item in
 *      the drawer. The desktop #notifyBtn is hidden on mobile via
 *      mobile.css; refreshNotifyItemState() keeps the drawer item's
 *      on/off state in sync with it.
 *
 * Integration: <script src="mobile.js"></script>
 * Place this AFTER <link rel="stylesheet" href="mobile.css">
 * and BEFORE </body> on each page.
 *
 * Zero dependencies. Vanilla JS only.
 *
 * ── HEADER LAYOUT (index.html only) ─────────────────────────
 * On the home page, the hamburger is injected into `.nav-right`
 * (appended after the auth-guard.js profile chip), so the header
 * reads: logo/title — avatar/username — hamburger, all in one row,
 * far-right hamburger. auth-guard.js's DOMContentLoaded listener is
 * registered earlier in the document (head) than this script's, so
 * the chip is always in the DOM before this script appends the
 * hamburger after it; mobile.css also pins the visual order
 * (`.page-index .nav-right` — chip before hamburger) as a backstop
 * regardless of injection timing.
 *
 * tracking.html: hamburger stays injected into `.nav-brand` (left side,
 * unchanged) — but as of this update, the auth-guard.js profile chip
 * (previously left sitting in `.nav-right`) is now ALSO relocated into
 * the drawer on mobile, same mechanism as index.html, positioned below
 * "Driver Portal". See relocateAuthChip().
 *
 * driver.html header layout is untouched by this update.
 * ============================================================
 */

(function MobileSystem() {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────
  const STORAGE_KEY   = 'ritians_view_mode';  // localStorage key
  const MOBILE_BP     = 768;                   // px breakpoint for auto-detect
  const DRAWER_ID     = 'mobileDrawer';
  const BACKDROP_ID   = 'drawerBackdrop';
  const HAMBURGER_ID  = 'hamburgerBtn';
  const TOGGLE_BTN_ID = 'viewToggleBtn';
  const NOTIFY_ITEM_ID = 'drawerNotifyItem';
  const PROFILE_SLOT_ID = 'drawerProfileSlot';   // where #authChip is relocated to on mobile (index + tracking pages)
  const AUTH_CHIP_ID    = 'authChip';            // id auth-guard.js gives the avatar/username chip it injects

  // ── STATE ──────────────────────────────────────────────────
  let currentMode = null; // 'mobile' | 'desktop'
  let drawerOpen  = false;


  // ── DETECT PAGE TYPE ───────────────────────────────────────
  // Used to build the correct drawer nav items per page, and to
  // decide where the hamburger gets injected in the header.
  function detectPage() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    if (path.includes('tracking'))  return 'tracking';
    if (path.includes('driver'))    return 'driver';
    return 'index';
  }

  // ── INITIAL MODE RESOLUTION ────────────────────────────────
  // Priority: localStorage > auto-detect
  function resolveInitialMode() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'desktop' || saved === 'mobile') return saved;
    return window.innerWidth <= MOBILE_BP ? 'mobile' : 'desktop';
  }

  // ── APPLY MODE TO <html> ────────────────────────────────────
  function applyMode(mode) {
    const html = document.documentElement;
    html.classList.remove('mode-mobile', 'mode-desktop');
    html.classList.add(`mode-${mode}`);
    currentMode = mode;

    // Update toggle button label
    const btn = document.getElementById(TOGGLE_BTN_ID);
    if (btn) {
      const label = btn.querySelector('.vtb-mode-label');
      const icon  = btn.querySelector('i');
      if (mode === 'mobile') {
        if (label) label.textContent = 'Mobile';
        if (icon)  icon.className = 'fas fa-mobile-screen-button';
        btn.title = 'Currently: Mobile View — click for Desktop';
      } else {
        if (label) label.textContent = 'Desktop';
        if (icon)  icon.className = 'fas fa-desktop';
        btn.title = 'Currently: Desktop View — click for Mobile';
      }
    }

    // Close drawer when switching to desktop
    if (mode === 'desktop' && drawerOpen) {
      closeDrawer();
    }

    // Relocate the avatar/username chip to match the new mode (index +
    // tracking pages; see relocateAuthChip() — no-ops safely if the
    // chip/slot aren't ready yet, or the current page doesn't have one).
    relocateAuthChip(mode);
  }

  // ── RELOCATE AUTH CHIP (index.html + tracking.html) ────────
  // auth-guard.js injects `#authChip` into `.nav-right` (desktop header
  // position — untouched). On mobile, the Mobile Header should show only
  // the logo/title + hamburger, so this moves the SAME chip node (not a
  // clone — preserves its logout button listener and lets auth-guard.js
  // keep updating it normally) into the drawer's profile slot — on
  // index.html this sits at the top of the drawer; on tracking.html it
  // sits just below "Driver Portal". Switching back to desktop moves it
  // back to `.nav-right`, right where auth-guard.js originally placed it.
  function relocateAuthChip(mode) {
    const page = detectPage();
    if (page !== 'index' && page !== 'tracking') return;

    const chip = document.getElementById(AUTH_CHIP_ID);
    const slot = document.getElementById(PROFILE_SLOT_ID);
    const navRight = document.querySelector('.nav-right');
    if (!chip || !navRight) return;

    if (mode === 'mobile') {
      if (slot && chip.parentElement !== slot) slot.appendChild(chip);
    } else if (chip.parentElement !== navRight) {
      const hbEl = document.getElementById(HAMBURGER_ID);
      if (hbEl) navRight.insertBefore(chip, hbEl);
      else navRight.appendChild(chip);
    }
  }

  // Fallback: if auth-guard.js injects #authChip asynchronously (after this
  // script's own init/applyMode calls have already run), catch it as soon
  // as it appears and place it correctly for whatever mode is active.
  function watchForAuthChip() {
    if (document.getElementById(AUTH_CHIP_ID)) {
      relocateAuthChip(currentMode);
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.getElementById(AUTH_CHIP_ID)) {
        relocateAuthChip(currentMode);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── TOGGLE MODE ────────────────────────────────────────────
  function toggleMode() {
    const next = currentMode === 'mobile' ? 'desktop' : 'mobile';
    localStorage.setItem(STORAGE_KEY, next);
    applyMode(next);
  }

  // ── DRAWER: OPEN ───────────────────────────────────────────
  function openDrawer() {
    const drawer   = document.getElementById(DRAWER_ID);
    const backdrop = document.getElementById(BACKDROP_ID);
    const hbBtn    = document.getElementById(HAMBURGER_ID);
    if (!drawer) return;

    drawer.classList.add('drawer-open');
    if (backdrop) backdrop.classList.add('visible');
    if (hbBtn)    hbBtn.classList.add('open');
    drawerOpen = true;

    // Refresh the notify item's on/off state each time the drawer opens,
    // in case notifications were enabled/disabled since last render.
    refreshNotifyItemState();

    // Prevent body scroll while drawer is open
    document.body.style.overflow = 'hidden';

    // Trap focus inside drawer (a11y)
    setTimeout(() => {
      const first = drawer.querySelector('button, a, [tabindex]');
      if (first) first.focus();
    }, 50);
  }

  // ── DRAWER: CLOSE ──────────────────────────────────────────
  function closeDrawer() {
    const drawer   = document.getElementById(DRAWER_ID);
    const backdrop = document.getElementById(BACKDROP_ID);
    const hbBtn    = document.getElementById(HAMBURGER_ID);
    if (!drawer) return;

    drawer.classList.remove('drawer-open');
    if (backdrop) backdrop.classList.remove('visible');
    if (hbBtn)    hbBtn.classList.remove('open');
    drawerOpen = false;

    document.body.style.overflow = '';
  }

  // ── DRAWER: TOGGLE ─────────────────────────────────────────
  function toggleDrawer() {
    if (drawerOpen) closeDrawer(); else openDrawer();
  }

  // ── NOTIFY ITEM: click handler ──────────────────────────────
  // Delegates to the enableNotifications() function defined in
  // index.html's inline script (loaded before mobile.js). Guards
  // against that function not existing on pages without it.
  function handleNotifyClick() {
    closeDrawer();
    if (typeof window.enableNotifications === 'function') {
      window.enableNotifications();
    }
  }

  // ── NOTIFY STATE: reflect current on/off state in the drawer ─
  // Mirrors whatever the top-nav #notifyBtn currently shows, so the
  // drawer item never disagrees with the desktop control.
  function refreshNotifyItemState() {
    const drawerItem  = document.getElementById(NOTIFY_ITEM_ID);
    const navBtnLabel = document.getElementById('notifyBtnLabel');
    const isOn = !!(navBtnLabel && navBtnLabel.textContent.trim() === 'Alerts On');

    if (drawerItem) {
      const label = drawerItem.querySelector('.drawer-notify-label');
      drawerItem.classList.toggle('notify-on', isOn);
      if (label) label.textContent = isOn ? 'Alerts On' : 'Enable Alerts';
    }
  }

  // ── BUILD DRAWER HTML ──────────────────────────────────────
  function buildDrawerHTML(page) {
    // Each page gets a tailored nav item set
    let navItems = '';

    if (page === 'index') {
      navItems = `
        <button class="drawer-nav-item active" id="dni-student"
          onclick="MobileNav.closeDrawer(); typeof showTab==='function' && showTab('student')">
          <i class="fas fa-user-graduate"></i> Student View
        </button>
        <button class="drawer-nav-item" id="dni-admin"
          onclick="MobileNav.closeDrawer(); typeof onAdminClick==='function' && onAdminClick()">
          <i class="fas fa-user-shield"></i> Admin Panel
        </button>
        <button class="drawer-nav-item" id="dni-driver"
          onclick="MobileNav.closeDrawer(); typeof onDriverClick==='function' && onDriverClick()">
          <i class="fas fa-id-card"></i> Driver Portal
        </button>
        <div class="drawer-divider"></div>
        <a class="drawer-nav-item" href="tracking.html">
          <i class="fas fa-satellite-dish"></i> Live Tracking
        </a>
        <a class="drawer-nav-item driver-ext" href="driver.html">
          <i class="fas fa-location-arrow"></i> Driver GPS
        </a>
        <button class="drawer-nav-item notify-item" id="${NOTIFY_ITEM_ID}"
          onclick="MobileNav.handleNotifyClick()">
          <i class="fas fa-bell"></i> <span class="drawer-notify-label">Enable Alerts</span>
        </button>
        <div class="drawer-divider"></div>
        <!-- The logged-in user's #authChip (avatar + username), injected into
             .nav-right by auth-guard.js, is relocated here on mobile — see
             relocateAuthChip(). Empty on desktop / before auth-guard.js runs. -->
        <div class="drawer-profile-slot" id="${PROFILE_SLOT_ID}"></div>
        <div class="drawer-divider"></div>
        <div class="drawer-sos-wrapper">
          <a class="drawer-sos-circle" href="sos.html" aria-label="Emergency SOS">
            <i class="fas fa-bell"></i>
            <span>SOS</span>
          </a>
          <div class="drawer-sos-label">Emergency Alert</div>
        </div>
      `;
    } else if (page === 'tracking') {
      navItems = `
        <a class="drawer-nav-item active" href="tracking.html">
          <i class="fas fa-satellite-dish"></i> Live Tracking
        </a>
        <div class="drawer-divider"></div>
        <a class="drawer-nav-item" href="index.html">
          <i class="fas fa-arrow-left"></i> Back to Home
        </a>
        <a class="drawer-nav-item driver-ext" href="driver.html">
          <i class="fas fa-location-arrow"></i> Driver Portal
        </a>
        <div class="drawer-divider"></div>
        <!-- The logged-in user's #authChip (avatar + username), injected into
             .nav-right by auth-guard.js, is relocated here on mobile — see
             relocateAuthChip(). Sits just below "Driver Portal". Empty on
             desktop / before auth-guard.js runs (collapses to nothing via
             .drawer-profile-slot:empty). -->
        <div class="drawer-profile-slot" id="${PROFILE_SLOT_ID}"></div>
        <div class="drawer-divider"></div>
        <div class="drawer-sos-wrapper">
          <a class="drawer-sos-circle" href="sos.html" aria-label="Emergency SOS">
            <i class="fas fa-bell"></i>
            <span>SOS</span>
          </a>
          <div class="drawer-sos-label">Emergency Alert</div>
        </div>
      `;
    } else if (page === 'driver') {
      navItems = `
        <a class="drawer-nav-item active" href="driver.html">
          <i class="fas fa-location-arrow"></i> Driver GPS Portal
        </a>
        <div class="drawer-divider"></div>
        <a class="drawer-nav-item" href="index.html">
          <i class="fas fa-arrow-left"></i> Back to Home
        </a>
        <a class="drawer-nav-item" href="tracking.html">
          <i class="fas fa-satellite-dish"></i> Live Tracking
        </a>
        <div class="drawer-divider"></div>
        <div class="drawer-sos-wrapper">
          <a class="drawer-sos-circle" href="sos.html" aria-label="Emergency SOS">
            <i class="fas fa-bell"></i>
            <span>SOS</span>
          </a>
          <div class="drawer-sos-label">Emergency Alert</div>
        </div>
      `;
    }

    return `
      <div class="drawer-header">
        <div class="drawer-brand">
          <div class="drawer-brand-icon"><i class="fas fa-bus"></i></div>
          <div class="drawer-brand-text">Ritians Transport</div>
        </div>
        <button class="drawer-close-btn" id="drawerCloseBtn" aria-label="Close menu">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <nav class="drawer-nav" role="navigation" aria-label="Mobile navigation">
        ${navItems}
      </nav>
      <div class="drawer-footer">
        <span class="drawer-clock" id="drawerClock">--:--:--</span>
        <button class="drawer-nav-item" style="width:auto;padding:6px 12px;font-size:12px"
          onclick="MobileNav.closeDrawer(); MobileNav.toggleMode()">
          <i class="fas fa-desktop"></i> Switch View
        </button>
      </div>
    `;
  }

  // ── BUILD VIEW TOGGLE BUTTON HTML ──────────────────────────
  function buildToggleBtnHTML() {
    return `
      <button id="${TOGGLE_BTN_ID}" class="view-toggle-btn"
        aria-label="Toggle view mode" title="Toggle view mode">
        <i class="fas fa-mobile-screen-button"></i>
        <span>View:</span>
        <span class="vtb-mode-label">Mobile</span>
      </button>
    `;
  }

  // ── BUILD HAMBURGER BUTTON HTML ────────────────────────────
  function buildHamburgerHTML() {
    return `
      <button id="${HAMBURGER_ID}" class="hamburger-btn"
        aria-label="Open navigation menu" aria-expanded="false">
        <span class="hb-line"></span>
        <span class="hb-line"></span>
        <span class="hb-line"></span>
      </button>
    `;
  }

  // ── SYNC DRAWER CLOCK ──────────────────────────────────────
  function startDrawerClock() {
    const el = document.getElementById('drawerClock');
    if (!el) return;
    function tick() {
      el.textContent = new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    tick();
    setInterval(tick, 1000);
  }

  // ── INJECT ALL DOM ELEMENTS ────────────────────────────────
  function inject() {
    const page = detectPage();

    // 1. Inject the hamburger button.
    //    - index.html: appended into `.nav-right`, AFTER the auth-guard.js
    //      profile chip, so the header reads brand — chip — hamburger,
    //      hamburger flush to the far right. auth-guard.js's
    //      DOMContentLoaded listener is registered earlier in the document
    //      than this one, so the chip is already in the DOM by the time
    //      this runs; mobile.css additionally pins the order via
    //      `.page-index .nav-right` as a backstop.
    //    - tracking.html / driver.html: unchanged from before — injected
    //      into `.nav-brand` (left side, with the logo/title) — so those
    //      pages' headers are not touched by this update.
    const navBrand = document.querySelector('.nav-brand');
    const navRight = document.querySelector('.nav-right');
    const hbWrap = document.createElement('div');
    hbWrap.innerHTML = buildHamburgerHTML();
    const hbEl = hbWrap.firstElementChild;

    if (page === 'index' && navRight) {
      navRight.appendChild(hbEl);
      hbEl.addEventListener('click', toggleDrawer);
    } else if (navBrand) {
      navBrand.insertBefore(hbEl, navBrand.firstChild);
      hbEl.addEventListener('click', toggleDrawer);
    }

    // 2. Inject backdrop
    const backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.className = 'drawer-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', closeDrawer);
    document.body.appendChild(backdrop);

    // 3. Inject drawer
    const drawer = document.createElement('nav');
    drawer.id = DRAWER_ID;
    drawer.className = 'mobile-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Navigation menu');
    drawer.innerHTML = buildDrawerHTML(page);
    document.body.appendChild(drawer);

    // Wire drawer close button + reflect current notify state
    setTimeout(() => {
      const closeBtn = document.getElementById('drawerCloseBtn');
      if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
      refreshNotifyItemState();
    }, 0);

    // 4. Inject view toggle button
    const toggleWrap = document.createElement('div');
    toggleWrap.innerHTML = buildToggleBtnHTML();
    const toggleEl = toggleWrap.firstElementChild;
    document.body.appendChild(toggleEl);
    toggleEl.addEventListener('click', toggleMode);

    // 5. Start drawer clock
    startDrawerClock();

    // 6. Keyboard: Escape closes drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawerOpen) closeDrawer();
    });
  }

  // ── UPDATE ACTIVE DRAWER ITEM (for index.html tab switches) ─
  function syncDrawerActiveTab(tabName) {
    const map = {
      student: 'dni-student',
      admin:   'dni-admin',
      driver:  'dni-driver',
    };
    document.querySelectorAll('.drawer-nav-item').forEach(el => {
      el.classList.remove('active');
    });
    const id = map[tabName];
    if (id) {
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    }
  }

  // ── HANDLE WINDOW RESIZE (auto re-detect if no saved preference) ─
  function onResize() {
    const saved = localStorage.getItem(STORAGE_KEY);
    // Only auto-switch if user hasn't manually overridden
    if (!saved) {
      const auto = window.innerWidth <= MOBILE_BP ? 'mobile' : 'desktop';
      if (auto !== currentMode) applyMode(auto);
    }
  }

  // Debounce resize handler to avoid excessive DOM work
  let resizeTimer;
  function debouncedResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 120);
  }

  // ── PUBLIC API (exposed on window.MobileNav) ───────────────
  window.MobileNav = {
    openDrawer,
    closeDrawer,
    toggleDrawer,
    toggleMode,
    syncDrawerActiveTab,
    handleNotifyClick,
    refreshNotifyItemState,
    getMode: () => currentMode,
  };

  // ── INIT ───────────────────────────────────────────────────
  function init() {
    // Apply mode BEFORE injecting DOM to avoid flash
    const mode = resolveInitialMode();
    applyMode(mode);

    // Inject nav elements
    inject();

    // Re-apply mode labels now that DOM is ready
    applyMode(mode);

    // Catch #authChip if auth-guard.js injects it after this point
    watchForAuthChip();

    // Listen for resize
    window.addEventListener('resize', debouncedResize, { passive: true });
  }

  // Run on DOMContentLoaded (or immediately if already loaded)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();