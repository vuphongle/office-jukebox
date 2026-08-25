import test from "node:test";
import assert from "node:assert/strict";

import * as youtube from "../src/youtube.js";

function resultItem({ videoId, title, kind, artist, musicVideoType, linkArtist = true }) {
  return {
    musicResponsiveListItemRenderer: {
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [] } } },
      overlay: {
        musicItemThumbnailOverlayRenderer: {
          content: {
            musicPlayButtonRenderer: {
              accessibilityPlayData: {
                accessibilityData: { label: `Phát ${title} - ${artist}` },
              },
              playNavigationEndpoint: {
                watchEndpoint: {
                  videoId,
                  watchEndpointMusicSupportedConfigs: {
                    watchEndpointMusicConfig: { musicVideoType },
                  },
                },
              },
            },
          },
        },
      },
      playlistItemData: { videoId },
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: title }] },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                { text: kind },
                { text: " • " },
                linkArtist
                  ? {
                      text: artist,
                      navigationEndpoint: { browseEndpoint: { browseId: "artist" } },
                    }
                  : { text: artist },
              ],
            },
          },
        },
      ],
    },
  };
}

function searchResponse(items) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{ musicShelfRenderer: { contents: items } }],
                },
              },
            },
          },
        ],
      },
    },
  };
}

test("buildSearchBody mirrors Vietnamese YouTube Music context without auth", () => {
  assert.equal(typeof youtube.buildSearchBody, "function");
  const body = youtube.buildSearchBody("2h", { mode: "web" });

  assert.deepEqual(body.context.client, {
    clientName: "WEB_REMIX",
    clientVersion: "1.20260818.08.00",
    hl: "vi",
    gl: "VN",
  });
  assert.equal(body.query, "2h");
  assert.equal("params" in body, false);
});

test("songs mode retains the existing Songs filter for browse", () => {
  assert.equal(typeof youtube.buildSearchBody, "function");
  const body = youtube.buildSearchBody("nhạc Việt", { mode: "songs" });

  assert.equal(body.params, "EgWKAQIIAWoMEA4QChADEAQQCRAF");
  assert.equal(body.context.client.gl, "VN");
});

test("web-like parsing keeps official songs and music videos, excluding UGC and podcasts", () => {
  assert.equal(typeof youtube.parseSearchResults, "function");
  const results = youtube.parseSearchResults(
    searchResponse([
      resultItem({
        videoId: "mck",
        title: "2h - MCK",
        kind: "Video",
        artist: "RPT MCK",
        musicVideoType: "MUSIC_VIDEO_TYPE_OMV",
      }),
      resultItem({
        videoId: "timer",
        title: "2 Hour Timer",
        kind: "Video",
        artist: "Milli Lofi Timer",
        musicVideoType: "MUSIC_VIDEO_TYPE_UGC",
      }),
      resultItem({
        videoId: "song",
        title: "tối nay 2h",
        kind: "Bài hát",
        artist: "GREY D",
        musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
      }),
      resultItem({
        videoId: "podcast",
        title: "2h kể chuyện",
        kind: "Tập podcast",
        artist: "Vọng Nguyệt",
        musicVideoType: "MUSIC_VIDEO_TYPE_PODCAST_EPISODE",
      }),
    ]),
    { webLike: true, limit: 12 }
  );

  assert.deepEqual(
    results.map(({ videoId, title, channel }) => ({ videoId, title, channel })),
    [
      { videoId: "mck", title: "2h - MCK", channel: "RPT MCK" },
      { videoId: "song", title: "tối nay 2h", channel: "GREY D" },
    ]
  );
});

test("songs parsing stays limited to the existing Songs shelves", () => {
  const data = searchResponse([
    resultItem({
      videoId: "songs-shelf",
      title: "Bài hát trong shelf",
      kind: "Bài hát",
      artist: "Artist",
      musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
    }),
  ]);
  data.contents.webOnly = resultItem({
    videoId: "web-only",
    title: "Video ngoài Songs shelf",
    kind: "Video",
    artist: "Artist",
    musicVideoType: "MUSIC_VIDEO_TYPE_OMV",
  });

  const results = youtube.parseSearchResults(data, { limit: 12 });

  assert.deepEqual(results.map(({ videoId }) => videoId), ["songs-shelf"]);
});

test("web-like parsing recovers an artist from the playback accessibility label", () => {
  const results = youtube.parseSearchResults(
    searchResponse([
      resultItem({
        videoId: "adele",
        title: "Someone Like You",
        kind: "Bài hát",
        artist: "Adele",
        musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
        linkArtist: false,
      }),
    ]),
    { webLike: true, limit: 12 }
  );

  assert.equal(results[0].channel, "Adele");
});

test("mergeSearchResults preserves primary ranking and removes duplicate video IDs", () => {
  assert.equal(typeof youtube.mergeSearchResults, "function");
  const merged = youtube.mergeSearchResults(
    [{ videoId: "top" }, { videoId: "shared" }],
    [{ videoId: "shared" }, { videoId: "fallback" }],
    3
  );

  assert.deepEqual(merged, [{ videoId: "top" }, { videoId: "shared" }, { videoId: "fallback" }]);
});

test("web search falls back to Songs results without copying browser credentials", async () => {
  assert.equal(typeof youtube.searchYouTube, "function");
  const requests = [];
  let call = 0;
  const fetchImpl = async (_url, options) => {
    requests.push({ headers: options.headers, body: JSON.parse(options.body) });
    call += 1;
    const body =
      call === 1
        ? searchResponse([
            resultItem({
              videoId: "web-top",
              title: "2h - MCK",
              kind: "Video",
              artist: "RPT MCK",
              musicVideoType: "MUSIC_VIDEO_TYPE_OMV",
            }),
          ])
        : searchResponse([
            resultItem({
              videoId: "web-top",
              title: "2h - MCK",
              kind: "Bài hát",
              artist: "RPT MCK",
              musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
            }),
            resultItem({
              videoId: "fallback",
              title: "tối nay 2h",
              kind: "Bài hát",
              artist: "GREY D",
              musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
            }),
          ]);
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const results = await youtube.searchYouTube("2h", { limit: 2, fetchImpl });

  assert.deepEqual(results.map(({ videoId }) => videoId), ["web-top", "fallback"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.params, undefined);
  assert.equal(requests[1].body.params, "EgWKAQIIAWoMEA4QChADEAQQCRAF");
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.Cookie, "SOCS=CAI;CONSENT=YES+1");
});
