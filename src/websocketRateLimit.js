// Process-local WebSocket abuse controls. The state is deliberately bounded
// and expires when an address has been idle so a scan cannot grow these maps
// without limit.

const DEFAULT_MESSAGE_WINDOW_MS = 60_000;
const DEFAULT_MAX_TRACKED_IPS = 5_000;

export class WebSocketRateLimiter {
  constructor({
    maxConnections = 200,
    maxMessages = 600,
    messageWindowMs = DEFAULT_MESSAGE_WINDOW_MS,
    maxTrackedIps = DEFAULT_MAX_TRACKED_IPS,
    now = Date.now,
  } = {}) {
    this.maxConnections = Math.max(1, Number(maxConnections) || 1);
    this.maxMessages = Math.max(1, Number(maxMessages) || 1);
    this.messageWindowMs = Math.max(1000, Number(messageWindowMs) || DEFAULT_MESSAGE_WINDOW_MS);
    this.maxTrackedIps = Math.max(100, Number(maxTrackedIps) || DEFAULT_MAX_TRACKED_IPS);
    this.now = now;
    this.connections = new Map();
    this.messages = new Map();
  }

  _prune(timestamp = this.now()) {
    for (const [ip, bucket] of this.connections) {
      if (bucket.count <= 0 && timestamp - bucket.lastSeen > this.messageWindowMs) this.connections.delete(ip);
    }
    for (const [ip, bucket] of this.messages) {
      if (timestamp >= bucket.resetAt) this.messages.delete(ip);
    }
    if (this.connections.size > this.maxTrackedIps) {
      for (const [ip, bucket] of this.connections) {
        if (this.connections.size <= this.maxTrackedIps) break;
        if (bucket.count <= 0) this.connections.delete(ip);
      }
    }
    if (this.messages.size > this.maxTrackedIps) {
      for (const [ip, bucket] of this.messages) {
        if (this.messages.size <= this.maxTrackedIps) break;
        if (timestamp >= bucket.resetAt && !this.connections.has(ip)) this.messages.delete(ip);
      }
    }
  }

  allowConnection(ip) {
    const key = String(ip || "unknown");
    const timestamp = this.now();
    this._prune(timestamp);
    if (!this.connections.has(key) && this.connections.size >= this.maxTrackedIps) return false;
    const bucket = this.connections.get(key) || { count: 0, lastSeen: timestamp };
    if (bucket.count >= this.maxConnections) {
      bucket.lastSeen = timestamp;
      this.connections.set(key, bucket);
      return false;
    }
    bucket.count += 1;
    bucket.lastSeen = timestamp;
    this.connections.set(key, bucket);
    this._prune(timestamp);
    return true;
  }

  releaseConnection(ip) {
    const key = String(ip || "unknown");
    const bucket = this.connections.get(key);
    if (!bucket) return;
    bucket.count = Math.max(0, bucket.count - 1);
    bucket.lastSeen = this.now();
    if (bucket.count === 0) this.connections.delete(key);
  }

  allowMessage(ip) {
    const key = String(ip || "unknown");
    const timestamp = this.now();
    this._prune(timestamp);
    if (!this.messages.has(key) && this.messages.size >= this.maxTrackedIps) return false;
    let bucket = this.messages.get(key);
    if (!bucket || timestamp >= bucket.resetAt) {
      bucket = { count: 0, resetAt: timestamp + this.messageWindowMs };
    }
    if (bucket.count >= this.maxMessages) {
      this.messages.set(key, bucket);
      return false;
    }
    bucket.count += 1;
    this.messages.set(key, bucket);
    this._prune(timestamp);
    return true;
  }

  snapshot() {
    return { connections: this.connections.size, messages: this.messages.size };
  }
}
