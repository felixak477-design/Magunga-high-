
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

    const authorization = req.headers.authorization || "";
    const idToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!idToken) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    // Verify Firebase account.
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

    if (!verifyResponse.ok || !verifyData.users?.length) {
      return res.status(401).json({
        error: "Your login session is invalid."
      });
    }

    const uid = verifyData.users[0].localId;

    // Retrieve the user's Firestore profile.
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
        error: "Your account profile could not be verified."
      });
    }

    const status = profileData.fields.status?.stringValue;
    const role = profileData.fields.role?.stringValue;

    if (status !== "approved" || role !== "superadmin") {
      return res.status(403).json({
        error: "Only the approved superadmin can delete library materials."
      });
    }

    // Validate resource ID.
    const resourceId = req.body?.resourceId;

    if (
      typeof resourceId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,150}$/.test(resourceId)
    ) {
      return res.status(400).json({
        error: "Invalid library resource ID."
      });
    }

    // Retrieve the resource metadata.
    const resourceResponse = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/libraryResources/${resourceId}`,
      {
        headers: {
          "Authorization": `Bearer ${idToken}`
        }
      }
    );

    const resourceData = await resourceResponse.json();

    if (resourceResponse.status === 404) {
      return res.status(404).json({
        error: "Library material was not found."
      });
    }

    if (!resourceResponse.ok) {
      return res.status(500).json({
        error: "Could not retrieve library material."
      });
    }

    const filePath =
      resourceData.fields?.filePath?.stringValue;

    if (
      typeof filePath !== "string" ||
      !filePath.startsWith("library/") ||
      filePath.includes("..")
    ) {
      return res.status(400).json({
        error: "Invalid storage file path."
      });
    }

    // Delete the PDF from the private Supabase bucket.
    const deleteResponse = await fetch(
      `${supabaseUrl}/storage/v1/object/magunga-library/${filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${supabaseSecretKey}`,
          "apikey": supabaseSecretKey
        }
      }
    );

    if (!deleteResponse.ok) {
      const errorData = await deleteResponse.json().catch(() => ({}));

      console.error("Supabase deletion error:", errorData);

      return res.status(500).json({
        error: "Could not delete the PDF from storage."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Library PDF deleted successfully."
    });

  } catch (error) {
    console.error("Library deletion API error:", error);

    return res.status(500).json({
      error: "An unexpected deletion error occurred."
    });
  }
}
