import { initializeApp } from
"https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";

import { getAuth } from
"https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

import { getFirestore } from
"https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBnnkdo4nCR0CuLmAGT3KoKtr4_sHfBl2I",
  authDomain: "magunga-high.firebaseapp.com",
  projectId: "magunga-high",
  storageBucket: "magunga-high.firebasestorage.app",
  messagingSenderId: "269431579701",
  appId: "1:269431579701:web:794a260163d67000e43d7c",
  measurementId: "G-QCHP6D65TM"

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
