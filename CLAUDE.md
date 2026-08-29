# CLAUDE.md

This file provides guidance for Claude Code (claude.ai/code) when working in
this repository.

## Overview

Office Jukebox is a QR jukebox for events. The host/projector page at / plays
YouTube videos; guests scan the QR code to open /guest on their phones, search
or browse YouTube, and add songs to the queue. The application uses plain
JavaScript with no framework, bundler, or TypeScript.

## Commands

Use Bun, not npm:

~~~bash
bun install
cp .env.example .env   # defaults are usable; moderation is off
bun start              # run server.js on port 45416
bun run test           # run the Bun test suite
bun run check-llm      # verify LLM_API_KEY and list available models
~~~

There is no lint or build step. Validate changes with the tests and, when the
change affects serving, run the server and inspect both / and /guest.

## Architecture

**The server owns all state.** src/state.js (JukeboxState) is the authoritative
in-memory queue. Each change calls onChange, and server.js broadcasts complete
state snapshots to all WebSocket clients. The projector is only a player: it
renders the item selected by nowPlaying and reports ended/error events so the
server can promote the next song. Host controls (skip, remove, reorder, and
filter toggling) use the same WebSocket. The queue is not persisted in memory;
the SQLite repositories restore it after a restart.

**Song request flow** (POST /api/request in server.js):

1. checkPlayable() checks YouTube oEmbed and rejects deleted or private videos.
   Network failures are allowed through; the projector separately skips iframe
   errors 101/150 for embed-disabled or region-locked videos.
2. moderate() runs the optional LLM filter when enabled from the projector.
3. state.add() inserts the item into the queue and broadcasts the update.

**Keyless YouTube access** (src/youtube.js): search uses the internal YouTube
Music InnerTube JSON endpoint. /api/search prioritizes Vietnam-like web context
(hl=vi, gl=VN), keeps official songs and music videos, and supplements with the
Songs filter when needed. /api/browse uses only the Songs filter and caches each
query for 30 minutes; it limits results to tracks of at most 10 minutes to avoid
live recordings and long compilations. videoIds are played in a normal YouTube
iframe. Moderation metadata comes from ytInitialPlayerResponse on the watch page.
SOCS/CONSENT cookies avoid the EU consent interstitial. If search breaks, suspect
an InnerTube API or schema change. The __vn_hits sentinel returns the current
Vietnamese YouTube music chart for the first All-tab load instead of performing a
text search.

**Moderation failure policy** (src/moderation.js) is intentional and must be
preserved:

- Allow only infrastructure failures such as a missing key, HTTP error, or
  network error. Moderation must never stop the party; the host can also disable
  the filter directly.
- Reject with the retryable Vietnamese message "Hệ thống đang bận, vui lòng thử
  lại." on timeout. Slow decisions often cluster around songs that need review,
  so a timed-out song must not play without a verdict.
- Reject a model that avoids the decision: a provider content_filter finish
  reason or a missing/invalid {"approved": boolean} JSON verdict means evasion.

Any OpenAI-compatible chat API can provide the LLM. It is configured through
LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY. LLM_WEB_SEARCH=true opts into the
OpenRouter web plugin so the model can inspect live search results, often actual
lyrics, instead of relying on the title. Other providers may reject that extra
field, so the option must remain opt-in. Do not depend on
response_format: json_object because provider support differs, and do not set
temperature unless LLM_TEMPERATURE is explicitly configured. EVENT_CONTEXT tells
the model to judge suitability for the occasion, not only sensitivity.

**Autonomous AI chat** (src/chatAi.js and src/chatAiCoordinator.js) uses the
existing chat WebSocket, but only the server can create messages marked isAI.
The AI evaluates batches of user messages without a tag, bounds context by
characters (up to 100,000), and never blocks user message delivery. Raw chat is
kept in SQLite with roughly the latest 5,000 messages per event; rolling
summaries and event memory are handled by separate repositories. CHAT_AI_API_KEY,
CHAT_AI_BASE_URL, and CHAT_AI_MODEL take precedence for chat and fall back to
LLM_*; keys must never enter settings, API responses, or WebSocket payloads.
Non-secret behavior settings are edited by admins and stored under chatAi in
data/settings.json.

**No dotenv dependency** — server.js contains a small, dependency-free .env
loader. Runtime dependencies are express, ws, and qrcode; keep them that way
unless a real requirement justifies a change.

## Language boundary

Developer-facing documentation, comments, test descriptions, configuration
comments, and operational logs use English. Keep user-facing UI copy, API
reasons shown to users, AI responses displayed in chat, rank names, and song or
artist metadata in Vietnamese or their original language. Preserve DOM ids,
classes, JSON fields, WebSocket message types, protocol values, environment
variable names, URLs, and query sentinels.

## Deployment

Run the home-server deployment with docker compose up -d --build. The image is
built locally from source; there is no registry or CI build step. A self-hosted
GitHub Actions runner (see .github/workflows/deploy.yml) rebuilds after each push
to main. The container joins the external reverseproxy network; PUBLIC_URL in
.env is the address used by the QR code, and the reverse proxy must forward
WebSocket upgrades. Do not add a pull_request trigger while the repository is
public and the runner is self-hosted.

Static assets intentionally use Cache-Control: no-cache; otherwise iOS Safari
can retain old JS/CSS across deployments.
