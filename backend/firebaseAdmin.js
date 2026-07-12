const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = require('./firebase-service-account.json');

const app = initializeApp({
  credential: cert(serviceAccount)
});

const messaging = getMessaging(app);

module.exports = { app, messaging };