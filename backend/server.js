/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   Ritians Transport – Live GPS Tracking Backend                            ║
 * ║   v4.0 – Production-Grade ETA Engine                                       ║
 * ║                                                                            ║
 * ║   NEW in v4 (over v3):                                                     ║
 * ║   ✅ Kalman-filter GPS smoothing (not just outlier rejection)              ║
 * ║   ✅ Exponential weighted moving average (EWMA) for speed                  ║
 * ║   ✅ Hybrid ETA: blends real-time speed + schedule drift correction        ║
 * ║   ✅ Traffic-pause detection (bus stopped > 60s → traffic penalty)        ║
 * ║   ✅ Stop dwell-time model (bus pauses AT stop, not just passes)          ║
 * ║   ✅ Precise stop crossing via perpendicular projection geometry           ║
 * ║   ✅ "Arriving" threshold upgraded from 50m → 150m configurable           ║
 * ║   ✅ Confidence score per ETA (low when stopped, speed volatile)           ║
 * ║   ✅ Cumulative delay tracking (early/on-time/delayed status per bus)     ║
 * ║   ✅ GET /eta-summary/:vehicleId – lightweight status for polling          ║
 * ║   ✅ Historical speed store per route segment for smarter fallback         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

"use strict";

const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const mongoose   = require("mongoose");
const authRoutes = require("./routes/auth");
const attendanceRoutes = require("./routes/attendance.js");

// ── SECTION 2: ADD THIS after app.use("/", authRoutes) ────────────
// (around line 45 in your server.js)



// ── MongoDB Connection ─────────────────────────────────────────────────────────
// Set MONGODB_URI in your environment, or replace the string below with your
// MongoDB Atlas connection string.
// Atlas format: mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/ritians
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ritians";

mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected — student auth ready"))
  .catch(err => console.error("❌ MongoDB connection failed:", err.message));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));
app.use("/", attendanceRoutes);

// ── Student Auth Routes (/signup  /login) ──────────────────────────────────────
app.use("/", authRoutes);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── In-Memory Stores ───────────────────────────────────────────────────────────
const locationStore   = {};  // vehicleId → vehicle state
const etaCache        = {};  // vehicleId → { stops, computedAt, speedAtCompute }
const segmentSpeedDB  = {};  // routeId:segIdx → [speed samples]  (historical)

// ── RIT Campus (final destination for ALL buses) ───────────────────────────────
const RIT_CAMPUS = { lat: 12.8231, lng: 80.0444 };

// ═════════════════════════════════════════════════════════════════════════════
// ██  THRESHOLDS & TUNABLES
// ═════════════════════════════════════════════════════════════════════════════
const T = {
  // Passing detection (new strict gates)
  PASS_PROXIMITY_KM:  0.100,   // 100 m  → bus must have been this close to a stop before it can be "passed"
  PASS_DEPARTURE_KM:  0.030,   //  30 m  → bus must have moved this far away from closest point to confirm departure

  // Stop detection radii
  DEST_RADIUS_KM:     0.200,   // 200 m  → "Reached Destination"
  ARRIVED_RADIUS_KM:  0.050,   // 50 m   → stop status "arrived"
  ARRIVING_RADIUS_KM: 0.150,   // 150 m  → stop status "arriving"
  CURRENT_RADIUS_KM:  0.100,   // 100 m  → stop status "current" (boarding)
  PASSED_PROJ_M:      50,      // 50 m   → projection overshoot → "passed"

  // GPS noise / movement
  GPS_NOISE_KM:       0.500,   // 500 m  → hard outlier jump
  GPS_NOISE_TIME_MS:  5_000,   // 5 s    → window for outlier check
  THROTTLE_DIST_KM:   0.010,   // 10 m   → skip recompute
  THROTTLE_TIME_MS:   3_000,   // 3 s    → skip recompute

  // Kalman filter
  KALMAN_Q:           0.0001,  // process noise variance  (lower = trust model more)
  KALMAN_R:           0.0025,  // measurement noise variance (GPS accuracy ~50 m → (0.05km)²)

  // Speed smoothing
  EWMA_ALPHA:         0.25,    // 0–1; higher = faster response, lower = smoother
  SPEED_HISTORY_LEN:  10,      // for variance/confidence calc
  FALLBACK_SPEED_KMH: 25,      // urban fallback
  STOPPED_KMH:        1.5,     // below this → bus is stopped
  TRAFFIC_STOP_MS:    60_000,  // 60 s stationary → "traffic jam" penalty

  // ETA cache invalidation
  ETA_CACHE_SPEED_D:  5,       // km/h delta to invalidate
  ETA_CACHE_DIST_D:   0.100,   // 100 m delta to invalidate

  // Schedule / hybrid ETA
  SCHED_BLEND_WEIGHT: 0.20,    // 20% schedule correction, 80% live speed
  MAX_DELAY_MIN:      30,      // cap schedule drift at 30 min
  DWELL_TIME_SEC:     15,      // assumed dwell at each stop (seconds)

  // Segment speed history
  SEG_HISTORY_LEN:    20,      // samples per segment kept
};

// ═════════════════════════════════════════════════════════════════════════════
// ██  ROUTE DATABASE  (unchanged from v3 – all 29 routes preserved)
// ═════════════════════════════════════════════════════════════════════════════
const routeStopsDB = {

  R01: [
    { stopId:"R01_01", stopName:"Lift Gate",            lat:13.1614, lng:80.2973, scheduledTime:"5:50", sequence:1 },
    { stopId:"R01_02", stopName:"Wimco Market",         lat:13.1589, lng:80.2961, scheduledTime:"5:55", sequence:2 },
    { stopId:"R01_03", stopName:"Ajax",                 lat:13.1550, lng:80.2942, scheduledTime:"6:00", sequence:3 },
    { stopId:"R01_04", stopName:"Periyar Nagar",        lat:13.1521, lng:80.2918, scheduledTime:"6:03", sequence:4 },
    { stopId:"R01_05", stopName:"Thiruvottiyur Market", lat:13.1681, lng:80.3014, scheduledTime:"6:08", sequence:5 },
    { stopId:"R01_06", stopName:"Theradi",              lat:13.1650, lng:80.2992, scheduledTime:"6:10", sequence:6 },
    { stopId:"R01_07", stopName:"Ellaimman Koil",       lat:13.1634, lng:80.2986, scheduledTime:"6:12", sequence:7 },
    { stopId:"R01_08", stopName:"Raja Kadai",           lat:13.1623, lng:80.2981, scheduledTime:"6:14", sequence:8 },
    { stopId:"R01_09", stopName:"Toll Gate",            lat:13.1608, lng:80.2974, scheduledTime:"6:15", sequence:9 },
    { stopId:"R01_10", stopName:"RIT Campus",           lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R01A: [
    { stopId:"R01A_01", stopName:"New Vannarpettai",         lat:13.1420, lng:80.2897, scheduledTime:"6:17", sequence:1 },
    { stopId:"R01A_02", stopName:"Apollo",                   lat:13.1402, lng:80.2882, scheduledTime:"6:18", sequence:2 },
    { stopId:"R01A_03", stopName:"Tondiarpet",               lat:13.1247, lng:80.2869, scheduledTime:"6:19", sequence:3 },
    { stopId:"R01A_04", stopName:"Maharani",                 lat:13.1198, lng:80.2856, scheduledTime:"6:21", sequence:4 },
    { stopId:"R01A_05", stopName:"Mint",                     lat:13.1027, lng:80.2879, scheduledTime:"6:22", sequence:5 },
    { stopId:"R01A_06", stopName:"New Bus Stand Mint",       lat:13.1012, lng:80.2875, scheduledTime:"6:27", sequence:6 },
    { stopId:"R01A_07", stopName:"Thirupalli Street",        lat:13.0935, lng:80.2845, scheduledTime:"6:33", sequence:7 },
    { stopId:"R01A_08", stopName:"Aminjikarai",              lat:13.0792, lng:80.2185, scheduledTime:"7:00", sequence:8 },
    { stopId:"R01A_09", stopName:"Skywalk",                  lat:13.0812, lng:80.2191, scheduledTime:"7:02", sequence:9 },
    { stopId:"R01A_10", stopName:"Arumbakkam",               lat:13.0761, lng:80.2127, scheduledTime:"7:07", sequence:10 },
    { stopId:"R01A_11", stopName:"Koyambedu Metro",          lat:13.0695, lng:80.1951, scheduledTime:"7:10", sequence:11 },
    { stopId:"R01A_12", stopName:"Vengaya Mandi",            lat:13.0638, lng:80.1763, scheduledTime:"7:16", sequence:12 },
    { stopId:"R01A_13", stopName:"Ration Stop (Nerkundram)", lat:13.0620, lng:80.1721, scheduledTime:"7:20", sequence:13 },
    { stopId:"R01A_14", stopName:"Maduravoyal",              lat:13.0581, lng:80.1622, scheduledTime:"7:21", sequence:14 },
    { stopId:"R01A_15", stopName:"Maduravoyal Erikarai",     lat:13.0568, lng:80.1597, scheduledTime:"7:25", sequence:15 },
    { stopId:"R01A_16", stopName:"Vanagaram",                lat:13.0445, lng:80.1408, scheduledTime:"7:29", sequence:16 },
    { stopId:"R01A_17", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:17 },
  ],

  R01B: [
    { stopId:"R01B_01", stopName:"Kasimedu",           lat:13.1382, lng:80.2968, scheduledTime:"6:15", sequence:1 },
    { stopId:"R01B_02", stopName:"Kalmandapam",        lat:13.1341, lng:80.2938, scheduledTime:"6:21", sequence:2 },
    { stopId:"R01B_03", stopName:"Royapuram Bridge",   lat:13.1148, lng:80.2921, scheduledTime:"6:27", sequence:3 },
    { stopId:"R01B_04", stopName:"Beach Station",      lat:13.0997, lng:80.2884, scheduledTime:"6:30", sequence:4 },
    { stopId:"R01B_05", stopName:"Parry's",            lat:13.0901, lng:80.2867, scheduledTime:"6:34", sequence:5 },
    { stopId:"R01B_06", stopName:"Central",            lat:13.0839, lng:80.2755, scheduledTime:"6:37", sequence:6 },
    { stopId:"R01B_07", stopName:"Egmore",             lat:13.0781, lng:80.2641, scheduledTime:"6:40", sequence:7 },
    { stopId:"R01B_08", stopName:"Dasaprakash",        lat:13.0758, lng:80.2521, scheduledTime:"6:44", sequence:8 },
    { stopId:"R01B_09", stopName:"Ega Theatre",        lat:13.0735, lng:80.2394, scheduledTime:"6:48", sequence:9 },
    { stopId:"R01B_10", stopName:"Aminjikarai Market", lat:13.0792, lng:80.2185, scheduledTime:"6:51", sequence:10 },
    { stopId:"R01B_11", stopName:"RIT Campus",         lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:11 },
  ],

  R02: [
    { stopId:"R02_01", stopName:"Chintadripet (Post Office)",          lat:13.0694, lng:80.2714, scheduledTime:"6:20", sequence:1 },
    { stopId:"R02_02", stopName:"D1 Police Station",                   lat:13.0658, lng:80.2752, scheduledTime:"6:25", sequence:2 },
    { stopId:"R02_03", stopName:"Triplicane Highway",                  lat:13.0621, lng:80.2798, scheduledTime:"6:29", sequence:3 },
    { stopId:"R02_04", stopName:"Ice House Police Station",            lat:13.0591, lng:80.2812, scheduledTime:"6:32", sequence:4 },
    { stopId:"R02_05", stopName:"Meersahibpet Market",                 lat:13.0571, lng:80.2831, scheduledTime:"6:35", sequence:5 },
    { stopId:"R02_06", stopName:"Royapettah New College",              lat:13.0548, lng:80.2732, scheduledTime:"6:39", sequence:6 },
    { stopId:"R02_07", stopName:"Sterling Road (Bharath Petrol Bunk)", lat:13.0729, lng:80.2532, scheduledTime:"6:40", sequence:7 },
    { stopId:"R02_08", stopName:"Choolaimedu Subway",                  lat:13.0748, lng:80.2341, scheduledTime:"6:43", sequence:8 },
    { stopId:"R02_09", stopName:"Choolaimedu Bus Stop",                lat:13.0761, lng:80.2318, scheduledTime:"6:45", sequence:9 },
    { stopId:"R02_10", stopName:"Anna Arch",                           lat:13.0781, lng:80.2214, scheduledTime:"6:50", sequence:10 },
    { stopId:"R02_11", stopName:"Arumbakkam Panchaliamman Koil",       lat:13.0762, lng:80.2128, scheduledTime:"6:53", sequence:11 },
    { stopId:"R02_12", stopName:"NSK",                                 lat:13.0741, lng:80.2047, scheduledTime:"6:55", sequence:12 },
    { stopId:"R02_13", stopName:"Maduravoyal Murugan Store",           lat:13.0581, lng:80.1622, scheduledTime:"6:58", sequence:13 },
    { stopId:"R02_14", stopName:"RIT Campus",                          lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:14 },
  ],

  R03: [
    { stopId:"R03_01", stopName:"Pulianthope",              lat:13.1081, lng:80.2745, scheduledTime:"6:20", sequence:1 },
    { stopId:"R03_02", stopName:"Choolai Post Office",      lat:13.1014, lng:80.2712, scheduledTime:"6:25", sequence:2 },
    { stopId:"R03_03", stopName:"Purasaivakkam Doveton",    lat:13.0956, lng:80.2568, scheduledTime:"6:30", sequence:3 },
    { stopId:"R03_04", stopName:"Kellys Signal",            lat:13.0921, lng:80.2414, scheduledTime:"6:33", sequence:4 },
    { stopId:"R03_05", stopName:"Water Tank Road Signal",   lat:13.0862, lng:80.2298, scheduledTime:"6:40", sequence:5 },
    { stopId:"R03_06", stopName:"Kilpauk Garden",           lat:13.0834, lng:80.2264, scheduledTime:"6:45", sequence:6 },
    { stopId:"R03_07", stopName:"Chinthamani",              lat:13.0868, lng:80.2195, scheduledTime:"6:50", sequence:7 },
    { stopId:"R03_08", stopName:"Anna Nagar Roundtana",     lat:13.0841, lng:80.2121, scheduledTime:"6:55", sequence:8 },
    { stopId:"R03_09", stopName:"Thirumangalam Blue Star",  lat:13.0818, lng:80.2068, scheduledTime:"6:57", sequence:9 },
    { stopId:"R03_10", stopName:"VR Mall",                  lat:13.0812, lng:80.2041, scheduledTime:"7:00", sequence:10 },
    { stopId:"R03_11", stopName:"Maduravoyal Ration Shop",  lat:13.0561, lng:80.1631, scheduledTime:"7:10", sequence:11 },
    { stopId:"R03_12", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:12 },
  ],

  R03A: [
    { stopId:"R03A_01", stopName:"Collector Nagar",       lat:13.0864, lng:80.1864, scheduledTime:"6:50", sequence:1 },
    { stopId:"R03A_02", stopName:"Golden Flat",           lat:13.0871, lng:80.1878, scheduledTime:"6:55", sequence:2 },
    { stopId:"R03A_03", stopName:"Mogappair West Depot",  lat:13.0925, lng:80.1792, scheduledTime:"7:00", sequence:3 },
    { stopId:"R03A_04", stopName:"Nolambur",              lat:13.0894, lng:80.1725, scheduledTime:"7:03", sequence:4 },
    { stopId:"R03A_05", stopName:"MGR University",        lat:13.0781, lng:80.1604, scheduledTime:"7:08", sequence:5 },
    { stopId:"R03A_06", stopName:"RIT Campus",            lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:6 },
  ],

  R03B: [
    { stopId:"R03B_01", stopName:"Gangaiamman Koil",         lat:13.1021, lng:80.2201, scheduledTime:"6:40", sequence:1 },
    { stopId:"R03B_02", stopName:"Madina Masjid",            lat:13.0981, lng:80.2218, scheduledTime:"6:43", sequence:2 },
    { stopId:"R03B_03", stopName:"New Avadi Road",           lat:13.0958, lng:80.2231, scheduledTime:"6:45", sequence:3 },
    { stopId:"R03B_04", stopName:"Chintamani",               lat:13.0868, lng:80.2195, scheduledTime:"6:50", sequence:4 },
    { stopId:"R03B_05", stopName:"Nalli Store",              lat:13.0841, lng:80.2108, scheduledTime:"6:58", sequence:5 },
    { stopId:"R03B_06", stopName:"Anna Nagar Metro",         lat:13.0831, lng:80.2088, scheduledTime:"7:05", sequence:6 },
    { stopId:"R03B_07", stopName:"Thirumangalam Metro",      lat:13.0818, lng:80.2068, scheduledTime:"7:10", sequence:7 },
    { stopId:"R03B_08", stopName:"Nerkundram",               lat:13.0641, lng:80.1741, scheduledTime:"7:15", sequence:8 },
    { stopId:"R03B_09", stopName:"Maduravoyal Ration Shop",  lat:13.0561, lng:80.1631, scheduledTime:"7:25", sequence:9 },
    { stopId:"R03B_10", stopName:"Maduravoyal Erikarai",     lat:13.0568, lng:80.1597, scheduledTime:"7:27", sequence:10 },
    { stopId:"R03B_11", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:11 },
  ],

  R04: [
    { stopId:"R04_01", stopName:"JJ Nagar Police Station", lat:13.0931, lng:80.1881, scheduledTime:"6:30", sequence:1 },
    { stopId:"R04_02", stopName:"HDFC Bank",               lat:13.0938, lng:80.1868, scheduledTime:"6:32", sequence:2 },
    { stopId:"R04_03", stopName:"IOB Bank",                lat:13.0951, lng:80.1851, scheduledTime:"6:35", sequence:3 },
    { stopId:"R04_04", stopName:"7H Bus Depot",            lat:13.0962, lng:80.1821, scheduledTime:"6:40", sequence:4 },
    { stopId:"R04_05", stopName:"Amutha School",           lat:13.0901, lng:80.1754, scheduledTime:"6:50", sequence:5 },
    { stopId:"R04_06", stopName:"D.R. Super Market",       lat:13.0888, lng:80.1738, scheduledTime:"6:52", sequence:6 },
    { stopId:"R04_07", stopName:"Nolambur",                lat:13.0894, lng:80.1725, scheduledTime:"6:55", sequence:7 },
    { stopId:"R04_08", stopName:"Meadows Apartment",       lat:13.0875, lng:80.1712, scheduledTime:"6:57", sequence:8 },
    { stopId:"R04_09", stopName:"MGR University",          lat:13.0781, lng:80.1604, scheduledTime:"7:00", sequence:9 },
    { stopId:"R04_10", stopName:"RIT Campus",              lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R05: [
    { stopId:"R05_01", stopName:"CIT Nagar",              lat:13.0461, lng:80.2438, scheduledTime:"6:10", sequence:1 },
    { stopId:"R05_02", stopName:"Aranganathan Subway",    lat:13.0498, lng:80.2401, scheduledTime:"6:12", sequence:2 },
    { stopId:"R05_03", stopName:"Srinivasa Theatre",      lat:13.0531, lng:80.2381, scheduledTime:"6:14", sequence:3 },
    { stopId:"R05_04", stopName:"Mettupalayam",           lat:13.0568, lng:80.2352, scheduledTime:"6:16", sequence:4 },
    { stopId:"R05_05", stopName:"Sangamam Hotel",         lat:13.0598, lng:80.2321, scheduledTime:"6:19", sequence:5 },
    { stopId:"R05_06", stopName:"Arya Gowda Road",        lat:13.0641, lng:80.2282, scheduledTime:"6:24", sequence:6 },
    { stopId:"R05_07", stopName:"Vivek",                  lat:13.0684, lng:80.2248, scheduledTime:"6:29", sequence:7 },
    { stopId:"R05_08", stopName:"Usman Road",             lat:13.0721, lng:80.2214, scheduledTime:"6:34", sequence:8 },
    { stopId:"R05_09", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:9 },
  ],

  R05A: [
    { stopId:"R05A_01", stopName:"Loyola College",                lat:13.0684, lng:80.2591, scheduledTime:"6:40", sequence:1 },
    { stopId:"R05A_02", stopName:"Choolaimedu",                   lat:13.0761, lng:80.2318, scheduledTime:"6:45", sequence:2 },
    { stopId:"R05A_03", stopName:"Metha Nagar",                   lat:13.0778, lng:80.2231, scheduledTime:"6:49", sequence:3 },
    { stopId:"R05A_04", stopName:"NSK Nagar",                     lat:13.0741, lng:80.2047, scheduledTime:"6:55", sequence:4 },
    { stopId:"R05A_05", stopName:"Arumbakkam (SBI Bank)",         lat:13.0762, lng:80.2128, scheduledTime:"7:00", sequence:5 },
    { stopId:"R05A_06", stopName:"MMDA Cholan Street",            lat:13.0778, lng:80.2084, scheduledTime:"7:05", sequence:6 },
    { stopId:"R05A_07", stopName:"MMDA Vallavan Hotel",           lat:13.0784, lng:80.2064, scheduledTime:"7:10", sequence:7 },
    { stopId:"R05A_08", stopName:"CMBT (Koyambedu)",              lat:13.0695, lng:80.1951, scheduledTime:"7:15", sequence:8 },
    { stopId:"R05A_09", stopName:"Rohini Theatre",                lat:13.0668, lng:80.1901, scheduledTime:"7:18", sequence:9 },
    { stopId:"R05A_10", stopName:"Nerkundram Vengaya Mandi",      lat:13.0641, lng:80.1741, scheduledTime:"7:22", sequence:10 },
    { stopId:"R05A_11", stopName:"Maduravoyal Erikarai",          lat:13.0568, lng:80.1597, scheduledTime:"7:25", sequence:11 },
    { stopId:"R05A_12", stopName:"RIT Campus",                    lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:12 },
  ],

  R06: [
    { stopId:"R06_01", stopName:"Chinmayanagar",              lat:13.0428, lng:80.2238, scheduledTime:"6:10", sequence:1 },
    { stopId:"R06_02", stopName:"Sai Nagar",                  lat:13.0441, lng:80.2224, scheduledTime:"6:12", sequence:2 },
    { stopId:"R06_03", stopName:"Natesan Nagar",              lat:13.0451, lng:80.2214, scheduledTime:"6:13", sequence:3 },
    { stopId:"R06_04", stopName:"Elango Nagar",               lat:13.0462, lng:80.2198, scheduledTime:"6:14", sequence:4 },
    { stopId:"R06_05", stopName:"Virugampakkam",              lat:13.0491, lng:80.2172, scheduledTime:"6:17", sequence:5 },
    { stopId:"R06_06", stopName:"KK Nagar",                   lat:13.0521, lng:80.2048, scheduledTime:"6:20", sequence:6 },
    { stopId:"R06_07", stopName:"KK Nagar ESI",               lat:13.0534, lng:80.2018, scheduledTime:"6:27", sequence:7 },
    { stopId:"R06_08", stopName:"Ashok Pillar",               lat:13.0548, lng:80.1981, scheduledTime:"6:32", sequence:8 },
    { stopId:"R06_09", stopName:"Kasi Theatre",               lat:13.0491, lng:80.1914, scheduledTime:"6:37", sequence:9 },
    { stopId:"R06_10", stopName:"Ekkatuthangal",              lat:13.0168, lng:80.1928, scheduledTime:"6:42", sequence:10 },
    { stopId:"R06_11", stopName:"Olympia",                    lat:13.0178, lng:80.1934, scheduledTime:"6:43", sequence:11 },
    { stopId:"R06_12", stopName:"Porur Saravana Stores",      lat:13.0321, lng:80.1564, scheduledTime:"6:55", sequence:12 },
    { stopId:"R06_13", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:13 },
  ],

  R07: [
    { stopId:"R07_01", stopName:"Mandaveli Bus Depot",         lat:13.0291, lng:80.2681, scheduledTime:"6:10", sequence:1 },
    { stopId:"R07_02", stopName:"Pattinapakkam",               lat:13.0234, lng:80.2714, scheduledTime:"6:15", sequence:2 },
    { stopId:"R07_03", stopName:"Kutchery Road",               lat:13.0268, lng:80.2668, scheduledTime:"6:20", sequence:3 },
    { stopId:"R07_04", stopName:"Luz Corner",                  lat:13.0294, lng:80.2641, scheduledTime:"6:25", sequence:4 },
    { stopId:"R07_05", stopName:"P.S. Sivasamy Road",          lat:13.0324, lng:80.2618, scheduledTime:"6:27", sequence:5 },
    { stopId:"R07_06", stopName:"SIET College",                lat:13.0368, lng:80.2554, scheduledTime:"6:32", sequence:6 },
    { stopId:"R07_07", stopName:"Nandanam Signal",             lat:13.0281, lng:80.2414, scheduledTime:"6:37", sequence:7 },
    { stopId:"R07_08", stopName:"Saidapet Veterinary Hospital",lat:13.0214, lng:80.2271, scheduledTime:"6:42", sequence:8 },
    { stopId:"R07_09", stopName:"Saidapet Bus Stop",           lat:13.0191, lng:80.2248, scheduledTime:"6:47", sequence:9 },
    { stopId:"R07_10", stopName:"Guindy",                      lat:13.0068, lng:80.2114, scheduledTime:"6:49", sequence:10 },
    { stopId:"R07_11", stopName:"Butt Road",                   lat:13.0111, lng:80.2084, scheduledTime:"6:55", sequence:11 },
    { stopId:"R07_12", stopName:"Chennai Trade Centre",        lat:13.0168, lng:80.1981, scheduledTime:"7:10", sequence:12 },
    { stopId:"R07_13", stopName:"Porur",                       lat:13.0321, lng:80.1564, scheduledTime:"7:15", sequence:13 },
    { stopId:"R07_14", stopName:"Ayyappanthangal",             lat:13.0261, lng:80.1441, scheduledTime:"7:18", sequence:14 },
    { stopId:"R07_15", stopName:"RIT Campus",                  lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:15 },
  ],

  R08: [
    { stopId:"R08_01", stopName:"Kovilampakkam",                     lat:12.9491, lng:80.2064, scheduledTime:"6:10", sequence:1 },
    { stopId:"R08_02", stopName:"Keelkattalai Bus Stop",             lat:12.9514, lng:80.2048, scheduledTime:"6:12", sequence:2 },
    { stopId:"R08_03", stopName:"Madipakkam UTI Bank",               lat:12.9568, lng:80.2024, scheduledTime:"6:15", sequence:3 },
    { stopId:"R08_04", stopName:"Madipakkam Koot Road Bus Stop",     lat:12.9581, lng:80.2018, scheduledTime:"6:16", sequence:4 },
    { stopId:"R08_05", stopName:"Ranga Theatre",                     lat:12.9621, lng:80.1994, scheduledTime:"6:18", sequence:5 },
    { stopId:"R08_06", stopName:"Nanganallur Chidambaram Stores",    lat:12.9641, lng:80.1978, scheduledTime:"6:20", sequence:6 },
    { stopId:"R08_07", stopName:"Nanganallur Saravana Hotel",        lat:12.9658, lng:80.1964, scheduledTime:"6:22", sequence:7 },
    { stopId:"R08_08", stopName:"Vanuvampet Church",                 lat:12.9694, lng:80.1948, scheduledTime:"6:25", sequence:8 },
    { stopId:"R08_09", stopName:"Surendhar Nagar Bus Stop",          lat:12.9714, lng:80.1934, scheduledTime:"6:27", sequence:9 },
    { stopId:"R08_10", stopName:"Jayalakshmi Theatre",               lat:12.9741, lng:80.1921, scheduledTime:"6:29", sequence:10 },
    { stopId:"R08_11", stopName:"Thillai Ganga Nagar Subway",        lat:12.9774, lng:80.1904, scheduledTime:"6:32", sequence:11 },
    { stopId:"R08_12", stopName:"Aazar Khana Bus Stop",              lat:12.9808, lng:80.1888, scheduledTime:"6:35", sequence:12 },
    { stopId:"R08_13", stopName:"Butt Road",                         lat:13.0111, lng:80.2084, scheduledTime:"6:37", sequence:13 },
    { stopId:"R08_14", stopName:"Ramavaram",                         lat:13.0218, lng:80.1851, scheduledTime:"6:39", sequence:14 },
    { stopId:"R08_15", stopName:"RIT Campus",                        lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:15 },
  ],

  R08A: [
    { stopId:"R08A_01", stopName:"Seasons",                   lat:12.9991, lng:80.2064, scheduledTime:"6:30", sequence:1 },
    { stopId:"R08A_02", stopName:"Kakkan Bridge",             lat:12.9984, lng:80.2028, scheduledTime:"6:33", sequence:2 },
    { stopId:"R08A_03", stopName:"Adambakkam Bus Depot",      lat:12.9968, lng:80.2014, scheduledTime:"6:35", sequence:3 },
    { stopId:"R08A_04", stopName:"St Thomas Mount",           lat:13.0018, lng:80.1984, scheduledTime:"6:38", sequence:4 },
    { stopId:"R08A_05", stopName:"Deepam Foods",              lat:13.0024, lng:80.1978, scheduledTime:"6:40", sequence:5 },
    { stopId:"R08A_06", stopName:"Maharaja Traders",          lat:13.0054, lng:80.1964, scheduledTime:"6:45", sequence:6 },
    { stopId:"R08A_07", stopName:"Vanuvampet Church",         lat:12.9694, lng:80.1948, scheduledTime:"6:50", sequence:7 },
    { stopId:"R08A_08", stopName:"Thillai Ganga Nagar Subway",lat:12.9774, lng:80.1904, scheduledTime:"6:55", sequence:8 },
    { stopId:"R08A_09", stopName:"Butt Road",                 lat:13.0111, lng:80.2084, scheduledTime:"7:00", sequence:9 },
    { stopId:"R08A_10", stopName:"Poonamallee",               lat:13.0461, lng:80.1164, scheduledTime:"7:35", sequence:10 },
    { stopId:"R08A_11", stopName:"RIT Campus",                lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:11 },
  ],

  R09: [
    { stopId:"R09_01", stopName:"Vyasarpadi",          lat:13.1101, lng:80.2614, scheduledTime:"6:00", sequence:1 },
    { stopId:"R09_02", stopName:"MKB Nagar",           lat:13.1068, lng:80.2588, scheduledTime:"6:05", sequence:2 },
    { stopId:"R09_03", stopName:"E.B. Stop",           lat:13.1041, lng:80.2571, scheduledTime:"6:08", sequence:3 },
    { stopId:"R09_04", stopName:"Kannadhasan Nagar",   lat:13.1021, lng:80.2558, scheduledTime:"6:10", sequence:4 },
    { stopId:"R09_05", stopName:"M.R. Nagar",          lat:13.0994, lng:80.2531, scheduledTime:"6:13", sequence:5 },
    { stopId:"R09_06", stopName:"Lakshmi Amman Nagar", lat:13.0921, lng:80.2414, scheduledTime:"6:22", sequence:6 },
    { stopId:"R09_07", stopName:"B.B. Road",           lat:13.0884, lng:80.2348, scheduledTime:"6:26", sequence:7 },
    { stopId:"R09_08", stopName:"Perambur Market",     lat:13.1038, lng:80.2488, scheduledTime:"6:34", sequence:8 },
    { stopId:"R09_09", stopName:"Agaram",              lat:13.1014, lng:80.2464, scheduledTime:"6:40", sequence:9 },
    { stopId:"R09_10", stopName:"Peravalur Road",      lat:13.0981, lng:80.2428, scheduledTime:"6:42", sequence:10 },
    { stopId:"R09_11", stopName:"RIT Campus",          lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:11 },
  ],

  R09A: [
    { stopId:"R09A_01", stopName:"BB Road",                    lat:13.0884, lng:80.2348, scheduledTime:"6:30", sequence:1 },
    { stopId:"R09A_02", stopName:"Perambur Bus Stop",          lat:13.1021, lng:80.2448, scheduledTime:"6:35", sequence:2 },
    { stopId:"R09A_03", stopName:"Perambur Railway Station",   lat:13.1041, lng:80.2481, scheduledTime:"6:39", sequence:3 },
    { stopId:"R09A_04", stopName:"Perambur Church",            lat:13.1048, lng:80.2491, scheduledTime:"6:41", sequence:4 },
    { stopId:"R09A_05", stopName:"Sembium Police Station",     lat:13.1054, lng:80.2498, scheduledTime:"6:43", sequence:5 },
    { stopId:"R09A_06", stopName:"Gandhi Salai",               lat:13.1061, lng:80.2508, scheduledTime:"6:45", sequence:6 },
    { stopId:"R09A_07", stopName:"Venus Mall",                 lat:13.1068, lng:80.2518, scheduledTime:"6:47", sequence:7 },
    { stopId:"R09A_08", stopName:"Retteri",                    lat:13.0981, lng:80.2278, scheduledTime:"6:50", sequence:8 },
    { stopId:"R09A_09", stopName:"Senthil Nagar",              lat:13.1008, lng:80.2241, scheduledTime:"6:55", sequence:9 },
    { stopId:"R09A_10", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R10: [
    { stopId:"R10_01", stopName:"Thachoor",                 lat:13.2314, lng:80.2681, scheduledTime:"5:50", sequence:1 },
    { stopId:"R10_02", stopName:"Panjetty",                 lat:13.2281, lng:80.2658, scheduledTime:"5:52", sequence:2 },
    { stopId:"R10_03", stopName:"Janappanchatram Bypass",   lat:13.2214, lng:80.2598, scheduledTime:"5:55", sequence:3 },
    { stopId:"R10_04", stopName:"Karanodai Bypass",         lat:13.2181, lng:80.2574, scheduledTime:"5:58", sequence:4 },
    { stopId:"R10_05", stopName:"Vijaya Nallur",            lat:13.2101, lng:80.2518, scheduledTime:"6:03", sequence:5 },
    { stopId:"R10_06", stopName:"Toll Gate",                lat:13.2068, lng:80.2494, scheduledTime:"6:05", sequence:6 },
    { stopId:"R10_07", stopName:"Padianallur",              lat:13.1994, lng:80.2441, scheduledTime:"6:07", sequence:7 },
    { stopId:"R10_08", stopName:"Red Hills (GRT)",          lat:13.1921, lng:80.2388, scheduledTime:"6:10", sequence:8 },
    { stopId:"R10_09", stopName:"Red Hills Market",         lat:13.1901, lng:80.2374, scheduledTime:"6:12", sequence:9 },
    { stopId:"R10_10", stopName:"Kavangarai",               lat:13.1868, lng:80.2348, scheduledTime:"6:15", sequence:10 },
    { stopId:"R10_11", stopName:"Puzhal Jail",              lat:13.1841, lng:80.2321, scheduledTime:"6:17", sequence:11 },
    { stopId:"R10_12", stopName:"Puzhal Camp",              lat:13.1818, lng:80.2301, scheduledTime:"6:20", sequence:12 },
    { stopId:"R10_13", stopName:"Velammal College",         lat:13.1784, lng:80.2274, scheduledTime:"6:25", sequence:13 },
    { stopId:"R10_14", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:14 },
  ],

  R11: [
    { stopId:"R11_01", stopName:"Chengalpattu Rattinakinaru", lat:12.6924, lng:79.9624, scheduledTime:"6:00", sequence:1 },
    { stopId:"R11_02", stopName:"New Bus Stand",              lat:12.6941, lng:79.9641, scheduledTime:"6:02", sequence:2 },
    { stopId:"R11_03", stopName:"Old Bus Stand",              lat:12.6958, lng:79.9658, scheduledTime:"6:04", sequence:3 },
    { stopId:"R11_04", stopName:"Chengalpattu Bypass",        lat:12.6991, lng:79.9681, scheduledTime:"6:07", sequence:4 },
    { stopId:"R11_05", stopName:"SP Kovil",                   lat:12.7214, lng:79.9748, scheduledTime:"6:18", sequence:5 },
    { stopId:"R11_06", stopName:"MM Nagar Samiyar Gate",      lat:12.7441, lng:79.9814, scheduledTime:"6:23", sequence:6 },
    { stopId:"R11_07", stopName:"MM Nagar Bus Stand",         lat:12.7468, lng:79.9831, scheduledTime:"6:28", sequence:7 },
    { stopId:"R11_08", stopName:"Kattankulathur",             lat:12.7914, lng:80.0021, scheduledTime:"6:30", sequence:8 },
    { stopId:"R11_09", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:9 },
  ],

  R11A: [
    { stopId:"R11A_01", stopName:"Guduvanchery",    lat:12.8434, lng:80.0588, scheduledTime:"6:30", sequence:1 },
    { stopId:"R11A_02", stopName:"Urapakkam",       lat:12.8514, lng:80.0614, scheduledTime:"6:35", sequence:2 },
    { stopId:"R11A_03", stopName:"Vandalur",        lat:12.8941, lng:80.0748, scheduledTime:"6:40", sequence:3 },
    { stopId:"R11A_04", stopName:"Perungalathur",   lat:12.9041, lng:80.0801, scheduledTime:"6:45", sequence:4 },
    { stopId:"R11A_05", stopName:"Vandalur Bridge", lat:12.9168, lng:80.0858, scheduledTime:"6:55", sequence:5 },
    { stopId:"R11A_06", stopName:"Mannivakkam",     lat:12.9348, lng:80.0928, scheduledTime:"7:05", sequence:6 },
    { stopId:"R11A_07", stopName:"RIT Campus",      lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:7 },
  ],

  R12: [
    { stopId:"R12_01", stopName:"Minjur Bus Stand",           lat:13.2584, lng:80.2598, scheduledTime:"5:45", sequence:1 },
    { stopId:"R12_02", stopName:"Minjur Railway Station",     lat:13.2591, lng:80.2614, scheduledTime:"5:50", sequence:2 },
    { stopId:"R12_03", stopName:"BDO Office",                 lat:13.2568, lng:80.2581, scheduledTime:"5:52", sequence:3 },
    { stopId:"R12_04", stopName:"Nandiyambakkam",             lat:13.2541, lng:80.2558, scheduledTime:"5:54", sequence:4 },
    { stopId:"R12_05", stopName:"Pattamandiri",               lat:13.2484, lng:80.2514, scheduledTime:"6:00", sequence:5 },
    { stopId:"R12_06", stopName:"Napalayam",                  lat:13.2448, lng:80.2488, scheduledTime:"6:05", sequence:6 },
    { stopId:"R12_07", stopName:"Manali Pudhu Nagar",         lat:13.1914, lng:80.2648, scheduledTime:"6:08", sequence:7 },
    { stopId:"R12_08", stopName:"Manali Market",              lat:13.1868, lng:80.2621, scheduledTime:"6:15", sequence:8 },
    { stopId:"R12_09", stopName:"MMDA 3rd Main Road",         lat:13.1548, lng:80.2568, scheduledTime:"6:18", sequence:9 },
    { stopId:"R12_10", stopName:"Mathur",                     lat:13.1468, lng:80.2524, scheduledTime:"6:22", sequence:10 },
    { stopId:"R12_11", stopName:"Veterinary Hospital",        lat:13.1414, lng:80.2488, scheduledTime:"6:25", sequence:11 },
    { stopId:"R12_12", stopName:"Madhavaram Milk Colony",     lat:13.1368, lng:80.2458, scheduledTime:"6:28", sequence:12 },
    { stopId:"R12_13", stopName:"Arul Nagar",                 lat:13.1341, lng:80.2441, scheduledTime:"6:30", sequence:13 },
    { stopId:"R12_14", stopName:"Thapalpetti",                lat:13.1318, lng:80.2424, scheduledTime:"6:32", sequence:14 },
    { stopId:"R12_15", stopName:"Moolakadai",                 lat:13.1264, lng:80.2384, scheduledTime:"6:38", sequence:15 },
    { stopId:"R12_16", stopName:"Kalpana Lamp",               lat:13.1214, lng:80.2348, scheduledTime:"6:45", sequence:16 },
    { stopId:"R12_17", stopName:"Madhavaram Roundana",        lat:13.1181, lng:80.2324, scheduledTime:"6:47", sequence:17 },
    { stopId:"R12_18", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:18 },
  ],

  R13: [
    { stopId:"R13_01", stopName:"Ganeshapuram",                    lat:13.1214, lng:80.2548, scheduledTime:"6:10", sequence:1 },
    { stopId:"R13_02", stopName:"G3 Police Station",               lat:13.1188, lng:80.2531, scheduledTime:"6:15", sequence:2 },
    { stopId:"R13_03", stopName:"Pattalam",                        lat:13.1154, lng:80.2508, scheduledTime:"6:18", sequence:3 },
    { stopId:"R13_04", stopName:"Otteri",                          lat:13.1128, lng:80.2491, scheduledTime:"6:20", sequence:4 },
    { stopId:"R13_05", stopName:"Podi Kadai",                      lat:13.1101, lng:80.2478, scheduledTime:"6:23", sequence:5 },
    { stopId:"R13_06", stopName:"T.B. Hospital",                   lat:13.1081, lng:80.2461, scheduledTime:"6:25", sequence:6 },
    { stopId:"R13_07", stopName:"Ayanavaram Signal",               lat:13.1048, lng:80.2441, scheduledTime:"6:27", sequence:7 },
    { stopId:"R13_08", stopName:"Sayyani",                         lat:13.1021, lng:80.2421, scheduledTime:"6:30", sequence:8 },
    { stopId:"R13_09", stopName:"Ayanavaram Noor Hotel",           lat:13.1001, lng:80.2404, scheduledTime:"6:33", sequence:9 },
    { stopId:"R13_10", stopName:"Joint Office",                    lat:13.0981, lng:80.2391, scheduledTime:"6:35", sequence:10 },
    { stopId:"R13_11", stopName:"Ayanavaram Railway Quarters",     lat:13.0961, lng:80.2378, scheduledTime:"6:37", sequence:11 },
    { stopId:"R13_12", stopName:"RIT Campus",                      lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:12 },
  ],

  R13A: [
    { stopId:"R13A_01", stopName:"ICF Signal",             lat:13.0868, lng:80.1928, scheduledTime:"6:45", sequence:1 },
    { stopId:"R13A_02", stopName:"Villivakkam Bus Stand",  lat:13.0901, lng:80.2048, scheduledTime:"6:50", sequence:2 },
    { stopId:"R13A_03", stopName:"Korattur Signal",        lat:13.0941, lng:80.2014, scheduledTime:"6:55", sequence:3 },
    { stopId:"R13A_04", stopName:"Nolambur Signal",        lat:13.0894, lng:80.1725, scheduledTime:"7:05", sequence:4 },
    { stopId:"R13A_05", stopName:"Vanagaram",              lat:13.0445, lng:80.1408, scheduledTime:"7:15", sequence:5 },
    { stopId:"R13A_06", stopName:"Velappanchavadi",        lat:13.0364, lng:80.1338, scheduledTime:"7:23", sequence:6 },
    { stopId:"R13A_07", stopName:"Poonamallee Bypass",     lat:13.0441, lng:80.1158, scheduledTime:"7:30", sequence:7 },
    { stopId:"R13A_08", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R14: [
    { stopId:"R14_01", stopName:"Sevapetai",                              lat:13.2548, lng:79.9024, scheduledTime:"6:25", sequence:1 },
    { stopId:"R14_02", stopName:"Kakkalur",                               lat:13.2368, lng:79.9114, scheduledTime:"6:30", sequence:2 },
    { stopId:"R14_03", stopName:"Poonga Nagar",                           lat:13.2281, lng:79.9168, scheduledTime:"6:35", sequence:3 },
    { stopId:"R14_04", stopName:"GRT",                                    lat:13.1941, lng:79.9318, scheduledTime:"6:50", sequence:4 },
    { stopId:"R14_05", stopName:"Manavalanagar Signal",                   lat:13.1768, lng:79.9414, scheduledTime:"6:55", sequence:5 },
    { stopId:"R14_06", stopName:"Manavalanagar Railway Station",          lat:13.1754, lng:79.9421, scheduledTime:"6:57", sequence:6 },
    { stopId:"R14_07", stopName:"Putlur",                                 lat:13.1541, lng:79.9548, scheduledTime:"7:10", sequence:7 },
    { stopId:"R14_08", stopName:"Aranvoyal",                              lat:13.1468, lng:79.9601, scheduledTime:"7:15", sequence:8 },
    { stopId:"R14_09", stopName:"Puthuchatram (India Japan Company)",     lat:13.1368, lng:79.9668, scheduledTime:"7:20", sequence:9 },
    { stopId:"R14_10", stopName:"RIT Campus",                             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R14A: [
    { stopId:"R14A_01", stopName:"Kakkalur Signal",  lat:13.2368, lng:79.9114, scheduledTime:"6:55", sequence:1 },
    { stopId:"R14A_02", stopName:"SBI Bank",         lat:13.2341, lng:79.9131, scheduledTime:"6:58", sequence:2 },
    { stopId:"R14A_03", stopName:"Vellavedu",        lat:13.1568, lng:80.0024, scheduledTime:"7:20", sequence:3 },
    { stopId:"R14A_04", stopName:"Thirumazhisai",    lat:13.1121, lng:80.0984, scheduledTime:"7:25", sequence:4 },
    { stopId:"R14A_05", stopName:"RIT Campus",       lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:5 },
  ],

  R15: [
    { stopId:"R15_01", stopName:"Ayyangarkulam",    lat:12.8481, lng:79.7048, scheduledTime:"6:00", sequence:1 },
    { stopId:"R15_02", stopName:"Housing Board",    lat:12.8501, lng:79.7084, scheduledTime:"6:05", sequence:2 },
    { stopId:"R15_03", stopName:"Collector Office", lat:12.8514, lng:79.7101, scheduledTime:"6:07", sequence:3 },
    { stopId:"R15_04", stopName:"Rangasamy Kulam",  lat:12.8568, lng:79.7148, scheduledTime:"6:15", sequence:4 },
    { stopId:"R15_05", stopName:"RIT Campus",       lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:5 },
  ],

  R15A: [
    { stopId:"R15A_01", stopName:"Orikkai",                      lat:12.8218, lng:79.7524, scheduledTime:"6:15", sequence:1 },
    { stopId:"R15A_02", stopName:"JJ Nagar",                     lat:12.8234, lng:79.7548, scheduledTime:"6:17", sequence:2 },
    { stopId:"R15A_03", stopName:"Keerai Mandapam",              lat:12.8251, lng:79.7568, scheduledTime:"6:20", sequence:3 },
    { stopId:"R15A_04", stopName:"Tollgate",                     lat:12.8268, lng:79.7584, scheduledTime:"6:23", sequence:4 },
    { stopId:"R15A_05", stopName:"Pachaiyappa's College",        lat:12.8314, lng:79.7624, scheduledTime:"6:30", sequence:5 },
    { stopId:"R15A_06", stopName:"Ayyampettai",                  lat:12.8341, lng:79.7641, scheduledTime:"6:32", sequence:6 },
    { stopId:"R15A_07", stopName:"Rajampettai",                  lat:12.8414, lng:79.7714, scheduledTime:"6:40", sequence:7 },
    { stopId:"R15A_08", stopName:"Walajabad",                    lat:12.8568, lng:79.8048, scheduledTime:"6:50", sequence:8 },
    { stopId:"R15A_09", stopName:"Natha Nallur",                 lat:12.8754, lng:79.8414, scheduledTime:"7:00", sequence:9 },
    { stopId:"R15A_10", stopName:"Panrutti",                     lat:12.8781, lng:79.8481, scheduledTime:"7:03", sequence:10 },
    { stopId:"R15A_11", stopName:"Oragadam",                     lat:12.8941, lng:79.9214, scheduledTime:"7:12", sequence:11 },
    { stopId:"R15A_12", stopName:"Arun Excello",                 lat:12.8968, lng:79.9268, scheduledTime:"7:15", sequence:12 },
    { stopId:"R15A_13", stopName:"Sriperumbudur High School",    lat:12.9714, lng:79.9484, scheduledTime:"7:20", sequence:13 },
    { stopId:"R15A_14", stopName:"Sriperumbudur Tollgate",       lat:12.9741, lng:79.9524, scheduledTime:"7:25", sequence:14 },
    { stopId:"R15A_15", stopName:"Irungattukottai Bus Stand",    lat:12.9914, lng:79.9714, scheduledTime:"7:30", sequence:15 },
    { stopId:"R15A_16", stopName:"RIT Campus",                   lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:16 },
  ],

  R16: [
    { stopId:"R16_01", stopName:"Prathana Theatre",           lat:12.9591, lng:80.2584, scheduledTime:"6:10", sequence:1 },
    { stopId:"R16_02", stopName:"Vetuvankeni",                lat:12.9541, lng:80.2548, scheduledTime:"6:15", sequence:2 },
    { stopId:"R16_03", stopName:"Thiruvanmiyur RTO Office",   lat:12.9831, lng:80.2574, scheduledTime:"6:20", sequence:3 },
    { stopId:"R16_04", stopName:"Adyar Depot",                lat:13.0068, lng:80.2534, scheduledTime:"6:29", sequence:4 },
    { stopId:"R16_05", stopName:"Madhya Kailash",             lat:13.0148, lng:80.2441, scheduledTime:"6:35", sequence:5 },
    { stopId:"R16_06", stopName:"Guindy",                     lat:13.0068, lng:80.2114, scheduledTime:"6:42", sequence:6 },
    { stopId:"R16_07", stopName:"Mugalivakkam",               lat:13.0208, lng:80.1781, scheduledTime:"6:55", sequence:7 },
    { stopId:"R16_08", stopName:"Karayanchavadi",             lat:13.0268, lng:80.1548, scheduledTime:"7:10", sequence:8 },
    { stopId:"R16_09", stopName:"Poonamallee Bus Stand",      lat:13.0461, lng:80.1164, scheduledTime:"7:15", sequence:9 },
    { stopId:"R16_10", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R16A: [
    { stopId:"R16A_01", stopName:"Butt Road",            lat:13.0111, lng:80.2084, scheduledTime:"6:45", sequence:1 },
    { stopId:"R16A_02", stopName:"Nandambakkam",         lat:13.0131, lng:80.2048, scheduledTime:"6:48", sequence:2 },
    { stopId:"R16A_03", stopName:"Ramapuram Signal",     lat:13.0194, lng:80.1964, scheduledTime:"6:52", sequence:3 },
    { stopId:"R16A_04", stopName:"DLF",                  lat:13.0208, lng:80.1928, scheduledTime:"6:55", sequence:4 },
    { stopId:"R16A_05", stopName:"Mugalivakkam",         lat:13.0208, lng:80.1781, scheduledTime:"7:00", sequence:5 },
    { stopId:"R16A_06", stopName:"Saravana Stores",      lat:13.0224, lng:80.1748, scheduledTime:"7:03", sequence:6 },
    { stopId:"R16A_07", stopName:"Poonamallee Depot",    lat:13.0461, lng:80.1164, scheduledTime:"7:25", sequence:7 },
    { stopId:"R16A_08", stopName:"RIT Campus",           lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R16B: [
    { stopId:"R16B_01", stopName:"Sholinganallur",       lat:12.9011, lng:80.2278, scheduledTime:"6:10", sequence:1 },
    { stopId:"R16B_02", stopName:"Karapakkam",           lat:12.9148, lng:80.2254, scheduledTime:"6:16", sequence:2 },
    { stopId:"R16B_03", stopName:"Karapakkam - TCS",     lat:12.9168, lng:80.2248, scheduledTime:"6:19", sequence:3 },
    { stopId:"R16B_04", stopName:"PTC (KFC)",            lat:12.9214, lng:80.2234, scheduledTime:"6:24", sequence:4 },
    { stopId:"R16B_05", stopName:"Mettukuppam",          lat:12.9241, lng:80.2224, scheduledTime:"6:26", sequence:5 },
    { stopId:"R16B_06", stopName:"Selaiyur",             lat:12.9491, lng:80.1381, scheduledTime:"6:56", sequence:6 },
    { stopId:"R16B_07", stopName:"MCC",                  lat:12.9514, lng:80.1371, scheduledTime:"6:59", sequence:7 },
    { stopId:"R16B_08", stopName:"Kulakarai Street",     lat:12.9541, lng:80.1354, scheduledTime:"7:05", sequence:8 },
    { stopId:"R16B_09", stopName:"Krishna Nagar",        lat:12.9554, lng:80.1344, scheduledTime:"7:07", sequence:9 },
    { stopId:"R16B_10", stopName:"Bharathi Nagar",       lat:12.9568, lng:80.1334, scheduledTime:"7:08", sequence:10 },
    { stopId:"R16B_11", stopName:"Madanapuram",          lat:12.9614, lng:80.1314, scheduledTime:"7:13", sequence:11 },
    { stopId:"R16B_12", stopName:"Nazarathpettai",       lat:13.0251, lng:80.1238, scheduledTime:"7:34", sequence:12 },
    { stopId:"R16B_13", stopName:"RIT Campus",           lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:13 },
  ],

  R17: [
    { stopId:"R17_01", stopName:"Valluvarkottam",         lat:13.0544, lng:80.2518, scheduledTime:"6:15", sequence:1 },
    { stopId:"R17_02", stopName:"Liberty",                lat:13.0514, lng:80.2484, scheduledTime:"6:20", sequence:2 },
    { stopId:"R17_03", stopName:"Power House",            lat:13.0484, lng:80.2448, scheduledTime:"6:25", sequence:3 },
    { stopId:"R17_04", stopName:"Lakshman Sruthi",        lat:13.0451, lng:80.2411, scheduledTime:"6:30", sequence:4 },
    { stopId:"R17_05", stopName:"Thai Sathya",            lat:13.0421, lng:80.2378, scheduledTime:"6:35", sequence:5 },
    { stopId:"R17_06", stopName:"Virugampakkam",          lat:13.0491, lng:80.2172, scheduledTime:"6:40", sequence:6 },
    { stopId:"R17_07", stopName:"Alwar Thirunagar",       lat:13.0468, lng:80.2148, scheduledTime:"6:42", sequence:7 },
    { stopId:"R17_08", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R17A: [
    { stopId:"R17A_01", stopName:"Valasaravakkam Shivan Koil", lat:13.0401, lng:80.1878, scheduledTime:"6:45", sequence:1 },
    { stopId:"R17A_02", stopName:"Valasaravakkam",             lat:13.0414, lng:80.1894, scheduledTime:"6:50", sequence:2 },
    { stopId:"R17A_03", stopName:"Saravana Bhavan Hotel",      lat:13.0428, lng:80.1911, scheduledTime:"6:53", sequence:3 },
    { stopId:"R17A_04", stopName:"Lakshmi Nagar",              lat:13.0441, lng:80.1924, scheduledTime:"6:55", sequence:4 },
    { stopId:"R17A_05", stopName:"Porur Bridge",               lat:13.0321, lng:80.1564, scheduledTime:"7:00", sequence:5 },
    { stopId:"R17A_06", stopName:"Iyyappanthangal",            lat:13.0261, lng:80.1441, scheduledTime:"7:05", sequence:6 },
    { stopId:"R17A_07", stopName:"Kattupakkam",                lat:13.0224, lng:80.1368, scheduledTime:"7:10", sequence:7 },
    { stopId:"R17A_08", stopName:"Kumanachavadi",              lat:13.0194, lng:80.1284, scheduledTime:"7:15", sequence:8 },
    { stopId:"R17A_09", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:9 },
  ],

  R18: [
    { stopId:"R18_01", stopName:"Pallikaranai Munsif Office", lat:12.9341, lng:80.2128, scheduledTime:"6:15", sequence:1 },
    { stopId:"R18_02", stopName:"Medavakkam Junction",        lat:12.9391, lng:80.2078, scheduledTime:"6:20", sequence:2 },
    { stopId:"R18_03", stopName:"Perumbakkam",                lat:12.9414, lng:80.2048, scheduledTime:"6:25", sequence:3 },
    { stopId:"R18_04", stopName:"Madambakkam",                lat:12.9454, lng:80.2014, scheduledTime:"6:30", sequence:4 },
    { stopId:"R18_05", stopName:"Selaiyur",                   lat:12.9491, lng:80.1381, scheduledTime:"6:35", sequence:5 },
    { stopId:"R18_06", stopName:"RIT Campus",                 lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:6 },
  ],

  R18A: [
    { stopId:"R18A_01", stopName:"Sembakkam",               lat:12.9204, lng:80.2054, scheduledTime:"6:25", sequence:1 },
    { stopId:"R18A_02", stopName:"Kamarajapuram",           lat:12.9241, lng:80.2034, scheduledTime:"6:30", sequence:2 },
    { stopId:"R18A_03", stopName:"Rajakilpakkam Signal",    lat:12.9264, lng:80.2018, scheduledTime:"6:32", sequence:3 },
    { stopId:"R18A_04", stopName:"Camp Road",               lat:12.9341, lng:80.1964, scheduledTime:"6:35", sequence:4 },
    { stopId:"R18A_05", stopName:"Tambaram Sanatorium",     lat:12.9214, lng:80.1148, scheduledTime:"6:50", sequence:5 },
    { stopId:"R18A_06", stopName:"Chrompet",                lat:12.9454, lng:80.1394, scheduledTime:"6:55", sequence:6 },
    { stopId:"R18A_07", stopName:"Thiruneermalai",          lat:12.9614, lng:80.1028, scheduledTime:"7:00", sequence:7 },
    { stopId:"R18A_08", stopName:"RIT Campus",              lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R18B: [
    { stopId:"R18B_01", stopName:"Kelambakkam - GH",            lat:12.7764, lng:80.2271, scheduledTime:"6:00", sequence:1 },
    { stopId:"R18B_02", stopName:"Pudupakkam",                  lat:12.7914, lng:80.2178, scheduledTime:"6:10", sequence:2 },
    { stopId:"R18B_03", stopName:"Mambakkam (Samathuvapuram)",  lat:12.8041, lng:80.2148, scheduledTime:"6:15", sequence:3 },
    { stopId:"R18B_04", stopName:"Mambakkam Kulam",             lat:12.8068, lng:80.2128, scheduledTime:"6:25", sequence:4 },
    { stopId:"R18B_05", stopName:"Ponmar",                      lat:12.8141, lng:80.2078, scheduledTime:"6:30", sequence:5 },
    { stopId:"R18B_06", stopName:"Sithalapakkam",               lat:12.8214, lng:80.2024, scheduledTime:"6:35", sequence:6 },
    { stopId:"R18B_07", stopName:"Private Parking",             lat:12.8914, lng:80.1281, scheduledTime:"6:45", sequence:7 },
    { stopId:"R18B_08", stopName:"Santhosapuram",               lat:12.8941, lng:80.1254, scheduledTime:"6:50", sequence:8 },
    { stopId:"R18B_09", stopName:"Kamarajapuram",               lat:12.9241, lng:80.2034, scheduledTime:"7:00", sequence:9 },
    { stopId:"R18B_10", stopName:"Kishkinta Kulam",             lat:12.9354, lng:80.0754, scheduledTime:"7:15", sequence:10 },
    { stopId:"R18B_11", stopName:"Old Perungalathur",           lat:12.9181, lng:80.0794, scheduledTime:"7:20", sequence:11 },
    { stopId:"R18B_12", stopName:"Mudichur Bypass",             lat:12.9128, lng:80.0771, scheduledTime:"7:25", sequence:12 },
    { stopId:"R18B_13", stopName:"RIT Campus",                  lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:13 },
  ],

  R19: [
    { stopId:"R19_01", stopName:"Poombukar",              lat:13.0648, lng:80.2694, scheduledTime:"6:10", sequence:1 },
    { stopId:"R19_02", stopName:"Ganga Cinema",           lat:13.0721, lng:80.2658, scheduledTime:"6:25", sequence:2 },
    { stopId:"R19_03", stopName:"Don Bosco",              lat:13.0741, lng:80.2641, scheduledTime:"6:28", sequence:3 },
    { stopId:"R19_04", stopName:"Poombukar (Second Stop)",lat:13.0648, lng:80.2694, scheduledTime:"6:30", sequence:4 },
    { stopId:"R19_05", stopName:"Korattur Bus Stop",      lat:13.0941, lng:80.2014, scheduledTime:"6:55", sequence:5 },
    { stopId:"R19_06", stopName:"Padi Britania",          lat:13.0961, lng:80.1994, scheduledTime:"6:58", sequence:6 },
    { stopId:"R19_07", stopName:"TVS Show Room",          lat:13.0994, lng:80.1954, scheduledTime:"7:10", sequence:7 },
    { stopId:"R19_08", stopName:"Ambattur",               lat:13.1021, lng:80.1614, scheduledTime:"7:12", sequence:8 },
    { stopId:"R19_09", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:9 },
  ],

  R19A: [
    { stopId:"R19A_01", stopName:"Vinayagapuram Bus Stand", lat:13.1481, lng:80.0948, scheduledTime:"6:45", sequence:1 },
    { stopId:"R19A_02", stopName:"Retteri RTO Office",      lat:13.0994, lng:80.2254, scheduledTime:"6:55", sequence:2 },
    { stopId:"R19A_03", stopName:"Retteri",                 lat:13.0981, lng:80.2278, scheduledTime:"6:58", sequence:3 },
    { stopId:"R19A_04", stopName:"Senthil Nagar",           lat:13.1008, lng:80.2241, scheduledTime:"7:00", sequence:4 },
    { stopId:"R19A_05", stopName:"RIT Campus",              lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:5 },
  ],

  R20: [
    { stopId:"R20_01", stopName:"Vepampattu Railway Station",       lat:13.1714, lng:79.9648, scheduledTime:"6:30", sequence:1 },
    { stopId:"R20_02", stopName:"Madha Kovil",                      lat:13.1701, lng:79.9658, scheduledTime:"6:32", sequence:2 },
    { stopId:"R20_03", stopName:"Eswar Nagar",                      lat:13.1694, lng:79.9664, scheduledTime:"6:33", sequence:3 },
    { stopId:"R20_04", stopName:"Indian Bank Thiruninravur",        lat:13.1681, lng:79.9674, scheduledTime:"6:35", sequence:4 },
    { stopId:"R20_05", stopName:"Thiruninravur Railway Station",    lat:13.1668, lng:79.9684, scheduledTime:"6:36", sequence:5 },
    { stopId:"R20_06", stopName:"Thiruninravur Bridge",             lat:13.1654, lng:79.9694, scheduledTime:"6:37", sequence:6 },
    { stopId:"R20_07", stopName:"Jaya College",                     lat:13.1534, lng:79.9731, scheduledTime:"6:39", sequence:7 },
    { stopId:"R20_08", stopName:"Nemilicherri Road",                lat:13.1514, lng:79.9741, scheduledTime:"6:40", sequence:8 },
    { stopId:"R20_09", stopName:"Pattabiram Gandhi Nagar",          lat:13.1494, lng:79.9751, scheduledTime:"6:41", sequence:9 },
    { stopId:"R20_10", stopName:"Pattabiram Vasantha Mandapam",     lat:13.1481, lng:79.9758, scheduledTime:"6:42", sequence:10 },
    { stopId:"R20_11", stopName:"Sekkadu Bus Stand",                lat:13.1414, lng:79.9791, scheduledTime:"6:45", sequence:11 },
    { stopId:"R20_12", stopName:"Avadi Ponnu Store",                lat:13.1148, lng:79.9864, scheduledTime:"6:50", sequence:12 },
    { stopId:"R20_13", stopName:"Avadi J.P. Garden",               lat:13.1128, lng:79.9874, scheduledTime:"6:52", sequence:13 },
    { stopId:"R20_14", stopName:"Govarthanagiri Bus Stand",         lat:13.1064, lng:79.9908, scheduledTime:"6:55", sequence:14 },
    { stopId:"R20_15", stopName:"Chennirkuppam",                    lat:13.0841, lng:80.0214, scheduledTime:"7:05", sequence:15 },
    { stopId:"R20_16", stopName:"RIT Campus",                       lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:16 },
  ],

  R21: [
    { stopId:"R21_01", stopName:"Ayappakkam Parking",        lat:13.0854, lng:80.1654, scheduledTime:"6:15", sequence:1 },
    { stopId:"R21_02", stopName:"Ayappakkam SBI ATM",        lat:13.0861, lng:80.1664, scheduledTime:"6:17", sequence:2 },
    { stopId:"R21_03", stopName:"Ayappakkam Petrol Bunk",    lat:13.0871, lng:80.1674, scheduledTime:"6:20", sequence:3 },
    { stopId:"R21_04", stopName:"ICF Church",                lat:13.0868, lng:80.1928, scheduledTime:"6:22", sequence:4 },
    { stopId:"R21_05", stopName:"Canara Bank",               lat:13.0881, lng:80.1954, scheduledTime:"6:27", sequence:5 },
    { stopId:"R21_06", stopName:"Singapore Shopping",        lat:13.0891, lng:80.1968, scheduledTime:"6:32", sequence:6 },
    { stopId:"R21_07", stopName:"Senneerkuppam",             lat:13.0648, lng:80.1564, scheduledTime:"7:05", sequence:7 },
    { stopId:"R21_08", stopName:"RIT Campus",                lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R22: [
    { stopId:"R22_01", stopName:"Thiruthani Bypass",              lat:13.1814, lng:79.6168, scheduledTime:"5:55", sequence:1 },
    { stopId:"R22_02", stopName:"Thiruvallur Bypass X Road",      lat:13.1441, lng:79.9048, scheduledTime:"6:00", sequence:2 },
    { stopId:"R22_03", stopName:"Nagalamman Nagar",               lat:13.1368, lng:79.9084, scheduledTime:"6:08", sequence:3 },
    { stopId:"R22_04", stopName:"Krishna Poly",                   lat:13.1348, lng:79.9094, scheduledTime:"6:10", sequence:4 },
    { stopId:"R22_05", stopName:"Jothi Nagar",                    lat:13.1328, lng:79.9108, scheduledTime:"6:12", sequence:5 },
    { stopId:"R22_06", stopName:"Indira Gandhi Nagar",            lat:13.1308, lng:79.9118, scheduledTime:"6:15", sequence:6 },
    { stopId:"R22_07", stopName:"Swalpet",                        lat:13.1294, lng:79.9128, scheduledTime:"6:16", sequence:7 },
    { stopId:"R22_08", stopName:"Government Hospital",            lat:13.1281, lng:79.9138, scheduledTime:"6:17", sequence:8 },
    { stopId:"R22_09", stopName:"Old Bus Stand",                  lat:13.1268, lng:79.9148, scheduledTime:"6:18", sequence:9 },
    { stopId:"R22_10", stopName:"Railway Station",                lat:13.1254, lng:79.9158, scheduledTime:"6:20", sequence:10 },
    { stopId:"R22_11", stopName:"New Bus Stand",                  lat:13.1241, lng:79.9168, scheduledTime:"6:22", sequence:11 },
    { stopId:"R22_12", stopName:"Navy Gate",                      lat:13.1214, lng:79.9188, scheduledTime:"6:30", sequence:12 },
    { stopId:"R22_13", stopName:"Venkatesapuram",                 lat:13.1201, lng:79.9198, scheduledTime:"6:31", sequence:13 },
    { stopId:"R22_14", stopName:"RIT Campus",                     lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:14 },
  ],

  R22A: [
    { stopId:"R22A_01", stopName:"SR Gate",                 lat:13.1041, lng:79.8968, scheduledTime:"6:30", sequence:1 },
    { stopId:"R22A_02", stopName:"Thakkolam Koot Road",     lat:13.0841, lng:79.8654, scheduledTime:"6:40", sequence:2 },
    { stopId:"R22A_03", stopName:"Thakkolam",               lat:13.0814, lng:79.8614, scheduledTime:"6:44", sequence:3 },
    { stopId:"R22A_04", stopName:"Marimangalam",            lat:13.0768, lng:79.8541, scheduledTime:"6:50", sequence:4 },
    { stopId:"R22A_05", stopName:"Narasimapuram",           lat:13.0714, lng:79.8468, scheduledTime:"6:55", sequence:5 },
    { stopId:"R22A_06", stopName:"Perambakkam",             lat:13.0614, lng:79.8318, scheduledTime:"7:05", sequence:6 },
    { stopId:"R22A_07", stopName:"Koovam Bus Stop",         lat:13.0561, lng:79.8248, scheduledTime:"7:08", sequence:7 },
    { stopId:"R22A_08", stopName:"RIT Campus",              lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R23: [
    { stopId:"R23_01", stopName:"Nathamuni Theatre",             lat:13.0868, lng:80.1984, scheduledTime:"6:35", sequence:1 },
    { stopId:"R23_02", stopName:"K4 Police Station",             lat:13.0881, lng:80.1994, scheduledTime:"6:40", sequence:2 },
    { stopId:"R23_03", stopName:"Labour Officers Quarters",      lat:13.0888, lng:80.2004, scheduledTime:"6:42", sequence:3 },
    { stopId:"R23_04", stopName:"Vijaya Maruthi (Nuts & Spices)",lat:13.0894, lng:80.2014, scheduledTime:"6:44", sequence:4 },
    { stopId:"R23_05", stopName:"Udayam Colony",                 lat:13.0901, lng:80.2024, scheduledTime:"6:46", sequence:5 },
    { stopId:"R23_06", stopName:"Kambar Colony",                 lat:13.0908, lng:80.2034, scheduledTime:"6:48", sequence:6 },
    { stopId:"R23_07", stopName:"Anna Nagar West Depot",         lat:13.0921, lng:80.2044, scheduledTime:"6:50", sequence:7 },
    { stopId:"R23_08", stopName:"Thirumangalam Bridge",          lat:13.0914, lng:80.2054, scheduledTime:"6:52", sequence:8 },
    { stopId:"R23_09", stopName:"Thirumangalam Waves",           lat:13.0818, lng:80.2068, scheduledTime:"6:56", sequence:9 },
    { stopId:"R23_10", stopName:"RIT Campus",                    lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R24: [
    { stopId:"R24_01", stopName:"Arcot Bus Stand",                       lat:12.9054, lng:79.3208, scheduledTime:"5:25", sequence:1 },
    { stopId:"R24_02", stopName:"Muthukadai",                            lat:12.9068, lng:79.3241, scheduledTime:"5:30", sequence:2 },
    { stopId:"R24_03", stopName:"VC Motor",                              lat:12.9081, lng:79.3268, scheduledTime:"5:33", sequence:3 },
    { stopId:"R24_04", stopName:"Walajapettai",                          lat:12.9094, lng:79.3298, scheduledTime:"5:35", sequence:4 },
    { stopId:"R24_05", stopName:"Arignar Anna Government College",       lat:12.9108, lng:79.3321, scheduledTime:"5:37", sequence:5 },
    { stopId:"R24_06", stopName:"Walajapettai Toll Gate",                lat:12.9124, lng:79.3348, scheduledTime:"5:40", sequence:6 },
    { stopId:"R24_07", stopName:"Kaveripakkam",                          lat:12.9341, lng:79.3648, scheduledTime:"5:45", sequence:7 },
    { stopId:"R24_08", stopName:"Perumpullipakkam",                      lat:12.9568, lng:79.4028, scheduledTime:"6:00", sequence:8 },
    { stopId:"R24_09", stopName:"Vinayagapuram (KPM)",                   lat:13.1481, lng:80.0948, scheduledTime:"6:20", sequence:9 },
    { stopId:"R24_10", stopName:"Olimugamathu Pettai (Gori)",            lat:13.1501, lng:80.0964, scheduledTime:"6:22", sequence:10 },
    { stopId:"R24_11", stopName:"Egambaranathar Koil",                   lat:13.1521, lng:80.0981, scheduledTime:"6:25", sequence:11 },
    { stopId:"R24_12", stopName:"Kachapeswarar Koil",                    lat:13.1541, lng:80.0998, scheduledTime:"6:28", sequence:12 },
    { stopId:"R24_13", stopName:"Pookadai Chatram",                      lat:13.1568, lng:80.1018, scheduledTime:"6:32", sequence:13 },
    { stopId:"R24_14", stopName:"Kammal Street",                         lat:13.1584, lng:80.1034, scheduledTime:"6:35", sequence:14 },
    { stopId:"R24_15", stopName:"Indra Nagar (KPM Railway Gate)",        lat:13.1601, lng:80.1051, scheduledTime:"6:37", sequence:15 },
    { stopId:"R24_16", stopName:"Ponnerikarai",                          lat:13.1618, lng:80.1068, scheduledTime:"6:40", sequence:16 },
    { stopId:"R24_17", stopName:"Santhavellore",                         lat:13.1281, lng:79.9138, scheduledTime:"7:05", sequence:17 },
    { stopId:"R24_18", stopName:"Sungawarchathram",                      lat:13.1254, lng:79.9158, scheduledTime:"7:10", sequence:18 },
    { stopId:"R24_19", stopName:"Vadamangalam",                          lat:13.1194, lng:79.9241, scheduledTime:"7:20", sequence:19 },
    { stopId:"R24_20", stopName:"RIT Campus",                            lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:20 },
  ],

  R25: [
    { stopId:"R25_01", stopName:"Kallikuppam",                          lat:13.1201, lng:80.1614, scheduledTime:"6:45", sequence:1 },
    { stopId:"R25_02", stopName:"Stedford Hospital",                    lat:13.1214, lng:80.1634, scheduledTime:"6:50", sequence:2 },
    { stopId:"R25_03", stopName:"Saraswathy Nagar Indian Oil Petrol Bunk", lat:13.1234, lng:80.1654, scheduledTime:"6:54", sequence:3 },
    { stopId:"R25_04", stopName:"Manigandapuram",                       lat:13.1248, lng:80.1668, scheduledTime:"6:56", sequence:4 },
    { stopId:"R25_05", stopName:"Thirumullaivoyal Junction",            lat:13.1261, lng:80.1681, scheduledTime:"6:58", sequence:5 },
    { stopId:"R25_06", stopName:"Vaishnavi Nagar",                      lat:13.1274, lng:80.1694, scheduledTime:"7:00", sequence:6 },
    { stopId:"R25_07", stopName:"Murugappa Polytechnic",                lat:13.1288, lng:80.1708, scheduledTime:"7:02", sequence:7 },
    { stopId:"R25_08", stopName:"RIT Campus",                           lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:8 },
  ],

  R25A: [
    { stopId:"R25A_01", stopName:"Pudur",                  lat:13.0814, lng:80.0454, scheduledTime:"6:45", sequence:1 },
    { stopId:"R25A_02", stopName:"Oragadam HP Pump",       lat:12.8941, lng:79.9214, scheduledTime:"6:47", sequence:2 },
    { stopId:"R25A_03", stopName:"PTR Mahal",              lat:13.0768, lng:80.0468, scheduledTime:"6:50", sequence:3 },
    { stopId:"R25A_04", stopName:"Ponnu Supermarket",      lat:13.0741, lng:80.0488, scheduledTime:"6:53", sequence:4 },
    { stopId:"R25A_05", stopName:"Govardhanagiri",         lat:13.1064, lng:79.9908, scheduledTime:"7:15", sequence:5 },
    { stopId:"R25A_06", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:6 },
  ],

  R26: [
    { stopId:"R26_01", stopName:"Andarkuppam",          lat:13.0214, lng:80.0914, scheduledTime:"6:35", sequence:1 },
    { stopId:"R26_02", stopName:"Kundrathur",           lat:13.0268, lng:80.0984, scheduledTime:"6:40", sequence:2 },
    { stopId:"R26_03", stopName:"Kundrathur Thandalam", lat:13.0281, lng:80.1014, scheduledTime:"6:43", sequence:3 },
    { stopId:"R26_04", stopName:"Kovur",                lat:13.0294, lng:80.1048, scheduledTime:"6:45", sequence:4 },
    { stopId:"R26_05", stopName:"Gerugambakkam",        lat:13.0308, lng:80.1078, scheduledTime:"6:50", sequence:5 },
    { stopId:"R26_06", stopName:"Bai Kadai",            lat:13.0321, lng:80.1108, scheduledTime:"6:53", sequence:6 },
    { stopId:"R26_07", stopName:"Mathanandapuram",      lat:13.0334, lng:80.1138, scheduledTime:"6:55", sequence:7 },
    { stopId:"R26_08", stopName:"Venkateswara Nagar",   lat:13.0348, lng:80.1168, scheduledTime:"6:58", sequence:8 },
    { stopId:"R26_09", stopName:"Porur",                lat:13.0321, lng:80.1564, scheduledTime:"7:05", sequence:9 },
    { stopId:"R26_10", stopName:"RIT Campus",           lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:10 },
  ],

  R27: [
    { stopId:"R27_01", stopName:"Ajeya Stadium",          lat:13.1148, lng:80.0714, scheduledTime:"6:25", sequence:1 },
    { stopId:"R27_02", stopName:"HVF",                    lat:13.1121, lng:80.0694, scheduledTime:"6:28", sequence:2 },
    { stopId:"R27_03", stopName:"CRP",                    lat:13.1094, lng:80.0668, scheduledTime:"6:32", sequence:3 },
    { stopId:"R27_04", stopName:"Mitnamalli",             lat:13.1068, lng:80.0648, scheduledTime:"6:35", sequence:4 },
    { stopId:"R27_05", stopName:"Muthapudupet",           lat:13.1041, lng:80.0624, scheduledTime:"6:40", sequence:5 },
    { stopId:"R27_06", stopName:"Sasthri Nagar",          lat:13.1014, lng:80.0601, scheduledTime:"6:45", sequence:6 },
    { stopId:"R27_07", stopName:"Avadi Checkpost",        lat:13.1148, lng:79.9864, scheduledTime:"6:55", sequence:7 },
    { stopId:"R27_08", stopName:"Rama Rathna Theatre",    lat:13.1068, lng:79.9894, scheduledTime:"7:06", sequence:8 },
    { stopId:"R27_09", stopName:"Avadi Mankoil",          lat:13.1048, lng:79.9904, scheduledTime:"7:10", sequence:9 },
    { stopId:"R27_10", stopName:"Vasantham Nagar",        lat:13.1028, lng:79.9914, scheduledTime:"7:12", sequence:10 },
    { stopId:"R27_11", stopName:"Kovarthanagiri",         lat:13.1008, lng:79.9924, scheduledTime:"7:14", sequence:11 },
    { stopId:"R27_12", stopName:"Kendra Vihar",           lat:13.0994, lng:79.9934, scheduledTime:"7:15", sequence:12 },
    { stopId:"R27_13", stopName:"Kaduveti",               lat:13.0981, lng:79.9944, scheduledTime:"7:17", sequence:13 },
    { stopId:"R27_14", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:14 },
  ],

  R27A: [
    { stopId:"R27A_01", stopName:"Kollumedu",                lat:13.1454, lng:80.0648, scheduledTime:"6:30", sequence:1 },
    { stopId:"R27A_02", stopName:"Vel Tech College",         lat:13.1314, lng:80.0734, scheduledTime:"6:40", sequence:2 },
    { stopId:"R27A_03", stopName:"Kovilpathagai",            lat:13.1268, lng:80.0768, scheduledTime:"6:45", sequence:3 },
    { stopId:"R27A_04", stopName:"Ajeya Stadium",            lat:13.1148, lng:80.0714, scheduledTime:"6:50", sequence:4 },
    { stopId:"R27A_05", stopName:"CRPF",                     lat:13.1108, lng:80.0684, scheduledTime:"6:55", sequence:5 },
    { stopId:"R27A_06", stopName:"Mittanemili",              lat:13.0568, lng:80.1318, scheduledTime:"7:00", sequence:6 },
    { stopId:"R27A_07", stopName:"Palavedu Service Road",    lat:13.0468, lng:80.1248, scheduledTime:"7:10", sequence:7 },
    { stopId:"R27A_08", stopName:"Nemilichery Tollgate",     lat:13.0394, lng:80.1178, scheduledTime:"7:15", sequence:8 },
    { stopId:"R27A_09", stopName:"Chithukadu Blue",          lat:13.0294, lng:80.1108, scheduledTime:"7:25", sequence:9 },
    { stopId:"R27A_10", stopName:"Panimalar Tollgate",       lat:13.0234, lng:80.1054, scheduledTime:"7:30", sequence:10 },
    { stopId:"R27A_11", stopName:"Chembarambakkam",          lat:13.0094, lng:80.0914, scheduledTime:"7:37", sequence:11 },
    { stopId:"R27A_12", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:12 },
  ],

  R28: [
    { stopId:"R28_01", stopName:"Agaram",                          lat:13.1014, lng:80.2464, scheduledTime:"6:20", sequence:1 },
    { stopId:"R28_02", stopName:"Periyar Nagar",                   lat:13.1024, lng:80.2474, scheduledTime:"6:22", sequence:2 },
    { stopId:"R28_03", stopName:"Thiruvalluvar Thirumanamandapam", lat:13.1034, lng:80.2484, scheduledTime:"6:24", sequence:3 },
    { stopId:"R28_04", stopName:"Perumal Koil",                    lat:13.1044, lng:80.2494, scheduledTime:"6:26", sequence:4 },
    { stopId:"R28_05", stopName:"Kamban Nagar",                    lat:13.1054, lng:80.2504, scheduledTime:"6:28", sequence:5 },
    { stopId:"R28_06", stopName:"E.B",                             lat:13.1064, lng:80.2514, scheduledTime:"6:30", sequence:6 },
    { stopId:"R28_07", stopName:"Shanmugam Mahal",                 lat:13.1074, lng:80.2524, scheduledTime:"6:32", sequence:7 },
    { stopId:"R28_08", stopName:"Senthil Nagar",                   lat:13.1008, lng:80.2241, scheduledTime:"6:35", sequence:8 },
    { stopId:"R28_09", stopName:"Thathankuppam",                   lat:13.0984, lng:80.2214, scheduledTime:"6:38", sequence:9 },
    { stopId:"R28_10", stopName:"Kalyan Jewellers",                lat:13.0941, lng:80.2168, scheduledTime:"6:45", sequence:10 },
    { stopId:"R28_11", stopName:"Collector Nagar",                 lat:13.0864, lng:80.1864, scheduledTime:"6:47", sequence:11 },
    { stopId:"R28_12", stopName:"Cheriyan Hospital",               lat:13.0871, lng:80.1874, scheduledTime:"6:48", sequence:12 },
    { stopId:"R28_13", stopName:"Golden Flats",                    lat:13.0871, lng:80.1878, scheduledTime:"6:50", sequence:13 },
    { stopId:"R28_14", stopName:"RIT Campus",                      lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:14 },
  ],

  R29: [
    { stopId:"R29_01", stopName:"Vijayanagar Bus Stand",     lat:12.9541, lng:80.1568, scheduledTime:"6:10", sequence:1 },
    { stopId:"R29_02", stopName:"Kaiveli",                   lat:12.9554, lng:80.1584, scheduledTime:"6:15", sequence:2 },
    { stopId:"R29_03", stopName:"Kamachi Hospital",          lat:12.9568, lng:80.1601, scheduledTime:"6:17", sequence:3 },
    { stopId:"R29_04", stopName:"Pallavaram Singapore Shopping", lat:12.9741, lng:80.1501, scheduledTime:"6:30", sequence:4 },
    { stopId:"R29_05", stopName:"Krishna Nagar",             lat:12.9554, lng:80.1344, scheduledTime:"6:33", sequence:5 },
    { stopId:"R29_06", stopName:"RIT Campus",                lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:6 },
  ],

  R29A: [
    { stopId:"R29A_01", stopName:"Pammal",                   lat:12.9868, lng:80.1348, scheduledTime:"6:35", sequence:1 },
    { stopId:"R29A_02", stopName:"Arunmathi Theatre",        lat:12.9881, lng:80.1364, scheduledTime:"6:37", sequence:2 },
    { stopId:"R29A_03", stopName:"Anagaputhur",              lat:12.9894, lng:80.1381, scheduledTime:"6:39", sequence:3 },
    { stopId:"R29A_04", stopName:"Manikandan Nagar",         lat:12.9908, lng:80.1394, scheduledTime:"6:41", sequence:4 },
    { stopId:"R29A_05", stopName:"Karima Nagar",             lat:12.9941, lng:80.1421, scheduledTime:"6:45", sequence:5 },
    { stopId:"R29A_06", stopName:"Kundrathur (Theradi)",     lat:13.0028, lng:80.1008, scheduledTime:"6:48", sequence:6 },
    { stopId:"R29A_07", stopName:"RIT Campus",               lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:7 },
  ],

  R29B: [
    { stopId:"R29B_01", stopName:"Sivanthangal",           lat:13.0081, lng:80.0814, scheduledTime:"7:05", sequence:1 },
    { stopId:"R29B_02", stopName:"Muthukumaran College",   lat:13.0128, lng:80.0868, scheduledTime:"7:10", sequence:2 },
    { stopId:"R29B_03", stopName:"Pattu Koot Road",        lat:13.0161, lng:80.0908, scheduledTime:"7:13", sequence:3 },
    { stopId:"R29B_04", stopName:"Mangadu",                lat:13.0194, lng:80.0948, scheduledTime:"7:15", sequence:4 },
    { stopId:"R29B_05", stopName:"Kankaiyamman Kovil",     lat:13.0248, lng:80.1008, scheduledTime:"7:20", sequence:5 },
    { stopId:"R29B_06", stopName:"MGR Nagar",              lat:13.0281, lng:80.1048, scheduledTime:"7:23", sequence:6 },
    { stopId:"R29B_07", stopName:"Kumananchavadi",         lat:13.0314, lng:80.1088, scheduledTime:"7:25", sequence:7 },
    { stopId:"R29B_08", stopName:"Aravind Hospital",       lat:13.0348, lng:80.1128, scheduledTime:"7:30", sequence:8 },
    { stopId:"R29B_09", stopName:"RIT Campus",             lat:12.8231, lng:80.0444, scheduledTime:"7:40", sequence:9 },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 1 — CORE MATH UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Haversine distance in kilometres between two GPS points.
 *
 * Formula:
 *   a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
 *   c = 2·atan2(√a, √(1−a))
 *   d = R·c   where R = 6371 km
 *
 * Accuracy: ±0.5% (flat-earth error irrelevant at bus-route scales).
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) *
               Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Route distance (km) from the bus's current position to a target stop
 * index by summing actual road segments along the stop sequence.
 *
 * Why segment-sum beats straight-line:
 *   Straight-line grossly underestimates distance when roads curve.
 *   Segment-sum is a good proxy for road distance without needing a
 *   full road network graph.
 */
function routeDistanceToStop(busLat, busLng, stops, fromIdx, targetIdx) {
  if (targetIdx <= fromIdx) return 0;
  // Leg 0: bus position → next waypoint (fromIdx stop)
  let total = haversine(busLat, busLng, stops[fromIdx].lat, stops[fromIdx].lng);
  // Remaining legs: stop-to-stop
  for (let i = fromIdx; i < targetIdx; i++) {
    total += haversine(stops[i].lat, stops[i].lng, stops[i + 1].lat, stops[i + 1].lng);
  }
  return total;
}

/**
 * Parse "H:MM" or "HH:MM" scheduled time string into minutes-since-midnight.
 */
function parseSched(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Current time in minutes since midnight (local server time).
 */
function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 2 — KALMAN FILTER FOR GPS SMOOTHING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 1-D Kalman filter applied independently to latitude and longitude.
 *
 * State:  x̂ (estimated position)
 * Gain:   K = P / (P + R)
 * Update: x̂ = x̂ + K·(z - x̂)
 *         P  = (1 - K)·P + Q
 *
 * Parameters:
 *   Q (process noise) – how much the true position can change between pings.
 *      Low Q = smoother but slower to track rapid direction changes.
 *   R (measurement noise) – GPS uncertainty variance (≈ (50m)² / (111km/deg)²).
 *
 * Each vehicle carries its own Kalman state so filters are independent.
 */
function kalmanUpdate(state, measurement) {
  // Prediction step: P grows by process noise each tick
  const Ppred = state.P + T.KALMAN_Q;

  // Kalman gain: how much to trust the measurement vs the model
  const K = Ppred / (Ppred + T.KALMAN_R);

  // Update estimate
  const xNew = state.x + K * (measurement - state.x);

  // Update error covariance
  const PNew = (1 - K) * Ppred;

  return { x: xNew, P: PNew };
}

/**
 * Apply Kalman filter to a new GPS ping.
 * Initialises the filter state on first call for this vehicle.
 * Returns { lat, lng } — the smoothed position.
 */
function applyKalman(vehicle, rawLat, rawLng) {
  // Initialise Kalman state if missing
  if (!vehicle.kalman) {
    vehicle.kalman = {
      lat: { x: rawLat, P: T.KALMAN_R },
      lng: { x: rawLng, P: T.KALMAN_R },
    };
    return { lat: rawLat, lng: rawLng };
  }

  vehicle.kalman.lat = kalmanUpdate(vehicle.kalman.lat, rawLat);
  vehicle.kalman.lng = kalmanUpdate(vehicle.kalman.lng, rawLng);

  return {
    lat: vehicle.kalman.lat.x,
    lng: vehicle.kalman.lng.x,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 3 — SPEED SMOOTHING (EWMA + VARIANCE CONFIDENCE)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Exponential Weighted Moving Average (EWMA) speed update.
 *
 * EWMA: S_t = α·x_t + (1-α)·S_{t-1}
 *
 * Advantages over simple moving average:
 *   ✔ More responsive to recent speed changes (α > 0.2 → fast city driving)
 *   ✔ No fixed window boundary artifacts
 *   ✔ Single float to store (not full history)
 *
 * We also store a ring buffer (speedHistory) for variance-based confidence.
 */
function updateEwmaSpeed(vehicle, newSpeedKmh) {
  const prev = vehicle.ewmaSpeed !== undefined ? vehicle.ewmaSpeed : newSpeedKmh;
  vehicle.ewmaSpeed = T.EWMA_ALPHA * newSpeedKmh + (1 - T.EWMA_ALPHA) * prev;

  const hist = vehicle.speedHistory || [];
  vehicle.speedHistory = [...hist.slice(-(T.SPEED_HISTORY_LEN - 1)), newSpeedKmh];
  return vehicle.ewmaSpeed;
}

/**
 * Return the best available speed estimate for this vehicle.
 * Falls back to per-segment historical average, then city fallback.
 */
function bestSpeed(vehicle, vehicleId, segIdx) {
  const ewma = vehicle.ewmaSpeed;
  if (ewma && ewma > T.STOPPED_KMH) return ewma;

  // Try historical segment average
  const key = `${vehicleId}:${segIdx}`;
  const hist = segmentSpeedDB[key];
  if (hist && hist.length >= 3) {
    const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
    if (avg > T.STOPPED_KMH) return avg;
  }

  return T.FALLBACK_SPEED_KMH;
}

/**
 * Confidence score [0–1] for ETA.
 * Low when: bus is stopped, speed is volatile, or location is stale.
 */
function etaConfidence(vehicle) {
  const hist = vehicle.speedHistory || [];
  if (hist.length < 3) return 0.5;

  const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
  const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1; // coefficient of variation

  const ageSec = (Date.now() - (vehicle.updatedAt || 0)) / 1000;
  const stalePenalty = Math.min(ageSec / 120, 0.5);   // 0→0.5 over 2 min

  const isStopped = (vehicle.ewmaSpeed || 0) < T.STOPPED_KMH;
  const stoppedPenalty = isStopped ? 0.3 : 0;

  return Math.max(0, Math.min(1, 1 - cv * 0.4 - stalePenalty - stoppedPenalty));
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 4 — GPS OUTLIER FILTER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Hard outlier rejection: if the raw GPS jump is physically impossible
 * (> 500 m in < 5 s for a bus), discard the ping entirely.
 *
 * This handles:
 *   • GPS satellite switching glitches
 *   • Network-assisted GPS "snap to road" errors
 *   • Bad NMEA sentences from the device
 */
function isGpsOutlier(prev, rawLat, rawLng, now) {
  if (!prev) return false;
  const elapsed = now - prev.updatedAt;
  if (elapsed >= T.GPS_NOISE_TIME_MS) return false;
  const distKm = haversine(prev.lat, prev.lng, rawLat, rawLng);
  return distKm > T.GPS_NOISE_KM;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 5 — STOP CROSSING DETECTION (PROJECTION METHOD)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determine if the bus has "crossed" a stop using perpendicular projection.
 *
 * Concept:
 *   Draw the segment from stop[i] → stop[i+1].
 *   Project the bus position onto that line.
 *   If the projection extends BEYOND stop[i] by > PASSED_PROJ_M (50 m),
 *   the bus has crossed that stop.
 *
 * This is far more accurate than a simple radius check for dense stops
 * (stops < 200 m apart) where radius check alone gives false positives.
 *
 *           S_i ──────────────────── S_{i+1}
 *                     ^
 *                     |  projected point
 *                     |
 *                   [Bus] ← if projection overshoot > 50 m → "passed"
 *
 * @returns {number} signed projection distance in km along the segment
 *   positive = bus is past stop[stopIdx] toward stop[stopIdx+1]
 *   negative = bus hasn't yet reached stop[stopIdx]
 */
function projectionAlongSegment(busLat, busLng, stopA, stopB) {
  // Flat-earth vectors (fine for <10 km distances)
  const KM_PER_DEG_LAT = 111.32;
  const KM_PER_DEG_LNG = 111.32 * Math.cos((stopA.lat + stopB.lat) / 2 * Math.PI / 180);

  const ax = (stopB.lng - stopA.lng) * KM_PER_DEG_LNG;
  const ay = (stopB.lat - stopA.lat) * KM_PER_DEG_LAT;
  const segLen = Math.sqrt(ax * ax + ay * ay);
  if (segLen === 0) return 0;

  const bx = (busLng - stopA.lng) * KM_PER_DEG_LNG;
  const by = (busLat - stopA.lat) * KM_PER_DEG_LAT;

  // Dot product gives signed scalar projection
  return (bx * ax + by * ay) / segLen;
}

/**
 * Returns true ONLY if the bus has genuinely passed stopIdx along the route.
 *
 * Three-gate system (ALL gates must agree):
 *
 *   Gate 1 – PROXIMITY GUARD (most important fix):
 *     The bus must have been seen within PASS_PROXIMITY_KM (100 m) of this stop
 *     at some point. If it has never been close, it cannot be "passed".
 *     This is stored in vehicle.stopProximityReached[stopIdx].
 *
 *   Gate 2 – PROJECTION OVERSHOOT:
 *     The perpendicular projection of the bus onto the segment stopA→stopB
 *     must extend at least PASSED_PROJ_M (50 m) past stopA.
 *     A negative or small projection means the bus is still before the stop.
 *
 *   Gate 3 – DISTANCE INCREASING (departure confirmation):
 *     The bus must now be farther from stopA than it was at closest approach.
 *     This is tracked via vehicle.stopClosestDist[stopIdx].
 *     We require the distance to have grown by at least PASS_DEPARTURE_M.
 *
 * This replaces the old "closer to next stop" heuristic (Method B) which
 * fired incorrectly at journey start because of geometry coincidences.
 *
 * @param {object} vehicle  – live vehicle state (mutated to track closest dist)
 * @param {number} busLat
 * @param {number} busLng
 * @param {Array}  stops
 * @param {number} stopIdx  – index of the stop to test
 * @returns {boolean}
 */
function hasCrossedStop(vehicle, busLat, busLng, stops, stopIdx) {
  if (stopIdx >= stops.length - 1) return false;

  const stopA = stops[stopIdx];
  const stopB = stops[stopIdx + 1];
  const dToA  = haversine(busLat, busLng, stopA.lat, stopA.lng);

  // ── Maintain closest-approach tracker ──────────────────────────────────────
  if (!vehicle.stopClosestDist)   vehicle.stopClosestDist   = {};
  if (!vehicle.stopProximityReached) vehicle.stopProximityReached = {};

  const prevClosest = vehicle.stopClosestDist[stopIdx];
  if (prevClosest === undefined || dToA < prevClosest) {
    vehicle.stopClosestDist[stopIdx] = dToA;
  }
  const closestEver = vehicle.stopClosestDist[stopIdx];

  // Mark that we have been near this stop (100 m threshold)
  if (dToA <= T.PASS_PROXIMITY_KM) {
    vehicle.stopProximityReached[stopIdx] = true;
  }

  // ── Gate 1: proximity guard — must have been within 100 m ──────────────────
  if (!vehicle.stopProximityReached[stopIdx]) return false;

  // ── Gate 2: projection overshoot ≥ PASSED_PROJ_M along segment ─────────────
  const proj = projectionAlongSegment(busLat, busLng, stopA, stopB);
  if (proj <= T.PASSED_PROJ_M / 1000) return false;

  // ── Gate 3: distance is increasing (bus is moving away after closest point) ─
  const departure = dToA - closestEver;
  if (departure < T.PASS_DEPARTURE_KM) return false;

  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 6 — STOP INDEX ENGINE (FORWARD-ONLY RATCHET)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find the effective "current" stop index.
 *
 * Algorithm (2-pass):
 *   Pass 1: Scan up to 5 stops ahead (tightened from 10 to reduce over-jumping)
 *           and find the nearest one by Haversine.
 *           Never move more than 5 stops ahead in a single update.
 *
 *   Pass 2: Projection crossing — advance ONLY if ALL three gates in
 *           hasCrossedStop() are satisfied (proximity seen + projection
 *           overshoot + distance increasing).
 *           A maximum of ONE stop advance per call prevents cascade errors.
 *
 * REMOVED: the old "proximity snap" Pass 2 that jumped the index forward
 * whenever the bus was within 150 m of a further stop — this was a major
 * source of false advances at journey start.
 *
 * Guarantees:
 *   • Index never decreases (forward-only ratchet)
 *   • Won't skip more than 5 stops at once (prevents GPS glitch runaway)
 *   • A stop can only be left behind after the bus was genuinely near it
 */
function findCurrentStopIndex(vehicle, busLat, busLng, stops, fromIdx = 0) {
  const searchStart = Math.max(0, fromIdx);
  const searchEnd   = Math.min(stops.length - 1, fromIdx + 5);  // tightened window

  let bestIdx  = fromIdx;
  let bestDist = haversine(busLat, busLng, stops[fromIdx].lat, stops[fromIdx].lng);

  // Pass 1: nearest stop by distance within bounded lookahead
  for (let i = searchStart + 1; i <= searchEnd; i++) {
    const d = haversine(busLat, busLng, stops[i].lat, stops[i].lng);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  // Pass 2: projection crossing — at most ONE step forward per call
  // (no while loop — prevents cascade advancing on ambiguous geometry)
  if (bestIdx < stops.length - 1 && hasCrossedStop(vehicle, busLat, busLng, stops, bestIdx)) {
    bestIdx++;
    bestDist = haversine(busLat, busLng, stops[bestIdx].lat, stops[bestIdx].lng);
  }

  return { nearestIdx: bestIdx, distToNearest: bestDist };
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 7 — STOP STATUS CLASSIFIER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Status vocabulary (matches requirement spec exactly):
 *   "passed"   → bus already crossed this stop (index < effectiveIdx)
 *                *** ONLY if bus was ever within PASS_PROXIMITY_KM of that stop ***
 *   "at_stop"  → within 50 m AND speed < 5 km/h (bus is boarding/alighting)
 *   "arriving" → within 100–200 m of this stop (bus is approaching)
 *   "upcoming" → not yet reached within 200 m
 *   "next"     → the immediately next stop beyond effectiveIdx (> 200 m away)
 *
 * CRITICAL FIX: A stop is never "passed" unless vehicle.stopProximityReached[idx]
 * is true.  This prevents the false-passed bug at journey start.
 */
function getStopStatus(idx, effectiveIdx, distToNearest, etaMin, busLat, busLng, stop, vehicle, busSpeedKmh) {
  const distToThis = haversine(busLat, busLng, stop.lat, stop.lng);

  // ── At-stop: within 50 m AND bus is slow/stopped ───────────────────────────
  if (distToThis <= T.ARRIVED_RADIUS_KM && (busSpeedKmh || 0) < 5) return "at_stop";

  // ── Passed: only if index is behind AND bus was genuinely near this stop ────
  if (idx < effectiveIdx) {
    const proximityConfirmed = vehicle?.stopProximityReached?.[idx] === true;
    return proximityConfirmed ? "passed" : "upcoming";
  }

  // ── Current stop (effectiveIdx) ─────────────────────────────────────────────
  if (idx === effectiveIdx) {
    if (distToThis <= T.ARRIVING_RADIUS_KM) return "arriving";   // 150 m
    return "next";
  }

  // ── Stops beyond effectiveIdx ───────────────────────────────────────────────
  if (distToThis <= T.ARRIVING_RADIUS_KM) return "arriving";     // within 200 m (uses ARRIVING 150m threshold)
  return "upcoming";
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 8 — DIRECTION AWARENESS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Dot-product heading check.
 * Returns true if the bus heading vector points broadly TOWARD the stop
 * (within a 214° arc, i.e. dot > -0.3).
 *
 * Uses heading (degrees from North, clockwise) from the GPS device.
 * Falls back to true (no warning) when heading is not reported.
 */
function isMovingTowardStop(busLat, busLng, headingDeg, stopLat, stopLng) {
  if (!headingDeg) return true;

  const hRad = headingDeg * Math.PI / 180;
  const hx   = Math.sin(hRad);
  const hy   = Math.cos(hRad);

  const dx  = stopLng - busLng;
  const dy  = stopLat - busLat;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) return true;

  const dot = (hx * dx + hy * dy) / mag;
  return dot > -0.3;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 9 — HYBRID ETA CALCULATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute ETA in minutes from bus to stop[targetIdx] along the route.
 *
 * Hybrid formula:
 *   liveETA    = routeDistance / smoothedSpeed
 *   schedETA   = scheduledMinutes - currentMinutes     (from timetable)
 *   hybridETA  = (1 - W)·liveETA + W·schedETA
 *
 * Where W = SCHED_BLEND_WEIGHT (0.20).
 *
 * This prevents pure live-speed ETAs from fluctuating too wildly while
 * maintaining real-time responsiveness. Schedule weight is low (20%)
 * so a severely delayed bus still shows the correct live ETA rather than
 * pretending it's on time.
 *
 * Traffic-jam penalty:
 *   If the bus has been stationary for > 60 s, we know it's stuck.
 *   We add a penalty derived from the ratio of FALLBACK_SPEED to actual
 *   current speed, capped at 10 min extra per stop.
 *
 * Dwell time:
 *   Each stop adds DWELL_TIME_SEC / 60 min to account for passenger boarding.
 *   The current stop doesn't add dwell (bus may have already stopped).
 */
function hybridEtaMinutes(busLat, busLng, stops, fromIdx, targetIdx, vehicle, vehicleId) {
  if (targetIdx <= fromIdx) return 0;

  const distKm = routeDistanceToStop(busLat, busLng, stops, fromIdx, targetIdx);
  const speed  = bestSpeed(vehicle, vehicleId, fromIdx);

  // Live ETA
  const liveETA = (distKm / speed) * 60;

  // Schedule ETA (only if we have scheduled times for this stop)
  const targetSched = parseSched(stops[targetIdx].scheduledTime);
  let hybridETA     = liveETA;

  if (targetSched !== null) {
    const now      = nowMinutes();
    const schedETA = targetSched - now;  // negative → already past scheduled time

    // Clamp schedule correction — don't let a very late bus look early
    const clampedSched = Math.max(0, Math.min(liveETA + T.MAX_DELAY_MIN, schedETA));

    // Only blend if schedule ETA is plausible (within 30 min of live)
    if (Math.abs(clampedSched - liveETA) < T.MAX_DELAY_MIN) {
      hybridETA = (1 - T.SCHED_BLEND_WEIGHT) * liveETA + T.SCHED_BLEND_WEIGHT * clampedSched;
    }
  }

  // Dwell time: add 15 s per intermediate stop (not the final target or current)
  const intermStops  = Math.max(0, targetIdx - fromIdx - 1);
  const dwellMinutes = intermStops * (T.DWELL_TIME_SEC / 60);
  hybridETA += dwellMinutes;

  // Traffic-jam penalty: bus has been stationary for a long time
  const stationaryMs = vehicle.stationaryStartMs
    ? Date.now() - vehicle.stationaryStartMs
    : 0;
  if (stationaryMs > T.TRAFFIC_STOP_MS && speed > 0) {
    // Extra time proportional to how much the delay has exceeded 60 s
    const extraMin = Math.min((stationaryMs - T.TRAFFIC_STOP_MS) / 60_000, 10);
    hybridETA += extraMin;
  }

  return Math.max(0, hybridETA);
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 10 — SEGMENT SPEED HISTORY RECORDER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Record the speed observed on a particular route segment.
 * Used to improve ETA for future trips on the same segments.
 */
function recordSegmentSpeed(vehicleId, segIdx, speedKmh) {
  if (speedKmh < T.STOPPED_KMH) return;  // don't record stopped speeds
  const key  = `${vehicleId}:${segIdx}`;
  const hist = segmentSpeedDB[key] || [];
  segmentSpeedDB[key] = [...hist.slice(-(T.SEG_HISTORY_LEN - 1)), speedKmh];
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 11 — ETA CACHE
// ═════════════════════════════════════════════════════════════════════════════

function shouldRecomputeEta(vehicleId, currentSpeed, currentLat, currentLng) {
  const c = etaCache[vehicleId];
  if (!c) return true;
  if (Math.abs(currentSpeed - c.speedAtCompute) > T.ETA_CACHE_SPEED_D)    return true;
  if (haversine(currentLat, currentLng, c.lat, c.lng) > T.ETA_CACHE_DIST_D) return true;
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SECTION 12 — DESTINATION DETECTION & ROUTE RESET
// ═════════════════════════════════════════════════════════════════════════════

function checkAndHandleDestination(vehicle, newLat, newLng) {
  const distToCampus = haversine(newLat, newLng, RIT_CAMPUS.lat, RIT_CAMPUS.lng);

  if (!vehicle.reachedDestination && distToCampus <= T.DEST_RADIUS_KM) {
    console.log(`[DEST] 🎯 ${vehicle.vehicleId} reached RIT Campus (${(distToCampus * 1000).toFixed(0)}m) — resetting route`);
    vehicle.reachedDestination    = true;
    vehicle.destinationReachedAt  = Date.now();
    vehicle.lastStopIdx           = 0;
    vehicle.speedHistory          = [];
    vehicle.ewmaSpeed             = undefined;
    vehicle.kalman                = undefined;
    vehicle.path                  = [];
    vehicle.stationaryStartMs     = null;
    vehicle.delayMinutes          = 0;
    vehicle.stopClosestDist       = {};   // reset proximity trackers for new trip
    vehicle.stopProximityReached  = {};   // reset proximity flags for new trip
    if (etaCache[vehicle.vehicleId]) delete etaCache[vehicle.vehicleId];
    return true;
  }

  if (vehicle.reachedDestination && distToCampus > 0.5) {
    console.log(`[DEST] 🔄 ${vehicle.vehicleId} departed campus — new trip starting`);
    vehicle.reachedDestination   = false;
    vehicle.destinationReachedAt = null;
  }

  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  EXPRESS ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /update-location ──────────────────────────────────────────────────────
// Driver app / GPS device pushes location updates here every 3–5 seconds.
//
// Body: { vehicleId, lat, lng, speed?, heading? }
//   speed  – reported by device in m/s or km/h (auto-detected)
//   heading – degrees from North, 0-360 (optional)
app.post("/update-location", (req, res) => {
  const { vehicleId, lat, lng, speed, heading } = req.body;
  if (!vehicleId || lat === undefined || lng === undefined)
    return res.status(400).json({ success: false, error: "vehicleId, lat, lng required." });

  const now    = Date.now();
  const rawLat = parseFloat(lat);
  const rawLng = parseFloat(lng);
  const prev   = locationStore[vehicleId];

  // ── STEP 1: Hard GPS outlier rejection ─────────────────────────────────────
  if (isGpsOutlier(prev, rawLat, rawLng, now)) {
    console.log(`[GPS] ⚠️  ${vehicleId} GPS outlier ignored (${
      prev ? (haversine(prev.lat, prev.lng, rawLat, rawLng) * 1000).toFixed(0) + 'm in ' +
             ((now - prev.updatedAt) / 1000).toFixed(1) + 's' : 'no prev'
    })`);
    return res.json({ success: true, status: prev?.status, speed: prev?.speed, filtered: true });
  }

  // ── STEP 2: Movement throttle — skip micro-movements ──────────────────────
  if (prev) {
    const movedKm   = haversine(prev.lat, prev.lng, rawLat, rawLng);
    const elapsedMs = now - prev.updatedAt;
    if (movedKm < T.THROTTLE_DIST_KM && elapsedMs < T.THROTTLE_TIME_MS) {
      prev.updatedAt = now;
      return res.json({ success: true, status: prev.status, speed: prev.speed, throttled: true });
    }
  }

  // ── STEP 3: Kalman filter — smooth GPS position ────────────────────────────
  const vehicle    = locationStore[vehicleId] || { vehicleId };
  const smoothed   = applyKalman(vehicle, rawLat, rawLng);
  const newLat     = smoothed.lat;
  const newLng     = smoothed.lng;

  // ── STEP 4: Speed calculation ──────────────────────────────────────────────
  //
  // We blend the reported speed (from device) with a computed speed
  // (distance / time). The computed speed is more reliable when the device
  // reports 0 or small values (e.g. GPS-only device without speedometer).
  let reportedRaw = speed ? parseFloat(speed) : 0;
  // Auto-detect unit: if value is < 50 and non-zero, assume m/s; else km/h
  let reportedKmh = reportedRaw > 0
    ? (reportedRaw < 50 ? reportedRaw * 3.6 : reportedRaw)
    : 0;

  let computedKmh = 0;
  if (prev) {
    const timeDeltaHrs = (now - prev.updatedAt) / 3_600_000;
    // Only compute if time delta is sensible (0.5s – 3 min)
    if (timeDeltaHrs > 0.000138 && timeDeltaHrs < 0.05) {
      // Use smoothed positions for a stable distance measurement
      const distKm = haversine(prev.lat, prev.lng, newLat, newLng);
      computedKmh  = distKm / timeDeltaHrs;
    }
  }

  let finalKmh;
  if (reportedKmh < 2 && computedKmh > 0) {
    // Trust computed if reported is stale/zero
    finalKmh = computedKmh;
  } else if (reportedKmh > 2 && computedKmh > 2) {
    const ratio = computedKmh / reportedKmh;
    // If both agree within 2.5× range, weighted blend (favour reported)
    finalKmh = (ratio > 0.4 && ratio < 2.5)
      ? (reportedKmh * 0.6 + computedKmh * 0.4)
      : Math.min(reportedKmh, computedKmh);   // disagree → conservative
  } else {
    finalKmh = Math.max(reportedKmh, computedKmh);
  }
  finalKmh = Math.min(finalKmh, 120);  // physical cap

  // ── STEP 5: EWMA speed update ──────────────────────────────────────────────
  updateEwmaSpeed(vehicle, finalKmh);

  // ── STEP 6: Traffic jam / stationary tracking ──────────────────────────────
  const isStopped = finalKmh < T.STOPPED_KMH;
  if (isStopped) {
    if (!vehicle.stationaryStartMs) vehicle.stationaryStartMs = now;
  } else {
    vehicle.stationaryStartMs = null;
  }
  const busStatus = isStopped ? "Stopped" : "Moving";

  // ── STEP 7: Stop index (forward-only ratchet) ──────────────────────────────
  const stops = routeStopsDB[vehicleId];
  let lastStopIdx = prev ? (prev.lastStopIdx || 0) : 0;

  if (stops) {
    const { nearestIdx } = findCurrentStopIndex(vehicle, newLat, newLng, stops, lastStopIdx);
    if (nearestIdx > lastStopIdx) {
      // Record segment speed when advancing
      recordSegmentSpeed(vehicleId, lastStopIdx, vehicle.ewmaSpeed || finalKmh);
      lastStopIdx = nearestIdx;
    }
  }

  // ── STEP 8: Cumulative delay tracking ─────────────────────────────────────
  //
  // Compare "time we should have been at last stop" vs actual time.
  // Positive delayMinutes = running late.
  if (stops && stops[lastStopIdx]) {
    const schedMin = parseSched(stops[lastStopIdx].scheduledTime);
    if (schedMin !== null) {
      const nowMin = nowMinutes();
      vehicle.delayMinutes = Math.min(nowMin - schedMin, T.MAX_DELAY_MIN);
    }
  }

  // ── STEP 9: Path history (last 60 points for trail display) ───────────────
  const prevPath = prev?.path || [];
  const newPath  = [...prevPath.slice(-59), { lat: newLat, lng: newLng, t: now }];

  // ── STEP 10: Persist vehicle record ───────────────────────────────────────
  Object.assign(vehicle, {
    vehicleId,
    lat:                newLat,
    lng:                newLng,
    rawLat,
    rawLng,
    speed:              parseFloat(finalKmh.toFixed(1)),
    heading:            heading ? parseFloat(heading) : 0,
    status:             busStatus,
    updatedAt:          now,
    lastStopIdx,
    path:               newPath,
    reachedDestination: vehicle.reachedDestination || false,
    destinationReachedAt: vehicle.destinationReachedAt || null,
    delayMinutes:       vehicle.delayMinutes || 0,
  });
  locationStore[vehicleId] = vehicle;

  // ── STEP 11: Destination detection ────────────────────────────────────────
  const justArrived = checkAndHandleDestination(vehicle, newLat, newLng);

  console.log(
    `[GPS] ${vehicleId} → lat:${newLat.toFixed(5)}, lng:${newLng.toFixed(5)}, ` +
    `speed:${finalKmh.toFixed(1)}km/h (ewma:${(vehicle.ewmaSpeed || 0).toFixed(1)}), ` +
    `${busStatus}, stopIdx:${vehicle.lastStopIdx}, delay:${(vehicle.delayMinutes || 0).toFixed(1)}min` +
    (justArrived ? " 🎯 DESTINATION REACHED" : "")
  );

  res.json({
    success:             true,
    status:              busStatus,
    speed:               parseFloat(finalKmh.toFixed(1)),
    reachedDestination:  vehicle.reachedDestination,
    delayMinutes:        vehicle.delayMinutes || 0,
  });
});

// ── GET /get-location/:vehicleId ───────────────────────────────────────────────
app.get("/get-location/:vehicleId", (req, res) => {
  const data = locationStore[req.params.vehicleId];
  if (!data) return res.status(404).json({ success: false, error: "Vehicle not found." });

  const { speedHistory, path, kalman, ...safe } = data;
  res.json({
    success: true,
    ...safe,
    isStale: Date.now() - data.updatedAt > 60_000,
  });
});

// ── GET /all-vehicles ──────────────────────────────────────────────────────────
app.get("/all-vehicles", (_req, res) => {
  const vehicles = Object.values(locationStore).map(v => ({
    vehicleId:          v.vehicleId,
    lat:                v.lat,
    lng:                v.lng,
    speed:              v.speed,
    status:             v.status,
    updatedAt:          v.updatedAt,
    lastStopIdx:        v.lastStopIdx,
    reachedDestination: v.reachedDestination,
    delayMinutes:       v.delayMinutes || 0,
    isStale:            Date.now() - v.updatedAt > 60_000,
  }));
  res.json({ success: true, count: vehicles.length, vehicles });
});

// ── GET /eta/:vehicleId ────────────────────────────────────────────────────────
// Full stop-by-stop ETA with v4 hybrid formula, confidence scores, and delay.
app.get("/eta/:vehicleId", (req, res) => {
  const { vehicleId } = req.params;
  const busData = locationStore[vehicleId];
  const stops   = routeStopsDB[vehicleId];

  if (!busData) return res.status(404).json({ success: false, error: "Vehicle not found or not tracking." });
  if (!stops)   return res.status(404).json({ success: false, error: `No route data for ${vehicleId}.` });

  const { lat, lng, heading } = busData;
  const currentSpeed = busData.ewmaSpeed || T.FALLBACK_SPEED_KMH;

  // ETA cache check
  if (!shouldRecomputeEta(vehicleId, currentSpeed, lat, lng) && etaCache[vehicleId]) {
    return res.json({ ...etaCache[vehicleId], cached: true });
  }

  // Effective stop index
  const { nearestIdx, distToNearest } = findCurrentStopIndex(busData, lat, lng, stops, busData.lastStopIdx);
  const effectiveIdx = Math.max(busData.lastStopIdx, nearestIdx);
  const confidence   = etaConfidence(busData);

  // Per-stop ETA
  const stopsWithETA = stops.map((stop, idx) => {
    const distKm = routeDistanceToStop(lat, lng, stops, effectiveIdx, idx);
    const etaMin = idx <= effectiveIdx
      ? 0
      : hybridEtaMinutes(lat, lng, stops, effectiveIdx, idx, busData, vehicleId);

    const status = getStopStatus(idx, effectiveIdx, distToNearest, etaMin, lat, lng, stop, busData, busData.ewmaSpeed);

    // Direction warning
    const movingToward   = isMovingTowardStop(lat, lng, heading, stop.lat, stop.lng);
    const directionWarning = (status === "upcoming" || status === "next") && !movingToward
      ? "bus_moving_away" : null;

    // Human-readable ETA label
    const etaLabel =
      status === "passed"   ? "Passed"   :
      status === "at_stop"  ? "At Stop"  :
      status === "arriving" ? `${Math.ceil(etaMin)} min` :
      status === "next"     ? `${Math.round(etaMin)} min` :
                              `${Math.round(etaMin)} min`;

    // Schedule comparison
    const schedMin  = parseSched(stop.scheduledTime);
    const nowMin    = nowMinutes();
    const etaClockMin = schedMin !== null ? nowMin + etaMin : null;
    const schedDrift  = schedMin !== null ? parseFloat((etaMin - (schedMin - nowMin)).toFixed(1)) : null;

    return {
      stopId:           stop.stopId,
      stopName:         stop.stopName,
      sequence:         stop.sequence,
      lat:              stop.lat,
      lng:              stop.lng,
      scheduledTime:    stop.scheduledTime,
      distanceKm:       parseFloat(distKm.toFixed(2)),
      etaMinutes:       parseFloat(etaMin.toFixed(1)),
      etaLabel,
      status,
      confidence:       parseFloat(confidence.toFixed(2)),
      schedDriftMin:    schedDrift,  // + = late, - = early
      directionWarning,
    };
  });

  const nextStop = stopsWithETA.find(s => s.status === "next" || s.status === "arriving");

  const result = {
    success:            true,
    vehicleId,
    currentLocation:    { lat, lng },
    speed:              currentSpeed,
    smoothedSpeed:      parseFloat(currentSpeed.toFixed(1)),
    status:             busData.status,
    reachedDestination: busData.reachedDestination || false,
    delayMinutes:       parseFloat((busData.delayMinutes || 0).toFixed(1)),
    delayStatus:        (busData.delayMinutes || 0) < -1 ? "early" :
                        (busData.delayMinutes || 0) >  5 ? "delayed" : "on-time",
    confidence:         parseFloat(confidence.toFixed(2)),
    isStale:            Date.now() - busData.updatedAt > 60_000,
    updatedAt:          busData.updatedAt,
    totalStops:         stops.length,
    currentStopIdx:     effectiveIdx,
    nextStopName:       nextStop?.stopName || null,
    stops:              stopsWithETA,
    cached:             false,
  };

  etaCache[vehicleId] = {
    ...result,
    speedAtCompute: currentSpeed,
    lat,
    lng,
    computedAt: Date.now(),
  };

  res.json(result);
});

// ── GET /eta-summary/:vehicleId ────────────────────────────────────────────────
// Lightweight polling endpoint — returns only the next-stop ETA.
// Ideal for frontend polling every 5–10 s without transferring full stop list.
app.get("/eta-summary/:vehicleId", (req, res) => {
  const { vehicleId } = req.params;
  const busData = locationStore[vehicleId];
  const stops   = routeStopsDB[vehicleId];

  if (!busData) return res.status(404).json({ success: false, error: "Vehicle not found." });
  if (!stops)   return res.status(404).json({ success: false, error: "No route data." });

  const { lat, lng } = busData;
  const speed = busData.ewmaSpeed || T.FALLBACK_SPEED_KMH;

  const { nearestIdx, distToNearest } = findCurrentStopIndex(busData, lat, lng, stops, busData.lastStopIdx);
  const effectiveIdx = Math.max(busData.lastStopIdx, nearestIdx);

  // Find next upcoming stop
  let nextIdx = effectiveIdx + 1;
  while (nextIdx < stops.length) {
    const d = haversine(lat, lng, stops[nextIdx].lat, stops[nextIdx].lng);
    if (d > 0.01) break;
    nextIdx++;
  }

  const nextStop = stops[nextIdx];
  const etaMin   = nextStop
    ? hybridEtaMinutes(lat, lng, stops, effectiveIdx, nextIdx, busData, vehicleId)
    : null;

  res.json({
    success:         true,
    vehicleId,
    status:          busData.status,
    speed:           parseFloat(speed.toFixed(1)),
    delayMinutes:    parseFloat((busData.delayMinutes || 0).toFixed(1)),
    delayStatus:     (busData.delayMinutes || 0) < -1 ? "early" :
                     (busData.delayMinutes || 0) >  5 ? "delayed" : "on-time",
    currentStopIdx:  effectiveIdx,
    currentStopName: stops[effectiveIdx]?.stopName || null,
    nextStopName:    nextStop?.stopName || null,
    nextStopEtaMin:  etaMin !== null ? parseFloat(etaMin.toFixed(1)) : null,
    nextStopEtaLabel:etaMin !== null
      ? (etaMin < 1 ? "Arriving" : `${Math.round(etaMin)} min`)
      : null,
    distToNextKm:    nextStop
      ? parseFloat(haversine(lat, lng, nextStop.lat, nextStop.lng).toFixed(2))
      : null,
    confidence:      parseFloat(etaConfidence(busData).toFixed(2)),
    isStale:         Date.now() - busData.updatedAt > 60_000,
    updatedAt:       busData.updatedAt,
  });
});

// ── GET /vehicle-status/:vehicleId ────────────────────────────────────────────
app.get("/vehicle-status/:vehicleId", (req, res) => {
  const v = locationStore[req.params.vehicleId];
  if (!v) return res.status(404).json({ success: false, error: "Vehicle not found." });

  const stops    = routeStopsDB[req.params.vehicleId];
  const total    = stops ? stops.length : 0;
  const progress = total > 0 ? Math.round((v.lastStopIdx / (total - 1)) * 100) : 0;

  res.json({
    success:             true,
    vehicleId:           v.vehicleId,
    lat:                 v.lat,
    lng:                 v.lng,
    speed:               v.speed,
    smoothedSpeed:       parseFloat((v.ewmaSpeed || v.speed || 0).toFixed(1)),
    status:              v.status,
    reachedDestination:  v.reachedDestination || false,
    destinationReachedAt: v.destinationReachedAt || null,
    lastStopIdx:         v.lastStopIdx,
    totalStops:          total,
    progressPercent:     progress,
    delayMinutes:        parseFloat((v.delayMinutes || 0).toFixed(1)),
    delayStatus:         (v.delayMinutes || 0) < -1 ? "early" :
                         (v.delayMinutes || 0) >  5 ? "delayed" : "on-time",
    isStale:             Date.now() - v.updatedAt > 60_000,
    updatedAt:           v.updatedAt,
  });
});

// ── GET /route-stops/:vehicleId ────────────────────────────────────────────────
app.get("/route-stops/:vehicleId", (req, res) => {
  const stops = routeStopsDB[req.params.vehicleId];
  if (!stops) return res.status(404).json({ success: false, error: "No route data." });
  res.json({ success: true, vehicleId: req.params.vehicleId, stops });
});

// ── GET /routes ────────────────────────────────────────────────────────────────
app.get("/routes", (_req, res) => {
  res.json({
    success: true,
    routes: Object.keys(routeStopsDB).map(id => ({
      vehicleId:   id,
      stopCount:   routeStopsDB[id].length,
      origin:      routeStopsDB[id][0]?.stopName,
      destination: routeStopsDB[id][routeStopsDB[id].length - 1]?.stopName,
    })),
  });
});

// ── GET /health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    ok:         true,
    version:    "4.0",
    uptime:     process.uptime(),
    tracked:    Object.keys(locationStore).length,
    routes:     Object.keys(routeStopsDB).length,
    segHistory: Object.keys(segmentSpeedDB).length,
  })
);

// ── GET /me/:studentId  (session validation on page load) ─────────────────────
app.get("/me/:studentId", async (req, res) => {
  try {
    const Student = require("./models/Student");
    const student = await Student.findById(req.params.studentId).select("-password");
    if (!student) return res.status(404).json({ success: false, message: "Session expired." });
    return res.json({ success: true, student });
  } catch (_) {
    return res.status(400).json({ success: false, message: "Invalid session." });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4008;
app.listen(PORT, () => {
  console.log(`\n🚌 Ritians Transport – GPS Backend (v4.1 + Student Auth) running on port ${PORT}`);
  console.log(`   POST /signup                      ← student registration`);
  console.log(`   POST /login                       ← student login`);
  console.log(`   GET  /me/:studentId               ← session validation`);
  console.log(`   POST /update-location             ← driver sends GPS`);
  console.log(`   GET  /get-location/:id            ← single vehicle location`);
  console.log(`   GET  /all-vehicles                ← all active vehicles`);
  console.log(`   GET  /eta/:vehicleId              ← full stop-wise ETA (v4 hybrid)`);
  console.log(`   GET  /eta-summary/:vehicleId      ← lightweight next-stop ETA (NEW)`);
  console.log(`   GET  /vehicle-status/:id          ← progress + delay status`);
  console.log(`   GET  /route-stops/:id             ← static stop list`);
  console.log(`   GET  /routes                      ← all available routes`);
  console.log(`   GET  /health                      ← server health\n`);
  console.log(`   📍 ${Object.keys(routeStopsDB).length} routes loaded (${
    Object.values(routeStopsDB).reduce((a, b) => a + b.length, 0)
  } total stops)`);
  console.log(`\n   ✅ v4 Improvements over v3:`);
  console.log(`      • Kalman filter GPS smoothing (position accuracy ↑)`);
  console.log(`      • EWMA speed smoothing (no sudden ETA jumps)`);
  console.log(`      • Perpendicular projection stop crossing detection`);
  console.log(`      • Hybrid ETA = 80% live speed + 20% schedule`);
  console.log(`      • Traffic-jam penalty (stationary > 60s)`);
  console.log(`      • Dwell time model (15s per intermediate stop)`);
  console.log(`      • ETA confidence score per stop`);
  console.log(`      • Cumulative delay tracking (early/on-time/delayed)`);
  console.log(`      • Per-segment historical speed database`);
  console.log(`      • /eta-summary lightweight polling endpoint\n`);
});
