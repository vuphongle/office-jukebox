(function (global) {
  function createHistoryController() {
    let loading = false;
    let refreshPending = false;

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
    };
  }

  global.JukeboxHistoryController = { create: createHistoryController };
})(window);
