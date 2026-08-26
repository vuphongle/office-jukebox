// Trạng thái hàng đợi trong bộ nhớ, có tính quyết định. Server sở hữu hàng đợi;
// trang host chỉ là trình phát hiển thị nội dung của nowPlaying.
//
// Mọi thay đổi đều gọi onChange(), server dùng hàm này để phát toàn bộ trạng thái
// tới mọi client đang kết nối. Trạng thái nhỏ (playlist của buổi tiệc), nên phát
// toàn bộ sau mỗi thay đổi giúp logic đơn giản.

import { randomUUID } from "node:crypto";

const DEFAULT_DURATION_SECONDS = 3 * 60 + 30;
const DEFAULT_DURATION = "3:30";

export class JukeboxState {
  constructor() {
    this.nowPlaying = null; // mục hiện tại hoặc null
    this.queue = []; // các mục sắp phát
    this.history = []; // các mục đã phát (mới nhất ở cuối), có giới hạn
    this.onChange = () => {};
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
    };
  }

  _publicItem(item, extra = {}) {
    if (!item) return null;
    const { requesterId: _requesterId, startedAt: _startedAt, ...publicItem } = item;
    return { ...publicItem, ...extra };
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

  // Đưa bài tiếp theo trong hàng đợi lên phát nếu hiện không có bài nào.
  _promoteIfIdle() {
    if (!this.nowPlaying && this.queue.length > 0) {
      this.nowPlaying = this.queue.shift();
      this.nowPlaying.startedAt = Date.now();
    }
  }

  // Thêm bài hát đã được kiểm duyệt/chấp thuận. Trả về mục đã tạo kèm vị trí.
  add({ videoId, title, channel, duration, thumbnail, addedBy, requesterId }) {
    const item = {
      id: randomUUID(),
      videoId,
      title,
      channel: channel || "",
      duration: normalizeDuration(duration),
      thumbnail: thumbnail || null,
      addedBy: (addedBy || "").slice(0, 40),
      requesterId: (requesterId || "").toString().slice(0, 64),
      addedAt: Date.now(),
    };
    this.queue.push(item);
    this._promoteIfIdle();
    this._emit();
    const position = this.nowPlaying === item ? 0 : this.queue.indexOf(item) + 1;
    return { item, position };
  }

  // Chuyển sang bài tiếp theo. finishedVideoId ngăn chuyển hai lần do các event
  // "ended"/"error" trùng lặp của cùng một bài.
  advance(finishedVideoId) {
    if (finishedVideoId && this.nowPlaying && this.nowPlaying.videoId !== finishedVideoId) {
      return; // event cũ của bài đã được chuyển qua
    }
    if (this.nowPlaying) {
      this.history.push(this.nowPlaying);
      if (this.history.length > 100) this.history.shift();
    }
    this.nowPlaying = this.queue.shift() || null;
    if (this.nowPlaying) this.nowPlaying.startedAt = Date.now();
    this._emit();
  }

  // Điều khiển host: bỏ qua bài hiện tại bất kể bài nào đang phát.
  skip() {
    this.advance(this.nowPlaying?.videoId);
  }

  // Xóa một mục sắp phát theo id (điều khiển host).
  remove(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((s) => s.id !== id);
    if (this.queue.length !== before) this._emit();
  }

  // Xóa một mục sắp phát khi clientId trùng với người đã thêm mục đó.
  removeOwned(id, requesterId) {
    if (typeof id !== "string" || typeof requesterId !== "string" || !requesterId) return false;
    const index = this.queue.findIndex((item) => item.id === id && item.requesterId === requesterId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this._emit();
    return true;
  }

  // Di chuyển một mục sắp phát lên/xuống (điều khiển host).
  move(id, dir) {
    const i = this.queue.findIndex((s) => s.id === id);
    if (i === -1) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this._emit();
  }

  // Đưa một mục tới ngay trước beforeId; beforeId null/undefined = đưa xuống cuối.
  // Dùng id của mục làm mốc thay vì index để không bị lệch khi queue đổi realtime.
  reorder(id, beforeId = null) {
    if (typeof id !== "string") return false;
    if (beforeId !== null && beforeId !== undefined && typeof beforeId !== "string") return false;
    if (beforeId === id) return false;

    const i = this.queue.findIndex((s) => s.id === id);
    if (i === -1) return false;
    if (beforeId !== null && beforeId !== undefined && !this.queue.some((s) => s.id === beforeId)) {
      return false;
    }

    const [item] = this.queue.splice(i, 1);
    const j = beforeId === null || beforeId === undefined
      ? this.queue.length
      : this.queue.findIndex((s) => s.id === beforeId);

    // The anchor was checked above, but restore safely if the state changes
    // unexpectedly while this operation is being prepared.
    if (j < 0) {
      this.queue.splice(i, 0, item);
      return false;
    }

    this.queue.splice(j, 0, item);
    if (j === i) return false;
    this._emit();
    return true;
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
