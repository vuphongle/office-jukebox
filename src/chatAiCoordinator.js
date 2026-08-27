import { randomUUID } from "node:crypto";
import { chatAiConfigured, decideChatAi, normalizeChatAiSettings, summarizeChat } from "./chatAi.js";
import { DEFAULT_EVENT_ID } from "./repositories/chatRepository.js";

const DEBOUNCE_MS = 2500;
const SUMMARY_REFRESH_CHARACTERS = 12000;
const SUMMARY_BATCH_CHARACTERS = 16000;
const PROACTIVE_MIN_INTERVAL_MS = 20 * 60 * 1000;
const QUEUE_CHANGE_DEBOUNCE_MS = 2500;
const BUSY_CHAT_WINDOW_MS = 90 * 1000;

function confidenceThreshold(autonomy, trigger) {
  const base = autonomy === "low" ? 0.84 : autonomy === "high" ? 0.55 : 0.7;
  return trigger === "idle" || trigger === "queue_change" ? Math.min(0.95, base + 0.1) : base;
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
    this.queueChangeTimer = null;
    this.idleTimer = null;
    this.lastAiReplyAt = 0;
    this.lastProactiveAt = 0;
    this.replyTimestamps = [];
    this.announcementTimestamps = [];
    this.lastAnnouncementAt = 0;
    this.pendingQueueChange = null;
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
    if (this.queueChangeTimer) clearTimeout(this.queueChangeTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.debounceTimer = null;
    this.queueChangeTimer = null;
    this.idleTimer = null;
  }

  reset() {
    this.generation += 1;
    this.pendingSeq = this.processedSeq;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.queueChangeTimer) clearTimeout(this.queueChangeTimer);
    this.debounceTimer = null;
    this.queueChangeTimer = null;
    this.pendingQueueChange = null;
    this.lastStatus = { ...this.lastStatus, state: "idle", lastAction: null, reasonCode: null };
  }

  schedule(message) {
    if (!message || message.isAI) return;
    this.pendingSeq = Math.max(this.pendingSeq, Number(message.seq) || 0);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.run("message"), DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /**
   * Queue mutations are coalesced so a reorder/remove burst results in at
   * most one provider call. The server remains responsible for deciding what
   * actually changed; the optional context is only a hint for the prompt.
   */
  scheduleQueueChange(change = {}) {
    const settings = normalizeChatAiSettings(this.getSettings());
    if (!settings.features.contextualAnnouncements || settings.maxAnnouncementsPerHour <= 0) return;
    this.pendingQueueChange = change && typeof change === "object" ? { ...change } : {};
    if (this.queueChangeTimer) clearTimeout(this.queueChangeTimer);
    this.queueChangeTimer = setTimeout(() => {
      this.queueChangeTimer = null;
      void this.run("queue_change");
    }, QUEUE_CHANGE_DEBOUNCE_MS);
    this.queueChangeTimer.unref?.();
  }

  status() {
    return { ...this.lastStatus, configured: chatAiConfigured(this.providerOptions), running: this.running };
  }

  callDelay(settings, trigger) {
    if (!settings.enabled || !this.getChatOn() || !chatAiConfigured(this.providerOptions)) return null;
    if (trigger === "queue_change") {
      if (!settings.features.contextualAnnouncements || settings.maxAnnouncementsPerHour <= 0) return null;
      const now = Date.now();
      this.announcementTimestamps = this.announcementTimestamps.filter(
        (timestamp) => now - timestamp < 60 * 60 * 1000
      );
      const delays = [
        Math.max(0, settings.announcementCooldownSeconds * 1000 - (now - this.lastAnnouncementAt)),
      ];
      if (this.announcementTimestamps.length >= settings.maxAnnouncementsPerHour) {
        delays.push(Math.max(0, this.announcementTimestamps[0] + 60 * 60 * 1000 - now));
      }
      return Math.max(...delays);
    }
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
      } else if (trigger === "queue_change") {
        if (this.queueChangeTimer) clearTimeout(this.queueChangeTimer);
        this.queueChangeTimer = setTimeout(() => {
          this.queueChangeTimer = null;
          void this.run("queue_change");
        }, delay);
        this.queueChangeTimer.unref?.();
      }
      return;
    }
    const targetSeq = this.pendingSeq;
    const runGeneration = this.generation;
    const queueChange = trigger === "queue_change" ? this.pendingQueueChange : null;
    if (trigger === "queue_change") this.pendingQueueChange = null;
    if (trigger === "idle") this.lastProactiveAt = Date.now();
    this.running = true;
    this.lastStatus = { ...this.lastStatus, state: "thinking", lastRunAt: new Date().toISOString() };

    try {
      const candidates = this.chatRepository.listRecentCandidates(this.eventId);
      if (!candidates.length) return;
      if (trigger === "queue_change" && !this.shouldRunQueueAnnouncement(candidates)) {
        this.lastStatus = {
          ...this.lastStatus,
          state: "idle",
          lastAction: "stay_silent",
          reasonCode: "busy_chat",
        };
        return;
      }
      const summary = this.memoryRepository.getSummary(this.eventId);
      const memories = this.memoryRepository.listActive(this.eventId, 50);
      // Clone the server snapshot before adding the trigger hint. A caller may
      // return a frozen/shared object and must not observe coordinator state.
      const roomState = { ...(this.getRoomState() || {}) };
      if (trigger === "queue_change" && queueChange) {
        roomState.queueChange = queueChange;
      }
      const result = await decideChatAi(
        {
          messages: candidates,
          summary: summary.content,
          memories,
          roomState,
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
        if (trigger === "queue_change") {
          this.lastAnnouncementAt = now;
          this.announcementTimestamps.push(now);
        }
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
      if (this.pendingQueueChange && !this.queueChangeTimer) {
        const currentSettings = normalizeChatAiSettings(this.getSettings());
        if (currentSettings.features.contextualAnnouncements && currentSettings.maxAnnouncementsPerHour > 0) {
          this.queueChangeTimer = setTimeout(() => {
            this.queueChangeTimer = null;
            void this.run("queue_change");
          }, QUEUE_CHANGE_DEBOUNCE_MS);
          this.queueChangeTimer.unref?.();
        }
      }
    }
  }

  shouldRunQueueAnnouncement(messages) {
    const cutoff = Date.now() - BUSY_CHAT_WINDOW_MS;
    const recentHumanMessages = messages.filter(
      (message) => !message.isAI && Date.parse(message.createdAt) >= cutoff
    );
    // A busy room is already getting human attention. Avoid spending a call or
    // inserting an unsolicited message while people are exchanging quickly.
    if (recentHumanMessages.length >= 5) return false;
    const last45s = Date.now() - 45 * 1000;
    return recentHumanMessages.filter((message) => Date.parse(message.createdAt) >= last45s).length < 3;
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
