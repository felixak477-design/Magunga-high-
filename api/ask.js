
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    const firebaseKey = process.env.FIREBASE_WEB_API_KEY;

    if (!geminiKey || !firebaseKey) {
      return res.status(500).json({
        error: "AI service configuration is incomplete. Check Vercel environment variables."
      });
    }

    // Verify login
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Please log in first."
      });
    }

    const idToken = authorization.slice(7);

    const verifyResponse = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      encodeURIComponent(firebaseKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ idToken })
      }
    );

    if (!verifyResponse.ok) {
      return res.status(401).json({
        error: "Your login session is invalid. Please log in again."
      });
    }

    const verified = await verifyResponse.json();
    const firebaseUser = verified.users?.[0];

    if (!firebaseUser || !firebaseUser.localId) {
      return res.status(401).json({
        error: "Student account could not be verified."
      });
    }

    const uid = firebaseUser.localId;

    // Check student approval
    const profileResponse = await fetch(
      "https://firestore.googleapis.com/v1/projects/magunga-high/databases/(default)/documents/users/" +
      encodeURIComponent(uid),
      {
        headers: {
          Authorization: "Bearer " + idToken
        }
      }
    );

    if (!profileResponse.ok) {
      return res.status(403).json({
        error: "Unable to verify your student profile."
      });
    }

    const profile = await profileResponse.json();

    if (profile.fields?.status?.stringValue !== "approved") {
      return res.status(403).json({
        error: "Only approved students can use Magunga AI."
      });
    }

    // Validate messages
    const messages = req.body?.messages;

    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > 12
    ) {
      return res.status(400).json({
        error: "Invalid conversation."
      });
    }

    const contents = [];

    for (const message of messages) {
      if (
        !message ||
        !["user", "model"].includes(message.role) ||
        typeof message.text !== "string" ||
        !message.text.trim() ||
        message.text.length > 4000
      ) {
        return res.status(400).json({
          error: "Invalid message."
        });
      }

      contents.push({
        role: message.role,
        parts: [
          { text: message.text.trim() }
        ]
      });
    }

    if (contents[contents.length - 1].role !== "user") {
      return res.status(400).json({
        error: "Send a question first."
      });
    }

    // Connect to Gemini
    const aiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiKey
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{
              text: `
You are Magunga AI, the educational study assistant
for The Magunga High.

Your purpose is to help students understand school
subjects and prepare for Form 4 and KCSE examinations.

Teaching guidelines:
- Explain difficult topics in simple language.
- Show mathematical steps clearly.
- Give examples where useful.
- Generate revision questions and quizzes.
- Explain mistakes and correct answers.
- Be patient and respectful.
- Never invent facts or pretend certainty.
- Ask for clarification when a question is unclear.
- Organise answers with headings and numbered steps.
- Encourage students to understand, not just copy answers.

You are a learning assistant, not a replacement for teachers.
              `.trim()
            }]
          },
          contents,
          generationConfig: {
            maxOutputTokens: 1200
          }
        })
      }
    );

    // Show the actual Gemini error for diagnosis
    if (!aiResponse.ok) {
      const details = await aiResponse.json().catch(() => ({}));

      console.error("Gemini API error:", details);

      return res.status(503).json({
        error:
          "Gemini error: " +
          (details.error?.message || "Unknown API error") +
          " (HTTP " + aiResponse.status + ")"
      });
    }

    const result = await aiResponse.json();

    const answer = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({
        error: "No answer received. Please try again."
      });
    }

    return res.status(200).json({
      answer: answer
    });

  } catch (error) {
    console.error("Magunga AI error:", error);

    return res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }
};
