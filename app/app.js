import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  get,
  getDatabase,
  onValue,
  ref,
  serverTimestamp,
  set,
  update,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";

const elements = {
  busId: document.querySelector("#busId"),
  searchForm: document.querySelector("#searchForm"),
  mapRoute: document.querySelector("#mapRoute"),
  mapSubhead: document.querySelector("#mapSubhead"),
  livePill: document.querySelector("#livePill"),
  mapEmpty: document.querySelector("#mapEmpty"),
  coordinates: document.querySelector("#coordinates"),
  openMaps: document.querySelector("#openMaps"),
  routeName: document.querySelector("#routeName"),
  locationSummary: document.querySelector("#locationSummary"),
  stopCount: document.querySelector("#stopCount"),
  stopsList: document.querySelector("#stopsList"),
  driverDialog: document.querySelector("#driverDialog"),
  openDriver: document.querySelector("#openDriver"),
  closeDriver: document.querySelector("#closeDriver"),
  driverTitle: document.querySelector("#driverTitle"),
  driverDescription: document.querySelector("#driverDescription"),
  driverMessage: document.querySelector("#driverMessage"),
  loginForm: document.querySelector("#loginForm"),
  routeForm: document.querySelector("#routeForm"),
  driverEmail: document.querySelector("#driverEmail"),
  driverPassword: document.querySelector("#driverPassword"),
  driverBusId: document.querySelector("#driverBusId"),
  driverRouteName: document.querySelector("#driverRouteName"),
  driverStops: document.querySelector("#driverStops"),
  startTracking: document.querySelector("#startTracking"),
  stopTracking: document.querySelector("#stopTracking"),
  signOut: document.querySelector("#signOut"),
  driverDisclaimer: document.querySelector("#driverDisclaimer"),
  toast: document.querySelector("#toast"),
};

const MAX_LOCATION_AGE_MS = 30_000;
const ARRIVAL_RADIUS_METERS = 75;
const MAX_ARRIVAL_ACCURACY_METERS = 50;
const ARRIVAL_DWELL_MS = 10_000;

let app;
let auth;
let database;
let map;
let busMarker;
let stopLayer;
let routeLine;
let hasCenteredMap = false;
let activeBusId = "";
let activeBusListener = null;
let busData = null;
let geoWatchId = null;
let lastStatusWrite = "";
let arrivalCandidateId = null;
let arrivalCandidateSince = 0;
let toastTimer;

initializeMap();
updateDriverMode(false);
window.setInterval(renderTrackingStatus, 5_000);

if (hasFirebaseConfig(firebaseConfig)) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    database = getDatabase(app);
    onAuthStateChanged(auth, (user) => {
      updateDriverMode(Boolean(user));
      if (user && elements.driverDialog.open) loadOwnedRoute();
    });
    subscribeToBus(normalizeBusId(elements.busId.value));
  } catch (error) {
    console.error("Firebase initialization failed.", error);
    showLiveState("error", "CONFIG ERROR");
    elements.mapSubhead.textContent = "Could not initialize Firebase.";
    showToast("Firebase configuration could not be loaded. Check firebase-config.js.");
  }
} else {
  showLiveState("idle", "SETUP REQUIRED");
  elements.mapSubhead.textContent = "Add your Firebase web config to connect";
  elements.locationSummary.textContent = "Waiting for Firebase setup";
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const busId = normalizeBusId(elements.busId.value);
  if (!isValidBusId(busId)) {
    showToast("Enter a bus ID with 2–24 letters, numbers, hyphens, or underscores.");
    elements.busId.focus();
    return;
  }
  elements.busId.value = busId;
  if (!database) {
    showToast("Add your Firebase web configuration in firebase-config.js to connect this app.");
    return;
  }
  subscribeToBus(busId);
});

elements.openDriver.addEventListener("click", () => {
  elements.driverDialog.showModal();
  if (auth?.currentUser) {
    updateDriverMode(true);
    loadOwnedRoute();
  } else {
    updateDriverMode(false);
    clearDriverMessage();
  }
});

elements.closeDriver.addEventListener("click", () => elements.driverDialog.close());
elements.driverDialog.addEventListener("click", (event) => {
  if (event.target === elements.driverDialog) elements.driverDialog.close();
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!auth) {
    showDriverMessage("Connect a Firebase project first by editing firebase-config.js.", true);
    return;
  }
  setBusy(elements.loginForm.querySelector('button[type="submit"]'), true, "Signing in…");
  clearDriverMessage();
  try {
    await signInWithEmailAndPassword(
      auth,
      elements.driverEmail.value.trim(),
      elements.driverPassword.value,
    );
    elements.driverPassword.value = "";
    updateDriverMode(true);
    showDriverMessage("Signed in. Set up your bus route to start sharing.");
  } catch (error) {
    console.error("Driver sign-in failed.", error);
    showDriverMessage(authErrorMessage(error), true);
  } finally {
    setBusy(elements.loginForm.querySelector('button[type="submit"]'), false);
  }
});

elements.routeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveRouteAndStart();
});

elements.stopTracking.addEventListener("click", () => stopSharing());

elements.signOut.addEventListener("click", async () => {
  if (geoWatchId !== null) await stopSharing({ showMessage: false });
  try {
    await signOut(auth);
    updateDriverMode(false);
    showDriverMessage("You are signed out. Riders can still track your last published location.");
  } catch (error) {
    console.error("Driver sign-out failed.", error);
    showDriverMessage(`Could not sign out: ${error.message}`, true);
  }
});

elements.driverBusId.addEventListener("change", () => {
  elements.driverBusId.value = normalizeBusId(elements.driverBusId.value);
  loadOwnedRoute();
});

function initializeMap() {
  if (!window.L) {
    showLiveState("error", "MAP UNAVAILABLE");
    elements.mapSubhead.textContent = "Map could not load. Check your connection.";
    return;
  }
  map = L.map("map", { zoomControl: true }).setView([22.5726, 88.3639], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  stopLayer = L.layerGroup().addTo(map);
}

function hasFirebaseConfig(config) {
  return Boolean(
    config?.apiKey &&
      !config.apiKey.startsWith("YOUR_") &&
      config?.projectId &&
      !config.projectId.startsWith("YOUR_") &&
      config?.databaseURL &&
      !config.databaseURL.includes("YOUR_DATABASE_NAME") &&
      config?.appId &&
      !config.appId.startsWith("YOUR_"),
  );
}

function normalizeBusId(value) {
  return value.trim().toUpperCase();
}

function isValidBusId(value) {
  return /^[A-Z0-9_-]{2,24}$/.test(value);
}

function subscribeToBus(busId) {
  if (!database || !isValidBusId(busId)) return;
  if (activeBusListener) activeBusListener();
  activeBusId = busId;
  busData = null;
  hasCenteredMap = false;
  elements.mapRoute.textContent = `${busId} · Finding your bus`;
  elements.mapSubhead.textContent = "Connecting to live bus data…";
  elements.routeName.textContent = "Loading route details…";
  elements.locationSummary.textContent = "Connecting to live location";
  elements.coordinates.textContent = "Waiting for GPS";
  elements.mapEmpty.hidden = false;
  elements.openMaps.hidden = true;
  showLiveState("idle", "CONNECTING");
  renderStops();

  activeBusListener = onValue(
    ref(database, `buses/${busId}`),
    (snapshot) => {
      busData = snapshot.exists() ? snapshot.val() : null;
      renderBus();
    },
    (error) => {
      console.error("Could not read live bus data.", error);
      showLiveState("error", "CONNECTION ERROR");
      elements.mapSubhead.textContent = "Could not load this bus. Check Firebase rules and network.";
      elements.locationSummary.textContent = error.message || "Could not connect to bus data";
      elements.mapEmpty.hidden = false;
      showToast("Could not read this bus. Check Firebase Realtime Database rules.");
    },
  );
}

function renderBus() {
  if (!busData) {
    elements.mapRoute.textContent = `${activeBusId} · Not sharing yet`;
    elements.mapSubhead.textContent = "Waiting for the driver to set up this bus";
    elements.routeName.textContent = "Route details arrive with the bus";
    elements.locationSummary.textContent = "No driver location yet";
    elements.coordinates.textContent = "Waiting for GPS";
    elements.mapEmpty.hidden = false;
    elements.mapEmpty.querySelector("strong").textContent = "No live bus just yet.";
    elements.mapEmpty.querySelector("span:last-child").textContent =
      "Check the bus ID or ask your driver to start sharing their route.";
    elements.openMaps.hidden = true;
    renderStops();
    showLiveState("idle", "NOT SHARING");
    return;
  }

  const metadata = busData.metadata || {};
  const routeName = metadata.routeName || "Route not configured";
  elements.mapRoute.textContent = `${activeBusId} · ${routeName}`;
  elements.mapSubhead.textContent = "Live bus location and route";
  elements.routeName.textContent = routeName;
  renderStops();
  renderTrackingStatus();
}

function renderTrackingStatus() {
  if (!activeBusId || !database || !busData) return;
  const location = busData.location;
  if (!location || !Number.isFinite(Number(location.latitude)) ||
      !Number.isFinite(Number(location.longitude))) {
    const status = busData.trackingStatus;
    const isError = typeof status === "string" && /failed|disabled|denied|error|could not/i.test(status);
    showLiveState(isError ? "error" : "idle", isError ? "GPS NEEDS ATTENTION" : "WAITING FOR GPS");
    elements.locationSummary.textContent = status || "Waiting for the driver’s first GPS fix";
    elements.mapEmpty.hidden = false;
    elements.mapEmpty.querySelector("strong").textContent = "Waiting for your bus to move.";
    elements.mapEmpty.querySelector("span:last-child").textContent =
      status || "The driver’s location will appear here as soon as it is shared.";
    elements.openMaps.hidden = true;
    return;
  }

  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const updatedAt = Number(location.updatedAt);
  const age = Date.now() - updatedAt;
  const isStale = !Number.isFinite(updatedAt) || age > MAX_LOCATION_AGE_MS || age < -5_000;
  const driverStatus = busData.trackingStatus;
  const isStopped = driverStatus === "Stopped";
  const hasError = typeof driverStatus === "string" &&
    /failed|disabled|denied|error|could not|attention/i.test(driverStatus);
  const state = isStale || isStopped || hasError ? "stale" : "live";
  const label = isStopped ? "SHARING STOPPED" :
    hasError ? "GPS NEEDS ATTENTION" :
      isStale ? "LOCATION STALE" : "LIVE NOW";
  showLiveState(state, label);
  elements.mapEmpty.hidden = true;
  elements.coordinates.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  const accuracy = Number(location.accuracy);
  const ageLabel = Number.isFinite(updatedAt) ? formatRelativeTime(updatedAt) : "time unknown";
  const warning = hasError && !isStopped ? `${driverStatus} · ` : "";
  const statusLabel = isStopped
    ? "Driver stopped sharing"
    : isStale
      ? "Location may be out of date"
      : "Live GPS location";
  elements.locationSummary.textContent =
    `${warning}${statusLabel} · ${ageLabel}${Number.isFinite(accuracy) ? ` · ±${Math.round(accuracy)} m` : ""}`;
  elements.mapSubhead.textContent = `${statusLabel} · updated ${ageLabel}`;
  elements.openMaps.href =
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
  elements.openMaps.hidden = false;
  updateMap(location, metadata.stops || {});
}

function showLiveState(state, label) {
  elements.livePill.dataset.state = state;
  elements.livePill.querySelector("b").textContent = label;
  const pulse = document.querySelector(".summary-pulse");
  if (pulse) pulse.dataset.state = state;
}

function updateMap(location, stopsObject) {
  if (!map) return;
  const busPoint = [Number(location.latitude), Number(location.longitude)];
  if (!Number.isFinite(busPoint[0]) || !Number.isFinite(busPoint[1])) return;
  const stopEntries = sortStops(stopsObject);

  if (!busMarker) {
    const busIcon = L.divIcon({
      className: "",
      html: '<span class="bus-pin"><svg viewBox="0 0 24 24"><path d="M5 17V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9m-14-3h14m-10-5h6m-8 8v2m8-2v2" /><circle cx="8" cy="16" r="1" /><circle cx="16" cy="16" r="1" /></svg></span>',
      iconSize: [38, 38],
      iconAnchor: [19, 35],
    });
    busMarker = L.marker(busPoint, { icon: busIcon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(`<strong>${escapeHtml(activeBusId)}</strong><br>Live bus location`);
  } else {
    busMarker.setLatLng(busPoint);
  }

  stopLayer.clearLayers();
  const points = [busPoint];
  for (const stop of stopEntries) {
    if (!validCoordinates(stop.latitude, stop.longitude)) continue;
    const point = [stop.latitude, stop.longitude];
    points.push(point);
    L.circleMarker(point, {
      radius: 6,
      color: "#216b52",
      fillColor: "#ffffff",
      fillOpacity: 1,
      weight: 2,
    }).bindPopup(escapeHtml(stop.name)).addTo(stopLayer);
  }
  if (routeLine) map.removeLayer(routeLine);
  if (points.length > 1) {
    routeLine = L.polyline(points, {
      color: "#6b9b7a",
      weight: 3,
      opacity: 0.65,
      dashArray: "4 8",
    }).addTo(map);
  }

  if (!hasCenteredMap) {
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points).pad(0.18), { maxZoom: 14 });
    } else {
      map.setView(busPoint, 15);
    }
    hasCenteredMap = true;
  } else if (!map.getBounds().pad(-0.18).contains(busPoint)) {
    map.panTo(busPoint, { animate: true, duration: 0.5 });
  }
}

function renderStops() {
  const metadata = busData?.metadata || {};
  const stops = sortStops(metadata.stops || {});
  const arrivals = busData?.arrivals || {};
  const nextStop = stops.find((stop) => !arrivals[stop.id]);
  elements.stopCount.textContent = `${stops.length} ${stops.length === 1 ? "STOP" : "STOPS"}`;
  if (!stops.length) {
    elements.stopsList.innerHTML = `
      <div class="stops-empty">
        <span class="stops-empty-icon">⌁</span>
        <strong>Stops will show up here</strong>
        <span>Once your driver starts sharing the route, you can follow each stop along the way.</span>
      </div>`;
    return;
  }

  elements.stopsList.innerHTML = stops.map((stop) => {
    const arrivalTime = Number(arrivals[stop.id]);
    const reached = Number.isFinite(arrivalTime) && arrivalTime > 0;
    const isNext = !reached && nextStop?.id === stop.id;
    const stateClass = reached ? "reached" : isNext ? "next" : "";
    const status = reached ? "Reached" : isNext ? "NEXT STOP" : "Upcoming";
    const marker = reached ? "✓" : "";
    return `
      <div class="stop-item ${stateClass}">
        <span class="stop-marker" aria-hidden="true">${marker}</span>
        <div class="stop-info">
          <div class="stop-name">${escapeHtml(stop.name)}</div>
          <div class="stop-status">${escapeHtml(status)}</div>
        </div>
        ${reached ? `<span class="stop-time">${escapeHtml(formatTime(arrivalTime))}</span>` : ""}
      </div>`;
  }).join("");
}

async function saveRouteAndStart() {
  if (!auth?.currentUser || !database) {
    showDriverMessage("Your driver session expired. Sign in again to start sharing.", true);
    updateDriverMode(false);
    return;
  }
  const busId = normalizeBusId(elements.driverBusId.value);
  const routeName = elements.driverRouteName.value.trim();
  const stops = parseStops(elements.driverStops.value);
  if (!isValidBusId(busId)) {
    showDriverMessage("Use 2–24 letters, numbers, hyphens, or underscores for the bus ID.", true);
    return;
  }
  if (!routeName || routeName.length > 80) {
    showDriverMessage("Enter a route name between 1 and 80 characters.", true);
    return;
  }
  if (!stops.length) {
    showDriverMessage("Add at least one valid stop: Name|latitude|longitude.", true);
    return;
  }
  if (stops.length > 50) {
    showDriverMessage("A route can contain at most 50 stops.", true);
    return;
  }

  setBusy(elements.startTracking, true, "Saving route…");
  try {
    const ownerRef = ref(database, `busOwners/${busId}`);
    await set(ownerRef, auth.currentUser.uid);

    const stopData = Object.fromEntries(stops.map((stop) => [
      stop.id,
      { name: stop.name, latitude: stop.latitude, longitude: stop.longitude },
    ]));
    await set(ref(database, `buses/${busId}/metadata`), { routeName, stops: stopData });
    await update(ref(database, `buses/${busId}`), {
      arrivals: null,
      location: null,
      trackingStatus: "Waiting for driver GPS",
    });

    elements.driverBusId.value = busId;
    activeBusId = busId;
    elements.busId.value = busId;
    subscribeToBus(busId);
    await startLocationSharing(busId, stops);
  } catch (error) {
    console.error("Could not save the driver route.", error);
    const message = error.code === "PERMISSION_DENIED"
      ? "This bus ID is already assigned to another driver, or Firebase denied access. Ask your transit administrator for help."
      : error.message || "Could not save this route. Check Firebase rules and your connection.";
    showDriverMessage(message, true);
  } finally {
    setBusy(elements.startTracking, false);
  }
}

function parseStops(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 50) return [];
  const stops = [];
  for (const [index, line] of lines.entries()) {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 3 || !parts[0] || parts[0].length > 80) return [];
    if (!parts[1] || !parts[2]) return [];
    const latitude = Number(parts[1]);
    const longitude = Number(parts[2]);
    if (!validCoordinates(latitude, longitude)) return [];
    stops.push({
      id: `stop_${String(index + 1).padStart(2, "0")}`,
      name: parts[0],
      latitude,
      longitude,
    });
  }
  return stops;
}

function sortStops(stops) {
  return Object.entries(stops || {})
    .map(([id, value]) => ({
      id,
      name: value?.name,
      latitude: Number(value?.latitude),
      longitude: Number(value?.longitude),
    }))
    .filter((stop) => typeof stop.name === "string" && stop.name.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

async function startLocationSharing(busId, stops) {
  if (!navigator.geolocation) {
    showDriverMessage("This browser does not support GPS location sharing.", true);
    await writeTrackingStatus(busId, "GPS unavailable");
    return;
  }
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  arrivalCandidateId = null;
  arrivalCandidateSince = 0;
  lastStatusWrite = "";
  const startMessage = "Route saved. Requesting precise location permission…";
  showDriverMessage(startMessage);
  try {
    await writeTrackingStatus(busId, "Waiting for driver GPS");
    geoWatchId = navigator.geolocation.watchPosition(
      (position) => publishLocation(busId, stops, position),
      (error) => handleLocationError(busId, error),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
    showDriverMessage("Location sharing is active. Keep this page open during the trip.");
    showToast("Bus route is saved. Riders can now follow this bus.");
  } catch (error) {
    console.error("Could not start location sharing.", error);
    geoWatchId = null;
    showDriverMessage(error.message || "Could not start GPS sharing. Check your browser permissions.", true);
    await writeTrackingStatus(busId, "GPS start failed");
  }
}

async function publishLocation(busId, stops, position) {
  if (!auth?.currentUser || auth.currentUser.uid === "") return;
  const { latitude, longitude, accuracy } = position.coords;
  if (!validCoordinates(latitude, longitude) || !Number.isFinite(accuracy) || accuracy < 0) {
    console.warn("Ignoring invalid GPS coordinates from the browser.");
    return;
  }
  const locationTimestamp = Number(position.timestamp);
  if (!Number.isFinite(locationTimestamp) || Date.now() - locationTimestamp > 20_000 ||
      locationTimestamp - Date.now() > 5_000) {
    console.warn("Ignoring an outdated browser location fix.");
    return;
  }

  try {
    await set(ref(database, `buses/${busId}/location`), {
      latitude,
      longitude,
      accuracy,
      updatedAt: serverTimestamp(),
    });
    await writeTrackingStatus(busId, "Live");
  } catch (error) {
    console.error("Could not publish bus location.", error);
    showDriverMessage(`Location upload failed: ${error.message || "check your connection."}`, true);
    await writeTrackingStatus(busId, "Location upload failed");
    return;
  }

  if (accuracy > MAX_ARRIVAL_ACCURACY_METERS) {
    arrivalCandidateId = null;
    arrivalCandidateSince = 0;
    return;
  }
  const arrivals = busData?.arrivals || {};
  const nextStop = stops.find((stop) => !arrivals[stop.id]);
  if (!nextStop) return;
  const distance = distanceBetween(latitude, longitude, nextStop.latitude, nextStop.longitude);
  if (distance > ARRIVAL_RADIUS_METERS) {
    arrivalCandidateId = null;
    arrivalCandidateSince = 0;
    return;
  }
  const now = performance.now();
  if (arrivalCandidateId !== nextStop.id) {
    arrivalCandidateId = nextStop.id;
    arrivalCandidateSince = now;
    return;
  }
  if (now - arrivalCandidateSince < ARRIVAL_DWELL_MS) return;

  try {
    await set(ref(database, `buses/${busId}/arrivals/${nextStop.id}`), serverTimestamp());
    arrivalCandidateId = null;
    arrivalCandidateSince = 0;
    showDriverMessage(`Arrival recorded at ${nextStop.name}.`);
  } catch (error) {
    console.error("Could not record stop arrival.", error);
    showDriverMessage(`Could not record the stop arrival: ${error.message || "check your connection."}`, true);
  }
}

function distanceBetween(latitude1, longitude1, latitude2, longitude2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLatitude = toRadians(latitude2 - latitude1);
  const dLongitude = toRadians(longitude2 - longitude1);
  const a = Math.sin(dLatitude / 2) ** 2 +
    Math.cos(toRadians(latitude1)) * Math.cos(toRadians(latitude2)) *
    Math.sin(dLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function handleLocationError(busId, error) {
  const messages = {
    1: "Location permission was denied. Allow precise location in your browser settings.",
    2: "Your device could not get a GPS fix. Check location services and try again.",
    3: "GPS request timed out. Keep location services enabled while sharing.",
  };
  const message = messages[error.code] || `GPS error: ${error.message || "unknown location problem."}`;
  console.error("Browser geolocation failed.", error);
  showDriverMessage(message, true);
  await writeTrackingStatus(busId, message);
}

async function stopSharing({ showMessage = true } = {}) {
  const busId = normalizeBusId(elements.driverBusId.value || activeBusId);
  if (geoWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  arrivalCandidateId = null;
  arrivalCandidateSince = 0;
  if (busId && database && auth?.currentUser) {
    await writeTrackingStatus(busId, "Stopped");
  }
  if (showMessage) showDriverMessage("Location sharing stopped. You can start again when you’re ready.");
  return true;
}

async function writeTrackingStatus(busId, status) {
  if (!database || !auth?.currentUser || !busId || lastStatusWrite === status) return;
  lastStatusWrite = status;
  try {
    await set(ref(database, `buses/${busId}/trackingStatus`), status);
  } catch (error) {
    lastStatusWrite = "";
    console.error("Could not update bus tracking status.", error);
  }
}

async function loadOwnedRoute() {
  const user = auth?.currentUser;
  const busId = normalizeBusId(elements.driverBusId.value);
  if (!user || !database || !isValidBusId(busId)) return;
  try {
    const ownerSnapshot = await get(ref(database, `busOwners/${busId}`));
    if (!ownerSnapshot.exists() || ownerSnapshot.val() !== user.uid) return;
    const snapshot = await get(ref(database, `buses/${busId}/metadata`));
    if (!snapshot.exists()) return;
    const metadata = snapshot.val();
    elements.driverRouteName.value = metadata.routeName || "";
    elements.driverStops.value = sortStops(metadata.stops || {})
      .map((stop) => `${stop.name}|${stop.latitude}|${stop.longitude}`)
      .join("\n");
  } catch (error) {
    console.error("Could not load driver route.", error);
    if (error.code !== "PERMISSION_DENIED") {
      showDriverMessage(`Could not load your saved route: ${error.message}`, true);
    }
  }
}

function updateDriverMode(isSignedIn) {
  elements.loginForm.hidden = isSignedIn;
  elements.routeForm.hidden = !isSignedIn;
  elements.driverDisclaimer.hidden = !isSignedIn;
  elements.driverTitle.innerHTML = "Your route,<br /><span>in motion.</span>";
  elements.driverDescription.textContent = isSignedIn
    ? "Set up the stops for your bus, then share your live location with riders."
    : "Sign in with your driver account to share a route with your riders.";
  if (isSignedIn) loadOwnedRoute();
}

function showDriverMessage(message, isError = false) {
  elements.driverMessage.textContent = message;
  elements.driverMessage.dataset.kind = isError ? "error" : "success";
  elements.driverMessage.hidden = !message;
}

function clearDriverMessage() {
  showDriverMessage("");
}

function setBusy(button, busy, busyText = "") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function authErrorMessage(error) {
  if (error.code === "auth/invalid-credential" || error.code === "auth/wrong-password" ||
      error.code === "auth/user-not-found") {
    return "Email or password is incorrect. Check your driver account and try again.";
  }
  if (error.code === "auth/too-many-requests") {
    return "Too many sign-in attempts. Wait a little while, then try again.";
  }
  return `Could not sign in: ${error.message || "check your connection and try again."}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(timestamp));
}

function formatRelativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3_800);
}
