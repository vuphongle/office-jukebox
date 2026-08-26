import test from "node:test";
import assert from "node:assert/strict";

import { createFixedWindowRateLimiter } from "../src/rateLimit.js";

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("Fixed-window limiter isolates keys and resets after its window", () => {
  let timestamp = 1000;
  const limiter = createFixedWindowRateLimiter({
    windowMs: 10_000,
    max: 2,
    key: (req) => req.ip,
    now: () => timestamp,
  });

  let nextCalls = 0;
  limiter({ ip: "a" }, createResponse(), () => nextCalls++);
  limiter({ ip: "a" }, createResponse(), () => nextCalls++);
  const blocked = createResponse();
  limiter({ ip: "a" }, blocked, () => nextCalls++);

  assert.equal(nextCalls, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.ok, false);
  assert.equal(blocked.headers["Retry-After"], "10");

  limiter({ ip: "b" }, createResponse(), () => nextCalls++);
  timestamp += 10_000;
  limiter({ ip: "a" }, createResponse(), () => nextCalls++);
  assert.equal(nextCalls, 4);
});
