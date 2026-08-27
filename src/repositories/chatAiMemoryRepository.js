import { randomUUID } from "node:crypto";
import { DEFAULT_EVENT_ID } from "./chatRepository.js";

function parseSourceIds(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    key: row.memory_key,
    type: row.memory_type,
    content: row.content,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    status: row.status,
    sourceMessageIds: parseSourceIds(row.source_message_ids),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at || null,
  };
}

export class ChatAiMemoryRepository {
  constructor(db) {
    this.db = db;
  }

  getSummary(eventId = DEFAULT_EVENT_ID) {
    const row = this.db.query("SELECT * FROM chat_ai_summaries WHERE event_id = ?").get(eventId);
    return row
      ? { content: row.content, coveredThroughSeq: row.covered_through_seq, updatedAt: row.updated_at }
      : { content: "", coveredThroughSeq: 0, updatedAt: null };
  }

  saveSummary(content, coveredThroughSeq, eventId = DEFAULT_EVENT_ID) {
    const updatedAt = new Date().toISOString();
    this.db.run(
      `INSERT INTO chat_ai_summaries (event_id, content, covered_through_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         content = excluded.content,
         covered_through_seq = excluded.covered_through_seq,
         updated_at = excluded.updated_at`,
      [eventId, content, coveredThroughSeq, updatedAt]
    );
    return { content, coveredThroughSeq, updatedAt };
  }

  listActive(eventId = DEFAULT_EVENT_ID, limit = 50) {
    const now = new Date().toISOString();
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db
      .query(
        `SELECT * FROM chat_ai_memories
         WHERE event_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY pinned DESC, updated_at DESC LIMIT ?`
      )
      .all(eventId, now, boundedLimit)
      .map(mapMemory);
  }

  upsert(memory, eventId = DEFAULT_EVENT_ID) {
    const existing = this.db
      .query("SELECT * FROM chat_ai_memories WHERE event_id = ? AND memory_key = ?")
      .get(eventId, memory.key);
    if (existing?.pinned === 1) return mapMemory(existing);

    const now = new Date().toISOString();
    const id = existing?.id || randomUUID();
    this.db.run(
      `INSERT INTO chat_ai_memories
       (id, event_id, memory_key, memory_type, content, confidence, pinned, status,
        source_message_ids, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
       ON CONFLICT(event_id, memory_key) DO UPDATE SET
         memory_type = excluded.memory_type,
         content = excluded.content,
         confidence = excluded.confidence,
         status = 'active',
         source_message_ids = excluded.source_message_ids,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [
        id,
        eventId,
        memory.key,
        memory.type,
        memory.content,
        memory.confidence,
        JSON.stringify(memory.sourceMessageIds || []),
        memory.expiresAt || null,
        existing?.created_at || now,
        now,
      ]
    );
    return mapMemory(this.db.query("SELECT * FROM chat_ai_memories WHERE id = ?").get(id));
  }

  setPinned(id, pinned) {
    const result = this.db.run(
      "UPDATE chat_ai_memories SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'",
      [pinned ? 1 : 0, new Date().toISOString(), id]
    );
    return Number(result.changes || 0) > 0;
  }

  delete(id) {
    const result = this.db.run(
      "UPDATE chat_ai_memories SET status = 'deleted', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), id]
    );
    return Number(result.changes || 0) > 0;
  }

  clearConversationState(eventId = DEFAULT_EVENT_ID) {
    const transaction = this.db.transaction(() => {
      this.db.run("DELETE FROM chat_ai_summaries WHERE event_id = ?", [eventId]);
      this.db.run("DELETE FROM chat_ai_memories WHERE event_id = ? AND pinned = 0", [eventId]);
    });
    transaction();
  }
}
