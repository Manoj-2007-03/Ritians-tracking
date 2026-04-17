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
 *
 * Integration: <script src="mobile.js"></script>
 * Place this AFTER <link rel="stylesheet" href="mobile.css">
 * and BEFORE </body> on each page.
 *
 * Zero dependencies. Vanilla JS only.
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

  // ── STATE ──────────────────────────────────────────────────
  let currentMode = null; // 'mobile' | 'desktop'
  let drawerOpen  = false;

  // ── DETECT PAGE TYPE ───────────────────────────────────────
  // Used to build the correct drawer nav items per page
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

    // 1. Inject hamburger into nav-right
    const navRight = document.querySelector('.nav-right');
    if (navRight) {
      const hbWrap = document.createElement('div');
      hbWrap.innerHTML = buildHamburgerHTML();
      const hbEl = hbWrap.firstElementChild;
      // Prepend so it's leftmost in nav-right
      navRight.insertBefore(hbEl, navRight.firstChild);
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

    // Wire drawer close button
    setTimeout(() => {
      const closeBtn = document.getElementById('drawerCloseBtn');
      if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
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
