
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

    // Check administrator profile
    const profileResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/magunga-high/databases/(default)/documents/users/${encodeURIComponent(uid)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` }
      }
    );

    if (!profileResponse.ok) {
      return res.status(403).json({ error: "Unable to verify profile" });
    }

    const profile = await profileResponse.json();
    const fields = profile.fields || {};

    if (
      fields.status?.stringValue !== "approved" ||
      !["superadmin", "streamAdmin"].includes(fields.role?.stringValue)
    ) {
      return res.status(403).json({ error: "Administrator approval required" });
    }

    // Validate resource ID
    const { resourceId } = req.body || {};

    if (
      typeof resourceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,150}$/.test(resourceId)
    ) {
      return res.status(400).json({ error: "Invalid resource ID" });
    }

    // Retrieve resource from Firestore
    const resourceResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/magunga-high/databases/(default)/documents/libraryResources/${encodeURIComponent(resourceId)}`,
      {
        headers: { Authorization: `Bearer ${idToken}` }
      }
    );

    if (!resourceResponse.ok) {
      return res.status(404).json({ error: "Resource not found" });
    }

    const resource = await resourceResponse.json();
    const filePath = resource.fields?.filePath?.stringValue;

    if (
      typeof filePath !== "string" ||
      !filePath.startsWith("library/") ||
      filePath.includes("..")
    ) {
      return res.status(400).json({ error: "Invalid file location" });
    }

    // Delete PDF from Supabase
    const deleteResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/magunga-library`,
      {
        method: "DELETE",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prefixes: [filePath]
        })
      }
    );

    if (!deleteResponse.ok) {
      console.error("Supabase delete failed:", deleteResponse.status);
      return res.status(502).json({ error: "Could not delete PDF from storage" });
    }

    return res.status(200).json({
      success: true,
      message: "PDF deleted from storage"
    });

  } catch (error) {
    console.error("Library delete error:", error);
    return res.status(500).json({ error: "Server error" });
  }
};
