import test from "node:test";
import assert from "node:assert/strict";

import { CHAT_MAX_MESSAGES, parseChatInput, pushRecentChat } from "../src/chat.js";

test("parseChatInput trims and bounds guest chat fields", () => {
  const result = parseChatInput({ name: `  ${"A".repeat(60)}  `, text: `  ${"x".repeat(400)}  ` });
  assert.equal(result.ok, true);
  assert.equal(result.name.length, 40);
  assert.equal(result.text.length, 280);
});

test("parseChatInput rejects missing name or text", () => {
  assert.equal(parseChatInput({ name: "", text: "hello" }).ok, false);
  assert.equal(parseChatInput({ name: "Mai", text: "   " }).ok, false);
});

test("pushRecentChat keeps only the newest bounded messages", () => {
  const messages = [];
  for (let i = 0; i < CHAT_MAX_MESSAGES + 2; i += 1) pushRecentChat(messages, { id: i });
  assert.equal(messages.length, CHAT_MAX_MESSAGES);
  assert.equal(messages[0].id, 2);
  assert.equal(messages.at(-1).id, CHAT_MAX_MESSAGES + 1);
});
