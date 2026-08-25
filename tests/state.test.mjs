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

test("guest can remove only an upcoming request created by the same client", () => {
  const state = createState();
  add(state, "now-playing");
  const mine = state.add({ videoId: "mine", title: "Mine", requesterId: "owner-a" }).item;
  const other = state.add({ videoId: "other", title: "Other", requesterId: "owner-b" }).item;
  let changes = 0;
  state.onChange = () => changes++;

  assert.equal(state.removeOwned(other.id, "owner-a"), false);
  assert.equal(state.removeOwned(mine.id, "owner-a"), true);
  assert.deepEqual(queueIds(state), ["other"]);
  assert.equal(changes, 1);
});

test("snapshot hides ownership tokens and estimates upcoming start time", () => {
  const state = createState();
  state.add({ videoId: "playing", title: "Playing", duration: "3:00", requesterId: "private-a" });
  state.add({ videoId: "next", title: "Next", duration: "4:00", requesterId: "private-b" });
  state.add({ videoId: "later", title: "Later", duration: "2:00", requesterId: "private-c" });

  const before = Date.now();
  const snapshot = state.snapshot();
  const after = Date.now();

  assert.equal("requesterId" in snapshot.nowPlaying, false);
  assert.equal("startedAt" in snapshot.nowPlaying, false);
  assert.equal("requesterId" in snapshot.queue[0], false);
  assert.ok(snapshot.queue[0].estimatedStartAt >= before + 179_000);
  assert.ok(snapshot.queue[0].estimatedStartAt <= after + 180_000);
  assert.equal(snapshot.queue[1].estimatedStartAt - snapshot.queue[0].estimatedStartAt, 4 * 60 * 1000);
});
