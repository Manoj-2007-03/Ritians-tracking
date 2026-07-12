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
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: '/favicon.ico'
  });
});