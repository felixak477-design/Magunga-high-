
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
    const projectId = process.env.FIREBASE_PROJECT_ID;

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !firebaseApiKey ||
      !projectId
    ) {
      return res.status(500).json({
        error: "Server configuration is incomplete."
      });
    }

    // VERIFY LOGIN

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
        body: JSON.stringify({
          idToken
        })
      }
    );

    const verifyData = await verifyResponse.json();

    if (
      !verifyResponse.ok ||
      !verifyData.users ||
      !verifyData.users.length
    ) {
      return res.status(401).json({
        error: "Your login session is invalid. Please sign in again."
      });
    }

    const user = verifyData.users[0];
    const uid = user.localId;

    // VERIFY APPROVED ACCOUNT

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

    const accountStatus =
      profileData.fields.status?.stringValue;

    if (accountStatus !== "approved") {
      return res.status(403).json({
        error: "Only approved accounts can upload materials."
      });
    }

    // VALIDATE FILE DETAILS

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

    // CREATE A SAFE UNIQUE FILE PATH

    const safeName = fileName
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 150);

    const uniqueName =
      `${crypto.randomUUID()}_${safeName}`;

    const filePath = `library/${uid}/${uniqueName}`;

    // REQUEST SECURE SUPABASE UPLOAD TOKEN

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

      console.error(
        "Supabase signing error:",
        signData
      );

      return res.status(500).json({
        error: "Could not prepare the secure file upload."
      });
    }

    // RETURN UPLOAD DETAILS

    return res.status(200).json({
      path: filePath,
      token: signData.token
    });

  } catch (error) {

    console.error(
      "Library upload API error:",
      error
    );

    return res.status(500).json({
      error: "An unexpected upload error occurred."
    });

  }

}
