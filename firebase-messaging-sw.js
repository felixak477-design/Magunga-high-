
importScripts(
  "https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyBnnkdo4nCR0CuLmAGT3KoKtr4_sHfBl2I",
  authDomain: "magunga-high.firebaseapp.com",
  projectId: "magunga-high",
  storageBucket: "magunga-high.firebasestorage.app",
  messagingSenderId: "269431579701",
  appId: "1:269431579701:web:794a260163d67000e43d7c",
  measurementId: "G-QCHP6D65TM"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title =
    payload.notification?.title || "The Magunga High";

  const options = {
    body:
      payload.notification?.body ||
      "You have a new school update.",

    data: {
      url: payload.data?.url || "/dashboard.html"
    }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    event.notification.data?.url || "/dashboard.html",
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();

        if ("navigate" in client) {
          await client.navigate(target);
        }

        return;
      }
    }

    await clients.openWindow(target);
  })());
});
