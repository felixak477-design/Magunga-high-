
import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

import {
  doc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

// Register a new student
export async function registerStudent(name, email, password, stream) {
  const allowedStreams = [
    "Victors",
    "Heroes",
    "Winners",
    "Champions",
    "Archivers"
  ];

  if (!allowedStreams.includes(stream)) {
    throw new Error("Please select a valid stream.");
  }

  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    password
  );

  await setDoc(doc(db, "users", credential.user.uid), {
    name,
    email,
    stream,
    role: "member",
    status: "pending",
    createdAt: serverTimestamp()
  });

  return credential.user;
}

// Login
export async function loginStudent(email, password) {
  const credential = await signInWithEmailAndPassword(
    auth,
    email,
    password
  );

  return credential.user;
}

// Logout
export async function logoutStudent() {
  await signOut(auth);
}
