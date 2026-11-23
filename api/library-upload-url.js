
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;

    if (!supabaseUrl || !supabaseSecretKey || !firebaseApiKey) {
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

    // Verify the Firebase ID token.
    const verifyResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idToken
        })
      }
    );

    const verifyData = await verifyResponse.json();

    if (!verifyResponse.ok || !verifyData.users?.length) {
      return res.status(401).json({
        error: "Your login session is invalid. Please sign in again."
      });
    }

    const user = verifyData.users[0];
    const uid = user.localId;

    // Read the user's Firestore profile.
    const projectId = process.env.FIREBASE_PROJECT_ID;

    if (!projectId) {
      return res.status(500).json({
        error: "Firebase project configuration is missing."
      });
    }

    const profileResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
      {
        headers: {
          "Authorization": `Bearer ${idToken}`
        }
      }
    );

    const profileData = await profileResponse.json();

    if (!profileResponse.ok || !profileData.fields) {
      return res.status(403).json({
        error: "Your user profile could not be verified."
      });
    }

    const status = profileData.fields.status?.stringValue;

    if (status !== "approved") {
      return res.status(403).json({
        error: "Only approved accounts can upload library materials."
      });
    }

    // Validate the submitted PDF.
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

    if (
      contentType !== "application/pdf" ||
      !fileName.toLowerCase().endsWith(".pdf")
    ) {
      return res.status(400).json({
        error: "Only PDF documents are allowed."
      });
    }

    if (
      typeof fileSize !== "number" ||
      !Number.isFinite(fileSize) ||
      fileSize <= 0 ||
      fileSize > 20 * 1024 * 1024
    ) {
      return res.status(400).json({
        error: "PDF size must be between 1 byte and 20 MB."
      });
    }

    const safeName = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 150);

    const uniqueName =
      `${crypto.randomUUID()}_${safeName}`;

    const filePath = `library/${uid}/${uniqueName}`;

    // Request a signed upload token from Supabase.
    const signResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/magunga-library/${filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${supabaseSecretKey}`,
          "apikey": supabaseSecretKey,
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
        error: "Could not prepare the secure PDF upload."
      });
    }

    return res.status(200).json({
      path: filePath,
      token: signData.token
    });

  } catch (error) {
    console.error("Library upload API error:", error);

    return res.status(500).json({
      error: "An unexpected upload error occurred."
    });
  }
}
