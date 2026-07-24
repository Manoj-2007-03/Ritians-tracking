importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDod0NDvWkdENXQtOn4NNl7AoBv95vPtPo",
  authDomain: "ritians-transport07.firebaseapp.com",
  projectId: "ritians-transport07",
  storageBucket: "ritians-transport07.firebasestorage.app",
  messagingSenderId: "193463468015",
  appId: "1:193463468015:web:c3541cae00884351e9001a"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  // Backend now sends data-only messages (see notifications.js) so the
  // Android native path can build its own rich tray notification in every
  // app state. title/body therefore travel in payload.data, not
  // payload.notification (which no longer exists on these messages).
  const data = payload.data || {};
  self.registration.showNotification(data.title || 'RITIANS Transport', {
    body: data.body || '',
    icon: '/favicon.ico',
    data: { liveUrl: data.liveUrl }
  });
});

// Clicking the web push notification opens the live tracking page, mirroring
// the Android native deep-link behavior in MainActivity.java.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const liveUrl = event.notification.data && event.notification.data.liveUrl;
  if (liveUrl) {
    event.waitUntil(clients.openWindow(liveUrl));
  }
});