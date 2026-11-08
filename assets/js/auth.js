
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

  await setDoc(doc(db, "users", credential.user.uid), {
    name,
    email,
    stream,
    role: "member",
    status: "pending",
    ...(photoURL ? { photoURL } : {}),
    createdAt: serverTimestamp()
  });

  return credential.user;
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
