import test from "node:test";
import assert from "node:assert/strict";
import { parseDurationSeconds, formatSecondsToDuration } from "../src/duration.js";

test("duration validation rejects malformed, zero, and over-limit values", () => {
  assert.equal(parseDurationSeconds("3:20", { maxSeconds: 600 }), 200);
  assert.equal(parseDurationSeconds("30", { maxSeconds: 600 }), 30);
  for (const value of ["", ":", "0", "00:00", "1:99", "1:2", "10:01:00"]) {
    assert.equal(parseDurationSeconds(value, { maxSeconds: 600 }), null, value);
  }
  assert.equal(parseDurationSeconds("10:00", { maxSeconds: 600 }), 600);
  assert.equal(parseDurationSeconds("10:01", { maxSeconds: 600 }), null);
});

test("formatSecondsToDuration formats seconds to M:SS and H:MM:SS", () => {
  assert.equal(formatSecondsToDuration(0), "0:00");
  assert.equal(formatSecondsToDuration(15), "0:15");
  assert.equal(formatSecondsToDuration(65), "1:05");
  assert.equal(formatSecondsToDuration(210), "3:30");
  assert.equal(formatSecondsToDuration(600), "10:00");
  assert.equal(formatSecondsToDuration(855), "14:15");
  assert.equal(formatSecondsToDuration(3600), "1:00:00");
  assert.equal(formatSecondsToDuration(3665), "1:01:05");
});

test("parseDurationSeconds parses long tracks when maxSeconds allows", () => {
  assert.equal(parseDurationSeconds("14:15", { maxSeconds: 86400 }), 855);
  assert.equal(parseDurationSeconds("1:01:05", { maxSeconds: 86400 }), 3665);
});
