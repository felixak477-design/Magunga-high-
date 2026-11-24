
import { createSign } from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function validId(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,150}$/.test(value);
}

async function getFirebaseAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  }));

  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
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

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Firebase server authentication failed.");
  }

  return data.access_token;
}

async function readDocument(projectId, path, headers) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { headers }
  );

  return {
    ok: response.ok,
    data: await response.json()
  };
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
      FIREBASE_PROJECT_ID,
      FIREBASE_SERVICE_ACCOUNT,
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    } = process.env;

    if (
      !FIREBASE_WEB_API_KEY ||
      !FIREBASE_PROJECT_ID ||
      !FIREBASE_SERVICE_ACCOUNT ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return res.status(500).json({
        error: "Server configuration is incomplete."
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

    // Verify the signed-in Firebase user.
    const verifyResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ idToken })
      }
    );

    const verifyData = await verifyResponse.json();

    if (!verifyResponse.ok || !verifyData.users?.length) {
      return res.status(401).json({
        error: "Your login session is invalid."
      });
    }

    const uid = verifyData.users[0].localId;

    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    const accessToken =
      await getFirebaseAccessToken(serviceAccount);

    const headers = {
      Authorization: `Bearer ${accessToken}`
    };

    // Check that the user is approved.
    const profileResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `users/${encodeURIComponent(uid)}`,
      headers
    );

    const profile = profileResult.data;

    if (
      !profileResult.ok ||
      profile.fields?.status?.stringValue !== "approved"
    ) {
      return res.status(403).json({
        error: "Only approved students can delete chat files."
      });
    }

    const userStream =
      profile.fields?.stream?.stringValue || "";

    const {
      chatType = "group",
      messageId,
      chatId
    } = req.body || {};

    if (!validId(messageId)) {
      return res.status(400).json({
        error: "Invalid message ID."
      });
    }

    let messagePath = "";
    let allowedFilePrefix = "";

    if (chatType === "group") {
      messagePath =
        `groupMessages/${encodeURIComponent(messageId)}`;

      allowedFilePrefix = `chatfiles/group/${uid}/`;

    } else if (chatType === "stream") {
      messagePath =
        `messages/${encodeURIComponent(messageId)}`;

    } else if (chatType === "private") {
      if (!validId(chatId)) {
        return res.status(400).json({
          error: "Invalid private chat ID."
        });
      }

      const chatResult = await readDocument(
        FIREBASE_PROJECT_ID,
        `privateChats/${encodeURIComponent(chatId)}`,
        headers
      );

      const participants =
        chatResult.data.fields?.participants?.arrayValue?.values || [];

      const isParticipant = participants.some(
        item => item.stringValue === uid
      );

      if (!chatResult.ok || !isParticipant) {
        return res.status(403).json({
          error: "You are not a participant in this private chat."
        });
      }

      messagePath =
        `privateChats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;

      allowedFilePrefix = `chatfiles/private/${chatId}/${uid}/`;

    } else {
      return res.status(400).json({
        error: "Unknown chat type."
      });
    }

    const messageResult = await readDocument(
      FIREBASE_PROJECT_ID,
      messagePath,
      headers
    );

    const messageData = messageResult.data;

    if (!messageResult.ok || !messageData.fields) {
      return res.status(404).json({
        error: "Message was not found."
      });
    }

    const fields = messageData.fields;

    // Only the original sender may remove their attachment.
    if (fields.senderId?.stringValue !== uid) {
      return res.status(403).json({
        error: "You can only delete your own attachment."
      });
    }

    // The message must already have been unsent.
    if (fields.deleted?.booleanValue !== true) {
      return res.status(403).json({
        error: "Unsend the message before deleting its attachment."
      });
    }

    // Stream attachments must belong to the sender's own stream.
    if (chatType === "stream") {
      const messageStream =
        fields.stream?.stringValue || "";

      if (!userStream || messageStream !== userStream) {
        return res.status(403).json({
          error: "This message does not belong to your stream."
        });
      }

      const streamKey = userStream.replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );

      allowedFilePrefix =
        `chatfiles/stream/${streamKey}/${uid}/`;
    }

    const filePath = fields.filePath?.stringValue;

    if (
      typeof filePath !== "string" ||
      !filePath.startsWith(allowedFilePrefix) ||
      filePath.includes("..") ||
      filePath.includes("\\") ||
      filePath.startsWith("/")
    ) {
      return res.status(400).json({
        error: "Invalid attachment path."
      });
    }

    // Remove the object from the private storage bucket.
    const deleteResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/magunga-library`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          apikey: SUPABASE_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prefixes: [filePath]
        })
      }
    );

    if (!deleteResponse.ok) {
      const errorData = await deleteResponse.text();
      console.error("Storage deletion error:", errorData);

      return res.status(500).json({
        error: "Could not delete the attachment from storage."
      });
    }

    return res.status(200).json({
      success: true
    });

  } catch (error) {
    console.error("Chat file deletion error:", error);

    return res.status(500).json({
      error: "Could not delete the chat attachment."
    });
  }
}
