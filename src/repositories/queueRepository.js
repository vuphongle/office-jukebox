import { randomUUID } from "node:crypto";

export class QueueRepository {
  constructor(db) {
    this.db = db;
  }

  getNextSequence(eventId = "default_event") {
    const row = this.db.query("SELECT MAX(queue_sequence) as maxSeq FROM queue_items WHERE event_id = ?").get(eventId);
    return (row?.maxSeq || 0) + 1;
  }

  createItem({ videoId, title, channel, duration, thumbnail, addedBy, requesterId, addedByUserId = null, eventId = "default_event" }) {
    const tx = this.db.transaction(() => {
      const id = randomUUID();
      const now = Date.now();
      const seq = this.getNextSequence(eventId);

      this.db.run(
        `INSERT INTO queue_items (
          id, event_id, video_id, title, channel, duration, thumbnail,
          added_by, requester_id, added_by_user_id, queue_sequence,
          vote_score, pinned, pinned_order, status, added_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'queued', ?)`,
        [id, eventId, videoId, title, channel || "", duration || "3:30", thumbnail || null, addedBy || "", requesterId || "", addedByUserId, seq, now]
      );

      return this.findById(id);
    });

    return tx.immediate();
  }

  findById(id) {
    if (!id) return null;
    return this.db.query("SELECT * FROM queue_items WHERE id = ?").get(id) || null;
  }

  getActiveOrPlaying(eventId = "default_event") {
    return this.db.query("SELECT * FROM queue_items WHERE event_id = ? AND status = 'playing' LIMIT 1").get(eventId) || null;
  }

  getQueuedItems(eventId = "default_event", voteSortEnabled = true) {
    if (voteSortEnabled) {
      return this.db
        .query(
          `SELECT * FROM queue_items
           WHERE event_id = ? AND status = 'queued'
           ORDER BY pinned DESC, pinned_order ASC, vote_score DESC, queue_sequence ASC`
        )
        .all(eventId);
    }
    return this.db
      .query(
        `SELECT * FROM queue_items
         WHERE event_id = ? AND status = 'queued'
         ORDER BY pinned DESC, pinned_order ASC, queue_sequence ASC`
      )
      .all(eventId);
  }

  updateStatus(id, status, { startedAt = null, finishedAt = null } = {}) {
    const now = Date.now();
    if (status === "playing") {
      this.db.run(
        "UPDATE queue_items SET status = 'playing', started_at = ? WHERE id = ?",
        [startedAt || now, id]
      );
    } else if (["played", "removed", "error"].includes(status)) {
      this.db.run(
        "UPDATE queue_items SET status = ?, finished_at = ? WHERE id = ?",
        [status, finishedAt || now, id]
      );
    } else {
      this.db.run("UPDATE queue_items SET status = ? WHERE id = ?", [status, id]);
    }
    return this.findById(id);
  }

  setPin(id, pinned, pinnedOrder = 0) {
    this.db.run(
      "UPDATE queue_items SET pinned = ?, pinned_order = ? WHERE id = ?",
      [pinned ? 1 : 0, pinnedOrder, id]
    );
    return this.findById(id);
  }

  reorderPinned(items) {
    const tx = this.db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        this.db.run(
          "UPDATE queue_items SET pinned = 1, pinned_order = ? WHERE id = ?",
          [i + 1, item.id]
        );
      }
    });
    tx.immediate();
  }

  unpin(id) {
    this.db.run("UPDATE queue_items SET pinned = 0, pinned_order = 0 WHERE id = ?", [id]);
    return this.findById(id);
  }

  // Voting logic
  addVote(queueItemId, userId) {
    const tx = this.db.transaction(() => {
      const user = this.db.query("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user || user.status !== "active") throw new Error("Tài khoản không hợp lệ hoặc bị khóa");
      if (user.points_balance < 1) throw new Error("Số dư điểm không đủ (cần 1 điểm)");

      const item = this.findById(queueItemId);
      if (!item || item.status !== "queued") throw new Error("Bài hát không còn trong hàng đợi để vote");

      const existingVote = this.db
        .query("SELECT 1 FROM queue_votes WHERE queue_item_id = ? AND user_id = ?")
        .get(queueItemId, userId);
      if (existingVote) throw new Error("Bạn đã vote cho bài hát này rồi");

      const now = new Date().toISOString();
      this.db.run(
        "INSERT INTO queue_votes (queue_item_id, user_id, points_spent, created_at) VALUES (?, ?, 1, ?)",
        [queueItemId, userId, now]
      );

      this.db.run("UPDATE queue_items SET vote_score = vote_score + 1 WHERE id = ?", [queueItemId]);

      const newBalance = user.points_balance - 1;
      this.db.run("UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?", [newBalance, now, userId]);

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, -1, 'vote_spend', ?, ?, ?, ?)`,
        [ledgerId, userId, queueItemId, userId, `Vote bài hát: ${item.title}`, now]
      );

      const updatedItem = this.findById(queueItemId);
      return { voteScore: updatedItem.vote_score, newBalance };
    });

    return tx.immediate();
  }

  hasVoted(queueItemId, userId) {
    if (!queueItemId || !userId) return false;
    const row = this.db
      .query("SELECT 1 FROM queue_votes WHERE queue_item_id = ? AND user_id = ? AND refunded_at IS NULL")
      .get(queueItemId, userId);
    return !!row;
  }

  listActiveVoteItemIds(userId) {
    if (!userId) return [];
    return this.db
      .query(
        `SELECT qv.queue_item_id
         FROM queue_votes qv
         JOIN queue_items qi ON qi.id = qv.queue_item_id
         WHERE qv.user_id = ? AND qv.refunded_at IS NULL AND qi.status = 'queued'`
      )
      .all(userId)
      .map((row) => row.queue_item_id);
  }

  getVoters(queueItemId) {
    return this.db
      .query(
        `SELECT qv.queue_item_id, qv.user_id, qv.points_spent, qv.created_at, u.username, u.display_name
         FROM queue_votes qv
         JOIN users u ON qv.user_id = u.id
         WHERE qv.queue_item_id = ? AND qv.refunded_at IS NULL`
      )
      .all(queueItemId);
  }

  _refundVotesUnsafe(queueItemId, reason) {
    const activeVotes = this.getVoters(queueItemId);
    if (!activeVotes.length) return [];

    const now = new Date().toISOString();
    const refunded = [];

    for (const vote of activeVotes) {
      this.db.run(
        "UPDATE users SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?",
        [vote.points_spent, now, vote.user_id]
      );
      const updatedUser = this.db.query("SELECT points_balance FROM users WHERE id = ?").get(vote.user_id);

      this.db.run(
        "UPDATE queue_votes SET refunded_at = ? WHERE queue_item_id = ? AND user_id = ?",
        [now, queueItemId, vote.user_id]
      );

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, ?, 'vote_refund', ?, NULL, ?, ?)`,
        [ledgerId, vote.user_id, vote.points_spent, queueItemId, reason, now]
      );

      refunded.push({
        userId: vote.user_id,
        pointsRefunded: vote.points_spent,
        newBalance: updatedUser.points_balance,
      });
    }

    return refunded;
  }

  refundVotes(queueItemId, reason = "Bài hát bị xóa khỏi hàng đợi") {
    const tx = this.db.transaction(() => this._refundVotesUnsafe(queueItemId, reason));

    return tx.immediate();
  }

  removeAndRefund(queueItemId, reason, finishedAt = Date.now()) {
    const tx = this.db.transaction(() => {
      this.db.run(
        "UPDATE queue_items SET status = 'removed', finished_at = ? WHERE id = ? AND status = 'queued'",
        [finishedAt, queueItemId]
      );
      return this._refundVotesUnsafe(queueItemId, reason);
    });
    return tx.immediate();
  }

  finishAndStart({ finishedId, finalStatus = "played", nextId = null, finishedAt = Date.now(), startedAt = Date.now(), refundReason = "" }) {
    const tx = this.db.transaction(() => {
      let refunds = [];
      if (finishedId) {
        this.db.run(
          "UPDATE queue_items SET status = ?, finished_at = ? WHERE id = ? AND status = 'playing'",
          [finalStatus, finishedAt, finishedId]
        );
        if (finalStatus === "error") {
          refunds = this._refundVotesUnsafe(finishedId, refundReason || "Lỗi phát video YouTube");
        }
      }
      if (nextId) {
        this.db.run(
          "UPDATE queue_items SET status = 'playing', started_at = ? WHERE id = ? AND status = 'queued'",
          [startedAt, nextId]
        );
      }
      return refunds;
    });
    return tx.immediate();
  }
}
