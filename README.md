# 🚌 Ritians Transport — Live GPS Tracking Integration Guide

## 📁 Folder Structure

```
ritians-tracking/
├── backend/
│   ├── server.js          ← Node.js Express API server
│   └── package.json       ← Dependencies
└── public/
    ├── index.html         ← Your EXISTING main website (copy yours here)
    ├── tracking.html      ← Student live tracking page (NEW)
    └── driver.html        ← Driver GPS portal (NEW)
```

---

## ⚙️ Step 1 — Set Up the Backend

### Install Node.js (if not installed)
Download from: https://nodejs.org (LTS version)

### Install dependencies
```bash
cd ritians-tracking/backend
npm install
```

### Start the server
```bash
npm start
```

You should see:
```
🚌 Ritians Transport – GPS Backend running on port 3001
   POST /update-location   ← driver sends GPS
   GET  /get-location/:id  ← tracking page polls
   GET  /all-vehicles      ← all active vehicles
   GET  /health            ← server health
```

---

## 🗺️ Step 2 — Get Google Maps API Key

1. Go to: https://console.cloud.google.com/google/maps-apis
2. Create a project → Enable **Maps JavaScript API**
3. Create an API key under "Credentials"
4. Open `public/tracking.html` and replace:
   ```js
   window.MAPS_API_KEY = 'YOUR_GOOGLE_MAPS_API_KEY';
   ```
   With your actual key:
   ```js
   window.MAPS_API_KEY = 'AIzaSyABC123...yourkey';
   ```

> 💡 **Cost**: Google Maps gives $200/month free credit — more than enough for a college transport portal.

---

## 🌐 Step 3 — Add Tracking Button to Your Main Site

Open your **existing `index.html`** and add this button inside the `.nav-right` div
(right before the `<div class="clock"` line):

```html
<a href="tracking.html" class="tab-btn" style="text-decoration:none">
  <i class="fas fa-satellite-dish"></i><span>Live Track</span>
</a>
```

Also, optionally add a hero tag inside `.hero-tags`:
```html
<span class="hero-tag"><i class="fas fa-satellite-dish"></i> 
  <a href="tracking.html" style="color:inherit;text-decoration:none">Live GPS Tracking</a>
</span>
```

---

## 🚀 Step 4 — Run Everything

### In one terminal: Start the backend
```bash
cd backend
npm start
```

### Open the frontend
- Open `public/index.html` in your browser  
- Click **"Live Track"** to open the tracking page  
- Click **"Driver Portal"** (link in tracking page) to open the driver page  

### Test the full flow
1. Open `driver.html` on your phone (or another tab)
2. Select a route → click **"Start Sharing Location"**
3. Allow GPS when prompted
4. Go to `tracking.html` → enter the same route ID → click **"Track Vehicle"**
5. Watch the marker move in real time! 🎉

---

## 📱 For Real Drivers (Mobile)

Drivers open `driver.html` on their phone browser:
- Works on Chrome/Safari/Firefox mobile
- No app download needed
- Uses `navigator.geolocation.watchPosition` for continuous GPS
- Sends location every ~4 seconds to the backend

**Important**: The driver's phone must have:
- GPS/Location enabled
- Browser permission to access location (tap "Allow" when prompted)
- Internet connection to reach the backend server

---

## 🌍 Deploying Online (for real-world use)

### Deploy backend to Railway (free):
1. Go to https://railway.app
2. New Project → Deploy from GitHub
3. Upload the `backend/` folder
4. Railway gives you a URL like `https://your-app.railway.app`
5. Update `API_BASE` in both `tracking.html` and `driver.html`:
   ```js
   const API_BASE = 'https://your-app.railway.app';
   ```

### Host frontend to Netlify (free):
1. Go to https://netlify.com
2. Drag & drop the `public/` folder
3. Done!

---

## 🔧 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/update-location` | POST | Driver sends `{vehicleId, lat, lng, speed, heading}` |
| `/get-location/:vehicleId` | GET | Get latest location of one vehicle |
| `/all-vehicles` | GET | Get all currently tracked vehicles |
| `/health` | GET | Server status check |

---

## ❓ Troubleshooting

| Problem | Solution |
|---|---|
| Map shows error | Add your Google Maps API key to `tracking.html` |
| GPS not working on driver page | Use HTTPS (required for GPS on mobile). Use ngrok for local testing. |
| CORS error in console | Backend has CORS enabled — check `API_BASE` URL matches your server |
| Marker not moving | Ensure driver is sharing location AND both pages use the same `API_BASE` |
| Location permission denied | Go to browser Settings → Site permissions → Allow location |

---

## 🔒 HTTPS for GPS (Mobile Requirement)

Browsers require **HTTPS** to access GPS on mobile. For local testing:

### Option 1: Use ngrok (easiest)
```bash
npm install -g ngrok
ngrok http 3001
# Use the https://xxx.ngrok.io URL as API_BASE
```

### Option 2: Use localhost on same device
GPS works on `localhost` even without HTTPS.

---

## 📝 Notes

- Location data is stored **in memory only** — it resets when the server restarts
- Locations older than **60 seconds** are marked as "Offline" (but not deleted)
- For production, replace in-memory store with MongoDB/Redis for persistence
- The system supports **unlimited simultaneous vehicles**
