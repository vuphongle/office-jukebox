import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JukeboxState } from "../src/state.js";

describe("Queue State and Order Integration for Multi-Artist Spotify", () => {
  test("JukeboxState preserves artists array in queue item and snapshot", () => {
    const state = new JukeboxState(null);
    const added = state.add({
      videoId: "4cOdK2wGLETKBW3PvgPWqT",
      title: "Ngáo Ngơ",
      channel: "HIEUTHUHAI, ERIK, Anh Tú Atus",
      artists: ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"],
      duration: "3:35",
      provider: "spotify",
    });

    assert.ok(added.item);
    assert.deepEqual(added.item.artists, ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"]);

    const snap = state.snapshot();
    assert.equal(snap.nowPlaying.title, "Ngáo Ngơ");
    assert.deepEqual(snap.nowPlaying.artists, ["HIEUTHUHAI", "ERIK", "Anh Tú Atus"]);
  });

  test("JukeboxState fallback extracts artists array from channel string if artists array not provided", () => {
    const state = new JukeboxState(null);
    const added = state.add({
      videoId: "dummy_id",
      title: "Chạy Ngay Đi",
      channel: "Sơn Tùng M-TP, Snoop Dogg",
      duration: "4:00",
      provider: "spotify",
    });

    assert.ok(added.item);
    assert.deepEqual(added.item.artists, ["Sơn Tùng M-TP", "Snoop Dogg"]);
  });
});
