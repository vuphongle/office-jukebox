import { describe, it, expect } from "bun:test";
import { computeStreakView, getNextMidnight } from "../src/checkin.js";

describe("computeStreakView", () => {
  const tz = "Asia/Ho_Chi_Minh";

  it("calculates view when user already checked in today", () => {
    // 2026-10-13 14:00:00 UTC+7
    const now = new Date("2026-10-13T07:00:00.000Z");
    const user = {
      current_streak: 5,
      last_checkin_date: "2026-10-13",
    };

    const view = computeStreakView(user, now, tz);
    expect(view.displayStreak).toBe(5);
    expect(view.checkedInToday).toBe(true);
    expect(view.streakAlive).toBe(true);
    expect(view.streakBroken).toBe(false);
    expect(view.localDate).toBe("2026-10-13");
    expect(view.restoreEligible).toBe(false);
    expect(view.nextRolloverAt).toBe("2026-10-13T17:00:00.000Z"); // 00:00:00 2026-10-14 UTC+7
  });

  it("handles 23:59:59 today", () => {
    // 2026-10-13 23:59:59 UTC+7
    const now = new Date("2026-10-13T16:59:59.000Z");
    const user = {
      current_streak: 5,
      last_checkin_date: "2026-10-13",
    };

    const view = computeStreakView(user, now, tz);
    expect(view.displayStreak).toBe(5);
    expect(view.checkedInToday).toBe(true);
    expect(view.streakAlive).toBe(true);
    expect(view.streakBroken).toBe(false);
    expect(view.localDate).toBe("2026-10-13");
  });

  it("transitions at 00:00:00 next day: fire goes inactive but streak is preserved (alive)", () => {
    // Exactly 2026-10-14 00:00:00 UTC+7
    const now = new Date("2026-10-13T17:00:00.000Z");
    const user = {
      current_streak: 5,
      last_checkin_date: "2026-10-13", // yesterday in local date
    };

    const view = computeStreakView(user, now, tz);
    expect(view.localDate).toBe("2026-10-14");
    expect(view.checkedInToday).toBe(false);
    expect(view.streakAlive).toBe(true); // fire inactive, but streak not broken!
    expect(view.streakBroken).toBe(false);
    expect(view.displayStreak).toBe(5); // Still shows 5 to encourage checkin
    expect(view.restoreEligible).toBe(false);
    expect(view.nextRolloverAt).toBe("2026-10-14T17:00:00.000Z");
  });

  it("identifies streak broken when 1 day was missed (last_checkin was day before yesterday)", () => {
    // 2026-10-15 10:00:00 UTC+7, last checked in 2026-10-13 (missed 2026-10-14)
    const now = new Date("2026-10-15T03:00:00.000Z");
    const user = {
      current_streak: 5,
      last_checkin_date: "2026-10-13",
    };

    const view = computeStreakView(user, now, tz);
    expect(view.localDate).toBe("2026-10-15");
    expect(view.checkedInToday).toBe(false);
    expect(view.streakAlive).toBe(false);
    expect(view.streakBroken).toBe(true);
    expect(view.displayStreak).toBe(0);
    expect(view.restoreEligible).toBe(true); // missed exactly yesterday, eligible for restore
  });

  it("marks restore ineligible if missed 2 or more days", () => {
    // 2026-10-16 10:00:00 UTC+7, last checked in 2026-10-13 (missed 14 and 15)
    const now = new Date("2026-10-16T03:00:00.000Z");
    const user = {
      current_streak: 5,
      last_checkin_date: "2026-10-13",
    };

    const view = computeStreakView(user, now, tz);
    expect(view.localDate).toBe("2026-10-16");
    expect(view.checkedInToday).toBe(false);
    expect(view.streakAlive).toBe(false);
    expect(view.streakBroken).toBe(true);
    expect(view.displayStreak).toBe(0);
    expect(view.restoreEligible).toBe(false);
  });

  it("handles new user who never checked in", () => {
    const now = new Date("2026-10-13T07:00:00.000Z");
    const user = {
      current_streak: 0,
      last_checkin_date: null,
    };

    const view = computeStreakView(user, now, tz);
    expect(view.displayStreak).toBe(0);
    expect(view.checkedInToday).toBe(false);
    expect(view.streakAlive).toBe(false);
    expect(view.streakBroken).toBe(false);
    expect(view.restoreEligible).toBe(false);
  });
});
