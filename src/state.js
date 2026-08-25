// Trạng thái hàng đợi trong bộ nhớ, có tính quyết định. Server sở hữu hàng đợi;
// trang host chỉ là trình phát hiển thị nội dung của nowPlaying.
//
// Mọi thay đổi đều gọi onChange(), server dùng hàm này để phát toàn bộ trạng thái
// tới mọi client đang kết nối. Trạng thái nhỏ (playlist của buổi tiệc), nên phát
// toàn bộ sau mỗi thay đổi giúp logic đơn giản.

import { randomUUID } from "node:crypto";

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
    return {
      nowPlaying: this.nowPlaying,
      queue: this.queue,
      historyCount: this.history.length,
    };
  }

  _emit() {
    this.onChange(this.snapshot());
  }

  // Đưa bài tiếp theo trong hàng đợi lên phát nếu hiện không có bài nào.
  _promoteIfIdle() {
    if (!this.nowPlaying && this.queue.length > 0) {
      this.nowPlaying = this.queue.shift();
    }
  }

  // Thêm bài hát đã được kiểm duyệt/chấp thuận. Trả về mục đã tạo kèm vị trí.
  add({ videoId, title, channel, duration, thumbnail, addedBy }) {
    const item = {
      id: randomUUID(),
      videoId,
      title,
      channel: channel || "",
      duration: duration || "",
      thumbnail: thumbnail || null,
      addedBy: (addedBy || "").slice(0, 40),
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
