import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("favorite UI state ignores stale users and synchronizes pending song changes", () => {
  let source = "";
  try {
    source = readFileSync(path.join(ROOT, "public/favorites-controller.js"), "utf8");
  } catch {}
  assert.ok(source, "favorites-controller.js must exist");

  const context = { window: {} };
  vm.runInNewContext(source, context);
  const controller = context.window.JukeboxFavoritesController.create();
  const first = { videoId: "dQw4w9WgXcQ", title: "First" };
  const second = { videoId: "M7lc1UVf-VE", title: "Second" };

  assert.equal(controller.setIdentity("user-a"), true);
  const firstIdentity = controller.captureIdentity();
  assert.equal(controller.isIdentityCurrent(firstIdentity), true);
  assert.equal(controller.replace(firstIdentity, [first, second]), true);
  assert.deepEqual(controller.all().map((item) => item.videoId), [first.videoId, second.videoId]);
  assert.equal(controller.isFavorite(first.videoId), true);
  assert.equal(controller.replace({ userId: "user-b", generation: firstIdentity.generation }, []), false);
  assert.equal(controller.isFavorite(first.videoId), true);

  assert.equal(controller.begin(first.videoId), true);
  assert.equal(controller.begin(first.videoId), false);
  assert.equal(controller.isPending(first.videoId), true);
  controller.remove(firstIdentity, first.videoId);
  controller.finish(firstIdentity, first.videoId);
  assert.equal(controller.isFavorite(first.videoId), false);
  assert.equal(controller.isPending(first.videoId), false);

  controller.upsert(firstIdentity, first);
  assert.equal(controller.all()[0].videoId, first.videoId);
  assert.equal(controller.setIdentity("user-b"), true);
  assert.deepEqual(controller.all(), []);
  assert.equal(controller.isFavorite(first.videoId), false);
});

test("stale favorite completions cannot change or finish the next user's operation", () => {
  const source = readFileSync(path.join(ROOT, "public/favorites-controller.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const controller = context.window.JukeboxFavoritesController.create();
  const song = { videoId: "dQw4w9WgXcQ", title: "Favorite" };

  controller.setIdentity("user-a");
  const staleIdentity = controller.captureIdentity();
  assert.equal(controller.begin(song.videoId), true);

  controller.setIdentity(null);
  controller.setIdentity("user-b");
  const currentIdentity = controller.captureIdentity();
  assert.equal(controller.begin(song.videoId), true);
  assert.equal(controller.upsert(staleIdentity, song), false);
  assert.equal(controller.remove(staleIdentity, song.videoId), false);
  assert.equal(controller.finish(staleIdentity, song.videoId), false);

  assert.equal(controller.isIdentityCurrent(currentIdentity), true);
  assert.equal(controller.isFavorite(song.videoId), false);
  assert.equal(controller.isPending(song.videoId), true);
});
