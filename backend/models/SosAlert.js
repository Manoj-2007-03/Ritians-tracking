/**
 * models/SosAlert.js — Ritians Transport Emergency Alert System
 * MongoDB schema for SOS alerts triggered by students
 */

const mongoose = require("mongoose");

const sosAlertSchema = new mongoose.Schema({
  // Student info (from session)
  studentName:   { type: String, required: true },
  studentId:     { type: String, required: true },
  busId:         { type: String, default: "Unknown" },
  rollNo:        { type: String, default: "" },

  // Location at time of trigger
  latitude:      { type: Number, default: null },
  longitude:     { type: Number, default: null },
  locationLabel: { type: String, default: "Location not available" },

  // Timing
  triggeredAt:   { type: Date, default: Date.now },
  resolvedAt:    { type: Date, default: null },

  // Status: active → resolved OR false_alarm
  status:        { type: String, enum: ["active", "resolved", "false_alarm"], default: "active" },
  resolvedBy:    { type: String, default: null },
  resolveNote:   { type: String, default: "" },

  // SMS delivery tracking
  smsSent:       { type: Boolean, default: false },
  smsRecipients: { type: [String], default: [] },
  smsError:      { type: String, default: null },
});

// Index for fast active alert queries
sosAlertSchema.index({ status: 1, triggeredAt: -1 });

module.exports = mongoose.model("SosAlert", sosAlertSchema);
