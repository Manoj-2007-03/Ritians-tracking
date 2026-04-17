/**
 * routes/attendance.js  —  Ritians Transport Attendance API
 * Handles:  face registration proxy, attendance dashboard, CSV/Excel export
 * All routes require student session (regNo via query/body or admin key)
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const https    = require("https");
const http     = require("http");

// ── Config ─────────────────────────────────────────────────────────
const FLASK_BASE = process.env.FLASK_URL || "http://localhost:5001";
const ADMIN_KEY  = process.env.ADMIN_KEY  || "RIT_CHENNAI07cd";

// ── Attendance Schema ──────────────────────────────────────────────
const attendSchema = new mongoose.Schema({
  regNo:      { type: String, required: true, index: true },
  name:       String,
  busNo:      String,
  route:      String,
  boardStop:  String,
  department: String,
  year:       String,
  className:  String,
  session:    { type: String, enum: ["morning", "evening"], default: "morning" },
  timestamp:  { type: Date,   default: Date.now, index: true },
  confidence: Number,
  status:     { type: String, default: "present" },
}, { collection: "attendance" });

const Attendance = mongoose.models.Attendance || mongoose.model("Attendance", attendSchema);

// ── Student Schema (extend existing) ──────────────────────────────
const studentSchema = new mongoose.Schema({
  name:               String,
  regNo:              { type: String, unique: true, index: true },
  department:         String,
  year:               String,
  className:          String,
  busNo:              String,
  route:              String,
  boardStop:          String,
  password:           String,
  face_registered:    { type: Boolean, default: false },
  face_embedding:     [Number],
  face_registered_at: Date,
  last_attendance:    Date,
}, { collection: "students" });

const Student = mongoose.models.Student || mongoose.model("Student", studentSchema);

// ── Helper: proxy request to Flask ────────────────────────────────
function flaskPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload  = JSON.stringify(body);
    const url      = new URL(FLASK_BASE + path);
    const isHttps  = url.protocol === "https:";
    const lib      = isHttps ? https : http;
    const options  = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = lib.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error("Flask response parse error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("Flask timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── Middleware: verify admin key ───────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.adminKey;
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  next();
}

// ══════════════════════════════════════════════════════════════════
// FACE REGISTRATION
// POST /attendance/register-face
// Body: { regNo, image (base64) }
// ══════════════════════════════════════════════════════════════════
router.post("/attendance/register-face", async (req, res) => {
  const { regNo, image } = req.body || {};
  if (!regNo || !image) {
    return res.status(400).json({ success: false, message: "regNo and image required." });
  }
  try {
    const result = await flaskPost("/register-face", { regNo, image });
    return res.json(result);
  } catch (err) {
    console.error("Flask /register-face error:", err.message);
    return res.status(502).json({ success: false, message: "Face recognition service unavailable. Ensure Python service is running." });
  }
});

// ══════════════════════════════════════════════════════════════════
// LIVE RECOGNITION
// POST /attendance/recognize
// Body: { image (base64), session }
// ══════════════════════════════════════════════════════════════════
router.post("/attendance/recognize", async (req, res) => {
  const { image, session = "morning" } = req.body || {};
  if (!image) {
    return res.status(400).json({ success: false, message: "image required." });
  }
  try {
    const result = await flaskPost("/recognize", { image, session });
    return res.json(result);
  } catch (err) {
    console.error("Flask /recognize error:", err.message);
    return res.status(502).json({ success: false, message: "Face recognition service unavailable." });
  }
});

// ══════════════════════════════════════════════════════════════════
// ATTENDANCE DASHBOARD (Admin)
// GET /attendance/records?date=&busNo=&route=&department=&page=&limit=
// Header: x-admin-key
// ══════════════════════════════════════════════════════════════════
router.get("/attendance/records", requireAdmin, async (req, res) => {
  try {
    const {
      date, busNo, route, department, year, session,
      page  = 1,
      limit = 50,
    } = req.query;

    const filter = {};

    if (date) {
      const d     = new Date(date);
      const start = new Date(d); start.setHours(0, 0, 0, 0);
      const end   = new Date(d); end.setHours(23, 59, 59, 999);
      filter.timestamp = { $gte: start, $lte: end };
    }
    if (busNo)      filter.busNo      = busNo;
    if (route)      filter.route      = route;
    if (department) filter.department = department;
    if (year)       filter.year       = year;
    if (session)    filter.session    = session;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Attendance.countDocuments(filter);
    const records = await Attendance.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    return res.json({
      success: true,
      total,
      page:    parseInt(page),
      pages:   Math.ceil(total / parseInt(limit)),
      records,
    });
  } catch (err) {
    console.error("Attendance records error:", err);
    return res.status(500).json({ success: false, message: "Database error." });
  }
});

// ══════════════════════════════════════════════════════════════════
// ATTENDANCE STATS (Admin)
// GET /attendance/stats?date=
// ══════════════════════════════════════════════════════════════════
router.get("/attendance/stats", requireAdmin, async (req, res) => {
  try {
    const date    = req.query.date ? new Date(req.query.date) : new Date();
    const start   = new Date(date); start.setHours(0, 0, 0, 0);
    const end     = new Date(date); end.setHours(23, 59, 59, 999);

    const [totalToday, totalStudents, byBus, byDept] = await Promise.all([
      Attendance.countDocuments({ timestamp: { $gte: start, $lte: end } }),
      Student.countDocuments({}),
      Attendance.aggregate([
        { $match: { timestamp: { $gte: start, $lte: end } } },
        { $group: { _id: "$busNo", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Attendance.aggregate([
        { $match: { timestamp: { $gte: start, $lte: end } } },
        { $group: { _id: "$department", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    return res.json({
      success: true,
      stats: {
        totalToday,
        totalStudents,
        attendanceRate: totalStudents > 0 ? Math.round((totalToday / totalStudents) * 100) : 0,
        byBus:  byBus.map(b => ({ bus: b._id, count: b.count })),
        byDept: byDept.map(d => ({ department: d._id, count: d.count })),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Stats error." });
  }
});

// ══════════════════════════════════════════════════════════════════
// EXPORT CSV
// GET /attendance/export/csv?date=&busNo=...
// Header: x-admin-key
// ══════════════════════════════════════════════════════════════════
router.get("/attendance/export/csv", requireAdmin, async (req, res) => {
  try {
    const { date, busNo, route, department } = req.query;
    const filter = {};
    if (date) {
      const d = new Date(date);
      filter.timestamp = {
        $gte: new Date(d.setHours(0,0,0,0)),
        $lte: new Date(d.setHours(23,59,59,999)),
      };
    }
    if (busNo)      filter.busNo      = busNo;
    if (route)      filter.route      = route;
    if (department) filter.department = department;

    const records = await Attendance.find(filter).sort({ timestamp: -1 }).lean();

    const header = "Name,Register Number,Department,Year,Class,Bus No,Route,Board Stop,Session,Timestamp,Confidence,Status\n";
    const rows   = records.map(r =>
      [
        r.name, r.regNo, r.department, r.year, r.className,
        r.busNo, r.route, r.boardStop, r.session,
        new Date(r.timestamp).toLocaleString("en-IN"),
        r.confidence ? r.confidence + "%" : "",
        r.status,
      ].map(v => `"${(v || "").toString().replace(/"/g, '""')}"`).join(",")
    ).join("\n");

    const dateStr = date || new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="attendance_${dateStr}.csv"`);
    return res.send(header + rows);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Export error." });
  }
});

// ══════════════════════════════════════════════════════════════════
// STUDENT FACE STATUS  (for registration page)
// GET /attendance/face-status/:regNo
// ══════════════════════════════════════════════════════════════════
router.get("/attendance/face-status/:regNo", async (req, res) => {
  try {
    const student = await Student.findOne(
      { regNo: req.params.regNo.toUpperCase() },
      "name regNo face_registered face_registered_at last_attendance busNo route boardStop"
    ).lean();
    if (!student) return res.status(404).json({ success: false, message: "Student not found." });
    return res.json({ success: true, student });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Database error." });
  }
});

// ══════════════════════════════════════════════════════════════════
// FLASK HEALTH PROXY
// GET /attendance/service-health
// ══════════════════════════════════════════════════════════════════
router.get("/attendance/service-health", async (req, res) => {
  try {
    const url    = new URL(FLASK_BASE + "/health");
    const lib    = url.protocol === "https:" ? https : http;
    const result = await new Promise((resolve, reject) => {
      const r = lib.get(url.href, (resp) => {
        let data = "";
        resp.on("data", c => data += c);
        resp.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on("error", reject);
      r.setTimeout(5000, () => { r.destroy(); reject(new Error("timeout")); });
    });
    return res.json({ success: true, service: result });
  } catch (_) {
    return res.json({ success: false, message: "Python face service is offline." });
  }
});

module.exports = router;
module.exports.Attendance = Attendance;
