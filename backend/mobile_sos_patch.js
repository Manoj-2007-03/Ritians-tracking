/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  mobile_sos_patch.js                                            ║
 * ║  HOW TO ADD SOS CIRCLE BUTTON TO YOUR EXISTING mobile.js        ║
 * ║                                                                 ║
 * ║  STEP 1: In mobile.js → find buildDrawerHTML() function        ║
 * ║  STEP 2: In the 'index' page navItems section, find this line: ║
 * ║          <a class="drawer-nav-item driver-ext" href="driver.html"> ║
 * ║  STEP 3: AFTER that closing </a>, paste the SOS_BLOCK below    ║
 * ║  STEP 4: Do the same for 'tracking' and 'driver' sections      ║
 * ║  STEP 5: Add SOS_CSS to your mobile.css file                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ══════════════════════════════════════════════════════════════════
// PASTE THIS BLOCK inside buildDrawerHTML() in mobile.js
// Add it AFTER the last <a class="drawer-nav-item ..."> in EACH
// page section (index, tracking, driver) — before the closing backtick
// ══════════════════════════════════════════════════════════════════

const SOS_BLOCK = `
      <div class="drawer-divider"></div>
      <div class="drawer-sos-wrapper">
        <a class="drawer-sos-circle" href="sos.html" aria-label="Emergency SOS">
          <i class="fas fa-bell"></i>
          <span>SOS</span>
        </a>
        <div class="drawer-sos-label">Emergency Alert</div>
      </div>
`;

// ══════════════════════════════════════════════════════════════════
// ADD THIS CSS to your mobile.css file (at the bottom)
// ══════════════════════════════════════════════════════════════════

const SOS_CSS = `
/* ── SOS Circle Button in Drawer ── */
.drawer-sos-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0 8px;
}

.drawer-sos-circle {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: linear-gradient(145deg, #EF4444, #B91C1C);
  box-shadow: 0 0 24px rgba(239, 68, 68, 0.5), 0 4px 16px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  text-decoration: none;
  color: #fff;
  transition: all 0.15s ease;
  border: 2px solid rgba(255, 255, 255, 0.15);
  position: relative;
  animation: sosPulseRing 2.5s ease-out infinite;
}

.drawer-sos-circle::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid rgba(239, 68, 68, 0.3);
  animation: sosPulseRing 2.5s ease-out infinite;
}

@keyframes sosPulseRing {
  0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.4), 0 0 24px rgba(239,68,68,0.5); }
  70%  { box-shadow: 0 0 0 12px rgba(239,68,68,0), 0 0 24px rgba(239,68,68,0.5); }
  100% { box-shadow: 0 0 0 0 rgba(239,68,68,0), 0 0 24px rgba(239,68,68,0.5); }
}

.drawer-sos-circle i {
  font-size: 20px;
  color: #fff;
  line-height: 1;
}

.drawer-sos-circle span {
  font-family: 'Syne', sans-serif;
  font-size: 11px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.08em;
}

.drawer-sos-circle:hover,
.drawer-sos-circle:active {
  transform: scale(0.95);
  box-shadow: 0 0 32px rgba(239, 68, 68, 0.7), 0 4px 16px rgba(0,0,0,0.4);
}

.drawer-sos-label {
  font-size: 11px;
  color: rgba(239, 68, 68, 0.8);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: center;
}
`;

// ══════════════════════════════════════════════════════════════════
// EXAMPLE: What the index page navItems will look like AFTER patch
// (for reference only — do not replace your entire function)
// ══════════════════════════════════════════════════════════════════
/*
if (page === 'index') {
  navItems = `
    <button class="drawer-nav-item active" id="dni-student" ...> Student View </button>
    <button class="drawer-nav-item" id="dni-admin" ...> Admin Panel </button>
    <button class="drawer-nav-item" id="dni-driver" ...> Driver Portal </button>
    <div class="drawer-divider"></div>
    <a class="drawer-nav-item" href="tracking.html"> Live Tracking </a>
    <a class="drawer-nav-item driver-ext" href="driver.html"> Driver GPS </a>

    ← PASTE SOS_BLOCK HERE ↓
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
*/
