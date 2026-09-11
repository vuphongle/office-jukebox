(function (global) {
  function createHistoryController() {
    let loading = false;
    let refreshPending = false;
    let identity = null;

    return {
      begin(reset = false) {
        if (loading) {
          if (reset) refreshPending = true;
          return false;
        }

        loading = true;
        if (reset) refreshPending = false;
        return true;
      },

      requestReset() {
        refreshPending = true;
      },

      setIdentity(userId) {
        const nextIdentity = typeof userId === "string" && userId ? userId : null;
        if (identity === nextIdentity) return false;
        identity = nextIdentity;
        refreshPending = true;
        return true;
      },

      isIdentityCurrent(userId) {
        const expectedIdentity = typeof userId === "string" && userId ? userId : null;
        return identity === expectedIdentity;
      },

      finish() {
        loading = false;
        return refreshPending;
      },

      get loading() {
        return loading;
      },

      get refreshPending() {
        return refreshPending;
      },

      get emptyReason() {
        return identity ? "no-history" : "authentication-required";
      },
    };
  }

  global.JukeboxHistoryController = { create: createHistoryController };
})(window);
