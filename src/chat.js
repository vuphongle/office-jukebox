export const CHAT_MAX_MESSAGES = 40;
export const CHAT_NAME_MAX = 40;
export const CHAT_TEXT_MAX = 280;
export const CHAT_MIN_INTERVAL_MS = 700;

export function parseChatInput(input) {
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, CHAT_NAME_MAX) : "";
  const text = typeof input?.text === "string" ? input.text.trim().slice(0, CHAT_TEXT_MAX) : "";
  if (!name) return { ok: false, reason: "Vui lòng nhập tên trước khi chat." };
  if (!text) return { ok: false, reason: "Vui lòng nhập nội dung tin nhắn." };
  return { ok: true, name, text };
}

export function pushRecentChat(messages, message) {
  messages.push(message);
  if (messages.length > CHAT_MAX_MESSAGES) {
    messages.splice(0, messages.length - CHAT_MAX_MESSAGES);
  }
  return messages;
}
