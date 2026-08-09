/**
 * routes/notifications-admin.js — Ritians Transport
 * Notification Dashboard API — lets admin send a targeted push
 * notification to every student registered on a specific bus.
 *
 * Endpoints:
 *   GET  /api/notify/buses            → distinct bus numbers that have students
 *   GET  /api/notify/bus-count/:busId → how many students / reachable tokens
 *   POST /api/notify/send             → send message to a bus, logs it
 *   GET  /api/notify/history          → admin fetches past sends (last 50)
 */

"use strict";

const express = require("express");
const router = express.Router();
const Student = require("../models/Student");
const NotificationLog = require("../models/NotificationLog");
const { notifyCustomMessage } = require("../notifications");

// ── GET /api/notify/buses ───────────────────────────────────────────────────
// Populates the bus-select dropdown with buses that actually have students
// signed up against them (checks busNumber, legacy busNo, and route fields).
router.get("/api/notify/buses", async (req, res) => {
  try {
    const [a, b, c] = await Promise.all([
      Student.distinct("busNumber", { busNumber: { $nin: ["", null] } }),
      Student.distinct("busNo", { busNo: { $nin: ["", null] } }),
      Student.distinct("route", { route: { $nin: ["", null] } }),
    ]);
    const buses = [...new Set([...a, ...b, ...c].map(x => String(x).trim()).filter(Boolean))].sort();
    return res.json({ success: true, buses });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] buses fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── GET /api/notify/bus-count/:busId ────────────────────────────────────────
// Shows the admin "will reach X of Y students" before sending.
router.get("/api/notify/bus-count/:busId", async (req, res) => {
  try {
    const busId = req.params.busId;
    const students = await Student.find({
      $or: [{ busNumber: busId }, { busNo: busId }, { route: busId }],
    }).select("fcmToken fcmTokenNative");

    const reachable = students.filter(s => s.fcmToken || s.fcmTokenNative).length;
    return res.json({ success: true, studentCount: students.length, reachable });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] bus-count error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── POST /api/notify/send ───────────────────────────────────────────────────
// Body: { busId, message, presetLabel, sentBy }
router.post("/api/notify/send", async (req, res) => {
  try {
    const { busId, message, presetLabel, sentBy } = req.body;

    if (!busId || !String(busId).trim())
      return res.status(400).json({ success: false, error: "Bus is required." });
    if (!message || !String(message).trim())
      return res.status(400).json({ success: false, error: "Message is required." });

    const cleanMessage = String(message).trim();
    const result = await notifyCustomMessage(busId, cleanMessage, { sentBy });

    const log = await NotificationLog.create({
      busId,
      message: cleanMessage,
      presetLabel: presetLabel || "Custom",
      sentBy: sentBy || "Admin",
      studentCount: result.studentCount || 0,
      tokenCount: result.tokenCount || 0,
      successCount: result.successCount || 0,
      failureCount: result.failureCount || 0,
    });

    console.log(
      `[NOTIFY-ADMIN] ${busId}: logged ${log._id} — sent ${result.successCount || 0}/${result.tokenCount || 0} tokens`
    );

    return res.json({
      success: true,
      logId: log._id,
      studentCount: result.studentCount || 0,
      tokenCount: result.tokenCount || 0,
      successCount: result.successCount || 0,
      failureCount: result.failureCount || 0,
      message:
        (result.tokenCount || 0) === 0
          ? "Saved, but no reachable students found on this bus (notifications not enabled on their devices)."
          : "Notification sent.",
    });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] Send error:", err.message);
    return res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// ── GET /api/notify/history ─────────────────────────────────────────────────
router.get("/api/notify/history", async (req, res) => {
  try {
    const logs = await NotificationLog.find({}).sort({ createdAt: -1 }).limit(50);
    return res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] history fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

module.exports = router;