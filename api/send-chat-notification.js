
import { createSign } from "node:crypto";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  }));

  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: [
      "https://www.googleapis.com/auth/datastore",
      "https://www.googleapis.com/auth/firebase.messaging"
    ].join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));

  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");

  signer.update(unsigned);
  signer.end();

  const signature = signer
    .sign(serviceAccount.private_key)
    .toString("base64url");

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`
      })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error("Firebase server authentication failed.");
  }

  return result.access_token;
}

async function verifyUser(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.users?.length) {
    throw new Error("Invalid login session.");
  }

  return result.users[0].localId;
}

async function firestore(path, accessToken, options = {}) {
  return fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );
}

function getString(fields, name) {
  return fields?.[name]?.stringValue || "";
}

async function getDocument(path, accessToken) {
  const response = await firestore(path, accessToken);
  const data = await response.json();

  if (!response.ok) {
    return null;
  }

  return data;
}

async function getTokens(uid, accessToken) {
  const response = await firestore(
    `users/${encodeURIComponent(uid)}/fcmTokens?pageSize=100`,
    accessToken
  );

  if (!response.ok) return [];

  const result = await response.json();

  return (result.documents || [])
    .map(item => ({
      token: getString(item.fields, "token"),
      platform: getString(item.fields, "platform")
    }))
    .filter(item => item.token);
}

async function sendPush(token, title, body, data, accessToken) {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: {
            priority: "high",
            notification: {
              channel_id: "magunga_messages",
              sound: "default",
              default_sound: true
            }
          }
        }
      })
    }
  );

  return response.ok;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {
    const {
      FIREBASE_WEB_API_KEY,
      FIREBASE_SERVICE_ACCOUNT
    } = process.env;

    if (
      !PROJECT_ID ||
      !FIREBASE_WEB_API_KEY ||
      !FIREBASE_SERVICE_ACCOUNT
    ) {
      return res.status(500).json({
        error: "Firebase server configuration is incomplete."
      });
    }

    const authorization = req.headers.authorization || "";
    const idToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!idToken) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    const uid = await verifyUser(idToken);
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    const accessToken = await getAccessToken(serviceAccount);

    const profile = await getDocument(
      `users/${encodeURIComponent(uid)}`,
      accessToken
    );

    if (getString(profile?.fields, "status") !== "approved") {
      return res.status(403).json({
        error: "Approved student account required."
      });
    }

    const {
      chatType,
      messageId,
      chatId
    } = req.body || {};

    if (
      !["private", "group", "stream"].includes(chatType) ||
      typeof messageId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,150}$/.test(messageId)
    ) {
      return res.status(400).json({
        error: "Invalid message details."
      });
    }

    let messagePath = "";
    let recipients = [];

    if (chatType === "private") {
      if (
        typeof chatId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,150}$/.test(chatId)
      ) {
        return res.status(400).json({
          error: "Invalid private chat."
        });
      }

      const chat = await getDocument(
        `privateChats/${chatId}`,
        accessToken
      );

      const participants =
        chat?.fields?.participants?.arrayValue?.values || [];

      if (!participants.some(p => p.stringValue === uid)) {
        return res.status(403).json({
          error: "You are not in this conversation."
        });
      }

      recipients = participants
        .map(p => p.stringValue)
        .filter(id => id && id !== uid);

      messagePath =
        `privateChats/${chatId}/messages/${messageId}`;

    } else {
      messagePath =
        `${chatType === "group" ? "groupMessages" : "messages"}/${messageId}`;
    }

    const message = await getDocument(messagePath, accessToken);
    const fields = message?.fields;

    if (!fields || getString(fields, "senderId") !== uid) {
      return res.status(404).json({
        error: "Message not found or sender not verified."
      });
    }

    if (fields.deleted?.booleanValue === true) {
      return res.status(200).json({
        sent: 0,
        skipped: true
      });
    }

    const senderName =
      getString(fields, "senderName") || "A student";

    if (chatType === "stream") {
      const stream = getString(fields, "stream");
      const ownStream = getString(profile.fields, "stream");

      if (!stream || stream !== ownStream) {
        return res.status(403).json({
          error: "Stream message not authorized."
        });
      }

      const response = await firestore(
        "users?pageSize=1000",
        accessToken
      );

      if (!response.ok) {
        throw new Error("Could not load stream recipients.");
      }

      const users = await response.json();

      recipients = (users.documents || [])
        .filter(user =>
          getString(user.fields, "status") === "approved" &&
          getString(user.fields, "stream") === stream
        )
        .map(user => user.name.split("/").pop())
        .filter(id => id !== uid);

    } else if (chatType === "group") {
      const response = await firestore(
        "users?pageSize=1000",
        accessToken
      );

      if (!response.ok) {
        throw new Error("Could not load group recipients.");
      }

      const users = await response.json();

      recipients = (users.documents || [])
        .filter(user =>
          getString(user.fields, "status") === "approved"
        )
        .map(user => user.name.split("/").pop())
        .filter(id => id !== uid);
    }

    const title = chatType === "private"
      ? senderName
      : chatType === "stream"
        ? `${senderName} · Stream Chat`
        : `${senderName} · School Chat`;

    const body = getString(fields, "text") ||
      (fields.filePath ? "Sent an attachment" : "New message");

    let sent = 0;
    let failed = 0;

    for (const recipientId of recipients) {
      const tokens = await getTokens(recipientId, accessToken);

      for (const item of tokens) {
        const data = {
          type: chatType,
          messageId,
          senderId: uid,
          senderName
        };

        if (chatId) data.chatId = chatId;

        if (await sendPush(
          item.token,
          title,
          body.slice(0, 180),
          data,
          accessToken
        )) {
          sent++;
        } else {
          failed++;
        }
      }
    }

    return res.status(200).json({
      success: true,
      sent,
      failed
    });

  } catch (error) {
    console.error("Chat notification error:", error);

    return res.status(500).json({
      error: "Could not send the notification."
    });
  }
}
  
