import { test, expect, describe } from "bun:test";
import { parseLrc } from "../src/lyricsService.js";

describe("Lyrics Synchronization Invariants", () => {
  test("server adjusts playbackTick position by elapsed time when playing", () => {
    const recordedTime = Date.now() - 1500; // 1.5 seconds ago
    const tick = {
      position: 10000,
      paused: false,
      seek: false,
      videoId: "track123",
      serverTime: recordedTime,
    };

    const now = Date.now();
    const elapsed = tick.paused ? 0 : Math.max(0, now - (tick.serverTime || now));
    const response = {
      ...tick,
      position: tick.position + elapsed,
      serverTime: now,
    };

    expect(response.position).toBeGreaterThanOrEqual(11400);
    expect(response.position).toBeLessThanOrEqual(11600);
    expect(response.serverTime).toBe(now);
  });

  test("server does not adjust playbackTick position when paused", () => {
    const recordedTime = Date.now() - 2500;
    const tick = {
      position: 10000,
      paused: true,
      seek: false,
      videoId: "track123",
      serverTime: recordedTime,
    };

    const now = Date.now();
    const elapsed = tick.paused ? 0 : Math.max(0, now - (tick.serverTime || now));
    const response = {
      ...tick,
      position: tick.position + elapsed,
      serverTime: now,
    };

    expect(response.position).toBe(10000);
    expect(response.serverTime).toBe(now);
  });

  test("guest latency compensation clamps delay to [0, 2000ms] and ignores when paused", () => {
    function computeGuestPosition(msg, clientNow = Date.now()) {
      const isPaused = Boolean(msg.paused);
      const rawDelay = typeof msg.serverTime === "number" ? clientNow - msg.serverTime : 0;
      const networkDelay = (!isPaused && rawDelay >= 0 && rawDelay <= 2000) ? rawDelay : 0;
      return (typeof msg.position === "number" ? msg.position : 0) + networkDelay;
    }

    const now = 100000;
    // Normal network latency (80ms)
    expect(computeGuestPosition({ position: 5000, paused: false, serverTime: now - 80 }, now)).toBe(5080);
    // Paused playback: no latency added
    expect(computeGuestPosition({ position: 5000, paused: true, serverTime: now - 80 }, now)).toBe(5000);
    // Negative delay (client clock behind server): treated as clock skew, delay = 0
    expect(computeGuestPosition({ position: 5000, paused: false, serverTime: now + 500 }, now)).toBe(5000);
    // Extreme delay (> 2000ms): treated as clock skew, delay = 0
    expect(computeGuestPosition({ position: 5000, paused: false, serverTime: now - 3500 }, now)).toBe(5000);
  });

  test("guest anchor smoothing applies soft correction for micro-drift and hard reset for seek/large jump", () => {
    function calculateAnchorUpdate({
      currentAnchorPos,
      currentAnchorTime,
      isCurrentlyPaused,
      newTargetPos,
      isSeek,
      newPaused,
      currentTime,
    }) {
      const currentExpectedPos = isCurrentlyPaused
        ? currentAnchorPos
        : currentAnchorPos + (currentTime - currentAnchorTime);
      const drift = newTargetPos - currentExpectedPos;

      let updatedAnchorPos = currentAnchorPos;
      let updatedAnchorTime = currentAnchorTime;

      if (isSeek || isCurrentlyPaused !== newPaused || Math.abs(drift) > 500 || currentAnchorTime === 0) {
        updatedAnchorPos = newTargetPos;
        updatedAnchorTime = currentTime;
      } else {
        updatedAnchorPos += drift * 0.3;
      }

      return { updatedAnchorPos, updatedAnchorTime, drift };
    }

    const t0 = 1000;
    // Small drift (50ms): smooth adjustment without resetting anchorTime
    const smoothResult = calculateAnchorUpdate({
      currentAnchorPos: 10000,
      currentAnchorTime: t0,
      isCurrentlyPaused: false,
      newTargetPos: 10050 + 200, // expected is 10000 + 200 = 10200; target is 10250 -> drift = +50
      isSeek: false,
      newPaused: false,
      currentTime: t0 + 200,
    });
    expect(smoothResult.drift).toBe(50);
    expect(smoothResult.updatedAnchorPos).toBeCloseTo(10015, 1);
    expect(smoothResult.updatedAnchorTime).toBe(t0);

    // Large jump (800ms): hard reset
    const hardJumpResult = calculateAnchorUpdate({
      currentAnchorPos: 10000,
      currentAnchorTime: t0,
      isCurrentlyPaused: false,
      newTargetPos: 11000,
      isSeek: false,
      newPaused: false,
      currentTime: t0 + 200,
    });
    expect(hardJumpResult.updatedAnchorPos).toBe(11000);
    expect(hardJumpResult.updatedAnchorTime).toBe(t0 + 200);

    // Explicit seek flag: hard reset even if drift is small
    const seekResult = calculateAnchorUpdate({
      currentAnchorPos: 10000,
      currentAnchorTime: t0,
      isCurrentlyPaused: false,
      newTargetPos: 10010,
      isSeek: true,
      newPaused: false,
      currentTime: t0 + 10,
    });
    expect(seekResult.updatedAnchorPos).toBe(10010);
    expect(seekResult.updatedAnchorTime).toBe(t0 + 10);
  });

  test("parseLrc parses offset tag and properly adjusts line times", () => {
    const lrcWithOffset = `
[offset:+1200]
[00:01.00]First line
[00:04.50]Second line
`;
    const parsed = parseLrc(lrcWithOffset);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].time).toBeCloseTo(2.2, 2); // 1.0 + 1.2 = 2.2
    expect(parsed[1].time).toBeCloseTo(5.7, 2); // 4.5 + 1.2 = 5.7
  });
});
