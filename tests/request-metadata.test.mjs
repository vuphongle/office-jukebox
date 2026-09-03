import test from "node:test";
import assert from "node:assert/strict";
import { initDb, closeDb } from "../src/db.js";
import { JukeboxState } from "../src/state.js";
import { resolveCanonicalRequestMetadata } from "../src/requestMetadata.js";
import { prepareRequestSong } from "../src/requestPipeline.js";
import { fetchYouTubeMetadata } from "../src/youtube.js";

test("request metadata uses canonical YouTube title/channel for moderation and storage", async () => {
  const canonical = {
    videoId: "W7rindfYUHk",
    title: "Canonical title",
    channel: "Canonical channel",
    thumbnail: "https://i.ytimg.com/vi/W7rindfYUHk/hqdefault.jpg",
  };
  const prepared = await resolveCanonicalRequestMetadata(canonical.videoId, {
    clientMetadata: {
      title: "attacker supplied title",
      channel: "attacker supplied channel",
      duration: "3:20",
    },
    fetchMetadata: async () => canonical,
  });
  assert.deepEqual(
    { title: prepared.title, channel: prepared.channel },
    { title: "Canonical title", channel: "Canonical channel" }
  );

  const moderationInputs = [];
  const moderation = (song) => {
    moderationInputs.push(song);
    return { approved: true };
  };
  assert.deepEqual(moderation({ title: prepared.title, channel: prepared.channel }), { approved: true });
  assert.deepEqual(moderationInputs[0], { title: "Canonical title", channel: "Canonical channel" });

  const pipelineInputs = [];
  const pipeline = await prepareRequestSong({
    videoId: canonical.videoId,
    clientMetadata: { title: "attacker supplied title", channel: "attacker supplied channel", duration: "3:20" },
    checkPlayable: async () => ({ ok: true }),
    fetchMetadata: async () => canonical,
    moderationOn: true,
    fetchDetails: async () => ({ category: "Music" }),
    moderateSong: async (song) => {
      pipelineInputs.push(song);
      return { approved: true };
    },
  });
  assert.equal(pipeline.ok, true);
  assert.deepEqual(pipelineInputs, [{ title: "Canonical title", channel: "Canonical channel" }]);

  const db = initDb({ dbPath: ":memory:" });
  const state = new JukeboxState(db);
  const stored = state.add(pipeline.song).item;
  assert.equal(stored.title, "Canonical title");
  assert.equal(stored.channel, "Canonical channel");
  closeDb();
});

test("request metadata rejects unavailable or incomplete canonical data", async () => {
  assert.equal(
    await resolveCanonicalRequestMetadata("W7rindfYUHk", { fetchMetadata: async () => null }),
    null
  );
  assert.equal(
    await resolveCanonicalRequestMetadata("W7rindfYUHk", {
      fetchMetadata: async () => ({ title: "Only title", channel: "" }),
    }),
    null
  );
  assert.equal(
    await fetchYouTubeMetadata("W7rindfYUHk", {
      fetchImpl: async () => new Response(JSON.stringify({ title: "Only title" }), { status: 200 }),
    }),
    null
  );
});
