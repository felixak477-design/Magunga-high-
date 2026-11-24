
import { auth, db } from "./firebase.js";

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  onSnapshot,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let profilePhotos = new Map();
let groupUnsubscribe = null;

const recordedViews = new Set();

function showStatus(message) {
  const element = $("groupStatus");
  if (element) element.textContent = message || "";
}

function getToken() {
  return auth.currentUser.getIdToken();
}

function formatTime(timestamp) {
  if (!timestamp?.toDate) return "";

  return timestamp.toDate().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function makeAvatar(name, photoURL = "") {
  const avatar = document.createElement("div");
  avatar.className = "messageAvatar";

  if (photoURL) {
    const image = document.createElement("img");
    image.className = "messageAvatarImage";
    image.src = photoURL;
    image.alt = "";

    image.onerror = () => {
      avatar.replaceChildren();
      avatar.textContent = (name || "S")[0].toUpperCase();
    };

    avatar.appendChild(image);
  } else {
    avatar.textContent = (name || "S")[0].toUpperCase();
  }

  return avatar;
}

/* FILE UPLOAD */

async function uploadGroupFile(file) {
  const token = await getToken();

  const response = await fetch("/api/chat-upload-url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Could not prepare file upload.");
  }

  const encodedPath = data.path
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const uploadResponse = await fetch(
    `${data.supabaseUrl}/storage/v1/object/upload/sign/magunga-library/${encodedPath}?token=${encodeURIComponent(data.token)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    }
  );

  if (!uploadResponse.ok) {
    throw new Error("File upload failed. Please try again.");
  }

  return data.path;
}

/* SEND GROUP MESSAGE */

async function sendGroupMessage(event) {
  event.preventDefault();

  const input = $("groupInput");
  const fileInput = $("groupFile");

  const text = input.value.trim();
  const file = fileInput?.files?.[0] || null;

  if (!currentUser || !currentProfile) return;

  if (!text && !file) {
    showStatus("Write a message or attach a file.");
    return;
  }

  const sendButton = $("groupSend");

  try {
    sendButton.disabled = true;
    showStatus(file ? "Uploading file..." : "Sending...");

    let filePath = "";

    if (file) {
      filePath = await uploadGroupFile(file);
    }

    const message = {
      senderId: currentUser.uid,
      senderName:
        currentProfile.name ||
        currentUser.displayName ||
        "Student",
      text,
      createdAt: serverTimestamp()
    };

    if (file) {
      message.filePath = filePath;
      message.fileName = file.name;
      message.fileType = file.type;
      message.fileSize = file.size;
    }

    await addDoc(collection(db, "groupMessages"), message);

    input.value = "";
    fileInput.value = "";

    const preview = $("groupFileName");
    if (preview) preview.textContent = "";

    showStatus("");

  } catch (error) {
    showStatus(error.message || "Message could not be sent.");
  } finally {
    sendButton.disabled = false;
  }
}

/* SECURE FILE DOWNLOAD */

async function downloadGroupFile(messageId, fileName) {
  try {
    showStatus("Preparing file...");

    const token = await getToken();

    const response = await fetch("/api/chat-download-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ messageId })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not open this file.");
    }

    const link = document.createElement("a");
    link.href = data.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.download = fileName || "attachment";
    document.body.appendChild(link);
    link.click();
    link.remove();

    showStatus("");

  } catch (error) {
    showStatus(error.message);
  }
}

/* RECORD WHO VIEWED A MESSAGE */

async function recordMessageView(messageId) {
  if (!currentUser || !currentProfile) return;

  const key = `${messageId}_${currentUser.uid}`;

  if (recordedViews.has(key)) return;

  recordedViews.add(key);

  try {
    await setDoc(
      doc(
        db,
        "groupMessages",
        messageId,
        "views",
        currentUser.uid
      ),
      {
        viewerId: currentUser.uid,
        viewerName:
          currentProfile.name ||
          currentUser.displayName ||
          "Student",
        viewedAt: serverTimestamp()
      },
      { merge: true }
    );
  } catch (error) {
    recordedViews.delete(key);
    console.warn("Could not record message view:", error);
  }
}

/* SHOW WHO VIEWED */

async function showMessageViews(messageId) {
  try {
    const snapshot = await getDocs(
      collection(db, "groupMessages", messageId, "views")
    );

    const modal = $("groupViewsModal");
    const list = $("groupViewsList");

    list.replaceChildren();

    if (snapshot.empty) {
      const empty = document.createElement("p");
      empty.textContent = "Nobody has viewed this message yet.";
      list.appendChild(empty);
    } else {
      snapshot.docs.forEach(item => {
        const data = item.data();

        const row = document.createElement("div");
        row.className = "groupViewer";

        const name = document.createElement("strong");
        name.textContent = data.viewerName || "Student";

        const time = document.createElement("small");
        time.textContent = formatTime(data.viewedAt);

        row.append(name, time);
        list.appendChild(row);
      });
    }

    modal.classList.remove("hidden");

  } catch (error) {
    showStatus("Could not load viewers: " + error.message);
  }
}

/* UNSEND MESSAGE */

async function unsendGroupMessage(messageId) {
  const messageRef = doc(db, "groupMessages", messageId);

  try {
    const messageSnapshot = await import(
      "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js"
    ).then(module => module.getDoc(messageRef));

    if (!messageSnapshot.exists()) {
      throw new Error("Message no longer exists.");
    }

    const data = messageSnapshot.data();

    if (data.senderId !== currentUser.uid) {
      throw new Error("You can only unsend your own message.");
    }

    if (data.deleted === true) return;

    await updateDoc(messageRef, {
      text: "",
      deleted: true,
      deletedAt: serverTimestamp()
    });

    // Remove the attachment from private storage, if one exists.
    if (data.filePath) {
      try {
        const token = await getToken();

        const response = await fetch("/api/chat-delete-file", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ messageId })
        });

        if (!response.ok) {
          console.warn("The message was unsent, but file cleanup failed.");
        }
      } catch (error) {
        console.warn("Attachment cleanup failed:", error);
      }
    }

    showStatus("");

  } catch (error) {
    showStatus(error.message || "Could not unsend message.");
  }
}

/* MESSAGE OPTIONS MENU */

function closeGroupMenu() {
  $("groupMessageMenu").classList.add("hidden");
  $("groupMessageMenu").dataset.messageId = "";
}

function openGroupMenu(messageId, x, y) {
  const menu = $("groupMessageMenu");

  menu.dataset.messageId = messageId;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 175))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 110))}px`;
  menu.classList.remove("hidden");
}

/* BUILD GROUP MESSAGE */

function createGroupMessage(item) {
  const data = item.data();
  const mine = data.senderId === currentUser.uid;

  const row = document.createElement("div");
  row.className = "messageRow";

  if (mine) row.classList.add("mine");

  const name = data.senderName || "Student";
  const photo = profilePhotos.get(data.senderId) || "";

  const bubble = document.createElement("div");
  bubble.className = "message groupMessageBubble";

  if (mine) bubble.classList.add("mine");

  if (data.deleted === true) {
    const deleted = document.createElement("p");
    deleted.className = "deletedMessage";
    deleted.textContent = mine
      ? "You deleted this message."
      : "This message was deleted.";

    bubble.appendChild(deleted);

  } else {
    const sender = document.createElement("strong");
    sender.textContent = mine ? "You" : name;

    const messageText = document.createElement("p");
    messageText.textContent = data.text || "";

    bubble.append(sender);

    if (data.text) {
      bubble.appendChild(messageText);
    }

    if (data.filePath) {
      const fileButton = document.createElement("button");
      fileButton.type = "button";
      fileButton.className = "groupAttachment";
      fileButton.textContent = "📎 " + (data.fileName || "Attachment");

      fileButton.addEventListener("click", () => {
        downloadGroupFile(item.id, data.fileName);
      });

      bubble.appendChild(fileButton);
    }

    const time = document.createElement("small");
    time.textContent = formatTime(data.createdAt);
    bubble.appendChild(time);

    if (!mine) {
      recordMessageView(item.id);
    }

    if (mine) {
      attachLongPress(row, item.id);
    }
  }

  const avatar = makeAvatar(name, photo);

  if (mine) {
    row.append(bubble, avatar);
  } else {
    row.append(avatar, bubble);
  }

  return row;
}

/* LONG PRESS SUPPORT */

function attachLongPress(element, messageId) {
  let pressTimer = null;
  let startX = 0;
  let startY = 0;

  function clearTimer() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  }

  element.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;

    startX = event.clientX;
    startY = event.clientY;

    clearTimer();

    pressTimer = setTimeout(() => {
      openGroupMenu(messageId, startX, startY);
    }, 550);
  });

  element.addEventListener("pointermove", event => {
    if (
      Math.abs(event.clientX - startX) > 12 ||
      Math.abs(event.clientY - startY) > 12
    ) {
      clearTimer();
    }
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach(type => {
    element.addEventListener(type, clearTimer);
  });

  element.addEventListener("contextmenu", event => {
    event.preventDefault();

    if (navigator.vibrate) navigator.vibrate(25);

    openGroupMenu(messageId, event.clientX, event.clientY);
  });
}

/* RENDER GROUP MESSAGES */

function renderGroupMessages(snapshot) {
  const container = $("groupMessages");
  container.replaceChildren();

  const messages = [...snapshot.docs].sort((a, b) => {
    const first = a.data().createdAt?.toMillis?.() || 0;
    const second = b.data().createdAt?.toMillis?.() || 0;
    return first - second;
  });

  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No messages yet. Start the conversation!";
    container.appendChild(empty);
    return;
  }

  let previousDate = "";

  messages.forEach(item => {
    const date = item.data().createdAt?.toDate?.() || new Date();
    const dateLabel = date.toLocaleDateString();

    if (dateLabel !== previousDate) {
      const separator = document.createElement("div");
      separator.className = "groupDateSeparator";
      separator.textContent = dateLabel;
      container.appendChild(separator);
      previousDate = dateLabel;
    }

    container.appendChild(createGroupMessage(item));
  });

  container.scrollTop = container.scrollHeight;
}

/* START AND STOP GROUP CHAT */

function stopGroupChat() {
  if (groupUnsubscribe) groupUnsubscribe();
  groupUnsubscribe = null;
}

function loadGroupChat() {
  stopGroupChat();

  groupUnsubscribe = onSnapshot(
    collection(db, "groupMessages"),
    snapshot => renderGroupMessages(snapshot),
    error => showStatus("Unable to load group messages: " + error.message)
  );
}

/* INITIALIZE GROUP CHAT */

export function initGroupChat(user, profile, photos = new Map()) {
  currentUser = user;
  currentProfile = profile;
  profilePhotos = photos;

  $("groupForm").addEventListener("submit", sendGroupMessage);

  $("groupAttach").addEventListener("click", () => {
    $("groupFile").click();
  });

  $("groupFile").addEventListener("change", event => {
    const file = event.target.files[0];
    $("groupFileName").textContent = file
      ? `Selected: ${file.name}`
      : "";
  });

  $("groupMessageMenu").addEventListener("click", async event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const messageId = $("groupMessageMenu").dataset.messageId;

    if (!action || !messageId) return;

    closeGroupMenu();

    if (action === "unsend") {
      await unsendGroupMessage(messageId);
    }

    if (action === "views") {
      await showMessageViews(messageId);
    }
  });

  $("groupViewsClose").addEventListener("click", () => {
    $("groupViewsModal").classList.add("hidden");
  });

  $("groupViewsModal").addEventListener("click", event => {
    if (event.target === $("groupViewsModal")) {
      $("groupViewsModal").classList.add("hidden");
    }
  });

  document.addEventListener("click", event => {
    if (
      !$("groupMessageMenu").contains(event.target)
    ) {
      closeGroupMenu();
    }
  });

  loadGroupChat();

  return {
    load: loadGroupChat,
    stop: stopGroupChat
  };
}
