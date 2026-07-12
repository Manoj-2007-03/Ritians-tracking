const { messaging } = require("./firebaseAdmin");
const Student = require("./models/Student");

// Tracks which (vehicleId, stopName) "arriving" alerts have already been sent
// for the CURRENT trip, so we don't spam the same notification every GPS tick.
const notifiedThisTrip = {}; // { vehicleId: Set of stopNames already notified }

function resetNotifyState(vehicleId) {
  notifiedThisTrip[vehicleId] = new Set();
}

async function sendToRoute(vehicleId, title, body, boardingPoint = null) {
  try {
    const query = { busNumber: vehicleId, fcmToken: { $exists: true, $ne: "" } };
    if (boardingPoint) query.boardingPoint = boardingPoint;

    const students = await Student.find(query).select("fcmToken");
    const tokens = students.map(s => s.fcmToken).filter(Boolean);

    if (tokens.length === 0) {
      console.log(`[NOTIFY] No tokens found for ${vehicleId}${boardingPoint ? " @ " + boardingPoint : ""}`);
      return;
    }

    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
    });
    console.log(`[NOTIFY] ${vehicleId}: sent ${res.successCount}/${tokens.length} (${title})`);
  } catch (err) {
    console.error("[NOTIFY] Send failed:", err.message);
  }
}

async function notifyBusStarted(vehicleId) {
  resetNotifyState(vehicleId);
  await sendToRoute(vehicleId, "Bus Started 🚌", `Bus ${vehicleId} has started its route.`);
}

async function notifyBusArriving(vehicleId, stopName) {
  if (!notifiedThisTrip[vehicleId]) notifiedThisTrip[vehicleId] = new Set();
  if (notifiedThisTrip[vehicleId].has(stopName)) return; // already sent for this trip
  notifiedThisTrip[vehicleId].add(stopName);

  await sendToRoute(vehicleId, "Bus Arriving 📍", `Bus ${vehicleId} is arriving at ${stopName}.`, stopName);
}

module.exports = { notifyBusStarted, notifyBusArriving, resetNotifyState };