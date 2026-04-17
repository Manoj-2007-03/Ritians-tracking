/**
 * models/Student.js  —  Ritians Transport
 * Mongoose schema for student authentication.
 */
"use strict";

const mongoose = require("mongoose");

const studentSchema = new mongoose.Schema(
  {
    name:       { type: String, required: true, trim: true },
    regNo:      { type: String, required: true, unique: true, trim: true, uppercase: true },
    className:  { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    year:       { type: String, required: true, trim: true },
    password:   { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Student", studentSchema);
