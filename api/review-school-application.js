
import { createSign, randomBytes } from "node:crypto";

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
    throw new Error("Firebase authentication failed.");
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

    // Authenticate the reviewer.
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
    const reviewer = verifyData.users?.[0];

    if (!verifyResponse.ok || !reviewer) {
      return res.status(401).json({
        error: "Invalid login session."
      });
    }

    const reviewerUid = reviewer.localId;

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
      await getFirebaseAccessToken(serviceAccount);

    const headers = {
      Authorization: `Bearer ${accessToken}`
    };

    // Confirm reviewer is an approved superadmin.
    const reviewerResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `users/${encodeURIComponent(reviewerUid)}`,
      headers
    );

    const reviewerFields = reviewerResult.data.fields;

    if (
      !reviewerResult.ok ||
      !reviewerFields ||
      reviewerFields.role?.stringValue !== "superadmin" ||
      reviewerFields.status?.stringValue !== "approved"
    ) {
      return res.status(403).json({
        error: "Only an approved superadmin can review school applications."
      });
    }

    const applicationUid =
      typeof req.body?.applicationUid === "string"
        ? req.body.applicationUid.trim()
        : "";

    const action =
      typeof req.body?.action === "string"
        ? req.body.action.trim()
        : "";

    if (
      !applicationUid ||
      applicationUid.length > 128 ||
      !["approve", "reject"].includes(action)
    ) {
      return res.status(400).json({
        error: "Invalid application or review action."
      });
    }

    // Load the application.
    const applicationResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `schoolApplications/${encodeURIComponent(applicationUid)}`,
      headers
    );

    if (
      !applicationResult.ok ||
      !applicationResult.data.fields
    ) {
      return res.status(404).json({
        error: "School application not found."
      });
    }

    const fields = applicationResult.data.fields;

    if (fields.status?.stringValue !== "pending") {
      return res.status(409).json({
        error: "This application has already been reviewed."
      });
    }

    const applicantUid = fields.applicantUid?.stringValue;
    const applicantEmail = fields.email?.stringValue;
    const schoolName = fields.schoolName?.stringValue;
    const schoolType = fields.schoolType?.stringValue;
    const county = fields.county?.stringValue;
    const subCounty = fields.subCounty?.stringValue;
    const location = fields.location?.stringValue;
    const applicantName = fields.applicantName?.stringValue;

    if (
      !applicantUid ||
      applicantUid !== applicationUid ||
      !applicantEmail ||
      !schoolName ||
      !schoolType ||
      !county ||
      !subCounty ||
      !location ||
      !applicantName
    ) {
      return res.status(400).json({
        error: "The application contains incomplete information."
      });
    }

    const base =
      `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    const applicationPath =
      `${base}/schoolApplications/${applicationUid}`;

    const now = new Date().toISOString();

    // Rejection does not create a school or administrator.
    if (action === "reject") {
      const rejectResponse = await fetch(
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
                  name: applicationPath,
                  fields: {
                    status: { stringValue: "rejected" },
                    reviewedBy: { stringValue: reviewerUid },
                    reviewedAt: { timestampValue: now }
                  }
                },
                updateMask: {
                  fieldPaths: [
                    "status",
                    "reviewedBy",
                    "reviewedAt"
                  ]
                }
              }
            ]
          })
        }
      );

      if (!rejectResponse.ok) {
        return res.status(500).json({
          error: "Could not reject this application."
        });
      }

      return res.status(200).json({
        success: true,
        status: "rejected"
      });
    }

    // Do not overwrite an existing user account.
    const existingUser = await readDocument(
      FIREBASE_PROJECT_ID,
      `users/${encodeURIComponent(applicantUid)}`,
      headers
    );

    if (existingUser.ok) {
      return res.status(409).json({
        error: "The applicant already has a user profile. Resolve that account before approval."
      });
    }

    // Generate a difficult-to-guess School ID.
    // The Firestore create precondition prevents overwriting
    // a school if an ID collision ever occurs.
    let schoolId = "";
    let commitResponse;
    let commitData;

    for (let attempt = 0; attempt < 3; attempt++) {
      schoolId =
        "MGH-SCH-" + randomBytes(8).toString("hex").toUpperCase();

      const schoolPath = `${base}/schools/${schoolId}`;
      const userPath = `${base}/users/${applicantUid}`;

      const writes = [
        {
          update: {
            name: applicationPath,
            fields: {
              status: { stringValue: "approved" },
              schoolId: { stringValue: schoolId },
              reviewedBy: { stringValue: reviewerUid },
              reviewedAt: { timestampValue: now }
            }
          },
          updateMask: {
            fieldPaths: [
              "status",
              "schoolId",
              "reviewedBy",
              "reviewedAt"
            ]
          }
        },
        {
          update: {
            name: schoolPath,
            fields: {
              schoolId: { stringValue: schoolId },
              schoolName: { stringValue: schoolName },
              schoolType: { stringValue: schoolType },
              county: { stringValue: county },
              subCounty: { stringValue: subCounty },
              location: { stringValue: location },
              status: { stringValue: "approved" },
              primaryAdminUid: { stringValue: applicantUid },
              createdAt: { timestampValue: now }
            }
          },
          currentDocument: {
            exists: false
          }
        },
        {
          update: {
            name: userPath,
            fields: {
              name: { stringValue: applicantName },
              email: { stringValue: applicantEmail },
              role: { stringValue: "schoolAdmin" },
              status: { stringValue: "approved" },
              schoolId: { stringValue: schoolId },
              createdAt: { timestampValue: now }
            }
          },
          currentDocument: {
            exists: false
          }
        }
      ];

      commitResponse = await fetch(
        `https://firestore.googleapis.com/v1/${base}:commit`,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ writes })
        }
      );

      commitData = await commitResponse.json();

      if (commitResponse.ok) {
        return res.status(200).json({
          success: true,
          status: "approved",
          schoolId
        });
      }

      // Retry only if the generated school document already exists.
      const errorText = JSON.stringify(commitData);

      if (
        !errorText.includes("ALREADY_EXISTS") &&
        !errorText.includes("already exists")
      ) {
        console.error("School approval error:", commitData);

        return res.status(500).json({
          error: "Could not approve the school application."
        });
      }
    }

    return res.status(500).json({
      error: "Could not generate a unique School ID. Please retry."
    });

  } catch (error) {
    console.error("School review error:", error);

    return res.status(500).json({
      error: "School application review failed."
    });
  }
}
