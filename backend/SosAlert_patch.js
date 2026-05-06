/**
 * models/SosAlert.js — ADD this one field to your existing schema:
 *
 * Add inside your SosAlert schema definition:
 *
 *   lastLocationAt: { type: Date, default: null },
 *
 * Example — your schema should include:
 *
 *   latitude:       { type: Number, default: null },
 *   longitude:      { type: Number, default: null },
 *   locationLabel:  { type: String, default: "" },
 *   lastLocationAt: { type: Date,   default: null },   // ← ADD THIS LINE
 *
 * That's the only change needed to models/SosAlert.js
 */
