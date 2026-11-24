import { randomUUID } from "node:crypto";

async function verifyUser(req) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!apiKey || !token) {
    throw new Error("Please sign in first.");
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.users?.length) {
    throw new Error("Your login session is invalid.");
  }

  const uid = data.users[0].localId;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  const profileResponse = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const profile = await profileResponse.json();

  if (!profileResponse.ok ||
      profile.fields?.status?.stringValue !== "approved") {
    throw new Error("Only approved students can upload files.");
  }

  return uid;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const uid = await verifyUser(req);

    const {
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        error: "Storage server configuration is incomplete."
      });
    }

    const { fileName, contentType, fileSize } = req.body || {};

    const allowed = {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
      "text/plain": [".txt"]
    };

    if (typeof fileName !== "string" ||
        !fileName.trim() ||
        fileName.length > 200) {
      return res.status(400).json({ error: "Invalid file name." });
    }

    const extension = fileName.trim().toLowerCase()
      .match(/\.[a-z0-9]+$/)?.[0];

    if (!allowed[contentType] ||
        !allowed[contentType].includes(extension)) {
      return res.status(400).json({
        error: "Allowed files: PDF, JPG, PNG, WEBP and TXT."
      });
    }

    if (typeof fileSize !== "number" ||
        fileSize <= 0 ||
        fileSize > 10 * 1024 * 1024) {
      return res.status(400).json({
        error: "Files must be smaller than 10 MB."
      });
    }

    const safeName = fileName.trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);

    const path = `groupchat/${uid}/${randomUUID()}_${safeName}`;

    const encodedPath = path.split("/")
      .map(encodeURIComponent).join("/");

    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/magunga-library/${encodedPath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          apikey: SUPABASE_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ upsert: false })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.token) {
      console.error("Storage signing error:", result);
      return res.status(500).json({
        error: "Could not prepare the file upload."
      });
    }

    return res.status(200).json({
      path,
      token: result.token,
      supabaseUrl: SUPABASE_URL
    });

  } catch (error) {
    return res.status(403).json({
      error: error.message || "Upload was not authorized."
    });
  }
}
