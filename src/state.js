// Trạng thái hàng đợi — Quản lý trong bộ nhớ kết hợp SQLite SSOT.
// Hỗ trợ xếp thứ tự đa tầng: pinned DESC, pinned_order ASC, vote_score DESC, queue_sequence ASC.
// Hoàn điểm 100% khi xóa bài hoặc lỗi phát YouTube (101/150).

import { randomUUID } from "node:crypto";
import { QueueRepository } from "./repositories/queueRepository.js";

const DEFAULT_DURATION_SECONDS = 3 * 60 + 30;
const DEFAULT_DURATION = "3:30";

export class JukeboxState {
  constructor(db = null) {
    this.db = db;
    this.queueRepo = db ? new QueueRepository(db) : null;
    this.nowPlaying = null; // mục hiện tại hoặc null
    this.queue = []; // các mục sắp phát
    this.history = []; // các mục đã phát (mới nhất ở cuối), có giới hạn
    this.voteSortOn = true;
    this.onChange = () => {};
    this.onBalanceChange = () => {};

    if (this.db) {
      this.initFromDb();
    }
  }

  initFromDb() {
    if (!this.queueRepo) return;
    try {
      const active = this.queueRepo.getActiveOrPlaying();
      if (active) {
        this.nowPlaying = {
          id: active.id,
          videoId: active.video_id,
          title: active.title,
          channel: active.channel || "",
          duration: normalizeDuration(active.duration),
          thumbnail: active.thumbnail || null,
          addedBy: active.added_by || "",
          requesterId: active.requester_id || "",
          addedByUserId: active.added_by_user_id || null,
          queueSequence: active.queue_sequence,
          voteScore: active.vote_score || 0,
          pinned: active.pinned === 1,
          pinnedOrder: active.pinned_order || 0,
          addedAt: active.added_at,
          startedAt: active.started_at || Date.now(),
        };
      }

      const items = this.queueRepo.getQueuedItems("default_event", this.voteSortOn);
      this.queue = items.map((row) => ({
        id: row.id,
        videoId: row.video_id,
        title: row.title,
        channel: row.channel || "",
        duration: normalizeDuration(row.duration),
        thumbnail: row.thumbnail || null,
        addedBy: row.added_by || "",
        requesterId: row.requester_id || "",
        addedByUserId: row.added_by_user_id || null,
        queueSequence: row.queue_sequence,
        voteScore: row.vote_score || 0,
        pinned: row.pinned === 1,
        pinnedOrder: row.pinned_order || 0,
        addedAt: row.added_at,
      }));

      this._sortQueue();
      this._promoteIfIdle();
    } catch (err) {
      console.warn(`[state] initFromDb error: ${err.message}`);
    }
  }

  // Video này đang phát hay đã ở đâu đó trong hàng đợi?
  has(videoId) {
    return this.nowPlaying?.videoId === videoId || this.queue.some((s) => s.videoId === videoId);
  }

  snapshot() {
    const queue = this._estimatedQueue();
    return {
      nowPlaying: this._publicItem(this.nowPlaying),
      queue,
      historyCount: this.history.length,
      voteSortOn: this.voteSortOn,
    };
  }

  _publicItem(item, extra = {}) {
    if (!item) return null;
    const { requesterId: _requesterId, startedAt: _startedAt, addedByUserId: _addedByUserId, ...publicItem } = item;
    return {
      ...publicItem,
      voteScore: item.voteScore || 0,
      pinned: !!item.pinned,
      ...extra,
    };
  }

  _estimatedQueue() {
    let nextStart = Date.now();
    if (this.nowPlaying) {
      const startedAt = this.nowPlaying.startedAt || Date.now();
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      const remaining = durationSeconds(this.nowPlaying.duration);
      if (!Number.isFinite(remaining)) {
        nextStart = null;
      } else {
        nextStart = Date.now() + Math.max(0, remaining - elapsed) * 1000;
      }
    }

    return this.queue.map((item) => {
      const estimatedStartAt = nextStart;
      const duration = durationSeconds(item.duration);
      if (nextStart !== null && Number.isFinite(duration)) nextStart += duration * 1000;
      else nextStart = null;
      return this._publicItem(item, { estimatedStartAt });
    });
  }

  _emit() {
    this.onChange(this.snapshot());
  }

  _sortQueue() {
    this.queue.sort((a, b) => {
      // 1. pinned DESC (1 before 0)
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;

      // If both are pinned, sort by pinnedOrder ASC
      if (a.pinned && b.pinned) {
        return (a.pinnedOrder || 0) - (b.pinnedOrder || 0);
      }

      // 2. voteScore DESC (if voteSortOn)
      if (this.voteSortOn) {
        const aScore = a.voteScore || 0;
        const bScore = b.voteScore || 0;
        if (aScore !== bScore) return bScore - aScore;
      }

      // 3. queueSequence ASC (added earlier plays earlier)
      return (a.queueSequence || 0) - (b.queueSequence || 0);
    });
  }

  // Đưa bài tiếp theo trong hàng đợi lên phát nếu hiện không có bài nào.
  _promoteIfIdle() {
    if (!this.nowPlaying && this.queue.length > 0) {
      this.nowPlaying = this.queue.shift();
      this.nowPlaying.startedAt = Date.now();
      if (this.queueRepo) {
        this.queueRepo.updateStatus(this.nowPlaying.id, "playing", { startedAt: this.nowPlaying.startedAt });
      }
    }
  }

  // Thêm bài hát đã được kiểm duyệt/chấp thuận. Trả về mục đã tạo kèm vị trí.
  add({ videoId, title, channel, duration, thumbnail, addedBy, requesterId, userId = null }) {
    let dbItem = null;
    if (this.queueRepo) {
      dbItem = this.queueRepo.createItem({
        videoId,
        title,
        channel,
        duration,
        thumbnail,
        addedBy,
        requesterId,
        addedByUserId: userId,
      });
    }

    const item = {
      id: dbItem ? dbItem.id : randomUUID(),
      videoId,
      title,
      channel: channel || "",
      duration: normalizeDuration(duration),
      thumbnail: thumbnail || null,
      addedBy: (addedBy || "").slice(0, 40),
      requesterId: (requesterId || "").toString().slice(0, 64),
      addedByUserId: userId,
      queueSequence: dbItem ? dbItem.queue_sequence : (this.queue.length ? Math.max(...this.queue.map(q => q.queueSequence || 0)) + 1 : 1),
      voteScore: 0,
      pinned: false,
      pinnedOrder: 0,
      addedAt: Date.now(),
    };

    this.queue.push(item);
    this._sortQueue();
    this._promoteIfIdle();
    this._emit();
    const position = this.nowPlaying === item ? 0 : this.queue.indexOf(item) + 1;
    return { item, position };
  }

  // Vote cho bài hát
  vote(itemId, userId) {
    if (!this.queueRepo) throw new Error("Không có kết nối database để vote");
    const res = this.queueRepo.addVote(itemId, userId);
    const item = this.queue.find((q) => q.id === itemId);
    if (item) {
      item.voteScore = res.voteScore;
      this._sortQueue();
      this._emit();
    }
    return res;
  }

  hasVoted(itemId, userId) {
    if (!this.queueRepo || !userId) return false;
    return this.queueRepo.hasVoted(itemId, userId);
  }

  // Chuyển sang bài tiếp theo. finishedVideoId ngăn chuyển hai lần do các event
  // "ended"/"error" trùng lặp của cùng một bài.
  advance(finishedVideoId, { isError = false } = {}) {
    if (finishedVideoId && this.nowPlaying && this.nowPlaying.videoId !== finishedVideoId) {
      return; // event cũ của bài đã được chuyển qua
    }
    const finishedItem = this.nowPlaying;
    const nextItem = this.queue[0] || null;
    const transitionedAt = Date.now();
    let refunds = [];
    if (this.queueRepo) {
      refunds = this.queueRepo.finishAndStart({
        finishedId: finishedItem?.id || null,
        finalStatus: isError ? "error" : "played",
        nextId: nextItem?.id || null,
        finishedAt: transitionedAt,
        startedAt: transitionedAt,
        refundReason: "Lỗi phát video YouTube",
      });
    }
    if (finishedItem) {
      this.history.push(finishedItem);
      if (this.history.length > 100) this.history.shift();
    }
    this.nowPlaying = this.queue.shift() || null;
    if (this.nowPlaying) this.nowPlaying.startedAt = transitionedAt;
    this._emit();
    this._emitBalanceChanges(refunds, "Hoàn điểm do lỗi phát video YouTube");
  }

  // Điều khiển host: bỏ qua bài hiện tại bất kể bài nào đang phát.
  skip() {
    this.advance(this.nowPlaying?.videoId);
  }

  // Xóa một mục sắp phát theo id (điều khiển host).
  remove(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index === -1) return;
    const refunds = this.queueRepo
      ? this.queueRepo.removeAndRefund(id, "Host xóa bài khỏi hàng đợi")
      : [];
    this.queue.splice(index, 1);
    this._emit();
    this._emitBalanceChanges(refunds, "Hoàn điểm do bài hát bị xóa khỏi hàng đợi");
  }

  // Xóa một mục sắp phát khi clientId trùng với người đã thêm mục đó (hoặc userId).
  removeOwned(id, requesterId, userId = null) {
    if (typeof id !== "string") return false;
    const index = this.queue.findIndex(
      (item) => item.id === id && (item.requesterId === requesterId || (userId && item.addedByUserId === userId))
    );
    if (index === -1) return false;
    const refunds = this.queueRepo
      ? this.queueRepo.removeAndRefund(id, "Người yêu cầu tự xóa bài")
      : [];
    this.queue.splice(index, 1);
    this._emit();
    this._emitBalanceChanges(refunds, "Hoàn điểm do bài hát bị xóa khỏi hàng đợi");
    return true;
  }

  // Di chuyển một mục sắp phát lên/xuống (điều khiển host).
  move(id, dir) {
    const i = this.queue.findIndex((s) => s.id === id);
    if (i === -1) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this._pinThroughIndex(j);
    this._syncPinnedOrder();
    this._emit();
  }

  // Đưa một mục tới ngay trước beforeId; beforeId null/undefined = đưa xuống cuối.
  reorder(id, beforeId = null) {
    if (typeof id !== "string") return false;
    if (beforeId !== null && beforeId !== undefined && typeof beforeId !== "string") return false;
    if (beforeId === id) return false;

    const i = this.queue.findIndex((s) => s.id === id);
    if (i === -1) return false;
    if (beforeId !== null && beforeId !== undefined && !this.queue.some((s) => s.id === beforeId)) {
      return false;
    }

    // No-op check: already at the end when beforeId is null/undefined
    if ((beforeId === null || beforeId === undefined) && i === this.queue.length - 1) {
      return false;
    }

    // No-op check: already immediately before beforeId
    if (beforeId !== null && beforeId !== undefined) {
      const targetIdx = this.queue.findIndex((s) => s.id === beforeId);
      if (i === targetIdx - 1) {
        return false;
      }
    }

    const [item] = this.queue.splice(i, 1);
    const j = beforeId === null || beforeId === undefined
      ? this.queue.length
      : this.queue.findIndex((s) => s.id === beforeId);

    if (j < 0) {
      this.queue.splice(i, 0, item);
      return false;
    }

    this.queue.splice(j, 0, item);
    this._pinThroughIndex(j);
    this._syncPinnedOrder();
    this._emit();
    return true;
  }

  unpin(id) {
    const item = this.queue.find((s) => s.id === id);
    if (!item) return false;
    if (this.queueRepo) this.queueRepo.unpin(id);
    item.pinned = false;
    item.pinnedOrder = 0;
    this._sortQueue();
    this._syncPinnedOrder();
    this._emit();
    return true;
  }

  setVoteSort(on) {
    this.voteSortOn = !!on;
    this._sortQueue();
    this._emit();
  }

  _syncPinnedOrder() {
    let order = 1;
    const pinnedItems = [];
    for (const item of this.queue) {
      if (item.pinned) {
        item.pinnedOrder = order++;
        pinnedItems.push(item);
      }
    }
    if (this.queueRepo && pinnedItems.length) this.queueRepo.reorderPinned(pinnedItems);
  }

  // Pinned items form one contiguous prefix. Pinning the whole prefix preserves
  // the host's explicit order both in memory and after SQLite reload/sorting.
  _pinThroughIndex(index) {
    for (let i = 0; i <= index; i++) {
      this.queue[i].pinned = true;
    }
  }

  _emitBalanceChanges(changes, reason) {
    for (const change of changes || []) {
      this.onBalanceChange({ ...change, reason });
    }
  }
}

function durationSeconds(duration) {
  if (typeof duration !== "string") return DEFAULT_DURATION_SECONDS;
  const normalized = duration.trim();
  if (!/^\d+(?::\d+){0,2}$/.test(normalized)) return DEFAULT_DURATION_SECONDS;
  const parts = normalized.split(":");
  if (parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60)) {
    return DEFAULT_DURATION_SECONDS;
  }
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_DURATION_SECONDS;
}

function normalizeDuration(duration) {
  if (typeof duration !== "string") return DEFAULT_DURATION;
  const normalized = duration.trim();
  return durationSeconds(normalized) === DEFAULT_DURATION_SECONDS && normalized !== DEFAULT_DURATION
    ? DEFAULT_DURATION
    : normalized;
}
