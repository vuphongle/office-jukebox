import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeElement {
  constructor() {
    const classes = new Set(["hidden"]);
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => force === undefined
        ? (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true))
        : (force ? classes.add(name) : classes.delete(name), force),
    };
    this.style = { setProperty() {} };
    this.textContent = "";
    this.value = "";
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(name, handler) {
    const list = this.listeners.get(name) || [];
    list.push(handler);
    this.listeners.set(name, list);
  }
  removeEventListener(name, handler) {
    const list = this.listeners.get(name) || [];
    this.listeners.set(name, list.filter((entry) => entry !== handler));
  }
  dispatch(name, event = {}) {
    for (const h of this.listeners.get(name) || []) h(event);
  }
  appendChild(child) { this.children.push(child); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function createHostContext({ hostToken = null } = {}) {
  const elements = new Map();
  const sent = [];
  const sockets = [];
  const fetchCalls = [];
  let intervalCallback = null;
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  let playerEvents;
  const player = {
    loadCalls: [],
    playCalls: 0,
    state: -1,
    loadVideoById(videoId) { this.loadCalls.push(videoId); },
    playVideo() { this.playCalls += 1; },
    stopVideo() {},
    getCurrentTime() { return 0; },
    getPlayerState() { return this.state; },
    listeners: new Map(),
    addEventListener(name, handler) {
      const list = this.listeners.get(name) || [];
      list.push(handler);
      this.listeners.set(name, list);
    },
    removeEventListener(name, handler) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== handler));
    },
  };
  const windowListeners = new Map();
  const spotifyListeners = new Map();
  const spotifyPlayer = {
    addListener(name, handler) {
      const list = spotifyListeners.get(name) || [];
      list.push(handler);
      spotifyListeners.set(name, list);
    },
    removeListener(name, handler) {
      const list = spotifyListeners.get(name) || [];
      spotifyListeners.set(name, list.filter((entry) => entry !== handler));
    },
    connect: () => Promise.resolve(true),
    seek: () => Promise.resolve(true),
  };
  const window = {
    addEventListener(name, handler) {
      const list = windowListeners.get(name) || [];
      list.push(handler);
      windowListeners.set(name, list);
    },
    removeEventListener(name, handler) {
      const list = windowListeners.get(name) || [];
      windowListeners.set(name, list.filter((entry) => entry !== handler));
    },
    dispatch(name, event = {}) {
      for (const h of windowListeners.get(name) || []) h(event);
    },
    Spotify: {
      Player: function () {
        return spotifyPlayer;
      },
    },
  };
  const context = vm.createContext({
    window,
    navigator: { onLine: true },
    document: {
      hidden: false,
      activeElement: null,
      addEventListener() {},
      createElement: () => new FakeElement(),
      getElementById,
      querySelectorAll: () => [],
    },
    Element: FakeElement,
    WebSocket: class {
      readyState = 1;
      constructor() { sockets.push(this); }
      send(payload) { sent.push(JSON.parse(payload)); }
    },
    YT: {
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 },
      Player: function (_id, options) {
        playerEvents = options.events;
        return player;
      },
    },
    location: { protocol: "http:", host: "localhost" },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url === "/api/host-token") return { json: async () => ({ token: hostToken }) };
      if (url === "/api/spotify/token") return { json: async () => ({ ok: true, access_token: "mock-spotify-token" }) };
      if (url.includes("/api/info")) return { json: async () => ({ guestUrl: "http://localhost/guest", qr: "qr" }) };
      return { ok: true, status: 204, json: async () => ({ ok: true }) };
    },
    crypto: { randomUUID: () => "test-id" },
    console,
    clearTimeout,
    setTimeout,
    clearInterval() {},
    setInterval: (callback) => {
      intervalCallback = callback;
      return 1;
    },
    requestAnimationFrame: (callback) => setTimeout(callback, 20),
    cancelAnimationFrame: (id) => clearTimeout(id),
    performance: { now: () => Date.now() },
  });
  context.globalThis = context;
  return {
    context,
    elements,
    player,
    sent,
    sockets,
    fetchCalls,
    spotifyListeners,
    windowListeners,
    getElementById,
    getIntervalCallback: () => intervalCallback,
    getPlayerEvents: () => playerEvents,
  };
}

test("host offers a user-gesture recovery when YouTube blocks the first autoplay", () => {
  const { context, elements, player, getPlayerEvents } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.window.onYouTubeIframeAPIReady();
  getPlayerEvents().onReady();
  elements.get("start-btn").onclick();
  vm.runInContext('latestState = { nowPlaying: { videoId: "first-song" }, queue: [] }; syncPlayer();', context);

  getPlayerEvents().onAutoplayBlocked();
  expect(elements.get("playback-recovery").classList.contains("hidden")).toBe(false);

  elements.get("resume-playback").onclick();
  expect(player.loadCalls).toEqual(["first-song", "first-song"]);
  expect(player.playCalls).toBe(2);

  player.state = context.YT.PlayerState.PLAYING;
  getPlayerEvents().onStateChange({ data: context.YT.PlayerState.PLAYING });
  expect(elements.get("playback-recovery").classList.contains("hidden")).toBe(true);
});

test("host binds playback callbacks to the server-issued generation token", () => {
  const { context, elements, sent, player, getPlayerEvents } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.connectWs();
  context.window.onYouTubeIframeAPIReady();
  getPlayerEvents().onReady();
  elements.get("start-btn").onclick();
  vm.runInContext('latestState = { nowPlaying: { videoId: "first-song", playbackToken: "token-a", duration: "3:30" }, queue: [] }; syncPlayer();', context);
  const firstEnded = player.listeners.get("onStateChange")[0];
  const firstError = player.listeners.get("onError")[0];

  vm.runInContext('latestState = { nowPlaying: { videoId: "current-song", playbackToken: "token-b", duration: "3:30" }, queue: [] }; syncPlayer();', context);
  const currentEnded = player.listeners.get("onStateChange")[0];
  const currentError = player.listeners.get("onError")[0];
  // Delayed callbacks from the previous load run on the same player object,
  // but retain token-a in their generation-scoped closure.
  firstEnded({ data: context.YT.PlayerState.ENDED, target: player });
  // A current error is accepted even when YouTube omits a useful video ID.
  currentError({ data: 150, target: { getVideoData: () => ({}) } });
  vm.runInContext('latestState = { nowPlaying: { videoId: "reconnected-song", playbackToken: "token-c", duration: "3:30" }, queue: [] }; syncPlayer();', context);
  player.state = context.YT.PlayerState.ENDED;
  context.reportIfEnded();

  assert.deepEqual(sent, [
    { type: "ended", videoId: "first-song", playbackToken: "token-a", playedSeconds: 0 },
    { type: "error", videoId: "current-song", playbackToken: "token-b", code: 150 },
    { type: "ended", videoId: "reconnected-song", playbackToken: "token-c", playedSeconds: 0 },
  ]);
});

test("host retries an ended report after reconnecting with the same playback token", () => {
  const { context, elements, sent, player, sockets, getPlayerEvents } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.connectWs();
  context.window.onYouTubeIframeAPIReady();
  getPlayerEvents().onReady();
  elements.get("start-btn").onclick();
  vm.runInContext('latestState = { nowPlaying: { videoId: "same-song", playbackToken: "same-token" }, queue: [] }; syncPlayer();', context);
  player.state = context.YT.PlayerState.ENDED;
  context.reportIfEnded();
  const firstSocket = sockets[0];
  firstSocket.onclose();
  context.connectWs();
  sockets[1].onopen();
  assert.deepEqual(sent.filter((message) => message.type === "ended"), [
    { type: "ended", videoId: "same-song", playbackToken: "same-token", playedSeconds: 0 },
    { type: "ended", videoId: "same-song", playbackToken: "same-token", playedSeconds: 0 },
  ]);
});

test("host shows the network registration authentication error", () => {
  const { context, elements, sent, sockets } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.clearTimeout = () => {};
  context.setTimeout = () => 0;
  context.connectWs();

  elements.get("order-network-host").onclick();
  assert.deepEqual(sent, [{ type: "registerOrderNetworkHost" }]);
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: "orderNetworkHostError", reason: "Hãy xác thực trang Host trước khi cập nhật mạng." }) });

  const status = elements.get("order-network-host-status");
  assert.equal(status.textContent, "Hãy xác thực trang Host trước khi cập nhật mạng.");
  assert.equal(status.classList.contains("hidden"), false);
});

test("host automatically registers its network only after playback starts and refreshes it", async () => {
  const { context, elements, sent, getIntervalCallback } = createHostContext({ hostToken: "host-token" });
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, [{ type: "auth", token: "host-token" }]);
  assert.equal(getIntervalCallback(), null);

  elements.get("start-btn").onclick();
  assert.deepEqual(sent.at(-1), { type: "registerOrderNetworkHost" });
  assert.equal(typeof getIntervalCallback(), "function");

  getIntervalCallback()();
});

test("host does not show toast on automatic background network registration error or update", async () => {
  const { context, elements, sockets, getElementById, getIntervalCallback } = createHostContext({ hostToken: "host-token" });
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  elements.get("start-btn").onclick();
  const status = getElementById("order-network-host-status");

  // Server responds to background registration with an error — UI must stay silent
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: "orderNetworkHostError", reason: "Hãy xác thực trang Host trước khi cập nhật mạng." }) });
  assert.equal(status.textContent, "");
  assert.equal(status.classList.contains("hidden"), true);

  // Background interval refresh responds with success — UI must stay silent
  getIntervalCallback()();
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: "orderNetworkHostUpdated", hostIp: "192.168.1.100" }) });
  assert.equal(status.textContent, "");
  assert.equal(status.classList.contains("hidden"), true);
});

test("host shows loading toast on manual update and transitions cleanly to success", () => {
  const { context, elements, sent, sockets, getElementById } = createHostContext({ hostToken: "host-token" });
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.clearTimeout = () => {};
  context.setTimeout = () => 0;
  context.connectWs();

  const status = getElementById("order-network-host-status");

  elements.get("order-network-host").onclick();
  assert.deepEqual(sent.at(-1), { type: "registerOrderNetworkHost" });
  assert.equal(status.textContent, "Đang cập nhật IP mạng Host...");
  assert.equal(status.classList.contains("loading"), true);
  assert.equal(status.classList.contains("hidden"), false);

  // Server responds with success
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: "orderNetworkHostUpdated", hostIp: "192.168.1.100" }) });
  assert.equal(status.textContent, "Đã cập nhật IP mạng Host thành công!");
  assert.equal(status.classList.contains("ok"), true);
  assert.equal(status.classList.contains("loading"), false);
  assert.equal(status.classList.contains("hidden"), false);
});

test("host ignores generic WebSocket errors for the network registration status", () => {
  const { context, sockets, getElementById } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  const status = getElementById("order-network-host-status");

  sockets.at(-1).onmessage({ data: JSON.stringify({ type: "error", reason: "Không thể lưu cài đặt lúc này." }) });

  assert.equal(status.textContent, "");
  assert.equal(status.classList.contains("hidden"), true);
});

test("host registers the YouTube callback before loading the iframe API", () => {
  const html = readFileSync(new URL("../public/host.html", import.meta.url), "utf8");
  assert.match(html, /id="order-network-host-status"/);
  const hostScript = html.indexOf('src="/host.js"');
  const iframeApiScript = html.indexOf('src="https://www.youtube.com/iframe_api"');
  assert.ok(hostScript >= 0);
  assert.ok(iframeApiScript > hostScript);
});

test("host resumes Spotify playback from previous position upon network reconnect ready event", async () => {
  const { context, elements, fetchCalls, spotifyListeners } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.window.onSpotifyWebPlaybackSDKReady();
  const onReady = spotifyListeners.get("ready")?.[0];
  const onNotReady = spotifyListeners.get("not_ready")?.[0];
  const onPlayerState = spotifyListeners.get("player_state_changed")?.[0];

  assert.ok(typeof onReady === "function");

  // Device connects initially
  onReady({ device_id: "spotify-dev-1" });
  elements.get("start-btn").onclick();

  // Start playing a Spotify song
  vm.runInContext(
    'latestState = { nowPlaying: { videoId: "spotify-track-1", provider: "spotify", duration: "3:00" }, queue: [] }; syncPlayer();',
    context
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Initial playback starts from 0:00 (no position_ms)
  const initialPlayCall = fetchCalls.find((c) => c.url.includes("/v1/me/player/play"));
  assert.ok(initialPlayCall);
  const initialBody = JSON.parse(initialPlayCall.options.body);
  assert.equal(initialBody.uris[0], "spotify:track:spotify-track-1");
  assert.equal(initialBody.position_ms, undefined);

  // Playback advances to 45 seconds (45000 ms)
  onPlayerState({
    paused: false,
    position: 45000,
    duration: 180000,
  });

  // Network disruption: Spotify SDK reports not_ready (offline)
  onNotReady({ device_id: "spotify-dev-1" });

  // Clear previous play calls to inspect reconnect
  fetchCalls.length = 0;

  // Network recovers: Spotify SDK reconnects with new or same device_id
  onReady({ device_id: "spotify-dev-reconnected" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Verify that playSpotify was called with position_ms preserved (45000ms)
  const resumePlayCall = fetchCalls.find((c) => c.url.includes("/v1/me/player/play"));
  assert.ok(resumePlayCall, "Spotify play endpoint should be called on reconnect");
  const resumeBody = JSON.parse(resumePlayCall.options.body);
  assert.equal(resumeBody.uris[0], "spotify:track:spotify-track-1");
  assert.ok(Math.abs(resumeBody.position_ms - 45000) <= 200, `position_ms (${resumeBody.position_ms}) should be close to 45000ms`);
});

test("host does not report ended for Spotify if interrupted prematurely during network drop", () => {
  const { context, sent, spotifyListeners } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.connectWs();
  context.window.onSpotifyWebPlaybackSDKReady();
  const onReady = spotifyListeners.get("ready")?.[0];
  const onPlayerState = spotifyListeners.get("player_state_changed")?.[0];

  onReady({ device_id: "spotify-dev-1" });
  vm.runInContext(
    'started = true; latestState = { nowPlaying: { videoId: "spotify-track-2", provider: "spotify", playbackToken: "token-s2", duration: "3:00" }, queue: [] }; syncPlayer();',
    context
  );

  // Song is playing at 30 seconds of a 180-second track
  onPlayerState({
    paused: false,
    position: 30000,
    duration: 180000,
  });

  // Network drops and Spotify emits a transient paused state at position 0
  onPlayerState({
    paused: true,
    position: 0,
    duration: 180000,
  });

  // Also verify reportIfEnded on WS reconnect
  context.reportIfEnded();

  // It must NOT send "ended" because the track only played 30s of 180s
  const endedReports = sent.filter((m) => m.type === "ended");
  assert.equal(endedReports.length, 0);

  // Now simulate actual end of track (played to 178 seconds of 180s track)
  onPlayerState({
    paused: false,
    position: 178000,
    duration: 180000,
  });
  onPlayerState({
    paused: true,
    position: 0,
    duration: 180000,
  });

  const finalEndedReports = sent.filter((m) => m.type === "ended");
  assert.equal(finalEndedReports.length, 1);
  assert.equal(finalEndedReports[0].videoId, "spotify-track-2");
});

test("host retries TikTok playback preserving timestamp on network interruption", () => {
  const { context, getElementById, sent } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.connectWs();
  const audioEl = getElementById("tiktok-audio-player");
  audioEl.currentTime = 28.5;
  audioEl.duration = 60;
  audioEl.play = () => Promise.resolve();

  vm.runInContext(
    'started = true; latestState = { nowPlaying: { videoId: "https://tiktok.com/@test/video/1", provider: "tiktok", playbackToken: "token-tk" }, queue: [] }; syncPlayer();',
    context
  );

  // Audio was playing at 28.5s
  audioEl.dispatch("play");
  audioEl.dispatch("timeupdate");

  // Network glitch triggers error event on HTML5 audio
  audioEl.error = { code: 2 }; // MEDIA_ERR_NETWORK
  audioEl.dispatch("error");

  // Should NOT immediately send terminal error
  const errorReports = sent.filter((m) => m.type === "error" && m.code === "tiktok_playback_error");
  assert.equal(errorReports.length, 0);
});

test("host reports error on Spotify initialization or authentication error", () => {
  const { context, sent, spotifyListeners } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.connectWs();
  context.window.onSpotifyWebPlaybackSDKReady();
  const onInitError = spotifyListeners.get("initialization_error")?.[0];

  vm.runInContext(
    'started = true; latestState = { nowPlaying: { videoId: "sp-err-1", provider: "spotify", playbackToken: "tok-sp-err" }, queue: [] }; syncPlayer();',
    context
  );

  onInitError({ message: "init failed" });
  const errorReports = sent.filter((m) => m.type === "error" && m.code === "initialization_error");
  assert.equal(errorReports.length, 1);
  assert.equal(errorReports[0].videoId, "sp-err-1");
  assert.equal(errorReports[0].playbackToken, "tok-sp-err");
});

test("host reports error when TikTok encounters non-network audio playback error", () => {
  const { context, getElementById, sent } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.connectWs();
  const audioEl = getElementById("tiktok-audio-player");
  audioEl.play = () => Promise.resolve();

  vm.runInContext(
    'started = true; latestState = { nowPlaying: { videoId: "https://tiktok.com/@test/err", provider: "tiktok", playbackToken: "tok-tk-err" }, queue: [] }; syncPlayer();',
    context
  );

  // Non-network error (e.g. MEDIA_ERR_SRC_NOT_SUPPORTED code 4)
  audioEl.error = { code: 4 };
  audioEl.dispatch("error");

  const errorReports = sent.filter((m) => m.type === "error" && m.code === "tiktok_playback_error");
  assert.equal(errorReports.length, 1);
  assert.equal(errorReports[0].videoId, "https://tiktok.com/@test/err");
  assert.equal(errorReports[0].playbackToken, "tok-tk-err");
});

test("host reports error when SoundCloud widget encounters playback error", () => {
  const { context, sent } = createHostContext();
  const scEvents = new Map();
  const scWidgetMock = {
    bind(name, handler) {
      scEvents.set(name, handler);
    },
    load(_url, options) {
      if (options?.callback) options.callback();
    },
    play() {},
    pause() {},
  };
  context.window.SC = {
    Widget: Object.assign(() => scWidgetMock, {
      Events: { READY: "ready", PLAY: "play", PAUSE: "pause", FINISH: "finish", ERROR: "error" },
    }),
  };

  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  context.connectWs();
  vm.runInContext(
    'started = true; latestState = { nowPlaying: { videoId: "https://soundcloud.com/test/err", provider: "soundcloud", playbackToken: "tok-sc-err" }, queue: [] }; syncPlayer();',
    context
  );

  const onError = scEvents.get("error");
  assert.ok(onError);
  onError("playback failed");

  const errorReports = sent.filter((m) => m.type === "error" && m.code === "soundcloud_error");
  assert.equal(errorReports.length, 1);
  assert.equal(errorReports[0].videoId, "https://soundcloud.com/test/err");
  assert.equal(errorReports[0].playbackToken, "tok-sc-err");
});

