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
    const activeProv = actual?.activeProvider || actual?.provider || null;

    if (!expected) {
      if (activeProv) return "stop_foreign_provider";
      return "ok";
    }

    // 1. Foreign provider active while another provider is expected
    if (activeProv && activeProv !== expected.provider) {
      return "stop_foreign_provider";
    }

    const actualId = actual?.videoId || "";
    const expectedId = expected?.videoId || "";

    // 2. Track relinking check for Spotify (with URI normalization)
    const cleanActualId = String(actualId).replace(/^spotify:track:/, "");
    const cleanExpectedId = String(expectedId).replace(/^spotify:track:/, "");
    const cleanLinkedFromId = String(actual?.linkedFromId || "").replace(/^spotify:track:/, "");
    const cleanActualUri = String(actual?.uri || "").replace(/^spotify:track:/, "");
    const cleanLinkedFromUri = String(actual?.linkedFromUri || "").replace(/^spotify:track:/, "");

    const isSpotifyMatch =
      expected.provider === "spotify" &&
      (
        cleanActualId === cleanExpectedId ||
        cleanActualUri === cleanExpectedId ||
        (cleanLinkedFromId && cleanLinkedFromId === cleanExpectedId) ||
        (cleanLinkedFromUri && cleanLinkedFromUri === cleanExpectedId)
      );

    const isMatch = isSpotifyMatch || (cleanActualId && cleanExpectedId && cleanActualId === cleanExpectedId);

    // 3. Token checking if actual has token
    const tokenMismatch = Boolean(
      expected.playbackToken &&
      actual?.playbackToken &&
      expected.playbackToken !== actual.playbackToken
    );

    // If ID mismatches or token mismatches:
    // Require at least 2 consecutive mismatch counts before stop_and_skip to prevent
    // premature skips during transient network drops or track loading.
    if ((actualId && !isMatch) || tokenMismatch) {
      if (mismatchCount >= 2 && elapsedMs >= 6000) {
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
  global.PlaybackReconciler = Object.freeze(exportsObj);
})(typeof window !== "undefined" ? window : globalThis);

