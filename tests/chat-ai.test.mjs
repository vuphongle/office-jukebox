import test from "node:test";
import assert from "node:assert/strict";

import { initDb, closeDb } from "../src/db.js";
import { ChatRepository } from "../src/repositories/chatRepository.js";
import { ChatAiMemoryRepository } from "../src/repositories/chatAiMemoryRepository.js";
import {
  buildChatAiPrompt,
  chatAiConfigured,
  decideChatAi,
  normalizeChatAiSettings,
  selectRecentMessagesByChars,
  summarizeFeedback,
} from "../src/chatAi.js";
import { ChatAiCoordinator } from "../src/chatAiCoordinator.js";
import { UserRepository } from "../src/repositories/userRepository.js";

function message(index, text = `Tin nhắn ${index}`) {
  return {
    id: `message-${index}`,
    name: `User ${index}`,
    text,
    senderId: `sender-${index}`,
    isAdmin: false,
    isAI: false,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}

function sseResponse(chunks) {
  return {
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    text: async () =>
      `${chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`).join("\n\n")}\n\ndata: [DONE]\n`,
  };
}

test("chat AI settings allow an expanded 200k context and keep bounded admin fields", () => {
  const settings = normalizeChatAiSettings({
    enabled: true,
    contextCharBudget: 999_999,
    name: "A".repeat(80),
    stylePrompt: "s".repeat(2000),
    knowledgePrompt: "k".repeat(4000),
  });
  assert.equal(settings.contextCharBudget, 200_000);
  assert.equal(settings.name.length, 40);
  assert.equal(settings.stylePrompt.length, 1500);
  assert.equal(settings.knowledgePrompt.length, 4000);
  assert.equal(settings.features.contextualAnnouncements, false);
  assert.equal(settings.features.feedbackDigest, false);
});

test("chat AI feature switches are grouped and preserve defaults for omitted keys", () => {
  const settings = normalizeChatAiSettings({
    features: { contextualAnnouncements: true, queueVoteInsights: false },
  });
  assert.equal(settings.features.contextualAnnouncements, true);
  assert.equal(settings.features.queueVoteInsights, false);
  assert.equal(settings.features.songRecommendations, true);
  assert.equal(settings.features.feedbackDigest, false);
});

test("chat AI provider detection falls back when the dedicated key is blank", () => {
  const previousChatKey = process.env.CHAT_AI_API_KEY;
  const previousLlmKey = process.env.LLM_API_KEY;
  try {
    process.env.CHAT_AI_API_KEY = "";
    process.env.LLM_API_KEY = "fallback-test-key";
    assert.equal(chatAiConfigured(), true);
  } finally {
    if (previousChatKey === undefined) delete process.env.CHAT_AI_API_KEY;
    else process.env.CHAT_AI_API_KEY = previousChatKey;
    if (previousLlmKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousLlmKey;
  }
});

test("character context keeps complete newest messages and stays inside the configured budget", () => {
  const messages = Array.from({ length: 500 }, (_, index) => message(index, `${index}:${"x".repeat(280)}`));
  const selected = selectRecentMessagesByChars(messages, 5000);
  assert.equal(selected.at(-1).id, "message-499");
  assert.ok(selected.length < messages.length);
  assert.equal(selected.every((item) => item.text.length === 284), true);

  const prompt = buildChatAiPrompt({
    messages,
    summary: "Tóm tắt ".repeat(1000),
    memories: Array.from({ length: 50 }, (_, index) => ({
      key: `memory_${index}`,
      type: "topic",
      content: "Nội dung ".repeat(50),
      pinned: false,
    })),
    roomState: { nowPlaying: { title: "Bài hiện tại" }, queue: [] },
    settings: { enabled: true, contextCharBudget: 100_000 },
  });
  assert.ok(prompt.characterCount <= 100_000);
  assert.equal(prompt.includedMessageIds.at(-1), "message-499");
});

test("expanded room context includes recent plays and trends only for enabled capabilities", () => {
  const prompt = buildChatAiPrompt({
    messages: [message(1, "Gợi ý bài tiếp theo")],
    roomState: {
      queueCount: 12,
      queue: [{ title: "Bài chờ", addedBy: "Mai", voteScore: 4 }],
      recentPlayed: [{ title: "Bài vừa phát", artist: "Nghệ sĩ", playedAt: "2026-08-27T09:00:00Z" }],
      songTrends: { artists: [{ name: "Nghệ sĩ", plays: 3 }] },
    },
    settings: { enabled: true, contextCharBudget: 8_000 },
  });
  const userPrompt = prompt.messages[1].content;
  assert.match(userPrompt, /Bài vừa phát/);
  assert.match(userPrompt, /Nghệ sĩ/);

  const disabledPrompt = buildChatAiPrompt({
    messages: [message(1)],
    roomState: { recentPlayed: [{ title: "Không nên đưa vào" }] },
    settings: {
      enabled: true,
      contextCharBudget: 8_000,
      features: { songRecommendations: false },
    },
  });
  assert.doesNotMatch(disabledPrompt.messages[1].content, /Không nên đưa vào/);
});

test("AI decision validates autonomous reply and memory updates from provider JSON", async () => {
  const source = message(1, "Hôm nay mọi người muốn nghe V-pop sôi động");
  const fetchImpl = async () =>
    jsonResponse({
      action: "reply",
      reasonCode: "topic",
      confidence: 0.91,
      reply: "Chốt mood V-pop sôi động nhé! Mọi người muốn mở đầu bằng bài nào?",
      memoryUpdates: [
        {
          key: "current_music_mood",
          type: "preference",
          content: "Phòng đang muốn nghe V-pop sôi động",
          confidence: 0.9,
          ttlHours: 6,
          sourceMessageIds: [source.id, "unknown-id"],
        },
      ],
    });
  const result = await decideChatAi(
    { messages: [source], settings: { enabled: true, contextCharBudget: 100_000 } },
    { apiKey: "test-key", baseUrl: "https://provider.test/v1", model: "test-model", fetchImpl }
  );
  assert.equal(result.action, "reply");
  assert.equal(result.memoryUpdates.length, 1);
  assert.deepEqual(result.memoryUpdates[0].sourceMessageIds, [source.id]);
});

test("AI decision accepts OpenAI-compatible SSE responses returned by the provider", async () => {
  const fetchImpl = async () =>
    sseResponse([
      '{"action":"reply","reasonCode":"topic",',
      '"confidence":0.93,"reply":"Chào cả phòng!","memoryUpdates":[]}',
    ]);
  const result = await decideChatAi(
    { messages: [message(1, "Xin chào")], settings: { enabled: true, contextCharBudget: 8000 } },
    { apiKey: "test-key", baseUrl: "https://provider.test/v1", model: "test-model", fetchImpl }
  );
  assert.equal(result.action, "reply");
  assert.equal(result.reply, "Chào cả phòng!");
});

test("feedback digest is bounded to supplied message ids and stays opt-in", async () => {
  const feedback = [
    { id: "fb-1", text: "Nên có nút tìm kiếm", createdAt: new Date().toISOString() },
    { id: "fb-2", text: "Ứng dụng bị lag", createdAt: new Date().toISOString() },
  ];
  const fetchImpl = async () =>
    jsonResponse({
      summary: "Có một ý tưởng và một lỗi cần xem xét.",
      groups: [
        { category: "idea", count: 1, priority: "low", messageIds: ["fb-1", "unknown"] },
        { category: "bug", count: 1, priority: "high", messageIds: ["fb-2"] },
      ],
      needsReview: true,
    });
  const result = await summarizeFeedback(
    { feedback, settings: { features: { feedbackDigest: true } } },
    { apiKey: "test-key", fetchImpl }
  );
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups[0].messageIds, ["fb-1"]);
  assert.equal(
    await summarizeFeedback({ feedback, settings: { features: { feedbackDigest: false } } }, { apiKey: "test-key", fetchImpl }),
    null
  );
});

test("coordinator persists an AI message and selected event memory without a tag", async () => {
  const db = initDb({ dbPath: ":memory:" });
  const chatRepository = new ChatRepository(db);
  const memoryRepository = new ChatAiMemoryRepository(db);
  const human = chatRepository.create(message(1, "Có bài V-pop nào vui để mở đầu không?"));
  const broadcasts = [];
  const fetchImpl = async () =>
    jsonResponse({
      action: "reply",
      reasonCode: "answer_question",
      confidence: 0.95,
      reply: "Thử See Tình để mở đầu không khí vui nhé!",
      memoryUpdates: [
        {
          key: "opening_mood",
          type: "preference",
          content: "Muốn mở đầu bằng V-pop vui",
          confidence: 0.9,
          ttlHours: 12,
          sourceMessageIds: [human.id],
        },
      ],
    });
  const coordinator = new ChatAiCoordinator({
    chatRepository,
    memoryRepository,
    getSettings: () => ({ enabled: true, autonomy: "balanced", contextCharBudget: 100_000 }),
    getRoomState: () => ({ nowPlaying: null, queue: [] }),
    onAiMessage: (created) => broadcasts.push(created),
    providerOptions: { apiKey: "test-key", baseUrl: "https://provider.test/v1", model: "test-model", fetchImpl },
    logger: { warn() {} },
  });
  coordinator.schedule(human);
  coordinator.stop();
  await coordinator.run("message");

  const history = chatRepository.listRecent("default_event", 40);
  assert.equal(history.length, 2);
  assert.equal(history[1].isAI, true);
  assert.equal(history[1].isAdmin, false);
  assert.equal(broadcasts.length, 1);
  assert.equal(memoryRepository.listActive().at(0).key, "opening_mood");
  closeDb();
});

test("persisted chat never exposes the authenticated user id in public message objects", () => {
  const db = initDb({ dbPath: ":memory:" });
  const user = new UserRepository(db).create({ username: "chat-user", passwordHash: "hash" });
  const chatRepository = new ChatRepository(db);
  const saved = chatRepository.create({ ...message(1), userId: user.id });
  assert.equal(Object.hasOwn(saved, "userId"), false);
  assert.equal(Object.hasOwn(chatRepository.listRecent().at(0), "userId"), false);
  assert.equal(db.query("SELECT user_id FROM chat_messages WHERE id = ?").get(saved.id).user_id, user.id);
  closeDb();
});

test("reset ignores an in-flight AI result after chat history is cleared", async () => {
  const db = initDb({ dbPath: ":memory:" });
  const chatRepository = new ChatRepository(db);
  const memoryRepository = new ChatAiMemoryRepository(db);
  const human = chatRepository.create(message(1, "Mọi người nghe gì tiếp?"));
  let resolveProvider;
  const fetchImpl = () =>
    new Promise((resolve) => {
      resolveProvider = () => resolve(jsonResponse({ action: "reply", confidence: 0.99, reply: "Nghe V-pop nhé!", memoryUpdates: [] }));
    });
  const coordinator = new ChatAiCoordinator({
    chatRepository,
    memoryRepository,
    getSettings: () => ({ enabled: true, contextCharBudget: 100_000 }),
    getRoomState: () => ({}),
    onAiMessage() {
      throw new Error("A stale AI message must not be broadcast");
    },
    providerOptions: { apiKey: "test-key", fetchImpl },
    logger: { warn() {} },
  });
  coordinator.schedule(human);
  clearTimeout(coordinator.debounceTimer);
  coordinator.debounceTimer = null;
  const run = coordinator.run("message");
  coordinator.reset();
  chatRepository.clear();
  resolveProvider();
  await run;
  assert.equal(chatRepository.listRecent().length, 0);
  closeDb();
});

test("reset prevents an in-flight summary from recreating cleared conversation state", async () => {
  const db = initDb({ dbPath: ":memory:" });
  const chatRepository = new ChatRepository(db);
  const memoryRepository = new ChatAiMemoryRepository(db);
  let latest;
  for (let index = 0; index < 50; index += 1) {
    latest = chatRepository.create(message(index, "x".repeat(280)));
  }
  let providerCall = 0;
  let resolveSummary;
  let markSummaryStarted;
  const summaryStarted = new Promise((resolve) => {
    markSummaryStarted = resolve;
  });
  const fetchImpl = async () => {
    providerCall += 1;
    if (providerCall === 1) {
      return jsonResponse({ action: "stay_silent", confidence: 0.9, memoryUpdates: [] });
    }
    markSummaryStarted();
    return new Promise((resolve) => {
      resolveSummary = () => resolve(jsonResponse({ summary: "Tóm tắt đã cũ" }));
    });
  };
  const coordinator = new ChatAiCoordinator({
    chatRepository,
    memoryRepository,
    getSettings: () => ({ enabled: true, summaryEnabled: true, contextCharBudget: 100_000 }),
    getRoomState: () => ({}),
    onAiMessage() {},
    providerOptions: { apiKey: "test-key", fetchImpl },
    logger: { warn() {} },
  });
  coordinator.pendingSeq = latest.seq;
  const run = coordinator.run("message");
  await summaryStarted;
  coordinator.reset();
  chatRepository.clear();
  memoryRepository.clearConversationState();
  resolveSummary();
  await run;

  assert.equal(chatRepository.listRecent().length, 0);
  assert.equal(memoryRepository.getSummary().content, "");
  closeDb();
});

test("silent proactive checks are throttled while a manual admin kick remains immediate", async () => {
  const db = initDb({ dbPath: ":memory:" });
  const chatRepository = new ChatRepository(db);
  const memoryRepository = new ChatAiMemoryRepository(db);
  chatRepository.create(message(1, "Phòng đang yên lặng"));
  const settings = normalizeChatAiSettings({ enabled: true, proactiveIdleMinutes: 1 });
  const coordinator = new ChatAiCoordinator({
    chatRepository,
    memoryRepository,
    getSettings: () => settings,
    getRoomState: () => ({}),
    onAiMessage() {},
    providerOptions: {
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse({ action: "stay_silent", confidence: 0.9, memoryUpdates: [] }),
    },
    logger: { warn() {} },
  });

  await coordinator.run("idle");
  assert.ok(coordinator.callDelay(settings, "idle") > 19 * 60 * 1000);
  assert.equal(coordinator.callDelay(settings, "manual"), 0);
  closeDb();
});

test("clearing inferred AI state keeps pinned memory", () => {
  const db = initDb({ dbPath: ":memory:" });
  const memoryRepository = new ChatAiMemoryRepository(db);
  const pinned = memoryRepository.upsert({
    key: "office_rule",
    type: "fact",
    content: "Không phát nội dung nhạy cảm",
    confidence: 1,
    sourceMessageIds: ["admin"],
  });
  memoryRepository.setPinned(pinned.id, true);
  memoryRepository.upsert({
    key: "temporary_mood",
    type: "topic",
    content: "Đang thích nhạc chill",
    confidence: 0.9,
    sourceMessageIds: ["message"],
  });
  memoryRepository.saveSummary("Một tóm tắt", 10);
  memoryRepository.clearConversationState();

  const memories = memoryRepository.listActive();
  assert.equal(memories.length, 1);
  assert.equal(memories[0].key, "office_rule");
  assert.equal(memoryRepository.getSummary().content, "");
  closeDb();
});

test("chat retention pruning keeps only the newest bounded messages", () => {
  const db = initDb({ dbPath: ":memory:" });
  const chatRepository = new ChatRepository(db);
  for (let index = 0; index < 6; index += 1) {
    chatRepository.create(message(index));
  }
  assert.equal(chatRepository.prune("default_event", 3), 3);
  assert.deepEqual(
    chatRepository.listRecent("default_event", 10).map((item) => item.id),
    ["message-3", "message-4", "message-5"]
  );
  closeDb();
});
