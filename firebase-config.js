/*
 * Firebase + Cloudinary configuration for the Members area.
 *
 * Nothing in this file is secret — a Firebase web apiKey only tells the
 * browser which project to talk to. The real protection is the Firestore
 * rules (firestore.rules) you paste into the Firebase console.
 */

// Firebase console → Project settings → General → Your apps → SDK setup and configuration
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB7ucA7BipbuQ0mMvJ8N3D_oTU7KwSvA3U",
  authDomain: "authentication-bc3cd.firebaseapp.com",
  projectId: "authentication-bc3cd",
  storageBucket: "authentication-bc3cd.firebasestorage.app",
  messagingSenderId: "225043945069",
  appId: "1:225043945069:web:19d7237fefcd4e7be0d164"
};

// Cloudinary console → Dashboard (cloud name, top left) → Settings → Upload →
// "Upload presets" → Add upload preset → set Signing Mode to "Unsigned" → Save
window.CLOUDINARY_CONFIG = {
  cloudName: "d98pty0j",
  uploadPreset: "lp4xv77t"
};
