
import { createSign } from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
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

    const profileResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      { headers }
    );

    const profileData = await profileResponse.json();

    if (
      !profileResponse.ok ||
      profileData.fields?.status?.stringValue !== "approved"
    ) {
      return res.status(403).json({
        error: "Only approved students can download group files."
      });
    }

    const { messageId } = req.body || {};

    if (
      typeof messageId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,150}$/.test(messageId)
    ) {
      return res.status(400).json({
        error: "Invalid message ID."
      });
    }

    const messageResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/groupMessages/${encodeURIComponent(messageId)}`,
      { headers }
    );

    const messageData = await messageResponse.json();

    if (!messageResponse.ok || !messageData.fields) {
      return res.status(404).json({
        error: "Message was not found."
      });
    }

    const fields = messageData.fields;

    if (fields.deleted?.booleanValue === true) {
      return res.status(404).json({
        error: "This message has been deleted."
      });
    }

    const filePath = fields.filePath?.stringValue;

    if (
      typeof filePath !== "string" ||
      !filePath.startsWith("groupchat/") ||
      filePath.includes("..")
    ) {
      return res.status(400).json({
        error: "This message has no valid attachment."
      });
    }

    const encodedPath = filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const signResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/magunga-library/${encodedPath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          apikey: SUPABASE_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expiresIn: 3600
        })
      }
    );

    const signData = await signResponse.json();

    if (!signResponse.ok || !signData.signedURL) {
      console.error("Download signing error:", signData);

      return res.status(500).json({
        error: "Could not prepare the secure download."
      });
    }

    const downloadUrl = signData.signedURL.startsWith("http")
      ? signData.signedURL
      : `${SUPABASE_URL}/storage/v1${signData.signedURL}`;

    return res.status(200).json({
      url: downloadUrl
    });

  } catch (error) {
    console.error("Group chat download error:", error);

    return res.status(500).json({
      error: "Could not prepare the file download."
    });
  }
}
