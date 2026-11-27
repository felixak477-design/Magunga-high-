
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

function clean(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
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

    // Require a Firebase login token.
    const authorization = req.headers.authorization || "";

    const idToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!idToken) {
      return res.status(401).json({
        error: "Please sign in first."
      });
    }

    // Verify the account directly with Firebase.
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
        error: "Verify your email before applying."
      });
    }

    const uid = verifiedUser.localId;
    const verifiedEmail = verifiedUser.email;

    if (!uid || !verifiedEmail) {
      return res.status(401).json({
        error: "Account information is incomplete."
      });
    }

    // Validate application information.
    const body = req.body || {};

    const schoolName = clean(body.schoolName, 150);
    const schoolType = clean(body.schoolType, 40);
    const county = clean(body.county, 80);
    const subCounty = clean(body.subCounty, 80);
    const location = clean(body.location, 500);
    const applicantName = clean(body.applicantName, 120);
    const phone = clean(body.phone, 30);
    const position = clean(body.position, 60);

    const allowedSchoolTypes = [
      "Primary",
      "Junior",
      "Secondary",
      "Combined",
      "Other"
    ];

    const allowedPositions = [
      "Headteacher",
      "Principal",
      "Deputy",
      "Director",
      "Board Representative",
      "Other"
    ];

    if (
      !schoolName ||
      !schoolType ||
      !county ||
      !subCounty ||
      !location ||
      !applicantName ||
      !phone ||
      !position
    ) {
      return res.status(400).json({
        error: "Please complete all required fields."
      });
    }

    if (!allowedSchoolTypes.includes(schoolType)) {
      return res.status(400).json({
        error: "Invalid school type."
      });
    }

    if (!allowedPositions.includes(position)) {
      return res.status(400).json({
        error: "Invalid applicant position."
      });
    }

    if (
      schoolName.length < 3 ||
      applicantName.length < 3 ||
      phone.length < 7
    ) {
      return res.status(400).json({
        error: "Some application details are too short."
      });
    }

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

    // An existing student/admin profile cannot be reused
    // as a new school administrator application.
    const userResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `users/${encodeURIComponent(uid)}`,
      headers
    );

    if (userResult.ok) {
      return res.status(409).json({
        error: "This account already has a user profile. Use a separate account for school registration."
      });
    }

    // One application per authenticated account.
    const applicationResult = await readDocument(
      FIREBASE_PROJECT_ID,
      `schoolApplications/${encodeURIComponent(uid)}`,
      headers
    );

    if (applicationResult.ok) {
      return res.status(409).json({
        error: "An application already exists for this account."
      });
    }

    const base =
      `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    const applicationPath =
      `${base}/schoolApplications/${uid}`;

    // Create a pending application.
    // The applicant cannot choose a role, approval status,
    // or School ID.
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
                name: applicationPath,
                fields: {
                  schoolName: {
                    stringValue: schoolName
                  },
                  schoolType: {
                    stringValue: schoolType
                  },
                  county: {
                    stringValue: county
                  },
                  subCounty: {
                    stringValue: subCounty
                  },
                  location: {
                    stringValue: location
                  },
                  applicantName: {
                    stringValue: applicantName
                  },
                  email: {
                    stringValue: verifiedEmail
                  },
                  phone: {
                    stringValue: phone
                  },
                  position: {
                    stringValue: position
                  },
                  applicantUid: {
                    stringValue: uid
                  },
                  status: {
                    stringValue: "pending"
                  },
                  submittedAt: {
                    timestampValue: new Date().toISOString()
                  }
                }
              },
              currentDocument: {
                exists: false
              }
            }
          ]
        })
      }
    );

    const commitData = await commitResponse.json();

    if (!commitResponse.ok) {
      console.error("School application error:", commitData);

      return res.status(500).json({
        error: "Could not submit the school application."
      });
    }

    return res.status(201).json({
      success: true,
      status: "pending",
      message: "Your school application has been submitted for review."
    });

  } catch (error) {
    console.error("School application error:", error);

    return res.status(500).json({
      error: "School application could not be processed."
    });
  }
}
