
import { auth, db } from "./firebase.js";

import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

export async function getAdminProfile() {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please log in first.");
  }

  const profile = await getDoc(doc(db, "users", user.uid));

  if (!profile.exists()) {
    throw new Error("Administrator profile not found.");
  }

  const data = profile.data();

  if (
    data.status !== "approved" ||
    !["superadmin", "streamAdmin"].includes(data.role)
  ) {
    throw new Error("You do not have administrator access.");
  }

  return {
    uid: user.uid,
    name: data.name,
    role: data.role,
    stream: data.stream
  };
}

export async function getPendingStudents() {
  const admin = await getAdminProfile();

  let studentQuery;

  if (admin.role === "superadmin") {
    studentQuery = query(
      collection(db, "users"),
      where("status", "==", "pending")
    );
  } else {
    studentQuery = query(
      collection(db, "users"),
      where("status", "==", "pending"),
      where("stream", "==", admin.stream)
    );
  }

  const results = await getDocs(studentQuery);

  return results.docs.map(student => ({
    id: student.id,
    ...student.data()
  }));
}

async function updateStudentStatus(studentId, newStatus) {
  if (!["approved", "rejected"].includes(newStatus)) {
    throw new Error("Invalid student status.");
  }

  const admin = await getAdminProfile();

  const studentRef = doc(db, "users", studentId);
  const studentProfile = await getDoc(studentRef);

  if (!studentProfile.exists()) {
    throw new Error("Student account not found.");
  }

  const student = studentProfile.data();

  if (student.status !== "pending") {
    throw new Error("This registration has already been reviewed.");
  }

  if (
    admin.role !== "superadmin" &&
    student.stream !== admin.stream
  ) {
    throw new Error("You cannot manage another stream.");
  }

  await updateDoc(studentRef, {
    status: newStatus,
    reviewedBy: admin.uid,
    reviewedAt: serverTimestamp()
  });

  return true;
}

export async function approveStudent(studentId) {
  return updateStudentStatus(studentId, "approved");
}

export async function rejectStudent(studentId) {
  return updateStudentStatus(studentId, "rejected");
}
