
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const firebaseKey = process.env.FIREBASE_WEB_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY;

    if (!firebaseKey || !supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: "Server configuration missing" });
    }

    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!idToken) {
      return res.status(401).json({ error: "Please log in" });
    }

    // Verify Firebase login
    const verifyResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      }
    );

    if (!verifyResponse.ok) {
      return res.status(401).json({ error: "Invalid login" });
    }

    const verified = await verifyResponse.json();
    const uid = verified.users?.[0]?.localId;

    if (!uid) {
      return res.status(401).json({ error: "User not found" });
    }

    // Read the user's Firestore profile
    const profileResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/magunga-high/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` }
      }
    );

    if (!profileResponse.ok) {
      return res.status(403).json({ error: "Unable to verify your profile" });
    }

    const profile = await profileResponse.json();
    const fields = profile.fields || {};

    const status = fields.status?.stringValue;
    const role = fields.role?.stringValue;

    if (
      status !== "approved" ||
      !["superadmin", "streamAdmin"].includes(role)
    ) {
      return res.status(403).json({ error: "Administrator approval required" });
    }

    // Validate the PDF details
    const { fileName, fileSize, contentType } = req.body || {};

    if (
      typeof fileName !== "string" ||
      !fileName.toLowerCase().endsWith(".pdf") ||
      typeof fileSize !== "number" ||
      fileSize <= 0 ||
      fileSize > 20 * 1024 * 1024 ||
      contentType !== "application/pdf"
    ) {
      return res.status(400).json({ error: "Invalid PDF or file size" });
    }

    const safeName = fileName
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 120);

    const path = `library/${uid}/${crypto.randomUUID()}_${safeName}`;

    // Request a temporary signed upload permission from Supabase
    const signResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/magunga-library/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ upsert: false })
      }
    );

    const signData = await signResponse.json();

    if (!signResponse.ok || !signData.token) {
      return res.status(502).json({ error: "Could not create upload permission" });
    }

    return res.status(200).json({
      path,
      token: signData.token
    });

  } catch (error) {
    console.error("Library upload permission error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};
