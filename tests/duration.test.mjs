import test from "node:test";
import assert from "node:assert/strict";
import { parseDurationSeconds } from "../src/duration.js";

test("duration validation rejects malformed, zero, and over-limit values", () => {
  assert.equal(parseDurationSeconds("3:20", { maxSeconds: 600 }), 200);
  assert.equal(parseDurationSeconds("30", { maxSeconds: 600 }), 30);
  for (const value of ["", ":", "0", "00:00", "1:99", "1:2", "10:01:00"]) {
    assert.equal(parseDurationSeconds(value, { maxSeconds: 600 }), null, value);
  }
  assert.equal(parseDurationSeconds("10:00", { maxSeconds: 600 }), 600);
  assert.equal(parseDurationSeconds("10:01", { maxSeconds: 600 }), null);
});
