import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WebSocketRateLimiter } from "../src/websocketRateLimit.js";
import { getClientIp } from "../src/clientIp.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(null);
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

test("WebSocket limits cap concurrent sockets, aggregate messages, and release on close", async () => {
  // Bun's bundled ws client does not implement failed-upgrade handling and
  // leaves a close wait pending; run the real upgrade/socket integration under
  // Node in CI and keep the limiter invariants covered by Bun's suite.
  if (process.versions.bun) {
    let now = 0;
    const limiter = new WebSocketRateLimiter({ maxConnections: 2, maxMessages: 3, now: () => now });
    assert.equal(limiter.allowConnection("same-ip"), true);
    assert.equal(limiter.allowConnection("same-ip"), true);
    assert.equal(limiter.allowConnection("same-ip"), false);
    limiter.releaseConnection("same-ip");
    assert.equal(limiter.allowConnection("same-ip"), true);
    assert.equal(limiter.allowMessage("same-ip"), true);
    assert.equal(limiter.allowMessage("same-ip"), true);
    assert.equal(limiter.allowMessage("same-ip"), true);
    assert.equal(limiter.allowMessage("same-ip"), false);
    now = 60_001;
    assert.equal(limiter.allowMessage("same-ip"), true);
    limiter.releaseConnection("same-ip");
    limiter.releaseConnection("same-ip");
    limiter.releaseConnection("same-ip");
    assert.deepEqual(limiter.snapshot(), { connections: 0, messages: 1 });
    return;
  }
  const server = http.createServer();
  const limiter = new WebSocketRateLimiter({ maxConnections: 2, maxMessages: 3, maxTrackedIps: 100 });
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      const ip = getClientIp(info.req, false);
      if (!limiter.allowConnection(ip)) return done(false, 429, "Too many connections");
      info.req.clientIp = ip;
      done(true);
    },
  });
  wss.on("connection", (socket, request) => {
    const ip = request.clientIp;
    socket.on("close", () => limiter.releaseConnection(ip));
    socket.on("message", () => {
      if (!limiter.allowMessage(ip)) socket.close(1008, "rate limit");
    });
  });
  const port = await listen(server);
  try {
    const first = await openSocket(port);
    const second = await openSocket(port);
    assert.equal(limiter.allowConnection("127.0.0.1"), false);
    first.close();
    await waitForClose(first);
    const replacement = await openSocket(port);

    replacement.send("one");
    replacement.send("two");
    replacement.send("three");
    replacement.send("four");
    const closeCode = await waitForClose(replacement);
    assert.equal(closeCode, 1008);

    second.close();
    await waitForClose(second);
    replacement.close();
  } finally {
    for (const socket of wss.clients) socket.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
