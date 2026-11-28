
import { createSign } from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(serviceAccount) {
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
    throw new Error("Firebase authentication failed.");
  }

  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
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

    // Authenticate the requester.
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
    const verifiedUser = verifyData.users?.[0];

    if (!verifyResponse.ok || !verifiedUser) {
      return res.status(401).json({
        error: "Invalid login session."
      });
    }

    const uid = verifiedUser.localId;

    const serviceAccount = JSON.parse(
      FIREBASE_SERVICE_ACCOUNT
    );

    if (
      serviceAccount.project_id !== FIREBASE_PROJECT_ID
    ) {
      return res.status(500).json({
        error: "Firebase project configuration does not match."
      });
    }

    const accessToken =
      await getAccessToken(serviceAccount);

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    };

    const base =
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    // Check the requester's actual Firestore profile.
    const profileResponse = await fetch(
      `${base}/users/${encodeURIComponent(uid)}`,
      { headers }
    );

    const profileData = await profileResponse.json();
    const profile = profileData.fields;

    if (
      !profileResponse.ok ||
      !profile ||
      profile.role?.stringValue !== "superadmin" ||
      profile.status?.stringValue !== "approved"
    ) {
      return res.status(403).json({
        error: "Only an approved superadmin can view school applications."
      });
    }

    // Retrieve pending applications only.
    const queryResponse = await fetch(
      `${base}:runQuery`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [
              {
                collectionId: "schoolApplications"
              }
            ],
            where: {
              fieldFilter: {
                field: {
                  fieldPath: "status"
                },
                op: "EQUAL",
                value: {
                  stringValue: "pending"
                }
              }
            },
            orderBy: [
              {
                field: {
                  fieldPath: "submittedAt"
                },
                direction: "DESCENDING"
              }
            ],
            limit: 100
          }
        })
      }
    );

    const queryData = await queryResponse.json();

    if (!queryResponse.ok) {
      console.error("Application query error:", queryData);

      return res.status(500).json({
        error: "Could not retrieve school applications."
      });
    }

    const applications = queryData
      .filter(item => item.document)
      .map(item => {
        const document = item.document;
        const fields = document.fields || {};

        return {
          applicationUid:
            fields.applicantUid?.stringValue || "",

          schoolName:
            fields.schoolName?.stringValue || "",

          schoolType:
            fields.schoolType?.stringValue || "",

          county:
            fields.county?.stringValue || "",

          subCounty:
            fields.subCounty?.stringValue || "",

          location:
            fields.location?.stringValue || "",

          applicantName:
            fields.applicantName?.stringValue || "",

          email:
            fields.email?.stringValue || "",

          phone:
            fields.phone?.stringValue || "",

          position:
            fields.position?.stringValue || "",

          status:
            fields.status?.stringValue || "pending",

          submittedAt:
            fields.submittedAt?.timestampValue || null
        };
      });

    return res.status(200).json({
      success: true,
      count: applications.length,
      applications
    });

  } catch (error) {
    console.error("List school applications error:", error);

    return res.status(500).json({
      error: "Could not load school applications."
    });
  }
}
