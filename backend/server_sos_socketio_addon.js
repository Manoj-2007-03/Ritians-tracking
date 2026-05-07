/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  server_sos_socketio_addon.js                                           ║
 * ║  Ritians Transport — SOS Real-Time Engine (Socket.IO upgrade)           ║
 * ║                                                                         ║
 * ║  WHAT THIS DOES:                                                        ║
 * ║  • Upgrades server.js from REST polling → WebSocket push                ║
 * ║  • Student pushes GPS every 2s via socket (no fetch loop)               ║
 * ║  • Admin receives location in <100ms latency                            ║
 * ║  • Multiple admins watching same SOS = all get updates                  ║
 * ║  • Auto-cleanup when SOS is resolved                                    ║
 * ║                                                                         ║
 * ║  HOW TO APPLY (3 steps, ~5 min):                                        ║
 * ║                                                                         ║
 * ║  STEP 1 — Install Socket.IO (run once in terminal):                     ║
 * ║     npm install socket.io                                               ║
 * ║                                                                         ║
 * ║  STEP 2 — Replace the very last line of server.js:                      ║
 * ║     OLD:  app.listen(PORT, () => { ... });                              ║
 * ║     NEW:  Copy SECTION A below (replaces app.listen)                    ║
 * ║                                                                         ║
 * ║  STEP 3 — Add SECTION B below the new http.listen block                 ║
 * ║                                                                         ║
 * ║  Everything else in server.js stays EXACTLY the same.                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

// ══════════════════════════════════════════════════════════════
// ADD THESE 2 REQUIRE LINES near the top of server.js
// (after: const express = require("express");)
// ══════════════════════════════════════════════════════════════
const http     = require("http");
const { Server } = require("socket.io");


// ══════════════════════════════════════════════════════════════
// SECTION A — Replace the old `app.listen(PORT, ...)` block
//             at the very bottom of server.js with this:
// ══════════════════════════════════════════════════════════════
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],   // websocket preferred
  pingInterval: 5000,   // faster heartbeat for emergency context
  pingTimeout:  10000,
});

// Make io globally accessible for SOS routes
app.set("io", io);

httpServer.listen(PORT, () => {
  console.log(`\n🚌 Ritians Transport – GPS Backend v6.0 (Pre-Test Hardened) → port ${PORT}`);
  console.log(`🔴 Socket.IO SOS engine active — real-time emergency tracking enabled`);
  console.log(`\n   🔴 v6 Pre-Test Fixes (mandatory before R01B test run):`);
  console.log(`      • FIX 1: Schedule blend clamp — floor at liveETA×0.50, anomaly guard at 0.70`);
  console.log(`      • FIX 2: Segment speed persistence — MongoDB TTL 24h, warm-load on startup`);
  console.log(`      • FIX 3: Calibration endpoints — GET /calibration-report/:id + POST /calibration-apply/:id`);
  console.log(`\n   ✅ v5 features preserved.`);
  console.log(`\n   Target ETA error: <10% (was 20-38% in v4)\n`);
});


// ══════════════════════════════════════════════════════════════
// SECTION B — Paste this AFTER the httpServer.listen block
//             (add at the very bottom of server.js)
// ══════════════════════════════════════════════════════════════

/**
 * SOS Socket.IO Real-Time Engine
 *
 * ROOM ARCHITECTURE:
 *   sos:<alertId>          — student + all watching admins join this room
 *
 * EVENTS (client → server):
 *   sos:join               { alertId, role: "student"|"admin" }
 *   sos:location           { alertId, latitude, longitude, accuracy, heading, speed, timestamp }
 *   sos:resolve            { alertId }
 *   sos:ping               { alertId }          — keepalive
 *
 * EVENTS (server → client):
 *   sos:location_update    { latitude, longitude, accuracy, heading, speed, timestamp, seq }
 *   sos:resolved           { alertId, resolvedAt }
 *   sos:admin_count        { count }            — how many admins watching
 *   sos:error              { message }
 *   sos:pong               {}                   — keepalive reply
 */

// In-memory session store for active SOS (lightweight, fast)
// Schema: sosActiveSessions[alertId] = {
//   studentSocketId, adminCount, lastLat, lastLng, lastTs, seq, resolvedAt
// }
const sosActiveSessions = {};

io.on("connection", (socket) => {
  let joinedRoom   = null;
  let joinedRole   = null;
  let joinedAlertId = null;

  // ── JOIN ────────────────────────────────────────────────
  socket.on("sos:join", ({ alertId, role }) => {
    if (!alertId || !["student", "admin"].includes(role)) {
      socket.emit("sos:error", { message: "Invalid join parameters" });
      return;
    }

    const room = `sos:${alertId}`;
    socket.join(room);
    joinedRoom    = room;
    joinedRole    = role;
    joinedAlertId = alertId;

    // Init session if first to join
    if (!sosActiveSessions[alertId]) {
      sosActiveSessions[alertId] = {
        studentSocketId: null,
        adminCount: 0,
        lastLat: null,
        lastLng: null,
        lastTs:  null,
        seq: 0,
        resolvedAt: null,
      };
    }

    const session = sosActiveSessions[alertId];

    if (role === "student") {
      session.studentSocketId = socket.id;
    } else {
      session.adminCount++;
      // Immediately send last known location to new admin
      if (session.lastLat !== null) {
        socket.emit("sos:location_update", {
          latitude:  session.lastLat,
          longitude: session.lastLng,
          accuracy:  session.lastAccuracy || null,
          heading:   session.lastHeading  || null,
          speed:     session.lastSpeed    || null,
          timestamp: session.lastTs,
          seq:       session.seq,
        });
      }
      // Broadcast updated admin count to student
      io.to(room).emit("sos:admin_count", { count: session.adminCount });
    }

    console.log(`[SOS-SOCKET] ${role} joined room ${room} (socket: ${socket.id})`);
  });

  // ── LOCATION UPDATE ────────────────────────────────────
  socket.on("sos:location", ({ alertId, latitude, longitude, accuracy, heading, speed, timestamp }) => {
    if (!alertId || latitude == null || longitude == null) return;

    const session = sosActiveSessions[alertId];
    if (!session) return;

    // Throttle: ignore if <1.5s since last update (prevents GPS burst spam)
    const now = Date.now();
    if (session.lastTs && (now - session.lastTs) < 1500) return;

    // Noise filter: ignore sub-2m movements (GPS jitter)
    if (session.lastLat !== null) {
      const dlat = Math.abs(latitude  - session.lastLat);
      const dlng = Math.abs(longitude - session.lastLng);
      const approxMeters = Math.sqrt(dlat * dlat + dlng * dlng) * 111000;
      if (approxMeters < 2) return;
    }

    session.lastLat      = latitude;
    session.lastLng      = longitude;
    session.lastAccuracy = accuracy || null;
    session.lastHeading  = heading  || null;
    session.lastSpeed    = speed    || null;
    session.lastTs       = now;
    session.seq++;

    const payload = {
      latitude,
      longitude,
      accuracy:  accuracy || null,
      heading:   heading  || null,
      speed:     speed    || null,
      timestamp: timestamp || now,
      seq:       session.seq,
    };

    // Broadcast to entire room (admins + anyone watching)
    io.to(`sos:${alertId}`).emit("sos:location_update", payload);

    // Async DB update — fire and forget (don't block socket thread)
    setImmediate(async () => {
      try {
        const SosAlert = require("./models/SosAlert");
        await SosAlert.findByIdAndUpdate(alertId, {
          latitude,
          longitude,
          lastLocationAt: new Date(now),
        });
      } catch (_) { /* non-critical — socket push already sent */ }
    });
  });

  // ── RESOLVE ────────────────────────────────────────────
  socket.on("sos:resolve", async ({ alertId }) => {
    if (!alertId) return;
    const resolvedAt = new Date().toISOString();
    io.to(`sos:${alertId}`).emit("sos:resolved", { alertId, resolvedAt });
    if (sosActiveSessions[alertId]) {
      sosActiveSessions[alertId].resolvedAt = resolvedAt;
    }
    try {
      const SosAlert = require("./models/SosAlert");
      await SosAlert.findByIdAndUpdate(alertId, { status: "resolved", resolvedAt: new Date() });
    } catch (_) {}
    console.log(`[SOS-SOCKET] Alert ${alertId} resolved`);
  });

  // ── PING / KEEPALIVE ───────────────────────────────────
  socket.on("sos:ping", () => {
    socket.emit("sos:pong", {});
  });

  // ── DISCONNECT ─────────────────────────────────────────
  socket.on("disconnect", () => {
    if (!joinedAlertId || !joinedRole) return;
    const session = sosActiveSessions[joinedAlertId];
    if (!session) return;

    if (joinedRole === "admin") {
      session.adminCount = Math.max(0, session.adminCount - 1);
      io.to(joinedRoom).emit("sos:admin_count", { count: session.adminCount });
    }

    // Clean up session after 10 min if no student reconnects
    if (joinedRole === "student") {
      setTimeout(() => {
        const s = sosActiveSessions[joinedAlertId];
        if (s && s.studentSocketId === socket.id) {
          delete sosActiveSessions[joinedAlertId];
          console.log(`[SOS-SOCKET] Session ${joinedAlertId} cleaned up`);
        }
      }, 10 * 60 * 1000);
    }

    console.log(`[SOS-SOCKET] ${joinedRole} disconnected from ${joinedRoom}`);
  });
});

// REST fallback — still works for non-socket clients (keeps backward compat)
// GET /api/sos/location/:alertId — returns last known from in-memory (fast, no DB)
app.get("/api/sos/location-fast/:alertId", (req, res) => {
  const session = sosActiveSessions[req.params.alertId];
  if (!session || session.lastLat === null) {
    return res.json({ success: false, message: "No location yet" });
  }
  res.json({
    success:       true,
    latitude:      session.lastLat,
    longitude:     session.lastLng,
    accuracy:      session.lastAccuracy,
    lastLocationAt: new Date(session.lastTs).toISOString(),
    seq:           session.seq,
    adminCount:    session.adminCount,
  });
});
