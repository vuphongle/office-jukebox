export const DEFAULT_EVENT_ID = "default_event";
export const CHAT_RETENTION_MESSAGES = 5000;
const CHAT_PRUNE_INTERVAL = 100;

function mapMessage(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    id: row.id,
    eventId: row.event_id,
    senderId: row.sender_id || "",
    name: row.name,
    text: row.text,
    isAdmin: row.is_admin === 1,
    isAI: row.is_ai === 1,
    createdAt: row.created_at,
  };
}

export class ChatRepository {
  constructor(db) {
    this.db = db;
    this.insertsSincePrune = new Map();
  }

  create(message, eventId = DEFAULT_EVENT_ID) {
    this.db.run(
      `INSERT INTO chat_messages
       (id, event_id, user_id, sender_id, name, text, is_admin, is_ai, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        eventId,
        message.userId || null,
        message.senderId || "",
        message.name,
        message.text,
        message.isAdmin ? 1 : 0,
        message.isAI ? 1 : 0,
        message.createdAt,
      ]
    );
    const created = mapMessage(this.db.query("SELECT * FROM chat_messages WHERE id = ?").get(message.id));
    const inserts = (this.insertsSincePrune.get(eventId) || 0) + 1;
    if (inserts >= CHAT_PRUNE_INTERVAL) {
      this.prune(eventId);
      this.insertsSincePrune.set(eventId, 0);
    } else {
      this.insertsSincePrune.set(eventId, inserts);
    }
    return created;
  }

  listRecent(eventId = DEFAULT_EVENT_ID, limit = 40) {
    const boundedLimit = Math.min(1000, Math.max(1, Number(limit) || 40));
    const rows = this.db
      .query("SELECT * FROM chat_messages WHERE event_id = ? ORDER BY seq DESC LIMIT ?")
      .all(eventId, boundedLimit);
    return rows.reverse().map(mapMessage);
  }

  listRecentCandidates(eventId = DEFAULT_EVENT_ID, limit = 1000) {
    const boundedLimit = Math.min(2000, Math.max(1, Number(limit) || 1000));
    return this.db
      .query("SELECT * FROM chat_messages WHERE event_id = ? ORDER BY seq DESC LIMIT ?")
      .all(eventId, boundedLimit)
      .reverse()
      .map(mapMessage);
  }

  listAfterSeq(eventId = DEFAULT_EVENT_ID, afterSeq = 0, limit = 500) {
    const boundedLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
    return this.db
      .query("SELECT * FROM chat_messages WHERE event_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(eventId, Math.max(0, Number(afterSeq) || 0), boundedLimit)
      .map(mapMessage);
  }

  statsAfterSeq(eventId = DEFAULT_EVENT_ID, afterSeq = 0) {
    return this.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(name) + LENGTH(text) + 16), 0) AS characters,
                COALESCE(MAX(seq), 0) AS last_seq
         FROM chat_messages WHERE event_id = ? AND seq > ?`
      )
      .get(eventId, Math.max(0, Number(afterSeq) || 0));
  }

  prune(eventId = DEFAULT_EVENT_ID, maxMessages = CHAT_RETENTION_MESSAGES) {
    const boundedLimit = Math.min(100000, Math.max(1, Number(maxMessages) || CHAT_RETENTION_MESSAGES));
    const result = this.db.run(
      `DELETE FROM chat_messages
       WHERE event_id = ?
         AND seq <= COALESCE(
           (SELECT seq FROM chat_messages WHERE event_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?),
           -1
         )`,
      [eventId, eventId, boundedLimit]
    );
    return Number(result.changes || 0);
  }

  clear(eventId = DEFAULT_EVENT_ID) {
    const result = this.db.run("DELETE FROM chat_messages WHERE event_id = ?", [eventId]);
    return Number(result.changes || 0);
  }
}
