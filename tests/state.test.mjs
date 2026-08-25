import test from "node:test";
import assert from "node:assert/strict";

import { JukeboxState } from "../src/state.js";

function createState() {
  const state = new JukeboxState();
  state.onChange = () => {};
  return state;
}

function add(state, videoId) {
  return state.add({ videoId, title: videoId }).item;
}

function queueIds(state) {
  return state.queue.map((item) => item.videoId);
}

test("reorder moves an upcoming item before an anchor", () => {
  const state = createState();
  const nowPlaying = add(state, "now-playing");
  const second = add(state, "second");
  const third = add(state, "third");
  const fourth = add(state, "fourth");
  let changes = 0;
  state.onChange = () => changes++;

  assert.equal(state.reorder(fourth.id, second.id), true);
  assert.equal(state.nowPlaying, nowPlaying);
  assert.deepEqual(queueIds(state), ["fourth", "second", "third"]);
  assert.equal(changes, 1);
});

test("reorder can append and ignores invalid or no-op requests", () => {
  const state = createState();
  add(state, "now-playing");
  const second = add(state, "second");
  const third = add(state, "third");
  const fourth = add(state, "fourth");
  let changes = 0;
  state.onChange = () => changes++;

  assert.equal(state.reorder(second.id, null), true);
  assert.deepEqual(queueIds(state), ["third", "fourth", "second"]);
  assert.equal(state.reorder(second.id, null), false);
  assert.equal(state.reorder("missing", null), false);
  assert.equal(state.reorder(third.id, "missing"), false);
  assert.equal(state.reorder(third.id, third.id), false);
  assert.deepEqual(queueIds(state), ["third", "fourth", "second"]);
  assert.equal(changes, 1);
});
