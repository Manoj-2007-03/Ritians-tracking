/**
 * routes/auth.js  —  Ritians Transport
 * POST /signup  and  POST /login  for student authentication.
 */
"use strict";

const express = require("express");
const bcrypt  = require("bcrypt");
const Student = require("../models/Student");
const router  = express.Router();

// ── POST /signup ──────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { name, regNo, className, department, year, password } = req.body;

    if (!name || !regNo || !className || !department || !year || !password)
      return res.status(400).json({ success: false, message: "All fields are required." });

    if (password.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });

    const existing = await Student.findOne({ regNo: regNo.toUpperCase() });
    if (existing)
      return res.status(409).json({ success: false, message: "Register number already registered. Please log in." });

    const hashedPassword = await bcrypt.hash(password, 10);

    await new Student({
      name, regNo: regNo.toUpperCase(),
      className, department, year,
      password: hashedPassword,
    }).save();

    return res.status(201).json({ success: true, message: "Signup successful! Please log in." });

  } catch (err) {
    console.error("[AUTH] Signup error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ── POST /login ───────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { regNo, password } = req.body;

    if (!regNo || !password)
      return res.status(400).json({ success: false, message: "Register number and password are required." });

    const student = await Student.findOne({ regNo: regNo.toUpperCase() });
    if (!student)
      return res.status(404).json({ success: false, message: "User not found. Please sign up first." });

    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch)
      return res.status(401).json({ success: false, message: "Invalid password. Please try again." });

    return res.status(200).json({
      success: true, message: "Login successful!",
      studentId:  student._id,
      name:       student.name,
      regNo:      student.regNo,
      className:  student.className,
      department: student.department,
      year:       student.year,
    });

  } catch (err) {
    console.error("[AUTH] Login error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;
