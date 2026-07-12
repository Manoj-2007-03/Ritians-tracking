/*
 * ============================================================
 * sounds.js — Ritians Transport
 * Premium notification sound engine (Web Audio API, no assets).
 * Shared across: index.html, driver.html
 *
 * Public API:
 *   window.RitiansSounds.playBusStarted()
 *   window.RitiansSounds.playNearBoarding()
 *
 * Two original tones, chosen and volume-tuned by the site owner:
 *   - Bus started    → confident rising double tone
 *   - Near boarding   → calm descending ping
 * A soft limiter prevents clipping even at boosted volume.
 * ============================================================
 */

(function () {
  "use strict";

  const VOLUME = 2.0; // 200% — user-selected loudness
  let ctx = null;
  let limiter = null;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.1;
      limiter.connect(ctx.destination);
    }
    // Some browsers suspend the context until a user gesture resumes it
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, peak, type) {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, c.currentTime + start);
    gain.gain.setValueAtTime(0, c.currentTime + start);
    gain.gain.linearRampToValueAtTime(peak * VOLUME, c.currentTime + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    osc.connect(gain).connect(limiter);
    osc.start(c.currentTime + start);
    osc.stop(c.currentTime + start + dur + 0.05);
  }

  function playBusStarted() {
    try {
      tone(523.25, 0, 0.07, 0.5, "sine");
      tone(1046.5, 0.06, 0.16, 0.5, "sine");
    } catch (err) {
      console.warn("RitiansSounds: could not play bus-started tone", err);
    }
  }

  function playNearBoarding() {
    try {
      tone(1046.5, 0, 0.08, 0.45, "sine");
      tone(783.99, 0.07, 0.16, 0.4, "sine");
    } catch (err) {
      console.warn("RitiansSounds: could not play near-boarding tone", err);
    }
  }

  window.RitiansSounds = {
    playBusStarted,
    playNearBoarding,
  };
})();
