import { randomUUID } from "node:crypto";
import { chatAiConfigured, decideChatAi, normalizeChatAiSettings, summarizeChat } from "./chatAi.js";
import { DEFAULT_EVENT_ID } from "./repositories/chatRepository.js";

const DEBOUNCE_MS = 2500;
const SUMMARY_REFRESH_CHARACTERS = 12000;
const SUMMARY_BATCH_CHARACTERS = 16000;
const PROACTIVE_MIN_INTERVAL_MS = 20 * 60 * 1000;

function confidenceThreshold(autonomy, trigger) {
  const base = autonomy === "low" ? 0.84 : autonomy === "high" ? 0.55 : 0.7;
  return trigger === "idle" ? Math.min(0.95, base + 0.1) : base;
}

function oldestBatchByCharacters(messages, maxCharacters) {
  const selected = [];
  let characters = 0;
  for (const message of messages) {
    const size = String(message.name || "").length + String(message.text || "").length + 32;
    if (selected.length && characters + size > maxCharacters) break;
    selected.push(message);
    characters += size;
  }
  return selected;
}

export class ChatAiCoordinator {
  constructor({
    chatRepository,
    memoryRepository,
    getSettings,
    getRoomState,
    getChatOn = () => true,
    onAiMessage,
    providerOptions = {},
    logger = console,
    eventId = DEFAULT_EVENT_ID,
  }) {
    this.chatRepository = chatRepository;
    this.memoryRepository = memoryRepository;
    this.getSettings = getSettings;
    this.getRoomState = getRoomState;
    this.getChatOn = getChatOn;
    this.onAiMessage = onAiMessage;
    this.providerOptions = { ...providerOptions, logger };
    this.logger = logger;
    this.eventId = eventId;
    this.pendingSeq = 0;
    this.processedSeq = 0;
    this.generation = 0;
    this.running = false;
    this.debounceTimer = null;
    this.idleTimer = null;
    this.lastAiReplyAt = 0;
    this.lastProactiveAt = 0;
    this.replyTimestamps = [];
    this.lastStatus = { state: "idle", lastRunAt: null, lastAction: null, reasonCode: null, contextCharacters: 0 };
  }

  start() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => void this.maybeRunProactive(), 60_000);
    this.idleTimer.unref?.();
  }

  stop() {
    this.reset();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.debounceTimer = null;
    this.idleTimer = null;
  }

  reset() {
    this.generation += 1;
    this.pendingSeq = this.processedSeq;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.lastStatus = { ...this.lastStatus, state: "idle", lastAction: null, reasonCode: null };
  }

  schedule(message) {
    if (!message || message.isAI) return;
    this.pendingSeq = Math.max(this.pendingSeq, Number(message.seq) || 0);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.run("message"), DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  status() {
    return { ...this.lastStatus, configured: chatAiConfigured(this.providerOptions), running: this.running };
  }

  callDelay(settings, trigger) {
    if (!settings.enabled || !this.getChatOn() || !chatAiConfigured(this.providerOptions)) return null;
    if (trigger === "manual") return 0;
    const now = Date.now();
    this.replyTimestamps = this.replyTimestamps.filter((timestamp) => now - timestamp < 60 * 60 * 1000);
    const delays = [Math.max(0, settings.cooldownSeconds * 1000 - (now - this.lastAiReplyAt))];
    if (this.replyTimestamps.length >= settings.maxRepliesPerHour) {
      delays.push(Math.max(0, this.replyTimestamps[0] + 60 * 60 * 1000 - now));
    }
    if (trigger === "idle") delays.push(Math.max(0, PROACTIVE_MIN_INTERVAL_MS - (now - this.lastProactiveAt)));
    return Math.max(...delays);
  }

  canCall(settings, trigger) {
    return this.callDelay(settings, trigger) === 0;
  }

  async run(trigger = "message") {
    if (this.running) return;
    const settings = normalizeChatAiSettings(this.getSettings());
    const delay = this.callDelay(settings, trigger);
    if (delay === null) return;
    if (delay > 0) {
      if (trigger === "message") {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => void this.run("message"), delay);
        this.debounceTimer.unref?.();
      }
      return;
    }
    const targetSeq = this.pendingSeq;
    const runGeneration = this.generation;
    if (trigger === "idle") this.lastProactiveAt = Date.now();
    this.running = true;
    this.lastStatus = { ...this.lastStatus, state: "thinking", lastRunAt: new Date().toISOString() };

    try {
      const candidates = this.chatRepository.listRecentCandidates(this.eventId);
      if (!candidates.length) return;
      const summary = this.memoryRepository.getSummary(this.eventId);
      const memories = this.memoryRepository.listActive(this.eventId, 50);
      const result = await decideChatAi(
        {
          messages: candidates,
          summary: summary.content,
          memories,
          roomState: this.getRoomState(),
          settings,
          trigger,
        },
        this.providerOptions
      );

      if (!result) {
        this.lastStatus = { ...this.lastStatus, state: "provider_error", lastAction: null, reasonCode: "provider_error" };
        return;
      }
      const currentSettings = normalizeChatAiSettings(this.getSettings());
      if (runGeneration !== this.generation || !this.getChatOn() || !currentSettings.enabled) {
        return;
      }

      this.applyMemoryUpdates(result.memoryUpdates, currentSettings);
      const shouldReply =
        result.action === "reply" &&
        result.reply &&
        result.confidence >= confidenceThreshold(currentSettings.autonomy, trigger);
      this.lastStatus = {
        state: "idle",
        lastRunAt: new Date().toISOString(),
        lastAction: shouldReply ? "reply" : "stay_silent",
        reasonCode: result.reasonCode,
        contextCharacters: result.contextCharacters,
      };

      if (shouldReply) {
        const saved = this.chatRepository.create(
          {
            id: randomUUID(),
            name: currentSettings.name,
            text: result.reply,
            senderId: "system:chat-ai",
            userId: null,
            isAdmin: false,
            isAI: true,
            createdAt: new Date().toISOString(),
          },
          this.eventId
        );
        const now = Date.now();
        this.lastAiReplyAt = now;
        this.replyTimestamps.push(now);
        this.onAiMessage(saved);
      }

      await this.maybeRefreshSummary(currentSettings, runGeneration);
    } catch (error) {
      this.logger.warn(`[chat-ai] coordinator error: ${error?.message || "unknown"}`);
      this.lastStatus = { ...this.lastStatus, state: "provider_error", reasonCode: "internal_error" };
    } finally {
      this.running = false;
      if (runGeneration !== this.generation) return;
      this.processedSeq = Math.max(this.processedSeq, targetSeq);
      if (this.pendingSeq > this.processedSeq) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => void this.run("message"), DEBOUNCE_MS);
        this.debounceTimer.unref?.();
      }
    }
  }

  applyMemoryUpdates(updates, settings) {
    if (!settings.memoryEnabled) return;
    for (const update of updates) {
      const expiresAt = new Date(Date.now() + update.ttlHours * 60 * 60 * 1000).toISOString();
      this.memoryRepository.upsert({ ...update, expiresAt }, this.eventId);
    }
  }

  async maybeRefreshSummary(settings, runGeneration = this.generation) {
    if (!settings.summaryEnabled) return;
    const current = this.memoryRepository.getSummary(this.eventId);
    const stats = this.chatRepository.statsAfterSeq(this.eventId, current.coveredThroughSeq);
    if (Number(stats.characters || 0) < SUMMARY_REFRESH_CHARACTERS) return;
    const candidates = this.chatRepository.listAfterSeq(this.eventId, current.coveredThroughSeq, 500);
    const batch = oldestBatchByCharacters(candidates, SUMMARY_BATCH_CHARACTERS);
    if (!batch.length) return;
    const summary = await summarizeChat(
      { previousSummary: current.content, messages: batch, settings },
      this.providerOptions
    );
    const currentSettings = normalizeChatAiSettings(this.getSettings());
    if (
      !summary ||
      runGeneration !== this.generation ||
      !this.getChatOn() ||
      !currentSettings.enabled ||
      !currentSettings.summaryEnabled
    ) {
      return;
    }
    this.memoryRepository.saveSummary(summary, batch.at(-1).seq, this.eventId);
  }

  async maybeRunProactive() {
    if (this.running) return;
    const settings = normalizeChatAiSettings(this.getSettings());
    if (!settings.enabled || settings.proactiveIdleMinutes <= 0 || !this.canCall(settings, "idle")) return;
    const recent = this.chatRepository.listRecent(this.eventId, 40);
    const last = recent.at(-1);
    if (!last || last.isAI) return;
    const idleMs = Date.now() - Date.parse(last.createdAt);
    if (!Number.isFinite(idleMs) || idleMs < settings.proactiveIdleMinutes * 60 * 1000) return;
    const cutoff = Date.now() - 30 * 60 * 1000;
    const activeHumans = new Set(
      recent
        .filter((message) => !message.isAI && Date.parse(message.createdAt) >= cutoff)
        .map((message) => message.senderId || message.name)
    );
    if (activeHumans.size < 2) return;
    this.pendingSeq = Math.max(this.pendingSeq, Number(last.seq) || 0);
    await this.run("idle");
  }
}
