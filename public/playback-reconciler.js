// Playback reconciler module for verifying and correcting player state
// Ensures the active audio/video player matches the expected song in the queue.

(function attachPlaybackReconciler(global) {
  /**
   * Decide which reconciliation action to take based on expected vs actual player state.
   *
   * @param {object} options
   * @param {object|null} options.expected - { provider, videoId, playbackToken }
   * @param {object|null} options.actual - { activeProvider, videoId, linkedFromId, playbackToken }
   * @param {number} options.mismatchCount - consecutive mismatch count
   * @param {number} options.elapsedMs - milliseconds elapsed in current state
   * @returns {"ok" | "reload" | "stop_and_skip" | "stop_foreign_provider"}
   */
  function decideReconcileAction({
    expected,
    actual,
    mismatchCount = 0,
    elapsedMs = 0,
  } = {}) {
    if (!expected) {
      if (actual && actual.activeProvider) return "stop_foreign_provider";
      return "ok";
    }

    // 1. Foreign provider active while another provider is expected
    if (actual?.activeProvider && actual.activeProvider !== expected.provider) {
      return "stop_foreign_provider";
    }

    const actualId = actual?.videoId || "";
    const expectedId = expected?.videoId || "";

    // 2. Track relinking check for Spotify
    const isSpotifyMatch =
      expected.provider === "spotify" &&
      (actualId === expectedId || (actual?.linkedFromId && actual.linkedFromId === expectedId));

    const isMatch = isSpotifyMatch || (actualId && expectedId && actualId === expectedId);

    // 3. Token checking if actual has token
    const tokenMismatch = Boolean(
      expected.playbackToken &&
      actual?.playbackToken &&
      expected.playbackToken !== actual.playbackToken
    );

    // If ID mismatches or token mismatches
    if ((actualId && !isMatch) || tokenMismatch) {
      if (mismatchCount >= 2 || elapsedMs >= 6000) {
        return "stop_and_skip";
      }
      return "reload";
    }

    return "ok";
  }

  const exportsObj = {
    decideReconcileAction,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportsObj;
  }
  global.JukeboxReconciler = Object.freeze(exportsObj);
})(typeof window !== "undefined" ? window : globalThis);
