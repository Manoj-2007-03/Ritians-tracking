/**
 * models/ScheduledNotification.js — Ritians Transport
 * Queues a notification to be sent later. Polled by processDueScheduledSends()
 * in routes/notifications-admin.js, which fires it once scheduledFor arrives
 * and then writes a NotificationLog entry for it.
 */
"use strict";

const mongoose = require("mongoose");

const scheduledNotificationSchema = new mongoose.Schema(
  {
    busId:        { type: String, required: true, trim: true }, // or "ALL" when sendToAll
    message:      { type: String, required: true },
    presetLabel:  { type: String, default: "Custom" },
    sentBy:       { type: String, default: "Admin" },
    sendToAll:    { type: Boolean, default: false },
    scheduledFor: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    sentAt:      { type: Date },
    resultLogId: { type: mongoose.Schema.Types.ObjectId, ref: "NotificationLog" },
    error:       { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ScheduledNotification", scheduledNotificationSchema);
