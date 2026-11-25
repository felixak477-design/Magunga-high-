
import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  signOut
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

import {
  doc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

import { uploadProfileImage } from "./cloudinary.js";

export async function registerStudent(
  name,
  email,
  password,
  stream,
  photoFile = null
) {
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

  let photoURL = "";

  if (photoFile) {
    photoURL = await uploadProfileImage(photoFile);
  }

  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    password
  );

  const uid = credential.user.uid;

  const batch = writeBatch(db);

  // Private student account
  batch.set(doc(db, "users", uid), {
    name,
    email,
    stream,
    role: "member",
    status: "pending",
    ...(photoURL ? { photoURL } : {}),
    createdAt: serverTimestamp()
  });

  // Public student profile
  batch.set(doc(db, "publicProfiles", uid), {
    name,
    stream,
    status: "pending",
    ...(photoURL ? { photoURL } : {}),
    createdAt: serverTimestamp()
  });

  await batch.commit();

  // Send Firebase email verification.
  await sendEmailVerification(credential.user, {
    url: "https://magunga-high.vercel.app/verify-email.html",
    handleCodeInApp: false
  });

  // Prevent access to the student portal before verification.
  await signOut(auth);

  return {
    success: true,
    email
  };
}

export async function loginStudent(email, password) {
  const credential = await signInWithEmailAndPassword(
    auth,
    email,
    password
  );

  return credential.user;
}

export async function logoutStudent() {
  await signOut(auth);
}
