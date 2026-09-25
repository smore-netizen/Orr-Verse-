// ======================================================
// Firebase Cloud Messaging — handles push notifications
// that arrive while the app is closed.
//
// PASTE THE SAME firebaseConfig FROM index.html BELOW.
// Keep these two copies in sync if you ever change projects.
// ======================================================
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBY1PdfF2HBhawABZ3jI_IVsglBXFKyYoU",
  authDomain: "orr-full-bible-reading.firebaseapp.com",
  projectId: "orr-full-bible-reading",
  storageBucket: "orr-full-bible-reading.firebasestorage.app",
  messagingSenderId: "294595654721",
  appId: "1:294595654721:web:10bf85792b597b019b82c0"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "One Chapter, Two Hearts";
  const options = {
    body: payload.notification?.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png"
  };
  self.registration.showNotification(title, options);
});

const CACHE_NAME = "one-chapter-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Network-first for everything except cached core shell, so data stays live.
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
