# Ritians Transport – AI Face Attendance System
## Complete Setup Guide

---

## 📁 File Structure
Copy these files into your existing project:

```
face-api-js-starter-main/
├── routes/
│   └── attendance.js          ← NEW: Node.js attendance API routes
├── python-service/
│   ├── face_service.py        ← NEW: Python Flask face recognition
│   └── requirements.txt       ← NEW: Python dependencies
├── face-register.html         ← NEW: Face registration page
├── attendance-live.html       ← NEW: Live attendance scanner
├── attendance-dashboard.html  ← NEW: Admin dashboard
└── server.js                  ← MODIFY: add 2 lines (see below)
```

---

## ⚙️ Step 1: Modify server.js (2 lines only)

Open your `server.js` and make these 2 additions:

### Addition 1 — After `const authRoutes = require("./routes/auth");` (line ~27):
```js
const attendanceRoutes = require("./routes/attendance");
```

### Addition 2 — After `app.use("/", authRoutes);` (line ~45):
```js
app.use("/", attendanceRoutes);
```

**That's all. Do NOT change anything else.**

---

## 🐍 Step 2: Install Python dependencies

Open a NEW terminal and run:

```bash
cd python-service
pip install -r requirements.txt
```

> ⚠️ This will download DeepFace + TensorFlow (~2GB). Takes 5-10 minutes.

---

## 🚀 Step 3: Start both services

### Terminal 1 — Python Face Service:
```bash
cd python-service
python face_service.py
```
You should see:
```
✅ Loaded X embeddings into cache.
🚀 Face Recognition Service starting on port 5001
```

### Terminal 2 — Node.js Server:
```bash
nodemon server.js
```

---

## 🌐 Step 4: Access the pages

| Page | URL |
|------|-----|
| Face Registration | http://localhost:4008/face-register.html |
| Live Attendance | http://localhost:4008/attendance-live.html |
| Admin Dashboard | http://localhost:4008/attendance-dashboard.html |

**Admin Key:** `ritians_admin_2025`
(Change this in `routes/attendance.js` → `ADMIN_KEY` and set env var `ADMIN_KEY`)

---

## 🔧 Environment Variables (optional)

Create a `.env` file or set these in your environment:

```env
MONGODB_URI=mongodb://localhost:27017/ritians
FLASK_URL=http://localhost:5001
ADMIN_KEY=ritians_admin_2025
FLASK_PORT=5001
```

---

## 📊 MongoDB Collections Added

### `attendance` collection:
```json
{
  "regNo": "2022CSIT001",
  "name": "Arun Kumar",
  "busNo": "R01",
  "route": "Thiruvottiyur",
  "boardStop": "Lift Gate",
  "department": "CSE",
  "year": "3rd Year",
  "className": "CSE-A",
  "session": "morning",
  "timestamp": "2025-04-12T06:30:00Z",
  "confidence": 94.5,
  "status": "present"
}
```

### `students` collection (extended fields):
```json
{
  "face_embedding": [0.23, -0.14, ...],  // 512-dim ArcFace vector
  "face_registered": true,
  "face_registered_at": "2025-04-12T06:00:00Z",
  "last_attendance": "2025-04-12T06:30:00Z"
}
```

---

## 🎯 How Accuracy Works

- **Model:** ArcFace (99.38% accuracy on LFW benchmark)
- **Distance metric:** Cosine similarity
- **Threshold:** 0.40 (rejects matches with distance > 0.40)
- **1500 students:** Uses in-memory cache — O(n) lookup, ~50ms for 1500 faces
- **Duplicate prevention:** Same regNo + session + date = skip

---

## 🆘 Troubleshooting

| Problem | Fix |
|---------|-----|
| `Face service offline` | Start `python face_service.py` |
| `No face detected` | Better lighting, face camera directly |
| `Student not found` | Student must sign up first via signup.html |
| `Already registered` | Contact admin — delete `face_embedding` from MongoDB |
| Port 5001 in use | Change `FLASK_PORT=5002` and update `FLASK_URL` |
