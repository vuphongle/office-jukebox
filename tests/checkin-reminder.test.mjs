import { describe, it, expect, beforeEach } from "bun:test";
import { initDb } from "../src/db.js";
import { PushRepository } from "../src/repositories/pushRepository.js";
import {
  calculateNextReminderDate,
  shouldSendCatchUpReminder,
  sendCheckinReminders,
} from "../src/checkinReminder.js";

describe("checkinReminder", () => {
  let db;
  let pushRepo;
  const tz = "Asia/Ho_Chi_Minh";

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    pushRepo = new PushRepository(db);
  });

  function createUser(id, username, { streak = 5, lastCheckin = "2026-10-12", status = "active" } = {}) {
    const nowIso = new Date().toISOString();
    db.run(
      `INSERT INTO users (id, username, password_hash, display_name, role, status, points_balance, current_streak, last_checkin_date, created_at, updated_at)
       VALUES (?, ?, 'hash', ?, 'user', ?, 100, ?, ?, ?, ?)`,
      [id, username, username, status, streak, lastCheckin, nowIso, nowIso]
    );
  }

  describe("calculateNextReminderDate & catch-up", () => {
    it("returns today at 22:00 when current time is 20:00 UTC+7", () => {
      // 2026-10-13 20:00 UTC+7 = 2026-10-13 13:00 UTC
      const now = new Date("2026-10-13T13:00:00.000Z");
      const next = calculateNextReminderDate(tz, "22:00", now);
      // 2026-10-13 22:00 UTC+7 = 2026-10-13 15:00 UTC
      expect(next.toISOString()).toBe("2026-10-13T15:00:00.000Z");
    });

    it("returns tomorrow at 22:00 when current time is 22:30 UTC+7", () => {
      // 2026-10-13 22:30 UTC+7 = 2026-10-13 15:30 UTC
      const now = new Date("2026-10-13T15:30:00.000Z");
      const next = calculateNextReminderDate(tz, "22:00", now);
      // 2026-10-14 22:00 UTC+7 = 2026-10-14 15:00 UTC
      expect(next.toISOString()).toBe("2026-10-14T15:00:00.000Z");
    });

    it("detects catch-up eligibility between 22:00 and 23:30", () => {
      // 22:15 UTC+7 = 15:15 UTC -> catch-up true
      const nowDuringCatchUp = new Date("2026-10-13T15:15:00.000Z");
      expect(shouldSendCatchUpReminder(tz, "22:00", "23:30", nowDuringCatchUp)).toBe(true);

      // 23:45 UTC+7 = 16:45 UTC -> catch-up false (too late)
      const nowTooLate = new Date("2026-10-13T16:45:00.000Z");
      expect(shouldSendCatchUpReminder(tz, "22:00", "23:30", nowTooLate)).toBe(false);

      // 21:00 UTC+7 = 14:00 UTC -> catch-up false (too early)
      const nowTooEarly = new Date("2026-10-13T14:00:00.000Z");
      expect(shouldSendCatchUpReminder(tz, "22:00", "23:30", nowTooEarly)).toBe(false);
    });
  });

  describe("sendCheckinReminders", () => {
    it("sends push to eligible users who haven't checked in today", async () => {
      // 2026-10-13 22:00 UTC+7 = 15:00 UTC
      const now = new Date("2026-10-13T15:00:00.000Z");

      // User 1: streak 5, last checkin yesterday (2026-10-12), has subscription
      createUser("u1", "alice", { streak: 5, lastCheckin: "2026-10-12" });
      pushRepo.saveSubscription("u1", {
        endpoint: "https://push.service.com/u1",
        p256dh: "key1",
        auth: "auth1",
      });

      // User 2: already checked in today (2026-10-13), has subscription -> Should NOT receive
      createUser("u2", "bob", { streak: 3, lastCheckin: "2026-10-13" });
      pushRepo.saveSubscription("u2", {
        endpoint: "https://push.service.com/u2",
        p256dh: "key2",
        auth: "auth2",
      });

      // User 3: streak 0, never checked in, has subscription -> Should receive
      createUser("u3", "carol", { streak: 0, lastCheckin: null });
      pushRepo.saveSubscription("u3", {
        endpoint: "https://push.service.com/u3",
        p256dh: "key3",
        auth: "auth3",
      });

      const sentPushes = [];
      const mockWebPush = {
        async sendNotification(sub, payload) {
          sentPushes.push({ sub, payload: JSON.parse(payload) });
          return { statusCode: 201 };
        },
      };

      const inAppNotifications = [];
      const mockNotificationRepo = {
        createNotification(item) {
          inAppNotifications.push(item);
        },
      };

      const result = await sendCheckinReminders({
        db,
        pushRepo,
        notificationRepo: mockNotificationRepo,
        webPushClient: mockWebPush,
        timezone: tz,
        now,
      });

      expect(result.sentCount).toBe(2);
      expect(sentPushes.length).toBe(2);

      // Verify Alice's message (streak 5)
      const alicePush = sentPushes.find((p) => p.sub.endpoint === "https://push.service.com/u1");
      expect(alicePush).toBeDefined();
      expect(alicePush.payload.title).toContain("Chuỗi điểm danh");
      expect(alicePush.payload.body).toContain("5 ngày");
      expect(alicePush.payload.data.url).toBe("/guest?checkin=1");

      // Verify Carol's message (streak 0)
      const carolPush = sentPushes.find((p) => p.sub.endpoint === "https://push.service.com/u3");
      expect(carolPush).toBeDefined();
      expect(carolPush.payload.body).toContain("bắt đầu chuỗi streak mới");

      // In-app notifications created
      expect(inAppNotifications.length).toBe(2);
      expect(inAppNotifications[0].sourceType).toBe("checkin_reminder");

      // Bob did not receive anything
      const bobPush = sentPushes.find((p) => p.sub.endpoint === "https://push.service.com/u2");
      expect(bobPush).toBeUndefined();

      // Second run on the same day -> 0 sent due to idempotent log!
      const repeatRun = await sendCheckinReminders({
        db,
        pushRepo,
        notificationRepo: mockNotificationRepo,
        webPushClient: mockWebPush,
        timezone: tz,
        now,
      });
      expect(repeatRun.sentCount).toBe(0);
    });

    it("removes subscription on HTTP 410 Gone / 404 Not Found", async () => {
      const now = new Date("2026-10-13T15:00:00.000Z");
      createUser("u4", "david", { streak: 2, lastCheckin: "2026-10-12" });
      pushRepo.saveSubscription("u4", {
        endpoint: "https://push.service.com/expired",
        p256dh: "key4",
        auth: "auth4",
      });

      const mockWebPush = {
        async sendNotification() {
          const err = new Error("Subscription expired");
          err.statusCode = 410;
          throw err;
        },
      };

      await sendCheckinReminders({
        db,
        pushRepo,
        webPushClient: mockWebPush,
        timezone: tz,
        now,
      });

      // Subscription should be deleted from DB
      const subs = pushRepo.getSubscriptionsForUser("u4");
      expect(subs.length).toBe(0);
    });
  });
});
