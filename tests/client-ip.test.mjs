import test from "node:test";
import assert from "node:assert/strict";
import { getClientIp, parseTrustProxy } from "../src/clientIp.js";
import express from "express";
import http from "node:http";
import { setSessionCookie } from "../src/auth.js";

const request = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
});

test("client IP follows supported trust-proxy modes", () => {
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("garbage"), false);
  assert.equal(getClientIp(request("10.0.0.2", "198.51.100.10"), false), "10.0.0.2");
  assert.equal(getClientIp(request("10.0.0.2", "198.51.100.10, 10.0.0.1"), 1), "10.0.0.1");
  assert.equal(getClientIp(request("10.0.0.2", "198.51.100.10, 10.0.0.1"), 2), "198.51.100.10");
  assert.equal(getClientIp(request("10.0.0.2", "198.51.100.10, 10.0.0.1"), true), "198.51.100.10");
});

test("Express secure cookies follow the configured proxy trust mode", async () => {
  for (const [mode, expectedSecure] of [[false, false], [1, true], [true, true]]) {
    const app = express();
    app.set("trust proxy", mode);
    app.get("/cookie", (req, res) => {
      setSessionCookie(res, "token", req);
      res.json({ secure: req.secure });
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cookie`, {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "198.51.100.10" },
      });
      assert.equal((await response.json()).secure, expectedSecure);
      assert.equal(response.headers.get("set-cookie").includes("Secure"), expectedSecure);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
