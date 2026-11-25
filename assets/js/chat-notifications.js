
export async function notifyChatMessage(
  user,
  chatType,
  messageId,
  chatId = ""
) {
  try {
    if (!user || !messageId) return;

    const token = await user.getIdToken();

    const payload = {
      chatType,
      messageId
    };

    if (chatType === "private") {
      payload.chatId = chatId;
    }

    const response = await fetch(
      "/api/send-chat-notification",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.warn(
        "Notification delivery failed:",
        result.error
      );
      return;
    }

    console.log(
      "Notification delivery result:",
      result
    );

  } catch (error) {
    console.warn(
      "Notification request failed:",
      error
    );
  }
}
