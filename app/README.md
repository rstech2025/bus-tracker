# Wayfarer · live bus tracking for the web

A responsive web app for following a bus on a live map and checking which stops it has reached. Riders do not need an account. Drivers sign in with Firebase Authentication, configure their bus and stops, then share GPS from the browser.

## Connect Firebase

1. Create a Firebase project and register a **Web app** in Project settings.
2. Copy the web app configuration into [`firebase-config.js`](./firebase-config.js). Copy the exact Realtime Database URL shown in Firebase Console; depending on the database region it may end in `.firebasedatabase.app` or `.firebaseio.com`.
3. In Firebase Authentication, enable **Email/Password** and create driver accounts. There is intentionally no public driver sign-up.
4. Create a **Realtime Database** and publish the rules from [`database.rules.json`](./database.rules.json).
5. Serve this folder over **HTTPS** (or `localhost` while developing) and open `index.html`. Browser geolocation requires a secure context.

Firebase web API keys identify the Firebase project and are intended to be included in web apps. Database access is controlled by the included security rules: bus data is public and read-only to riders, and only the signed-in owner can publish a route, location, or arrival. Driver ownership is kept in a private database path rather than the public bus record.

## Run locally

With Python 3 installed:

```sh
python3 -m http.server 4173
```

Open <http://localhost:4173>. The map uses Leaflet and OpenStreetMap tiles from public internet endpoints. OpenStreetMap attribution is displayed on the map. For high-traffic production use, choose a tile provider and usage plan that meet your needs.

## Using the app

- **Riders:** enter the bus ID and choose **Track bus**. The map updates in real time and shows when the bus reaches each stop. No rider account or location permission is needed.
- **Drivers:** choose **Driver sign in** and sign in with an account created by your transit administrator. Enter a bus ID and route name, then add one stop per line in `Stop name|latitude|longitude` format, for example `Central Station|22.5726|88.3639`. Choose **Save route & start sharing** and allow precise browser location access.
- A stop is marked reached after GPS readings with accuracy of 50 metres or better stay within 75 metres of the next stop for 10 seconds.

## Important browser GPS limitation

This web app publishes location while its page is open and the browser is delivering location updates. Mobile browsers and operating systems may pause or throttle a background tab, and a web page cannot guarantee continuous tracking after it is closed or suspended. The rider view flags locations older than 30 seconds. For dependable tracking throughout a real bus route, keep the driver page open and the device powered; if background tracking must be guaranteed, use a native driver app or a managed fleet GPS device.

Without a Firebase configuration, the rider interface still opens, but it cannot connect to live data. Driver accounts, a Firebase project, an enabled Realtime Database, and the published rules are required for real tracking.
