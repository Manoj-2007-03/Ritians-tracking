const { app, messaging } = require('./firebaseAdmin');
console.log('Firebase Admin initialized:', !!app);
console.log('Messaging service ready:', !!messaging);