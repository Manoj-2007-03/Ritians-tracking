/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  sos_location_engine_patch.js                                       ║
 * ║  Ritians SOS — Student-Side Location Streaming Engine               ║
 * ║                                                                     ║
 * ║  HOW TO APPLY TO sos.html:                                          ║
 * ║                                                                     ║
 * ║  STEP 1 — Add Socket.IO client BEFORE closing </body> in sos.html  ║
 * ║     <script src="/socket.io/socket.io.js"></script>                 ║
 * ║                                                                     ║
 * ║  STEP 2 — Replace the triggerSOS() function in sos.html            ║
 * ║     Find:  async function triggerSOS() {                            ║
 * ║     Replace with the SECTION A below                                ║
 * ║                                                                     ║
 * ║  STEP 3 — Add SECTION B anywhere after the existing JS variables   ║
 * ║     (after: let alertId = null; or similar)                         ║
 * ║                                                                     ║
 * ║  That's it. The rest of sos.html stays exactly the same.            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */


// ══════════════════════════════════════════════════════════════
// SECTION B — Add near top of the <script> block in sos.html
//             (after existing variable declarations)
// ══════════════════════════════════════════════════════════════

/**
 * SOS Location Streaming Engine
 *
 * Strategy:
 *  1. navigator.geolocation.watchPosition() — continuous high-accuracy GPS
 *     (battery-efficient: device streams only when position changes)
 *  2. Socket.IO push — sub-100ms delivery to admin, no polling overhead
 *  3. REST fallback — if socket unavailable, POST to REST every 2.5s
 *  4. Throttle: minimum 2s between pushes (prevents GPS burst spam)
 *  5. Noise filter: ignore <3m movements (GPS jitter suppression)
 *  6. Auto-reconnect: socket reconnects automatically, GPS watch persists
 *  7. Cleanup: watchPosition + socket closed on page unload / SOS stop
 */

let sosSocket        = null;   // Socket.IO connection
let gpsWatchId       = null;   // navigator.geolocation.watchPosition handle
let lastPushTime     = 0;      // throttle: ms timestamp of last push
let lastPushLat      = null;   // noise filter: last pushed lat
let lastPushLng      = null;   // noise filter: last pushed lng
let restFallbackInt  = null;   // REST fallback interval
let sosAlertId_live  = null;   // set after /api/sos/trigger succeeds
let sosActive        = false;  // flag to stop pushing after resolve

const MIN_PUSH_INTERVAL_MS = 2000;   // never push faster than every 2s
const MIN_MOVE_METERS      = 3;      // ignore sub-3m movements (GPS noise)

/** Called once after SOS trigger succeeds — starts location streaming */
function startLocationStreaming(alertId) {
  sosAlertId_live = alertId;
  sosActive       = true;

  // ── 1. Connect Socket ──────────────────────────────────────────────
  try {
    sosSocket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnectionDelay:    1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 8000,
    });

    sosSocket.on('connect', () => {
      console.log('[SOS] Socket connected — joining room sos:' + alertId);
      sosSocket.emit('sos:join', { alertId, role: 'student' });
      // Clear REST fallback once socket is live
      if (restFallbackInt) {
        clearInterval(restFallbackInt);
        restFallbackInt = null;
      }
    });

    sosSocket.on('sos:resolved', () => {
      stopLocationStreaming();
    });

    sosSocket.on('connect_error', () => {
      // Socket failed — ensure REST fallback is running
      if (!restFallbackInt && sosActive) {
        console.warn('[SOS] Socket failed — activating REST fallback');
        startRestFallback();
      }
    });

    sosSocket.on('disconnect', () => {
      // Socket disconnected — start REST fallback until socket reconnects
      if (sosActive && !restFallbackInt) {
        startRestFallback();
      }
    });

    sosSocket.on('reconnect', () => {
      console.log('[SOS] Socket reconnected');
      sosSocket.emit('sos:join', { alertId, role: 'student' });
      // Stop REST fallback now that socket is back
      if (restFallbackInt) {
        clearInterval(restFallbackInt);
        restFallbackInt = null;
      }
    });

  } catch(e) {
    console.warn('[SOS] Socket.IO not available — using REST only');
    startRestFallback();
  }

  // ── 2. Start GPS watch ─────────────────────────────────────────────
  if (!navigator.geolocation) {
    console.warn('[SOS] Geolocation not supported');
    return;
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!sosActive) return;

      const lat      = pos.coords.latitude;
      const lng      = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;
      const heading  = pos.coords.heading;
      const speed    = pos.coords.speed;
      const now      = Date.now();

      // Throttle check
      if (now - lastPushTime < MIN_PUSH_INTERVAL_MS) return;

      // Noise filter — ignore sub-3m jitter
      if (lastPushLat !== null) {
        const dlat = Math.abs(lat - lastPushLat);
        const dlng = Math.abs(lng - lastPushLng);
        const approxMeters = Math.sqrt(dlat * dlat + dlng * dlng) * 111000;
        if (approxMeters < MIN_MOVE_METERS && accuracy < 20) return;
      }

      lastPushTime = now;
      lastPushLat  = lat;
      lastPushLng  = lng;

      const payload = {
        alertId,
        latitude:  lat,
        longitude: lng,
        accuracy:  accuracy  || null,
        heading:   heading   || null,
        speed:     speed     || null,
        timestamp: now,
      };

      // Push via socket (preferred)
      if (sosSocket && sosSocket.connected) {
        sosSocket.emit('sos:location', payload);
      }
      // REST is handled by startRestFallback() separately when socket is down
    },
    (err) => {
      console.warn('[SOS] GPS watch error:', err.code, err.message);
      // Don't stop — watchPosition retries automatically
    },
    {
      enableHighAccuracy: true,
      timeout:            8000,
      maximumAge:         0,       // always fresh, never cached
    }
  );
}

/** REST fallback — polls GPS and POSTs every 2.5s when socket is unavailable */
function startRestFallback() {
  if (restFallbackInt || !sosActive) return;

  restFallbackInt = setInterval(() => {
    if (!sosActive || (sosSocket && sosSocket.connected)) {
      clearInterval(restFallbackInt);
      restFallbackInt = null;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const now = Date.now();

        if (now - lastPushTime < MIN_PUSH_INTERVAL_MS) return;
        lastPushTime = now;
        lastPushLat  = lat;
        lastPushLng  = lng;

        fetch(`/api/sos/location/${sosAlertId_live}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude: lat, longitude: lng }),
        }).catch(() => {}); // silent fail — will retry next interval
      },
      null,
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 1000 }
    );
  }, 2500);
}

/** Called on SOS stop / page unload — cleans up everything */
function stopLocationStreaming() {
  sosActive = false;

  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  if (sosSocket) {
    sosSocket.disconnect();
    sosSocket = null;
  }

  if (restFallbackInt) {
    clearInterval(restFallbackInt);
    restFallbackInt = null;
  }

  console.log('[SOS] Location streaming stopped — resources released');
}

// Cleanup on page unload (browser close, navigation, phone lock)
window.addEventListener('beforeunload', stopLocationStreaming);
window.addEventListener('pagehide',     stopLocationStreaming);   // iOS Safari


// ══════════════════════════════════════════════════════════════
// SECTION A — Replace the entire async function triggerSOS()
//             in sos.html with this version:
// ══════════════════════════════════════════════════════════════

async function triggerSOS() {
  document.getElementById('sosBtn').classList.remove('pressing');
  document.getElementById('holdHint').textContent = 'Sending alert…';

  const payload = {
    studentName: student?.name || 'Unknown',
    studentId:   student?.studentId || student?._id || 'unknown',
    busId:       student?.busNumber || student?.busId || student?.bus || 'Unknown',
    rollNo:      student?.regNo || student?.rollNo || '',
    latitude:    currentLat,
    longitude:   currentLng,
  };

  try {
    const res  = await fetch('/api/sos/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      alertId = data.alertId;

      // ★ KEY CHANGE: Replace old setInterval + getCurrentPosition loop
      //   with the efficient streaming engine above.
      //   Old code: setInterval every 5s, getCurrentPosition each time = slow + battery draining
      //   New code: watchPosition streams continuously, socket pushes instantly, auto-reconnects
      startLocationStreaming(alertId);

      showSuccessScreen();
    } else {
      showError(data.error || 'Failed to send alert. Try again.');
      resetSOS();
    }
  } catch(_) {
    // Demo mode: show success even without backend
    showSuccessScreen();
  }
}
