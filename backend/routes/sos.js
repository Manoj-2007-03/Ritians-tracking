/**
 * routes/sos.js — Ritians Transport Emergency Alert System
 * All SOS API endpoints
 *
 * Endpoints:
 *   POST  /api/sos/trigger          → Student triggers SOS
 *   GET   /api/sos/active           → Admin fetches active alerts
 *   GET   /api/sos/history          → Admin fetches all past alerts
 *   POST  /api/sos/resolve/:id      → Admin resolves an alert
 *   POST  /api/sos/false-alarm/:id  → Student cancels within 60s
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const twilio   = require("twilio");
const SosAlert = require("../models/SosAlert");

// ── Twilio Config ──────────────────────────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER  = process.env.TWILIO_FROM_NUMBER;

// Recipients — set these in your environment variables
const RECIPIENTS = [
  { label: "Driver",         phone: process.env.DRIVER_PHONE },
  { label: "Admin",          phone: process.env.ADMIN_PHONE },
  { label: "Transport Team", phone: process.env.TRANSPORT_PHONE },
].filter(r => r.phone); // Only include if phone number is set

// ── SMS Helper ─────────────────────────────────────────────────────────────
async function sendSosSmS(alert) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !FROM_NUMBER) {
    console.warn("[SOS] Twilio not configured — SMS skipped. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in .env");
    return { sent: false, error: "Twilio not configured" };
  }

  if (RECIPIENTS.length === 0) {
    console.warn("[SOS] No recipient phone numbers set — SMS skipped. Set DRIVER_PHONE, ADMIN_PHONE, TRANSPORT_PHONE in .env");
    return { sent: false, error: "No recipients configured" };
  }

  const client = twilio(TWILIO_SID, TWILIO_TOKEN);

  const mapsLink = alert.latitude && alert.longitude
    ? `https://maps.google.com/?q=${parseFloat(alert.latitude).toFixed(4)},${parseFloat(alert.longitude).toFixed(4)}`
    : "No location";

  const triggeredTime = new Date(alert.triggeredAt).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: true,
    timeZone: "Asia/Kolkata"
  });

  const message =
    `🚨EMERGENCY | SOS ${alert.studentName} | Bus:${alert.busId} | ${triggeredTime} | ${mapsLink}`;
  const sentTo = [];
  let lastError = null;

  for (const recipient of RECIPIENTS) {
    try {
      await client.messages.create({
        body: message,
        from: FROM_NUMBER,
        to:   recipient.phone,
      });
      sentTo.push(recipient.phone);
      console.log(`[SOS] SMS sent to ${recipient.label} (${recipient.phone})`);
    } catch (err) {
      lastError = err.message;
      console.error(`[SOS] SMS failed for ${recipient.label}:`, err.message);
    }
  }

  return {
    sent:       sentTo.length > 0,
    recipients: sentTo,
    error:      lastError,
  };
}

// ── Voice Call Helper ──────────────────────────────────────────────────────
async function makeVoiceCall(alert) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !FROM_NUMBER) {
    console.warn("[SOS] Twilio not configured — Voice call skipped.");
    return { called: false, error: "Twilio not configured" };
  }

  const CALL_RECIPIENT = process.env.ADMIN_PHONE;
  if (!CALL_RECIPIENT) {
    console.warn("[SOS] ADMIN_PHONE not set — Voice call skipped.");
    return { called: false, error: "No call recipient configured" };
  }

  const client = twilio(TWILIO_SID, TWILIO_TOKEN);

  const twiml = `
    <Response>
      <Say voice="alice" language="en-IN" loop="2">
        Alert. Alert. Alert.
        There is an emergency S O S from student ${alert.studentName},
        on Bus ${alert.busId}.
        Please check your message section immediately for details.
        Alert. Alert.
      </Say>
    </Response>
  `.trim();

  try {
    const call = await client.calls.create({
      twiml,
      to:   CALL_RECIPIENT,
      from: FROM_NUMBER,
    });
    console.log(`[SOS] 📞 Voice call initiated to Admin (${CALL_RECIPIENT}) — SID: ${call.sid}`);
    return { called: true, callSid: call.sid };
  } catch (err) {
    console.error(`[SOS] Voice call failed:`, err.message);
    return { called: false, error: err.message };
  }
}

// ── POST /api/sos/trigger ──────────────────────────────────────────────────
// Called by student when SOS button is held for 3 seconds
router.post("/api/sos/trigger", async (req, res) => {
  try {
    const { studentName, studentId, busId, rollNo, latitude, longitude } = req.body;

    if (!studentName || !studentId) {
      return res.status(400).json({ success: false, error: "Student info required." });
    }

    // ── Duplicate guard: block same student triggering again within 2 minutes ──
    const recentAlert = await SosAlert.findOne({
      studentId: studentId,
      status: "active",
      triggeredAt: { $gt: new Date(Date.now() - 2 * 60 * 1000) }
    });
    if (recentAlert) {
      console.log(`[SOS] Duplicate blocked for ${studentName} — alert already active (${recentAlert._id})`);
      return res.json({
        success: true,
        alertId: recentAlert._id,
        smsSent: false,
        message: "Alert already active. No duplicate SMS sent.",
      });
    }
    let locationLabel = "Location not available";
    if (latitude && longitude) {
      locationLabel = `${parseFloat(latitude).toFixed(4)}, ${parseFloat(longitude).toFixed(4)}`;
    }

    // Save alert to MongoDB
    const alert = await SosAlert.create({
      studentName,
      studentId,
      busId:     busId || "Unknown",
      rollNo:    rollNo || "",
      latitude:  latitude  || null,
      longitude: longitude || null,
      locationLabel,
      triggeredAt: new Date(),
      status: "active",
    });

    console.log(`[SOS] 🚨 Alert triggered by ${studentName} (Bus: ${busId}) at ${locationLabel}`);

    // Send SMS (non-blocking — don't fail if SMS fails)
    const smsResult = await sendSosSmS(alert);

    // 📞 Make voice call to Admin (non-blocking — don't fail if call fails)
    const callResult = await makeVoiceCall(alert);

    // Update alert with SMS + call status
    alert.smsSent       = smsResult.sent;
    alert.smsRecipients = smsResult.recipients || [];
    alert.smsError      = smsResult.error || null;
    await alert.save();

    return res.json({
      success:    true,
      alertId:    alert._id,
      smsSent:    smsResult.sent,
      callMade:   callResult.called,
      message:    "Emergency alert sent successfully.",
    });

  } catch (err) {
    console.error("[SOS] Trigger error:", err.message);
    return res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// ── GET /api/sos/active ────────────────────────────────────────────────────
// Admin dashboard — fetch all active alerts
router.get("/api/sos/active", async (req, res) => {
  try {
    const alerts = await SosAlert.find({ status: "active" }).sort({ triggeredAt: -1 });
    return res.json({ success: true, count: alerts.length, alerts });
  } catch (err) {
    console.error("[SOS] Active fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── GET /api/sos/history ───────────────────────────────────────────────────
// Admin dashboard — fetch all past alerts (last 50)
router.get("/api/sos/history", async (req, res) => {
  try {
    const alerts = await SosAlert.find({}).sort({ triggeredAt: -1 }).limit(50);
    return res.json({ success: true, count: alerts.length, alerts });
  } catch (err) {
    console.error("[SOS] History fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── POST /api/sos/resolve/:id ──────────────────────────────────────────────
// Admin marks an alert as resolved
router.post("/api/sos/resolve/:id", async (req, res) => {
  try {
    const { resolvedBy, note } = req.body;
    const alert = await SosAlert.findById(req.params.id);

    if (!alert) return res.status(404).json({ success: false, error: "Alert not found." });
    if (alert.status !== "active") return res.json({ success: true, message: "Already resolved." });

    alert.status      = "resolved";
    alert.resolvedAt  = new Date();
    alert.resolvedBy  = resolvedBy || "Admin";
    alert.resolveNote = note || "";
    await alert.save();

    console.log(`[SOS] ✅ Alert ${alert._id} resolved by ${alert.resolvedBy}`);
    return res.json({ success: true, message: "Alert resolved." });
  } catch (err) {
    console.error("[SOS] Resolve error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── POST /api/sos/false-alarm/:id ─────────────────────────────────────────
// Student cancels alert within 60-second window
router.post("/api/sos/false-alarm/:id", async (req, res) => {
  try {
    const alert = await SosAlert.findById(req.params.id);

    if (!alert) return res.status(404).json({ success: false, error: "Alert not found." });

    // Only allow cancel within 60 seconds
    const ageSeconds = (Date.now() - new Date(alert.triggeredAt).getTime()) / 1000;
    if (ageSeconds > 60) {
      return res.status(400).json({ success: false, error: "Cancel window expired (60s)." });
    }

    alert.status     = "false_alarm";
    alert.resolvedAt = new Date();
    alert.resolveNote = "Cancelled by student as false alarm";
    await alert.save();

    console.log(`[SOS] ⚪ Alert ${alert._id} marked as false alarm by student`);
    return res.json({ success: true, message: "Alert cancelled." });
  } catch (err) {
    console.error("[SOS] False alarm error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── POST /api/sos/location/:id ─────────────────────────────────────────────
// Student's device keeps pushing updated GPS coords every 5 seconds
router.post("/api/sos/location/:id", async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ success: false, error: "Coordinates required." });
    }

    const alert = await SosAlert.findById(req.params.id);
    if (!alert) return res.status(404).json({ success: false, error: "Alert not found." });
    if (alert.status !== "active") return res.json({ success: false, error: "Alert no longer active." });

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    alert.latitude      = lat;
    alert.longitude     = lng;
    alert.locationLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    alert.lastLocationAt = new Date();
    await alert.save();

    return res.json({ success: true });
  } catch (err) {
    console.error("[SOS] Location update error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// ── GET /api/sos/location/:id ──────────────────────────────────────────────
// Admin dashboard polls this to get the latest coordinates
router.get("/api/sos/location/:id", async (req, res) => {
  try {
    const alert = await SosAlert.findById(req.params.id).select("latitude longitude locationLabel lastLocationAt status studentName busId");
    if (!alert) return res.status(404).json({ success: false, error: "Alert not found." });
    return res.json({
      success:   true,
      latitude:  alert.latitude,
      longitude: alert.longitude,
      locationLabel: alert.locationLabel,
      lastLocationAt: alert.lastLocationAt,
      status:    alert.status,
      studentName: alert.studentName,
      busId:     alert.busId,
    });
  } catch (err) {
    console.error("[SOS] Location fetch error:", err.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

module.exports = router;
