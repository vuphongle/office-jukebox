import { randomUUID } from "node:crypto";

export class QueueRepository {
  constructor(db) {
    this.db = db;
  }

  getNextSequence(eventId = "default_event") {
    const row = this.db.query("SELECT MAX(queue_sequence) as maxSeq FROM queue_items WHERE event_id = ?").get(eventId);
    return (row?.maxSeq || 0) + 1;
  }

  getNextVoteRankSequence(eventId = "default_event") {
    const row = this.db
      .query("SELECT MAX(vote_rank_sequence) as maxSeq FROM queue_items WHERE event_id = ?")
      .get(eventId);
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
           ORDER BY pinned DESC, pinned_order ASC, vote_score DESC, vote_rank_sequence ASC, queue_sequence ASC`
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

  getRecentPlayed(eventId = "default_event", limit = 20) {
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.db
      .query(
        `SELECT id, video_id, title, channel, duration, added_by, added_by_user_id,
                vote_score, finished_at, finish_reason, played_seconds
         FROM queue_items
         WHERE event_id = ? AND status = 'played'
         ORDER BY finished_at DESC LIMIT ?`
      )
      .all(eventId, boundedLimit);
  }

  getQueueStats(eventId = "default_event") {
    return this.db
      .query(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
           SUM(CASE WHEN status = 'playing' THEN 1 ELSE 0 END) AS playing_count,
           SUM(CASE WHEN status = 'played' THEN 1 ELSE 0 END) AS played_count,
           COALESCE(MAX(vote_score), 0) AS max_vote_score
         FROM queue_items WHERE event_id = ?`
      )
      .get(eventId);
  }

  getVoteLeaders(eventId = "default_event", limit = 10) {
    const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 10));
    return this.db
      .query(
        `SELECT title, vote_score
         FROM queue_items
         WHERE event_id = ? AND status IN ('queued', 'playing') AND vote_score > 0
         ORDER BY vote_score DESC, queue_sequence ASC LIMIT ?`
      )
      .all(eventId, boundedLimit);
  }

  updateStatus(id, status, { startedAt = null, finishedAt = null, finishReason = null, playedSeconds = null } = {}) {
    const now = Date.now();
    if (status === "playing") {
      this.db.run(
        "UPDATE queue_items SET status = 'playing', started_at = ? WHERE id = ?",
        [startedAt || now, id]
      );
    } else if (["played", "removed", "error"].includes(status)) {
      const resolvedFinishReason = finishReason || (status === "played" ? "ended" : status);
      this.db.run(
        "UPDATE queue_items SET status = ?, finished_at = ?, finish_reason = ?, played_seconds = ? WHERE id = ?",
        [status, finishedAt || now, resolvedFinishReason, playedSeconds, id]
      );
    } else {
      this.db.run("UPDATE queue_items SET status = ? WHERE id = ?", [status, id]);
    }
    return this.findById(id);
  }

  syncPinnedOrder(items) {
    const tx = this.db.transaction(() => {
      for (const item of items) {
        this.db.run(
          "UPDATE queue_items SET pinned = ?, pinned_order = ? WHERE id = ? AND status = 'queued'",
          [item.pinned ? 1 : 0, item.pinned ? item.pinnedOrder : 0, item.id]
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
        .query("SELECT points_spent, refunded_at FROM queue_votes WHERE queue_item_id = ? AND user_id = ?")
        .get(queueItemId, userId);

      const now = new Date().toISOString();
      if (existingVote && !existingVote.refunded_at) {
        this.db.run(
          "UPDATE queue_votes SET points_spent = points_spent + 1 WHERE queue_item_id = ? AND user_id = ?",
          [queueItemId, userId]
        );
      } else if (existingVote) {
        this.db.run(
          "UPDATE queue_votes SET points_spent = 1, created_at = ?, refunded_at = NULL WHERE queue_item_id = ? AND user_id = ?",
          [now, queueItemId, userId]
        );
      } else {
        this.db.run(
          "INSERT INTO queue_votes (queue_item_id, user_id, points_spent, created_at) VALUES (?, ?, 1, ?)",
          [queueItemId, userId, now]
        );
      }

      const voteRankSequence = this.getNextVoteRankSequence(item.event_id);
      this.db.run(
        "UPDATE queue_items SET vote_score = vote_score + 1, vote_rank_sequence = ? WHERE id = ?",
        [voteRankSequence, queueItemId]
      );

      const newBalance = user.points_balance - 1;
      this.db.run("UPDATE users SET points_balance = ?, updated_at = ? WHERE id = ?", [newBalance, now, userId]);

      const ledgerId = randomUUID();
      this.db.run(
        `INSERT INTO point_ledger (id, user_id, delta, type, reference_id, actor_user_id, reason, created_at)
         VALUES (?, ?, -1, 'vote_spend', ?, ?, ?, ?)`,
        [ledgerId, userId, queueItemId, userId, `Vote bài hát: ${item.title}`, now]
      );

      const updatedItem = this.findById(queueItemId);
      return {
        voteScore: updatedItem.vote_score,
        voteRankSequence: updatedItem.vote_rank_sequence,
        newBalance,
      };
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

  listActiveVotesByUser(userId) {
    if (!userId) return [];
    return this.db
      .query(
        `SELECT qv.queue_item_id, qv.points_spent
         FROM queue_votes qv
         JOIN queue_items qi ON qi.id = qv.queue_item_id
         WHERE qv.user_id = ? AND qv.refunded_at IS NULL AND qi.status = 'queued'`
      )
      .all(userId);
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
        "UPDATE queue_items SET status = 'removed', finished_at = ?, finish_reason = 'removed' WHERE id = ? AND status = 'queued'",
        [finishedAt, queueItemId]
      );
      return this._refundVotesUnsafe(queueItemId, reason);
    });
    return tx.immediate();
  }

  finishAndStart({
    finishedId,
    finalStatus = "played",
    nextId = null,
    finishedAt = Date.now(),
    startedAt = Date.now(),
    finishReason = null,
    playedSeconds = null,
    refundReason = "",
  }) {
    const tx = this.db.transaction(() => {
      let refunds = [];
      if (finishedId) {
        const resolvedFinishReason = finishReason || (finalStatus === "played" ? "ended" : finalStatus);
        this.db.run(
          "UPDATE queue_items SET status = ?, finished_at = ?, finish_reason = ?, played_seconds = ? WHERE id = ? AND status = 'playing'",
          [finalStatus, finishedAt, resolvedFinishReason, playedSeconds, finishedId]
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
