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
  }

  addEventListener() {}
  appendChild(child) { this.children.push(child); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function createHostContext() {
  const elements = new Map();
  const sent = [];
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
  };
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window,
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
    fetch: async () => ({ json: async () => ({ guestUrl: "http://localhost/guest", qr: "qr" }) }),
    crypto: { randomUUID: () => "test-id" },
    console,
    clearTimeout,
    setTimeout,
    requestAnimationFrame: (callback) => callback(),
  });
  context.globalThis = context;
  return { context, elements, player, sent, getPlayerEvents: () => playerEvents };
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

test("host ignores ended events that identify a different video", () => {
  const { context, elements, sent, getPlayerEvents } = createHostContext();
  const source = readFileSync(new URL("../public/host.js", import.meta.url), "utf8");
  vm.runInContext(source, context);
  context.connectWs();
  context.window.onYouTubeIframeAPIReady();
  getPlayerEvents().onReady();
  elements.get("start-btn").onclick();
  vm.runInContext('latestState = { nowPlaying: { videoId: "current-song" }, queue: [] }; syncPlayer();', context);

  getPlayerEvents().onStateChange({
    data: context.YT.PlayerState.ENDED,
    target: { getVideoData: () => ({ video_id: "previous-song" }) },
  });
  getPlayerEvents().onStateChange({
    data: context.YT.PlayerState.ENDED,
    target: { getVideoData: () => ({ video_id: "current-song" }) },
  });

  assert.deepEqual(sent, [{ type: "ended", videoId: "current-song" }]);
});

test("host registers the YouTube callback before loading the iframe API", () => {
  const html = readFileSync(new URL("../public/host.html", import.meta.url), "utf8");
  const hostScript = html.indexOf('src="/host.js"');
  const iframeApiScript = html.indexOf('src="https://www.youtube.com/iframe_api"');
  assert.ok(hostScript >= 0);
  assert.ok(iframeApiScript > hostScript);
});
