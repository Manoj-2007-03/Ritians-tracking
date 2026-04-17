/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  server_attendance_addon.js                                 ║
 * ║  ADD THESE LINES TO YOUR EXISTING server.js                 ║
 * ║                                                             ║
 * ║  Instructions:                                              ║
 * ║  1. Copy the "REQUIRE" section near the top of server.js    ║
 * ║     (after existing requires)                               ║
 * ║  2. Copy the "USE" section after app.use("/", authRoutes)   ║
 * ║  3. DO NOT modify any existing code                         ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ── SECTION 1: ADD THIS after existing require() lines ────────────
// (around line 27-28 in your server.js, after authRoutes require)

const attendanceRoutes = require("./routes/attendance");

// ── SECTION 2: ADD THIS after app.use("/", authRoutes) ────────────
// (around line 45 in your server.js)

app.use("/", attendanceRoutes);

// ─────────────────────────────────────────────────────────────────
// That's it! No other changes needed.
// Your server.js already handles MongoDB connection and Express setup.
// The attendance routes will attach to the existing Express instance.
// ─────────────────────────────────────────────────────────────────
