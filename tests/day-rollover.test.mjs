import { describe, it, expect } from "bun:test";
import { startDayRolloverScheduler } from "../src/dayRollover.js";

describe("dayRollover scheduler", () => {
  it("schedules and fires day_rollover when midnight arrives", async () => {
    let broadcastMessages = [];
    let currentTime = new Date("2026-10-13T16:59:59.800Z").getTime(); // 200ms before midnight UTC+7

    const nowFn = () => new Date(currentTime);
    const broadcast = (msg) => broadcastMessages.push(msg);

    const scheduler = startDayRolloverScheduler({
      timezone: "Asia/Ho_Chi_Minh",
      broadcast,
      nowFn,
    });

    // Advance time past midnight
    currentTime += 500;
    // Wait slightly for the timer to fire in test
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(broadcastMessages.length).toBeGreaterThanOrEqual(1);
    expect(broadcastMessages[0].type).toBe("day_rollover");
    expect(broadcastMessages[0].localDate).toBe("2026-10-14");

    scheduler.stop();
  });
});
