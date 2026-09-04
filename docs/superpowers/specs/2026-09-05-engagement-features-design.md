# Engagement Features Design

**Date:** 2026-09-05
**Status:** Approved in chat; implementation follows the decisions confirmed by the product owner.

## Goal

Make the existing rank system useful, give the room a transparent XP leaderboard, let song owners skip their own currently playing song without receiving a vote refund, and add a lightweight in-app announcement inbox for active users.

## Product decisions

### Rank-aware check-in

The daily check-in base reward is derived from the user's rank at the moment of check-in:

| Rank | Base check-in reward |
| --- | ---: |
| 1 | 1 point |
| 2 | 2 points |
| 3 | 3 points |
| 4 | 4 points |
| 5 | 5 points |
| 6 | 6 points |

The existing streak milestone bonus remains additive. For example, a rank 3 user on streak day 7 receives `3 + 5 = 8` points. Existing check-in rows and balances are not rewritten. The server reads the persisted rank XP, computes the reward transactionally, and stores the resolved base reward in the existing `checkins.base_points` column. A repeated check-in remains idempotent and awards zero additional points.

The rank UI shows all six levels, each level's check-in reward, the current rank, current XP, and the next-rank progress. The account success message uses the server's total award once; it does not add the streak bonus a second time.

### Public leaderboard

The leaderboard ranks active regular users by cumulative rank XP, not spendable wallet points. It returns at most the top 10 entries and exposes only display name, rank/badge, XP, and position. Blocked users, admins, usernames, user IDs, and wallet balances are excluded. Ties use a deterministic display-name and ID ordering so positions are stable.

The guest page is the primary entry point. Top 3 entries use podium styling (gold, silver, bronze); entries 4–10 use a compact scrollable list. The page remains usable on a phone and the list cannot expand without bound.

### Owner skip

The owner of the currently playing queue item may send `skipOwn` over the existing WebSocket connection. Ownership is checked server-side using the existing authenticated user ID or the requester's client ID; the client-side request list is only a display aid. The command is accepted only for the exact current item, never for an upcoming item or another user's item.

An accepted owner skip transitions the item with `finish_reason = 'owner_skipped'`, starts the next item using the normal state transition, and never refunds votes. It also does not award qualified-play rank XP, preventing a user from farming XP by skipping their own song. Host skip behavior remains unchanged.

The guest UI shows the control only when it can identify the item as owned, asks for confirmation that vote points will not be refunded, and relies on the server result/state broadcast for the final outcome.

### Active-user notifications

Notifications are in-app only; no email, browser push, or native push is required. An admin sends a title, body, and simple category. At send time, one recipient row is created for every user with `status = 'active'`; later registrations do not receive historical notifications. The notification is persisted even if there are no active recipients.

Authenticated users see a bell with an unread count. The inbox shows the newest 20 items in a bounded scroll area. Selecting one notification marks it read; a single `Mark all read` action marks all of the user's recipients read. Reloading reads from SQLite. Connected clients receive the new item and updated count over WebSocket; REST remains the source of truth and handles reconnects.

Admins get a notification tab with a bounded composer and recent send history, including recipient count. Title/body lengths and category are validated server-side, and sending is rate-limited. Notification content is rendered as text in the browser so it cannot inject HTML.

## Architecture and data flow

- `src/rank.js` remains the single source for rank descriptors and check-in reward values.
- `src/checkin.js` reads `user_rank_profiles.xp_total` inside the existing immediate transaction and records the resolved reward in the existing check-in and point ledger rows.
- `RankRepository` gets a public, privacy-filtered leaderboard query. The API exposes `/api/rank/leaderboard`; rank benefit metadata is exposed through `/api/rank/benefits` so the UI does not duplicate rank configuration.
- `JukeboxState` gets an owner-only current-item transition that delegates to `advance`, preserving SQLite transition/refund semantics and WebSocket broadcasting.
- Notifications use two SQLite tables: one immutable notification record and one per-user recipient/read record. A repository owns fan-out, listing, unread counts, and read mutations.
- Existing cookie authentication, WebSocket identity refresh, rate limiting, static HTML, and vanilla JavaScript are reused. No framework or external dependency is added.

## Error handling and security

- A missing or inactive user cannot check in, read or mutate notifications, or use owner skip.
- Public rank endpoints never return ownership tokens, wallet balances, usernames, or IDs.
- An invalid owner-skip request returns a failure result without mutating state.
- Notification list/read routes require an active authenticated account; a user can mark only their own recipient rows.
- Admin notification sends reject empty/over-limit fields and unsupported categories. The database transaction either creates the notification and all active recipient rows or rolls back.
- UI network failures show a bounded error/retry state and never represent an unknown notification count as zero.

## Compatibility and migration

No existing rows require a data migration. Rank rewards use the existing `base_points` field. Notification tables are created by the normal idempotent database initialization. Existing public queue snapshots remain token-free, and guest song ordering/removal behavior remains unchanged.

## Test and release gates

- Rank helpers and check-in tests cover all reward levels, additive milestone rewards, idempotency, and persisted base points.
- Leaderboard tests cover active-user filtering, privacy fields, deterministic ordering, and the 10-item bound.
- State/rank tests cover owner authorization, current-item-only behavior, `owner_skipped` persistence, no refunds, and no qualified-play XP.
- Notification repository/API tests cover active-user fan-out, unread counts, one/all read mutations, pagination bound, restart persistence, validation, and authorization.
- Existing unit tests and server-persistence integration tests must remain green. Static JavaScript must pass `node --check`; the final diff must pass `git diff --check`.
