/**
 * models/Student.js  —  Ritians Transport
 * Mongoose schema for student authentication.
 */
"use strict";

const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true },
    regNo:         { type: String, required: true, unique: true, trim: true, uppercase: true },
    className:     { type: String, required: true, trim: true },
    department:    { type: String, required: true, trim: true },
    year:          { type: String, required: true, trim: true },
    password:      { type: String, required: true },
    busNumber:     { type: String, default: "" },
    boardingPoint: { type: String, default: "" },
    phoneNumber:   { type: String, default: "", trim: true },
    fcmToken:      { type: String, default: null },

    // ── merged from routes/attendance.js's duplicate schema ──
    busNo:              { type: String, default: "" },
    route:              { type: String, default: "" },
    boardStop:          { type: String, default: "" },
    face_registered:    { type: Boolean, default: false },
    face_embedding:     { type: [Number], default: [] },
    face_registered_at: { type: Date, default: null },
    last_attendance:    { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Student", studentSchema);