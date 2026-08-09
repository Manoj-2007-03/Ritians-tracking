/**
 * models/NotificationLog.js — Ritians Transport
 * Stores a history record every time an admin sends a bus-targeted
 * notification from the Notification Dashboard.
 */
"use strict";

const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema(
  {
    busId:        { type: String, required: true, trim: true },
    message:      { type: String, required: true },
    presetLabel:  { type: String, default: "Custom" }, // which of the 8 presets, or "Custom"
    sentBy:       { type: String, default: "Admin" },
    studentCount: { type: Number, default: 0 }, // students matched on this bus
    tokenCount:   { type: Number, default: 0 }, // total FCM tokens targeted (web + native)
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    sentAt:       { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NotificationLog", notificationLogSchema);
