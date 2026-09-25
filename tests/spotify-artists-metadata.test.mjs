import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fetchSpotifyTrackMetadata,
  parseArtistListFromString,
  extractFeaturedArtistsFromTitle,
} from "../src/spotify.js";

describe("Spotify Multi-Artist Extraction", () => {
  test("parseArtistListFromString splits commas, &, feat, and x cleanly", () => {
    const raw = "TINH HÀ \"SAY HI\", Quang Hùng MasterD & RHYDER feat. Captain Boy x Lou Hoàng";
    const artists = parseArtistListFromString(raw);
    assert.deepEqual(artists, [
      "TINH HÀ \"SAY HI\"",
      "Quang Hùng MasterD",
      "RHYDER",
      "Captain Boy",
      "Lou Hoàng",
    ]);
  });

  test("extractFeaturedArtistsFromTitle extracts artists in (feat. ...) or (ft. ...)", () => {
    const artists = extractFeaturedArtistsFromTitle("Catch Me If You Can (feat. Quang Hùng MasterD, Nicky)");
    assert.deepEqual(artists, ["Quang Hùng MasterD", "Nicky"]);
  });

  test("fetchSpotifyTrackMetadata returns artists array and durationMs from API response", async () => {
    const mockTrack = {
      id: "4cOdK2wGLETKBW3PvgPWqT",
      name: "Ngáo Ngơ (feat. Orange)",
      artists: [
        { name: "HIEUTHUHAI" },
        { name: "ERIK" },
        { name: "Anh Tú Atus" },
        { name: "JSOL" },
      ],
      duration_ms: 215430,
      album: { images: [{ url: "https://example.com/cover.jpg" }] },
    };

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockTrack,
    });

    const meta = await fetchSpotifyTrackMetadata("4cOdK2wGLETKBW3PvgPWqT", {
      accessToken: "mock_token",
      fetchImpl: mockFetch,
    });

    assert.ok(meta);
    assert.equal(meta.title, "Ngáo Ngơ (feat. Orange)");
    assert.ok(Array.isArray(meta.artists));
    assert.ok(meta.artists.includes("HIEUTHUHAI"));
    assert.ok(meta.artists.includes("ERIK"));
    assert.ok(meta.artists.includes("Anh Tú Atus"));
    assert.ok(meta.artists.includes("JSOL"));
    assert.ok(meta.artists.includes("Orange")); // Trích xuất thêm từ feat trong title
    assert.equal(meta.durationMs, 215430);
  });
});
