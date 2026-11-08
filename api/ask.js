
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {
    // Check the Gemini API key
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey) {
      return res.status(500).json({
        error: "AI service has not been configured yet."
      });
    }

    // Check Firebase login token
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Please log in first."
      });
    }

    const idToken = authorization.slice(7);
    const tokenParts = idToken.split(".");

    if (tokenParts.length !== 3) {
      return res.status(401).json({
        error: "Invalid login session."
      });
    }

    const token = JSON.parse(
      Buffer.from(tokenParts[1], "base64url").toString("utf8")
    );

    if (
      token.aud !== "magunga-high" ||
      token.iss !== "https://securetoken.google.com/magunga-high" ||
      !token.sub ||
      token.exp * 1000 < Date.now()
    ) {
      return res.status(401).json({
        error: "Your login session has expired."
      });
    }

    const uid = token.sub;

    // Check the student's Firestore profile using their own token.
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
        error: "Unable to verify your student account."
      });
    }

    const profile = await profileResponse.json();
    const status = profile.fields?.status?.stringValue;

    if (status !== "approved") {
      return res.status(403).json({
        error: "Only approved students can use Magunga AI."
      });
    }

    // Validate conversation
    const messages = req.body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Enter a question first."
      });
    }

    const contents = messages.slice(-12).map((message) => {
      if (
        !["user", "model"].includes(message.role) ||
        typeof message.text !== "string" ||
        !message.text.trim() ||
        message.text.length > 4000
      ) {
        throw new Error("Invalid message.");
      }

      return {
        role: message.role,
        parts: [{ text: message.text.trim() }]
      };
    });

    if (contents[contents.length - 1].role !== "user") {
      return res.status(400).json({
        error: "Your latest message must be a question."
      });
    }

    // Ask Gemini
    const geminiResponse = await fetch(
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

Your purpose is to help students learn and understand
their school subjects.

RULES:
1. Explain difficult topics in simple language.
2. Show mathematical steps when solving problems.
3. Help with Form 4 and KCSE revision.
4. Generate practice questions and quizzes.
5. Explain why an answer is correct or incorrect.
6. Use examples where helpful.
7. Be patient and respectful.
8. Do not invent facts or pretend to know information
   you are uncertain about.
9. Ask for clarification when a question is unclear.
10. Keep answers organised and easy to read.

You are a tutor, not a replacement for teachers.
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

    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.json().catch(() => ({}));
      console.error("Gemini error:", errorData);

      return res.status(503).json({
        error: "Magunga AI is temporarily unavailable. Please try again."
      });
    }

    const result = await geminiResponse.json();

    const answer = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({
        error: "AI did not return an answer. Please try again."
      });
    }

    return res.status(200).json({ answer });

  } catch (error) {
    console.error("Magunga AI error:", error);

    return res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }
};
