(function attachJukeboxFavoritesController(global) {
  function create() {
    let userId = null;
    let generation = 0;
    let items = new Map();
    const pending = new Set();

    return {
      setIdentity(nextUserId) {
        const normalized = nextUserId || null;
        if (userId === normalized) return false;
        userId = normalized;
        generation += 1;
        items = new Map();
        pending.clear();
        return true;
      },
      captureIdentity() {
        return userId ? { userId, generation } : null;
      },
      isIdentityCurrent(identity) {
        return Boolean(identity) && identity.userId === userId && identity.generation === generation;
      },
      replace(identity, nextItems) {
        if (!this.isIdentityCurrent(identity)) return false;
        items = new Map(
          (Array.isArray(nextItems) ? nextItems : [])
            .filter((item) => item?.videoId)
            .map((item) => [item.videoId, item])
        );
        return true;
      },
      all() {
        return [...items.values()];
      },
      get(videoId) {
        return items.get(videoId) || null;
      },
      isFavorite(videoId) {
        return items.has(videoId);
      },
      upsert(identity, item) {
        if (!this.isIdentityCurrent(identity) || !item?.videoId) return false;
        items.delete(item.videoId);
        items = new Map([[item.videoId, item], ...items]);
        return true;
      },
      remove(identity, videoId) {
        if (!this.isIdentityCurrent(identity)) return false;
        items.delete(videoId);
        return true;
      },
      begin(videoId) {
        if (!videoId || pending.has(videoId)) return false;
        pending.add(videoId);
        return true;
      },
      finish(identity, videoId) {
        if (!this.isIdentityCurrent(identity)) return false;
        pending.delete(videoId);
        return true;
      },
      isPending(videoId) {
        return pending.has(videoId);
      },
    };
  }

  global.JukeboxFavoritesController = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);
