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
    const { name, regNo, className, department, year, password, busNumber, boardingPoint, phoneNumber } = req.body;

    if (!name || !regNo || !className || !department || !year || !password)
      return res.status(400).json({ success: false, message: "All fields are required." });

    if (password.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });

    if (phoneNumber && !/^[6-9]\d{9}$/.test(phoneNumber))
      return res.status(400).json({ success: false, message: "Enter a valid 10-digit phone number." });

    const existing = await Student.findOne({ regNo: regNo.toUpperCase() });
    if (existing)
      return res.status(409).json({ success: false, message: "Register number already registered. Please log in." });

    const hashedPassword = await bcrypt.hash(password, 10);

     await new Student({
      name, regNo: regNo.toUpperCase(),
      className, department, year,
      password: hashedPassword,
      busNumber: busNumber || "",
      boardingPoint: boardingPoint || "",
      phoneNumber: phoneNumber || "",
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
      studentId:    student._id,
      name:         student.name,
      regNo:        student.regNo,
      className:    student.className,
      department:   student.department,
      year:         student.year,
      busNumber:    student.busNumber    || "",
      boardingPoint: student.boardingPoint || "",
      phoneNumber:  student.phoneNumber  || "",
    });

  } catch (err) {
    console.error("[AUTH] Login error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ── POST /api/save-fcm-token ───────────────────────────────────
// Called from index.html after a student enables push notifications.
// Saves their Firebase Cloud Messaging token against their student record.
router.post("/api/save-fcm-token", async (req, res) => {
  try {
    const { studentId, fcmToken } = req.body;

    if (!studentId || !fcmToken)
      return res.status(400).json({ success: false, message: "studentId and fcmToken are required." });

    const student = await Student.findByIdAndUpdate(
      studentId,
      { fcmToken },
      { new: true }
    );

    if (!student)
      return res.status(404).json({ success: false, message: "Student not found." });

    return res.json({ success: true, message: "Notification token saved." });
  } catch (err) {
    console.error("[AUTH] Save FCM token error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ── POST /api/save-fcm-token-native ────────────────────────────
// Called from index.html's native-app branch (Capacitor PushNotifications
// plugin) instead of the browser flow above. Kept as a separate field
// (fcmTokenNative) so a student using both the website and the app doesn't
// have one token overwrite the other.
router.post("/api/save-fcm-token-native", async (req, res) => {
  try {
    const { studentId, fcmToken } = req.body;

    if (!studentId || !fcmToken)
      return res.status(400).json({ success: false, message: "studentId and fcmToken are required." });

    const student = await Student.findByIdAndUpdate(
      studentId,
      { fcmTokenNative: fcmToken },
      { new: true }
    );

    if (!student)
      return res.status(404).json({ success: false, message: "Student not found." });

    return res.json({ success: true, message: "Native notification token saved." });
  } catch (err) {
    console.error("[AUTH] Save native FCM token error:", err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;