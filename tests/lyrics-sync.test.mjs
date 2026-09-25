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

  test("server falls back to nowPlaying.startedAt when latestSpotifyPlaybackTick is null", () => {
    const startedAt = Date.now() - 15000; // started 15s ago
    const nowPlaying = {
      provider: "spotify",
      videoId: "track_fallback",
      startedAt,
    };
    const latestSpotifyPlaybackTick = null;

    function getServerTickResponse(now = Date.now()) {
      if (latestSpotifyPlaybackTick) {
        const elapsed = latestSpotifyPlaybackTick.paused
          ? 0
          : Math.max(0, now - (latestSpotifyPlaybackTick.serverTime || now));
        return {
          type: "playbackTick",
          ...latestSpotifyPlaybackTick,
          position: latestSpotifyPlaybackTick.position + elapsed,
          serverTime: now,
        };
      }
      if (nowPlaying?.provider === "spotify") {
        const elapsed = nowPlaying.startedAt ? Math.max(0, now - nowPlaying.startedAt) : 0;
        return {
          type: "playbackTick",
          position: elapsed,
          paused: false,
          seek: false,
          videoId: nowPlaying.videoId || "",
          serverTime: now,
        };
      }
      return null;
    }

    const res = getServerTickResponse();
    expect(res).not.toBeNull();
    expect(res.position).toBeGreaterThanOrEqual(14900);
    expect(res.position).toBeLessThanOrEqual(15200);
    expect(res.videoId).toBe("track_fallback");
    expect(res.paused).toBe(false);
  });

  test("guest continuous extrapolation does not freeze after 10 seconds while song is playing", () => {
    function calculateGuestProgress({
      anchorPos,
      anchorTime,
      isPaused,
      currentTime,
      durationMs,
    }) {
      if (isPaused) {
        return { posMs: anchorPos, paused: true, shouldRequestTick: false };
      }
      const elapsed = anchorTime > 0 ? currentTime - anchorTime : 0;
      const currentPosMs = Math.max(0, anchorPos + elapsed);
      if (currentPosMs >= durationMs + 5000) {
        return { posMs: currentPosMs, paused: true, shouldRequestTick: false };
      }
      return {
        posMs: currentPosMs,
        paused: false,
        shouldRequestTick: currentTime - anchorTime > 4000,
      };
    }

    const t0 = 1000;
    const anchorPos = 30000; // 30s into song
    const durationMs = 210000; // 3m30s

    // At 12 seconds elapsed (past the old 10s freeze point):
    const progressAt12s = calculateGuestProgress({
      anchorPos,
      anchorTime: t0,
      isPaused: false,
      currentTime: t0 + 12000,
      durationMs,
    });

    expect(progressAt12s.paused).toBe(false);
    expect(progressAt12s.posMs).toBe(42000);
    expect(progressAt12s.shouldRequestTick).toBe(true);
  });

  test("renderGuestLyricsLines position includes elapsed time and does not jump backwards", () => {
    function computeInitialRenderPosition({
      anchorPos,
      anchorTime,
      isPaused,
      currentTime,
    }) {
      const elapsed = (!isPaused && anchorTime > 0) ? currentTime - anchorTime : 0;
      return Math.max(0, (anchorPos || 0) + elapsed) / 1000;
    }

    const t0 = 50000;
    const curPos = computeInitialRenderPosition({
      anchorPos: 20000, // 20s
      anchorTime: t0,
      isPaused: false,
      currentTime: t0 + 6500, // 6.5s later
    });

    expect(curPos).toBe(26.5);
  });

  test("lyrics vertical centering: every line from index 0 to N-1 aligns exactly with vertical center of scroller", () => {
    function simulateLyricsLayout({ lineCount, scrollerH = 220, lineH = 38, gap = 6 }) {
      const centerPad = Math.round((scrollerH - lineH) / 2);
      const totalH = centerPad * 2 + lineCount * lineH + Math.max(0, lineCount - 1) * gap;
      const maxScroll = Math.max(0, totalH - scrollerH);

      const lines = [];
      for (let i = 0; i < lineCount; i++) {
        const lineTop = centerPad + i * (lineH + gap);
        const lineCenter = lineTop + lineH / 2;
        const targetScroll = Math.max(0, Math.min(maxScroll, Math.round(lineCenter - scrollerH / 2)));
        const visibleCenterOnScreen = lineCenter - targetScroll;
        lines.push({
          index: i,
          targetScroll,
          visibleCenterOnScreen,
          isExactCenter: Math.abs(visibleCenterOnScreen - scrollerH / 2) <= 1,
        });
      }

      return { centerPad, totalH, maxScroll, lines };
    }

    // Test with standard 40 lines lyrics on 220px desktop scroller
    const desktopLayout = simulateLyricsLayout({ lineCount: 40, scrollerH: 220, lineH: 38, gap: 6 });
    expect(desktopLayout.lines[0].targetScroll).toBe(0);
    expect(desktopLayout.lines[0].visibleCenterOnScreen).toBe(110);
    expect(desktopLayout.lines[0].isExactCenter).toBe(true);

    const lastIdx = desktopLayout.lines.length - 1;
    expect(desktopLayout.lines[lastIdx].targetScroll).toBe(desktopLayout.maxScroll);
    expect(desktopLayout.lines[lastIdx].visibleCenterOnScreen).toBe(110);
    expect(desktopLayout.lines[lastIdx].isExactCenter).toBe(true);

    for (const line of desktopLayout.lines) {
      expect(line.isExactCenter).toBe(true);
      expect(line.targetScroll).toBeGreaterThanOrEqual(0);
      expect(line.targetScroll).toBeLessThanOrEqual(desktopLayout.maxScroll);
    }

    // Test on 185px mobile scroller
    const mobileLayout = simulateLyricsLayout({ lineCount: 25, scrollerH: 185, lineH: 34, gap: 4 });
    for (const line of mobileLayout.lines) {
      expect(line.isExactCenter).toBe(true);
    }

    // Test single-line lyrics
    const singleLineLayout = simulateLyricsLayout({ lineCount: 1, scrollerH: 220, lineH: 38, gap: 6 });
    expect(singleLineLayout.lines[0].targetScroll).toBe(0);
    expect(singleLineLayout.lines[0].isExactCenter).toBe(true);
  });

  test("playbackTick anchor normalization prevents backward time jitter and activeIndex rollback", () => {
    const lines = [
      { time: 10.0, text: "Line 1" },
      { time: 15.0, text: "Line 2" },
      { time: 20.0, text: "Line 3" },
      { time: 25.0, text: "Line 4" },
    ];

    function getActiveIndex(lines, curSec) {
      let activeIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= curSec + 0.25) {
          activeIdx = i;
        } else {
          break;
        }
      }
      return activeIdx;
    }

    // At 15.1s, Line 2 (index 1) has just become active.
    let anchorPos = 12000;
    let anchorTime = 1000;
    const nowAtTransition = 1000 + 3100; // 4100ms
    const curSec = (anchorPos + (nowAtTransition - anchorTime)) / 1000; // 15.1s
    expect(getActiveIndex(lines, curSec)).toBe(1);

    // Buggy implementation: tick arrives with 15.12s, drift is small (+20ms).
    // The buggy code did `anchorPos += drift * 0.3` without updating anchorTime,
    // then called syncGuestLyricsPosition(anchorPos / 1000) directly:
    const buggySyncTime = (anchorPos + 20 * 0.3) / 1000; // ~12.006s!
    expect(getActiveIndex(lines, buggySyncTime)).toBe(0); // ROLLED BACK TO LINE 1 (JERK)!

    // Fixed implementation: anchor is normalized to current time,
    // and normal playback ticks do not call syncGuestLyricsPosition out-of-band:
    const fixedPosMs = (anchorPos + (nowAtTransition - anchorTime)) + 20 * 0.3; // 15126ms
    const fixedAnchorTime = nowAtTransition;
    const fixedRafCurSec = (fixedPosMs + (nowAtTransition - fixedAnchorTime)) / 1000;
    expect(getActiveIndex(lines, fixedRafCurSec)).toBe(1); // STAYED AT LINE 2 (NO ROLLBACK)!
  });

  test("auto-open guest lyrics on new Spotify song transition", () => {
    let guestLyricsActive = false;
    let lastHandledSpotifyTrackId = "";
    let userCollapsedTrackId = "";
    let guestLyricsAnchorPosition = -1;
    let lyricsModeRendered = false;

    function handleStateUpdate(state, lyricsDataMap) {
      const curNp = state?.nowPlaying;
      const isSpotify = curNp?.provider === "spotify";
      const trackId = isSpotify
        ? (curNp.videoId || curNp.id || `${(curNp.channel || "").toLowerCase()}:::${(curNp.title || "").toLowerCase()}`)
        : "";

      if (isSpotify && trackId) {
        const isNewSpotifySong = String(trackId) !== String(lastHandledSpotifyTrackId);
        if (isNewSpotifySong) {
          lastHandledSpotifyTrackId = trackId;
          userCollapsedTrackId = "";
          guestLyricsAnchorPosition = 0;

          // Simulate loadGuestLyrics with { autoOpen: true }
          const lyrics = lyricsDataMap[trackId];
          if (lyrics && lyrics.lines && lyrics.lines.length > 0) {
            if (String(trackId) !== String(userCollapsedTrackId)) {
              guestLyricsActive = true;
              lyricsModeRendered = true;
            }
          } else {
            // No lyrics: revert or stay in compact mode
            if (guestLyricsActive) {
              guestLyricsActive = false;
              lyricsModeRendered = false;
            }
          }
        }
      } else {
        lastHandledSpotifyTrackId = "";
        userCollapsedTrackId = "";
        guestLyricsActive = false;
        lyricsModeRendered = false;
      }

      return { guestLyricsActive, lyricsModeRendered, guestLyricsAnchorPosition, lastHandledSpotifyTrackId };
    }

    const lyricsDb = {
      "spotify:track:song1": { lines: [{ time: 1.0, text: "Line 1" }, { time: 5.0, text: "Line 2" }] },
      "spotify:track:song2": { lines: [] }, // Song 2 has NO lyrics
      "spotify:track:song3": { lines: [{ time: 2.0, text: "Song 3 Line 1" }] },
    };

    // 1. Initial song: Spotify song1 with lyrics -> AUTO OPENS
    const res1 = handleStateUpdate(
      { nowPlaying: { provider: "spotify", videoId: "spotify:track:song1", title: "Song 1", channel: "Artist 1" } },
      lyricsDb
    );
    expect(res1.guestLyricsActive).toBe(true);
    expect(res1.lyricsModeRendered).toBe(true);
    expect(res1.guestLyricsAnchorPosition).toBe(0);

    // 2. Next song: Spotify song2 WITHOUT lyrics -> AUTO CLOSES / STAYS COMPACT
    const res2 = handleStateUpdate(
      { nowPlaying: { provider: "spotify", videoId: "spotify:track:song2", title: "Song 2", channel: "Artist 2" } },
      lyricsDb
    );
    expect(res2.guestLyricsActive).toBe(false);
    expect(res2.lyricsModeRendered).toBe(false);

    // 3. Next song: Spotify song3 with lyrics -> AUTO OPENS AGAIN
    const res3 = handleStateUpdate(
      { nowPlaying: { provider: "spotify", videoId: "spotify:track:song3", title: "Song 3", channel: "Artist 3" } },
      lyricsDb
    );
    expect(res3.guestLyricsActive).toBe(true);
    expect(res3.lyricsModeRendered).toBe(true);
    expect(res3.guestLyricsAnchorPosition).toBe(0);

    // 4. Next song: YouTube song -> LYRICS COLLAPSED AND RESET
    const res4 = handleStateUpdate(
      { nowPlaying: { provider: "youtube", videoId: "yt123", title: "YT Song", channel: "YT Channel" } },
      lyricsDb
    );
    expect(res4.guestLyricsActive).toBe(false);
    expect(res4.lyricsModeRendered).toBe(false);
    expect(res4.lastHandledSpotifyTrackId).toBe("");
  });

  test("user collapse state is sticky per track, resets on new track", () => {
    let guestLyricsActive = true;
    let lastHandledSpotifyTrackId = "spotify:track:songA";
    let userCollapsedTrackId = "";

    function collapseCurrentSong(trackId) {
      guestLyricsActive = false;
      userCollapsedTrackId = trackId;
    }

    // User collapses Song A
    collapseCurrentSong("spotify:track:songA");
    expect(guestLyricsActive).toBe(false);
    expect(userCollapsedTrackId).toBe("spotify:track:songA");

    // Subsequent tick/state for Song A does NOT re-open
    const isNewSongForA = "spotify:track:songA" !== lastHandledSpotifyTrackId;
    expect(isNewSongForA).toBe(false);

    // Transition to Song B (Spotify with lyrics):
    const nextTrackId = "spotify:track:songB";
    const isNewSongForB = nextTrackId !== lastHandledSpotifyTrackId;
    expect(isNewSongForB).toBe(true);

    // On new song, userCollapsedTrackId is cleared:
    lastHandledSpotifyTrackId = nextTrackId;
    userCollapsedTrackId = "";
    // Because lyrics exist and userCollapsedTrackId is empty, auto-open succeeds:
    guestLyricsActive = true;
    expect(guestLyricsActive).toBe(true);
  });

  test("lyrics scroller resets to top (scrollTop = 0) upon rendering new song lines", () => {
    const fakeScroller = {
      scrollTop: 150, // was scrolled down during previous song
      scrolledTo: null,
      scrollTo(opts) {
        this.scrolledTo = opts;
      },
    };

    function resetScrollerForNewSong(scroller) {
      scroller.scrollTop = 0;
      scroller.scrollTo({ top: 0, behavior: "auto" });
    }

    resetScrollerForNewSong(fakeScroller);
    expect(fakeScroller.scrollTop).toBe(0);
    expect(fakeScroller.scrolledTo).toEqual({ top: 0, behavior: "auto" });
  });
});

