
import { createSign, randomUUID } from "node:crypto";

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

  const unsignedToken = `${header}.${claims}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(
    serviceAccount.private_key
  ).toString("base64url");

  const assertion = `${unsignedToken}.${signature}`;

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
        assertion
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("Firebase token error:", data);
    throw new Error("Firebase server authentication failed.");
  }

  return data.access_token;
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const serviceAccountText =
      process.env.FIREBASE_SERVICE_ACCOUNT;

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !firebaseApiKey ||
      !projectId ||
      !serviceAccountText
    ) {
      return res.status(500).json({
        error: "Server configuration is incomplete."
      });
    }

    // LOAD FIREBASE SERVICE ACCOUNT

    let serviceAccount;

    try {
      serviceAccount = JSON.parse(serviceAccountText);
    } catch {
      return res.status(500).json({
        error: "Firebase service account configuration is invalid."
      });
    }

    if (
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      return res.status(500).json({
        error: "Firebase service account is missing required credentials."
      });
    }

    if (
      serviceAccount.project_id &&
      serviceAccount.project_id !== projectId
    ) {
      return res.status(500).json({
        error: "Firebase project ID does not match the service account."
      });
    }

    // VERIFY USER LOGIN

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
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ idToken })
      }
    );

    const verifyData = await verifyResponse.json();

    if (
      !verifyResponse.ok ||
      !verifyData.users?.length
    ) {
      return res.status(401).json({
        error: "Your login session is invalid. Sign in again."
      });
    }

    const uid = verifyData.users[0].localId;

    // AUTHENTICATE WITH FIREBASE ADMIN CREDENTIALS

    const accessToken =
      await getFirebaseAccessToken(serviceAccount);

    // READ USER PROFILE WITHOUT STUDENT FIRESTORE PERMISSIONS

    const profileResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const profileData = await profileResponse.json();

    if (
      profileResponse.status === 404 ||
      !profileData.fields
    ) {
      return res.status(403).json({
        error: "Your user profile was not found."
      });
    }

    if (!profileResponse.ok) {
      console.error("Firestore profile error:", profileData);

      return res.status(500).json({
        error: "Could not verify your account profile."
      });
    }

    const accountStatus =
      profileData.fields.status?.stringValue;

    if (accountStatus !== "approved") {
      return res.status(403).json({
        error: "Only approved accounts can upload materials."
      });
    }

    // VALIDATE FILE

    const {
      fileName,
      contentType,
      fileSize
    } = req.body || {};

    if (
      typeof fileName !== "string" ||
      !fileName.trim() ||
      fileName.length > 200
    ) {
      return res.status(400).json({
        error: "Invalid file name."
      });
    }

    const allowedFiles = {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"]
    };

    const extension = fileName
      .trim()
      .toLowerCase()
      .match(/\.[a-z0-9]+$/)?.[0];

    const validExtensions = allowedFiles[contentType];

    if (
      !validExtensions ||
      !extension ||
      !validExtensions.includes(extension)
    ) {
      return res.status(400).json({
        error: "Only PDF, JPG, JPEG, PNG and WEBP files are allowed."
      });
    }

    if (
      typeof fileSize !== "number" ||
      !Number.isFinite(fileSize) ||
      fileSize <= 0 ||
      fileSize > 20 * 1024 * 1024
    ) {
      return res.status(400).json({
        error: "File size must be between 1 byte and 20 MB."
      });
    }

    // CREATE UNIQUE STORAGE PATH

    const safeName = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 150);

    const uniqueName = `${randomUUID()}_${safeName}`;
    const filePath = `library/${uid}/${uniqueName}`;

    // CREATE SUPABASE SIGNED UPLOAD TOKEN

    const encodedPath = filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const signResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/magunga-library/${encodedPath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseSecretKey}`,
          apikey: supabaseSecretKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          upsert: false
        })
      }
    );

    const signData = await signResponse.json();

    if (!signResponse.ok || !signData.token) {
      console.error("Supabase signing error:", signData);

      return res.status(500).json({
        error: "Could not prepare the secure file upload."
      });
    }

    return res.status(200).json({
      path: filePath,
      token: signData.token
    });

  } catch (error) {

    console.error("Library upload API error:", error);

    return res.status(500).json({
      error: error.message ||
        "An unexpected upload error occurred."
    });

  }
}
