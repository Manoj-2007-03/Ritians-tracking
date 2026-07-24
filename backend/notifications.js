const { messaging } = require("./firebaseAdmin");
const Student = require("./models/Student");

// Tracks which (vehicleId, stopName) "arriving" alerts have already been sent
// for the CURRENT trip, so we don't spam the same notification every GPS tick.
const notifiedThisTrip = {}; // { vehicleId: Set of stopNames already notified }

function resetNotifyState(vehicleId) {
  notifiedThisTrip[vehicleId] = new Set();
}

async function sendToRoute(vehicleId, title, body, boardingPoint = null, data = null) {
  try {
    // Match students whose bus/route matches AND who have at least one kind
    // of push token registered (web OR native app).
    const query = {
      busNumber: vehicleId,
      $or: [
        { fcmToken: { $exists: true, $ne: "" } },
        { fcmTokenNative: { $exists: true, $ne: "" } },
      ],
    };
    if (boardingPoint) query.boardingPoint = boardingPoint;

    const students = await Student.find(query).select("fcmToken fcmTokenNative");

    // Combine both token types into one list. A Firebase Cloud Messaging
    // token is a token regardless of whether it came from a browser web
    // push subscription or a native Android/iOS app registration — the
    // send call below doesn't need to treat them differently.
    const tokens = [];
    for (const s of students) {
      if (s.fcmToken) tokens.push(s.fcmToken);
      if (s.fcmTokenNative) tokens.push(s.fcmTokenNative);
    }

    if (tokens.length === 0) {
      console.log(`[NOTIFY] No tokens found for ${vehicleId}${boardingPoint ? " @ " + boardingPoint : ""}`);
      return;
    }

    // DATA-ONLY payload (no top-level "notification" key). This is required
    // so RtMessagingService.onMessageReceived on Android always fires and
    // builds the rich tray notification (icon/color/big picture/action
    // button) in EVERY app state — foreground, background, and killed.
    // If a "notification" key were present, Android would bypass our native
    // code whenever the app is backgrounded/killed and show a bare system
    // notification instead, with none of the premium styling.
    //
    // title/body now travel inside `data` (all FCM data values must be
    // strings) alongside whatever extra fields the caller passed in, so
    // both the native tray notification and the foreground JS toast handler
    // read from the same place.
    const payload = { title, body, ...(data || {}) };
    const message = {
      tokens,
      data: Object.fromEntries(
        Object.entries(payload)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      ),
    };

    const res = await messaging.sendEachForMulticast(message);
    console.log(`[NOTIFY] ${vehicleId}: sent ${res.successCount}/${tokens.length} (${title})`);
  } catch (err) {
    console.error("[NOTIFY] Send failed:", err.message);
  }
}

async function notifyBusStarted(vehicleId, opts = {}) {
  resetNotifyState(vehicleId);

  // `opts.route` lets a call site pass a human-facing route label (e.g.
  // "R12") when it differs from the internal vehicleId. Falls back to
  // vehicleId so existing call sites (`notifyBusStarted(vehicleId)`) keep
  // working unchanged.
  const route = opts.route || vehicleId;
  const startedAt = opts.startedAt || Date.now();
  const liveUrl = opts.liveUrl || `/map.html?vehicleId=${encodeURIComponent(vehicleId)}`;

  await sendToRoute(
    vehicleId,
    "Bus Started 🚌",
    `Bus ${vehicleId} has started its route.`,
    null,
    { type: "bus_started", vehicleId, route, startedAt, liveUrl }
  );
}

async function notifyBusArriving(vehicleId, stopName) {
  if (!notifiedThisTrip[vehicleId]) notifiedThisTrip[vehicleId] = new Set();
  if (notifiedThisTrip[vehicleId].has(stopName)) return; // already sent for this trip
  notifiedThisTrip[vehicleId].add(stopName);

  await sendToRoute(vehicleId, "Bus Arriving 📍", `Bus ${vehicleId} is arriving at ${stopName}.`, stopName);
}

module.exports = { notifyBusStarted, notifyBusArriving, resetNotifyState };