# Engagement Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship rank-aware check-in rewards, a privacy-safe Top 10 XP leaderboard, owner-only current-song skip, and an active-user in-app notification inbox without changing existing guest queue behavior.

**Architecture:** Keep rank configuration and reward derivation in `src/rank.js`; use the existing SQLite repositories and server-authoritative WebSocket state for all mutations. Add a focused notification repository backed by immutable notification rows plus per-user recipient/read rows. Reuse the existing static HTML/CSS/vanilla-JS pages, cookies, rate-limit helpers, and WebSocket broadcasts.

**Tech Stack:** Bun, Node test runner, SQLite via `bun:sqlite`, Express, `ws`, static HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-05-engagement-features-design.md`

## Global Constraints

- Check-in base rewards are rank 1..6 = 1..6 points; streak milestone bonuses remain additive.
- Rank XP is separate from wallet points; the public leaderboard exposes active regular users only and at most 10 entries.
- Owner skip accepts only the exact current item, records `owner_skipped`, never refunds votes, and never awards qualified-play XP.
- Notifications are in-app only and fan out once to users with `status = 'active'` at send time; newest 20 are shown in a bounded scroll area.
- Existing queue ownership tokens remain private; client-side ownership lists are display hints only, with server-side authorization as the source of truth.
- No new runtime dependency, native push, email delivery, event reset, or unrelated refactor is introduced.
- Every production behavior change gets a real failing test first; each completed task ends with its targeted test command and a focused commit.

### Task 1: Rank-aware check-in rewards and rank-benefit UI

**Files:**
- Modify: `src/rank.js` — add the six public check-in reward values and expose them through the existing rank descriptor returned by `rankForXp`.
- Modify: `src/checkin.js` — read `user_rank_profiles.xp_total` inside the existing immediate transaction and use the resolved rank reward instead of `1`.
- Modify: `server.js` — include check-in reward metadata in `publicRank` and add the public `/api/rank/benefits` response.
- Modify: `public/guest.html`, `public/guest.js`, `public/guest.css` — show the current reward and a compact six-level benefits table in the check-in modal.
- Modify: `public/account.html`, `public/account.js`, `public/account.css` — show the current reward and the same benefits table on the authenticated account page.
- Test: `tests/rank.test.mjs`, `tests/checkin.test.mjs`.

**Interfaces:**
- Produces `rankForXp(xp).checkinPoints` for all rank descriptors.
- Produces `performCheckin(...).basePoints`, `pointsAwarded`, and `rank`-compatible reward data without changing existing idempotency fields.
- `/api/rank/benefits` returns `{ ok: true, benefits: [{ level, minXp, name, badge, checkinPoints }] }`.

- [ ] **Step 1: Write the failing rank mapping test.** Add a table-driven assertion with hand-written expected values:

```js
test("rank descriptors expose the approved check-in reward", () => {
  const expected = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(RANK_LEVELS.map((rank) => rank.checkinPoints), expected);
  assert.equal(rankForXp(300).checkinPoints, 3);
  assert.equal(rankForXp(3_000).checkinPoints, 6);
});
```

- [ ] **Step 2: Run the rank test and confirm it fails because `checkinPoints` is missing.**

Run: `bun test tests/rank.test.mjs`

Expected: the new assertion fails before the production mapping exists.

- [ ] **Step 3: Add the minimal rank reward fields.** Add `checkinPoints: 1` through `checkinPoints: 6` to `RANK_LEVELS`; keep `rankForXp` returning the descriptor so consumers receive the value without a second mapping.

- [ ] **Step 4: Run the rank test and confirm it passes.**

Run: `bun test tests/rank.test.mjs`

Expected: all rank tests pass with zero failures.

- [ ] **Step 5: Write the failing rank-aware check-in test.** In `tests/checkin.test.mjs`, create an active user, insert its `user_rank_profiles` row with `xp_total = 300`, perform a first check-in on a fixed date, and assert literal outcomes:

```js
assert.equal(result.basePoints, 3);
assert.equal(result.pointsAwarded, 3);
assert.equal(userRepo.findById(user.id).points_balance, 3);
assert.equal(db.query("SELECT base_points FROM checkins WHERE user_id = ?").get(user.id).base_points, 3);
```

Also assert the existing rank-1 streak-day-7 behavior remains `1 + 5 = 6` and a repeated check-in still awards `0`.

- [ ] **Step 6: Run the check-in test and confirm the rank-3 assertion fails with the current hard-coded base reward.**

Run: `bun test tests/checkin.test.mjs`

Expected: the new rank-3 expectation receives `1` instead of `3`.

- [ ] **Step 7: Implement transactional rank lookup and reward derivation.** Import `rankForXp`, read the profile after validating the user, default to XP `0` when no profile exists, compute `const basePoints = rankForXp(profile?.xp_total || 0).checkinPoints`, and include the resolved rank/reward in new and already-checked-in responses. Keep all point/check-in writes in the existing transaction.

- [ ] **Step 8: Run the rank and check-in tests together.**

Run: `bun test tests/rank.test.mjs tests/checkin.test.mjs`

Expected: all tests pass and no existing milestone/idempotency assertion changes.

- [ ] **Step 9: Add the public rank-benefit API and wire the UI.** Build `/api/rank/benefits` from `RANK_LEVELS` rather than duplicating values in HTML. Render the current rank's reward next to the check-in CTA, replace the hard-coded `+1` copy, render all six rows with the current row highlighted, and fix the account success message to display `data.pointsAwarded` exactly once.

- [ ] **Step 10: Check modified browser scripts and whitespace.**

Run: `node --check public/guest.js && node --check public/account.js && git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 11: Commit the completed rank slice.**

```bash
git add src/rank.js src/checkin.js server.js public/guest.html public/guest.js public/guest.css public/account.html public/account.js public/account.css tests/rank.test.mjs tests/checkin.test.mjs
git commit -m "feat(rank): make check-in rewards rank-aware"
```

### Task 2: Public Top 10 XP leaderboard

**Files:**
- Modify: `src/repositories/rankRepository.js` — add a bounded public leaderboard query that joins active regular users and never returns private identifiers or wallet values.
- Modify: `server.js` — add `GET /api/rank/leaderboard` with a fixed maximum of 10 entries and serve the public `/leaderboard` page.
- Create: `tests/leaderboard.test.mjs` — exercise the repository with real SQLite data.
- Modify: `public/guest.html`, `public/guest.css` — add a compact link to the public leaderboard without displacing the song-request flow.
- Modify: `public/guest.js` — remove eager leaderboard loading from the song-request page.
- Create: `public/leaderboard.html`, `public/leaderboard.js`, `public/leaderboard.css` — provide the full public leaderboard page with podium styling for top 3 and a bounded list for positions 4–10.

**Interfaces:**
- `RankRepository.listPublicLeaderboard({ limit = 10, offset = 0 })` returns `{ position, displayName, xpTotal, rank }` objects only.
- `GET /api/rank/leaderboard` returns `{ ok: true, leaderboard: [...] }` and never accepts a client-controlled limit above 10.

- [ ] **Step 1: Write the failing repository test.** Seed active users with XP values, one blocked user, one admin, and a tie. Assert the first 10 positions, deterministic tie order, active regular filtering, and absence of `userId`, `username`, `pointsBalance`, and `passwordHash`.

```js
assert.equal(rows.length, 10);
assert.deepEqual(rows[0], { position: 1, displayName: "Top User", xpTotal: 900, rank: { level: 4, name: "DJ cộng đồng", badge: "turntable" } });
assert.equal(rows.some((row) => row.displayName === "Blocked User"), false);
assert.equal(Object.hasOwn(rows[0], "userId"), false);
```

- [ ] **Step 2: Run the new test and confirm it fails because the public method does not exist.**

Run: `bun test tests/leaderboard.test.mjs`

Expected: failure at the missing `listPublicLeaderboard` method.

- [ ] **Step 3: Implement the bounded public query.** Select only `u.display_name`, `COALESCE(urp.xp_total, 0)`, and rank-derived fields from `users` left-joined to `user_rank_profiles`; filter `u.status = 'active' AND u.role = 'user'`; order XP descending, display name case-insensitively, then ID; clamp the SQL limit to 10 and map one-based positions.

- [ ] **Step 4: Run the leaderboard test and confirm it passes.**

Run: `bun test tests/leaderboard.test.mjs`

Expected: all repository privacy, filter, tie, and limit assertions pass.

- [ ] **Step 5: Register the public API route.** Return the repository result with the same privacy-safe shape and use the existing public read limiter if the route is exposed to unauthenticated guests.

- [ ] **Step 6: Add the public leaderboard page and compact Guest entry point.** Serve `/leaderboard` without authentication, render top 3 as gold/silver/bronze podium cards and positions 4–10 as bounded rows, and show a retry state on fetch failure. Keep only a compact "Xem bảng xếp hạng" link on `/guest`; load leaderboard data from the new page rather than on every song-request page load.

- [ ] **Step 7: Check the route-facing scripts and diff.**

Run: `node --check public/guest.js && node --check public/leaderboard.js && git diff --check`

Expected: both commands exit `0`.

- [ ] **Step 8: Commit the leaderboard slice.**

```bash
git add server.js public/guest.html public/guest.js public/guest.css public/leaderboard.html public/leaderboard.js public/leaderboard.css tests/server-persistence.test.mjs UI-BRIEF.md README.md docs/superpowers/specs/2026-09-05-engagement-features-design.md
git commit -m "feat(rank): add public XP leaderboard"
```

### Task 3: Owner-only skip for the currently playing song

**Files:**
- Modify: `src/state.js` — add `skipOwned(id, requesterId, userId)` and delegate the accepted transition to `advance` with `finishReason: 'owner_skipped'`.
- Modify: `src/rank.js` — ensure only natural end and qualified host skip remain XP-eligible; `owner_skipped` is never qualified.
- Modify: `server.js` — handle `skipOwn` before host-only controls and return a result without bypassing server ownership checks.
- Modify: `public/guest.html`, `public/guest.js`, `public/guest.css` — show the action for locally known owned current items, confirm no refund, and handle success/failure messages.
- Modify: `tests/state.test.mjs`, `tests/rank.test.mjs`.
- Create or modify: `tests/owner-skip.test.mjs` — verify the WebSocket command through a real server when the integration harness is available.

**Interfaces:**
- `JukeboxState.skipOwned(id, requesterId, userId)` returns the same transition object as `advance` on success and `null` on mismatch.
- WebSocket command `{ type: "skipOwn", id, clientId }` returns `{ type: "skipOwnResult", id, ok, reason? }` and causes the normal state broadcast when accepted.

- [ ] **Step 1: Write failing state and qualification tests.** Cover an owner user/client, another user/client, the current item, and an upcoming item. Assert only the exact current owner can transition, `finishReason === 'owner_skipped'`, status becomes `played`, active vote rows are not refunded, and `isQualifiedPlay({ finishReason: 'owner_skipped' }) === false`.

- [ ] **Step 2: Run the targeted tests and confirm they fail for the missing method/qualification branch.**

Run: `bun test tests/state.test.mjs tests/rank.test.mjs`

Expected: the new owner-skip assertions fail before implementation.

- [ ] **Step 3: Implement the minimal state transition.** Match ownership by `addedByUserId === userId` or `requesterId === requesterId`, require `this.nowPlaying.id === id`, and call `advance` with no error flag and `finishReason: 'owner_skipped'`. Do not modify vote refund logic; normal `played` transitions already do not refund.

- [ ] **Step 4: Update rank qualification and settle the command in the server.** Add the WebSocket handler before the host switch; send an explicit failure for invalid requests; call `settleRankTransition` only after an accepted transition so the existing XP settlement sees the new non-qualified reason.

- [ ] **Step 5: Run targeted state/rank/vote tests and confirm green.**

Run: `bun test tests/state.test.mjs tests/rank.test.mjs tests/vote.test.mjs`

Expected: all tests pass, including existing host skip/error refund behavior.

- [ ] **Step 6: Add the guest control and confirmation copy.** Reuse the existing `myRequestIds` display hint, disable the button while in flight, send `skipOwn`, explain that spent vote points will not be returned, and let the state broadcast remove the control after transition.

- [ ] **Step 7: Run the owner-skip integration test and script checks.**

Run: `bun test tests/owner-skip.test.mjs && node --check public/guest.js && git diff --check`

Expected: the real authenticated owner path passes; if the environment prevents ephemeral server binding, rerun with the elevated local-server test command and record the result.

- [ ] **Step 8: Commit the owner-skip slice.**

```bash
git add src/state.js src/rank.js server.js public/guest.html public/guest.js public/guest.css tests/state.test.mjs tests/rank.test.mjs tests/owner-skip.test.mjs
git commit -m "feat(queue): allow owners to skip their playing song"
```

### Task 4: Notification persistence, admin API, and user API

**Files:**
- Modify: `src/db.js` — create `notifications` and `notification_recipients` tables plus user/unread indexes during idempotent initialization.
- Create: `src/repositories/notificationRepository.js` — own transactional fan-out, list, unread count, one-read, all-read, and admin history operations.
- Modify: `server.js` — instantiate the repository, expose authenticated user routes and admin send/history routes, validate fields/categories, rate-limit sends, and notify connected recipients over WebSocket.
- Create: `tests/notification.test.mjs` — test repository contracts with real SQLite data.
- Modify: `tests/server-persistence.test.mjs` or create `tests/notification-server.test.mjs` — test API authorization/validation and restart persistence through a real server.

**Interfaces:**
- `NotificationRepository.createForActiveUsers({ title, body, kind, createdByUserId })` returns `{ notification, recipientCount, recipientUserIds }` atomically.
- `listForUser(userId, { limit = 20, offset = 0 })` returns `{ items, unreadCount, total }`; the limit is clamped to 20 for the inbox.
- `markRead(notificationId, userId)` and `markAllRead(userId)` mutate only that user's recipient rows.
- `GET /api/me/notifications`, `POST /api/me/notifications/:id/read`, and `POST /api/me/notifications/read-all` require active authentication.
- `POST /api/admin/notifications` accepts `{ title, body, kind }`; `GET /api/admin/notifications` returns bounded send history.
- WebSocket messages are `{ type: "notificationCreated", notification, unreadCount }` and `{ type: "notificationsUpdated", unreadCount }`.

- [ ] **Step 1: Write failing repository tests.** Assert active users receive rows at send time, blocked users and later users do not, initial unread count equals recipient count, one read decrements only one user's count, all-read clears the count, list size is bounded, and closing/reopening the database preserves state.

- [ ] **Step 2: Run the notification test and confirm it fails because the schema/repository does not exist.**

Run: `bun test tests/notification.test.mjs`

Expected: failure at the missing notification tables/repository.

- [ ] **Step 3: Add the idempotent SQLite schema.** Create an immutable notification row with UUID, title/body/kind, creator, and ISO timestamp; create recipient rows keyed by `(notification_id, user_id)` with nullable `read_at`; add indexes for `(user_id, read_at, notification_id)` and created history.

- [ ] **Step 4: Implement the repository transaction and read methods.** Fan out only `status = 'active'` users in one immediate transaction, return a mapped public notification shape, clamp user list to 20, order newest first, and use `COALESCE(read_at, now)` semantics so repeated reads are idempotent.

- [ ] **Step 5: Run repository tests and confirm green.**

Run: `bun test tests/notification.test.mjs`

Expected: all persistence, active-user, unread, read, all-read, bound, and restart assertions pass.

- [ ] **Step 6: Write failing server API tests.** Through a real server, assert a regular user can list/read only their own inbox, an unauthenticated request receives 401, a non-admin send receives 403, invalid/over-limit title/body/kind receives 400, a valid admin send returns recipient count, and `/api/me` exposes the current unread count.

- [ ] **Step 7: Run the server tests and confirm the new routes fail before registration.**

Run: `bun test tests/notification-server.test.mjs`

Expected: 404 or missing response fields from the unimplemented routes.

- [ ] **Step 8: Register authenticated/admin routes and validation.** Add conservative title/body limits, allow only `info`, `maintenance`, and `feature`, rate-limit admin sends with a dedicated fixed-window key, and return structured errors. Keep notification content text-only and never interpolate it into SQL.

- [ ] **Step 9: Broadcast new notifications to connected active sessions.** Refresh WebSocket identity before matching recipient user IDs, send the new item and repository unread count, and send the updated count after read/read-all mutations. REST remains authoritative if a socket is disconnected.

- [ ] **Step 10: Run server notification tests and the full existing integration test.**

Run: `bun test tests/notification-server.test.mjs tests/server-persistence.test.mjs`

Expected: all new API tests and the existing 4 persistence tests pass.

- [ ] **Step 11: Commit the notification backend slice.**

```bash
git add src/db.js src/repositories/notificationRepository.js server.js tests/notification.test.mjs tests/notification-server.test.mjs
git commit -m "feat(notifications): add active-user inbox APIs"
```

### Task 5: Notification inbox, bell, and admin composer UI

**Files:**
- Modify: `public/guest.html`, `public/guest.js`, `public/guest.css` — add authenticated bell, unread badge, bounded inbox modal, read/read-all actions, and WebSocket updates.
- Modify: `public/account.html`, `public/account.js`, `public/account.css` — add the same bell/inbox behavior in the account context.
- Modify: `public/admin.html`, `public/admin.js`, `public/admin.css` — add the admin notification tab, composer, validation status, recipient count, and bounded history table.

**Interfaces:**
- User pages call `/api/me/notifications`, `/api/me/notifications/:id/read`, and `/api/me/notifications/read-all`.
- The bell displays `currentUser.unreadNotificationCount` or the server response; an unknown/error state is not rendered as zero.
- Admin pages call `/api/admin/notifications` and show the server's recipient count after a successful send.

- [ ] **Step 1: Add the static UI structure.** Add a bell button that is hidden for guests, a modal/card with an `aria-live` list, a read-all button, and a list container with `max-height: min(60dvh, 420px); overflow-y: auto; overscroll-behavior: contain`. Add an admin tab with title/body/category inputs and recent history.

- [ ] **Step 2: Implement user inbox state and safe rendering.** Load only after authentication or modal open, keep at most 20 newest records in memory, render title/body through `textContent`/escaped text, mark one item read on click, update badge optimistically only after the API succeeds, and show a retry/error state on failure.

- [ ] **Step 3: Handle WebSocket notification messages.** Insert/dedupe a pushed notification, use the pushed unread count, refresh the open modal when needed, and show a short non-blocking toast without forcing navigation.

- [ ] **Step 4: Implement the admin composer/history.** Disable submit while sending, show validation/server errors inline, reset only after success, display recipient count, and keep history in a bounded table/list so long bodies do not stretch the page.

- [ ] **Step 5: Run static checks for every modified browser script and whitespace.**

Run: `node --check public/guest.js && node --check public/account.js && node --check public/admin.js && git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 6: Commit the notification/UI slice.**

```bash
git add public/guest.html public/guest.js public/guest.css public/account.html public/account.js public/account.css public/admin.html public/admin.js public/admin.css
git commit -m "feat(ui): add notification inbox and admin composer"
```

### Task 6: End-to-end release verification

**Files:**
- Inspect: all files changed by Tasks 1–5.
- Modify only if required: focused tests or documentation that exposes a concrete mismatch with the approved spec.

- [ ] **Step 1: Review the final diff and confirm scope.**

Run: `git diff main...HEAD --stat && git diff main...HEAD --check && git status --short --branch`

Expected: only the spec, plan, feature code, UI, and feature tests appear; the worktree is clean after commits.

- [ ] **Step 2: Run the complete test suite with the local-server environment.**

Run: `bun test`

Expected: 0 failures. If sandbox port binding is denied, rerun the same command with the approved local-server escalation and report both environments separately.

- [ ] **Step 3: Run final JavaScript syntax checks.**

Run: `node --check public/guest.js && node --check public/account.js && node --check public/admin.js && node --check public/host.js`

Expected: all commands exit `0`.

- [ ] **Step 4: Perform a manual API smoke check against a temporary database.** Start the server with temporary `JUKEBOX_DB_PATH`/`JUKEBOX_DATA_DIR`, create two users, send one admin notification, verify only active users receive it, mark one read, mark all read, fetch leaderboard, and exercise owner skip over WebSocket.

- [ ] **Step 5: Read the verification output before reporting completion.** Report exact test counts, commits, branch name, and any physical-browser/device QA that was not possible; do not claim UI completion based only on syntax checks.
