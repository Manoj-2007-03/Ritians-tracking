/**
 * routes/notifications-admin.js — Ritians Transport
 * Notification Dashboard API — lets admin send a targeted push
 * notification to every student registered on a specific bus.
 *
 * Endpoints:
 *   GET    /api/notify/buses            → distinct bus numbers that have students
 *   GET    /api/notify/bus-count/:busId → how many students / reachable tokens
 *   POST   /api/notify/send             → send message to a bus, logs it
 *   GET    /api/notify/history          → admin fetches past sends (last 50)
 *   POST   /api/notify/schedule         → queue a message to send at a future time
 *   GET    /api/notify/scheduled        → admin fetches pending scheduled sends
 *   DELETE /api/notify/schedule/:id     → cancel a still-pending scheduled send
 *
 * Also exports processDueScheduledSends() — a worker function polled on an
 * interval by server.js, which sends any scheduled notification whose time
 * has arrived and logs it to NotificationLog just like an immediate send.
 */

"use strict";

const express = require("express");
const router = express.Router();
const Student = require("../models/Student");
const NotificationLog = require("../models/NotificationLog");
const ScheduledNotification = require("../models/ScheduledNotification");
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

// ── GET /api/notify/all-count ────────────────────────────────────────────────
// Shows the admin "will reach X of Y students" preview when "Send to all
// buses" is toggled on, mirroring /api/notify/bus-count/:busId but with no
// bus filter.
router.get("/api/notify/all-count", async (req, res) => {
  try {
    const students = await Student.find({}).select("fcmToken fcmTokenNative");
    const reachable = students.filter(s => s.fcmToken || s.fcmTokenNative).length;
    return res.json({ success: true, studentCount: students.length, reachable });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] all-count error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── POST /api/notify/send ───────────────────────────────────────────────────
// Body: { busId, message, presetLabel, sentBy, sendToAll }
// When sendToAll is true, busId is ignored and the message goes to every
// reachable student; the log's busId is recorded as "ALL".
router.post("/api/notify/send", async (req, res) => {
  try {
    const { busId, message, presetLabel, sentBy, sendToAll } = req.body;

    if (!sendToAll && (!busId || !String(busId).trim()))
      return res.status(400).json({ success: false, error: "Bus is required." });
    if (!message || !String(message).trim())
      return res.status(400).json({ success: false, error: "Message is required." });

    const cleanMessage = String(message).trim();
    const targetBusId = sendToAll ? "ALL" : busId;
    const result = await notifyCustomMessage(targetBusId, cleanMessage, { sentBy, sendToAll: !!sendToAll });

    const log = await NotificationLog.create({
      busId: targetBusId,
      message: cleanMessage,
      presetLabel: presetLabel || "Custom",
      sentBy: sentBy || "Admin",
      studentCount: result.studentCount || 0,
      tokenCount: result.tokenCount || 0,
      successCount: result.successCount || 0,
      failureCount: result.failureCount || 0,
    });

    console.log(
      `[NOTIFY-ADMIN] ${targetBusId}: logged ${log._id} — sent ${result.successCount || 0}/${result.tokenCount || 0} tokens`
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
          ? sendToAll
            ? "Saved, but no reachable students found (notifications not enabled on their devices)."
            : "Saved, but no reachable students found on this bus (notifications not enabled on their devices)."
          : "Notification sent.",
    });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] Send error:", err.message);
    return res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// ── POST /api/notify/schedule ───────────────────────────────────────────────
// Body: { busId, message, presetLabel, sentBy, sendToAll, scheduledFor }
// Queues a notification instead of sending it immediately. scheduledFor must
// be an ISO datetime string in the future. The actual send happens later,
// off the request/response cycle, via processDueScheduledSends() below.
router.post("/api/notify/schedule", async (req, res) => {
  try {
    const { busId, message, presetLabel, sentBy, sendToAll, scheduledFor } = req.body;

    if (!sendToAll && (!busId || !String(busId).trim()))
      return res.status(400).json({ success: false, error: "Bus is required." });
    if (!message || !String(message).trim())
      return res.status(400).json({ success: false, error: "Message is required." });

    const sendAt = new Date(scheduledFor);
    if (!scheduledFor || isNaN(sendAt.getTime()))
      return res.status(400).json({ success: false, error: "A valid scheduled time is required." });
    if (sendAt.getTime() <= Date.now())
      return res.status(400).json({ success: false, error: "Scheduled time must be in the future." });

    const scheduled = await ScheduledNotification.create({
      busId: sendToAll ? "ALL" : busId,
      message: String(message).trim(),
      presetLabel: presetLabel || "Custom",
      sentBy: sentBy || "Admin",
      sendToAll: !!sendToAll,
      scheduledFor: sendAt,
    });

    console.log(`[NOTIFY-SCHEDULE] Queued ${scheduled._id} for ${sendAt.toISOString()} (${scheduled.busId})`);

    return res.json({ success: true, scheduled });
  } catch (err) {
    console.error("[NOTIFY-SCHEDULE] Create error:", err.message);
    return res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// ── GET /api/notify/scheduled ───────────────────────────────────────────────
// Powers the "Scheduled" list on the dashboard — every notification still
// waiting to fire, soonest first.
router.get("/api/notify/scheduled", async (req, res) => {
  try {
    const scheduled = await ScheduledNotification.find({ status: "pending" })
      .sort({ scheduledFor: 1 })
      .limit(100);
    return res.json({ success: true, count: scheduled.length, scheduled });
  } catch (err) {
    console.error("[NOTIFY-SCHEDULE] fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── DELETE /api/notify/schedule/:id ─────────────────────────────────────────
// Cancels a scheduled notification before it fires. Once a scheduled entry
// has already been sent (or failed), it's no longer cancellable — it belongs
// to history at that point.
router.delete("/api/notify/schedule/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const scheduled = await ScheduledNotification.findById(id);
    if (!scheduled) {
      return res.status(404).json({ success: false, error: "Scheduled notification not found." });
    }
    if (scheduled.status !== "pending") {
      return res.status(400).json({ success: false, error: "This notification has already been processed and can no longer be cancelled." });
    }
    await ScheduledNotification.findByIdAndDelete(id);
    console.log(`[NOTIFY-SCHEDULE] ${id} cancelled`);
    return res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("[NOTIFY-SCHEDULE] cancel error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
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

// ── DELETE /api/notify/history/:id ──────────────────────────────────────────
// Deletes a single notification log entry (e.g. a test message sent by
// mistake). Used by the per-card trash icon on the dashboard. This route is
// declared before the bulk "/api/notify/history" route below is matched by
// Express on path shape alone, but since the two paths differ ("/:id" vs
// none) there's no ordering conflict either way.
router.delete("/api/notify/history/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await NotificationLog.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Notification entry not found." });
    }
    console.log(`[NOTIFY-ADMIN] History entry ${id} deleted`);
    return res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] history entry delete error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── DELETE /api/notify/history ──────────────────────────────────────────────
// Clears all notification history records. Used by the "Clear Notification
// History" button on the dashboard. Irreversible — the frontend confirms
// with the admin before calling this.
router.delete("/api/notify/history", async (req, res) => {
  try {
    const result = await NotificationLog.deleteMany({});
    console.log(`[NOTIFY-ADMIN] History cleared — ${result.deletedCount} record(s) removed`);
    return res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (err) {
    console.error("[NOTIFY-ADMIN] history clear error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── processDueScheduledSends ────────────────────────────────────────────────
// Polled on an interval from server.js (see setInterval near the other
// background jobs). Finds every "pending" ScheduledNotification whose
// scheduledFor time has arrived, sends it through the same notifyCustomMessage
// path an immediate send uses, and writes a NotificationLog entry so it shows
// up in Recent Notifications indistinguishably from a manual send (aside from
// wasScheduled/scheduledFor on the log). A simple in-flight flag stops two
// overlapping runs if a previous pass is still awaiting Firebase.
let isProcessingScheduled = false;

async function processDueScheduledSends() {
  if (isProcessingScheduled) return;
  isProcessingScheduled = true;

  try {
    const due = await ScheduledNotification.find({
      status: "pending",
      scheduledFor: { $lte: new Date() },
    });

    for (const item of due) {
      try {
        const result = await notifyCustomMessage(item.busId, item.message, {
          sentBy: item.sentBy,
          sendToAll: item.sendToAll,
        });

        const log = await NotificationLog.create({
          busId: item.busId,
          message: item.message,
          presetLabel: item.presetLabel || "Custom",
          sentBy: item.sentBy || "Admin",
          studentCount: result.studentCount || 0,
          tokenCount: result.tokenCount || 0,
          successCount: result.successCount || 0,
          failureCount: result.failureCount || 0,
          wasScheduled: true,
          scheduledFor: item.scheduledFor,
        });

        item.status = "sent";
        item.sentAt = new Date();
        item.resultLogId = log._id;
        await item.save();

        console.log(
          `[NOTIFY-SCHEDULE] ${item.busId}: fired ${item._id} → logged ${log._id} — sent ${result.successCount || 0}/${result.tokenCount || 0} tokens`
        );
      } catch (err) {
        item.status = "failed";
        item.error = err.message;
        try { await item.save(); } catch (_) { /* best effort */ }
        console.error(`[NOTIFY-SCHEDULE] Failed to fire ${item._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[NOTIFY-SCHEDULE] processDueScheduledSends error:", err.message);
  } finally {
    isProcessingScheduled = false;
  }
}

module.exports = router;
module.exports.processDueScheduledSends = processDueScheduledSends;