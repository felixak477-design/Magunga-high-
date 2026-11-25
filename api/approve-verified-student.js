
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

async function readDocument(projectId, path, headers) {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    { headers }
  );

  const data = await response.json();

  return {
    ok: response.ok,
    data
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
      FIREBASE_SERVICE_ACCOUNT
    } = process.env;

    if (
      !FIREBASE_WEB_API_KEY ||
      !FIREBASE_PROJECT_ID ||
      !FIREBASE_SERVICE_ACCOUNT
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

    // Verify the Firebase user's identity and email status.
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
    const verifiedUser = verifyData.users?.[0];

    if (!verifyResponse.ok || !verifiedUser) {
      return res.status(401).json({
        error: "Your login session is invalid."
      });
    }

    if (verifiedUser.emailVerified !== true) {
      return res.status(403).json({
        error: "Please verify your email address first."
      });
    }

    const uid = verifiedUser.localId;
    const verifiedEmail = verifiedUser.email;

    if (!uid || !verifiedEmail) {
      return res.status(401).json({
        error: "Your account information is incomplete."
      });
    }

    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

    if (serviceAccount.project_id !== FIREBASE_PROJECT_ID) {
      return res.status(500).json({
        error: "Firebase project configuration does not match."
      });
    }

    const accessToken =
      await getFirebaseAccessToken(serviceAccount);

    const headers = {
      Authorization: `Bearer ${accessToken}`
    };

    // Read the private student profile.
    const userResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `users/${encodeURIComponent(uid)}`,
      headers
    );

    if (!userResult.ok || !userResult.data.fields) {
      return res.status(404).json({
        error: "Student profile was not found."
      });
    }

    const fields = userResult.data.fields;

    const role = fields.role?.stringValue;
    const status = fields.status?.stringValue;
    const profileEmail = fields.email?.stringValue;

    // Never approve or modify administrator accounts.
    if (role !== "member") {
      return res.status(403).json({
        error: "This automatic approval is only for student accounts."
      });
    }

    if (
      !profileEmail ||
      profileEmail.toLowerCase() !== verifiedEmail.toLowerCase()
    ) {
      return res.status(403).json({
        error: "The verified email does not match the student profile."
      });
    }

    if (status === "approved") {
      return res.status(200).json({
        success: true,
        status: "approved"
      });
    }

    if (status !== "pending") {
      return res.status(403).json({
        error: "This account cannot be automatically approved."
      });
    }

    // Confirm the public profile exists before updating either profile.
    const publicResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `publicProfiles/${encodeURIComponent(uid)}`,
      headers
    );

    if (!publicResult.ok || !publicResult.data.fields) {
      return res.status(404).json({
        error: "Public student profile was not found."
      });
    }

    // Approve both profiles in one Firestore commit.
    const base =
      `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    const commitResponse = await fetch(
      `https://firestore.googleapis.com/v1/${base}:commit`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `${base}/users/${uid}`,
                fields: {
                  status: { stringValue: "approved" }
                }
              },
              updateMask: {
                fieldPaths: ["status"]
              }
            },
            {
              update: {
                name: `${base}/publicProfiles/${uid}`,
                fields: {
                  status: { stringValue: "approved" }
                }
              },
              updateMask: {
                fieldPaths: ["status"]
              }
            }
          ]
        })
      }
    );

    const commitData = await commitResponse.json();

    if (!commitResponse.ok) {
      console.error("Student approval error:", commitData);

      return res.status(500).json({
        error: "Could not approve the student account."
      });
    }

    return res.status(200).json({
      success: true,
      status: "approved"
    });

  } catch (error) {
    console.error("Automatic approval error:", error);

    return res.status(500).json({
      error: "Automatic approval failed."
    });
  }
}
