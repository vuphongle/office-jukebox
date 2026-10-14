import { describe, it, expect } from "bun:test";
import { decideReconcileAction } from "../public/playback-reconciler.js";

describe("Playback Reconciler Pure Logic", () => {
  it("returns ok when nothing is expected and nothing is playing", () => {
    const action = decideReconcileAction({
      expected: null,
      actual: null,
      mismatchCount: 0,
      elapsedMs: 0,
    });
    expect(action).toBe("ok");
  });

  it("returns stop_foreign_provider when another provider is active while expected is YouTube", () => {
    const action = decideReconcileAction({
      expected: { provider: "youtube", videoId: "yt123", playbackToken: "tok1" },
      actual: { activeProvider: "tiktok", videoId: "tt999", playbackToken: "tok0" },
      mismatchCount: 0,
      elapsedMs: 1000,
    });
    expect(action).toBe("stop_foreign_provider");
  });

  it("returns ok when actual videoId matches expected videoId", () => {
    const action = decideReconcileAction({
      expected: { provider: "youtube", videoId: "yt123", playbackToken: "tok1" },
      actual: { activeProvider: "youtube", videoId: "yt123", playbackToken: "tok1" },
      mismatchCount: 0,
      elapsedMs: 3000,
    });
    expect(action).toBe("ok");
  });

  it("returns reload on first video mismatch (mismatchCount = 0 or 1)", () => {
    const action = decideReconcileAction({
      expected: { provider: "youtube", videoId: "yt_new", playbackToken: "tok2" },
      actual: { activeProvider: "youtube", videoId: "yt_old_stuck", playbackToken: "tok1" },
      mismatchCount: 1,
      elapsedMs: 3000,
    });
    expect(action).toBe("reload");
  });

  it("returns stop_and_skip on repeated mismatch (mismatchCount >= 2, >= 6s)", () => {
    const action = decideReconcileAction({
      expected: { provider: "youtube", videoId: "yt_new", playbackToken: "tok2" },
      actual: { activeProvider: "youtube", videoId: "yt_old_stuck", playbackToken: "tok1" },
      mismatchCount: 2,
      elapsedMs: 6500,
    });
    expect(action).toBe("stop_and_skip");
  });

  it("supports Spotify track relinking (linked_from id match)", () => {
    const action = decideReconcileAction({
      expected: { provider: "spotify", videoId: "sp_target", playbackToken: "tok_sp" },
      actual: {
        activeProvider: "spotify",
        videoId: "sp_relinked",
        linkedFromId: "sp_target",
        playbackToken: "tok_sp",
      },
      mismatchCount: 0,
      elapsedMs: 2000,
    });
    expect(action).toBe("ok");
  });

  it("handles TikTok token checking", () => {
    const action = decideReconcileAction({
      expected: { provider: "tiktok", videoId: "tt_song", playbackToken: "token_curr" },
      actual: {
        activeProvider: "tiktok",
        videoId: "tt_song",
        playbackToken: "token_stale",
      },
      mismatchCount: 2,
      elapsedMs: 6000,
    });
    expect(action).toBe("stop_and_skip");
  });

  it("supports provider property as fallback for activeProvider", () => {
    const action = decideReconcileAction({
      expected: { provider: "youtube", videoId: "yt123", playbackToken: "tok1" },
      actual: { provider: "tiktok", videoId: "tt999", playbackToken: "tok0" },
      mismatchCount: 0,
      elapsedMs: 1000,
    });
    expect(action).toBe("stop_foreign_provider");
  });

  it("exports both JukeboxReconciler and PlaybackReconciler on global scope", () => {
    expect(globalThis.JukeboxReconciler).toBeDefined();
    expect(globalThis.PlaybackReconciler).toBeDefined();
    expect(typeof globalThis.PlaybackReconciler.decideReconcileAction).toBe("function");
    expect(globalThis.PlaybackReconciler).toBe(globalThis.JukeboxReconciler);
  });
});

