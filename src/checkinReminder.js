import webpush from "web-push";
import { DEFAULT_TIMEZONE, getLocalDate, getTzOffsetMs } from "./checkin.js";

function resolveTimezone(timezone) {
  return timezone || process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

export function calculateNextReminderDate(timezone = null, reminderTimeStr = "22:00", now = new Date()) {
  const resolvedTz = resolveTimezone(timezone);
  const [targetH, targetM] = (reminderTimeStr || "22:00").split(":").map(Number);
  const todayStr = getLocalDate(resolvedTz, now);
  const [y, m, d] = todayStr.split("-").map(Number);

  const offsetMsToday = getTzOffsetMs(now, resolvedTz);
  // UTC ms for today at targetH:targetM in resolvedTz
  let targetUtcMs = Date.UTC(y, m - 1, d, targetH, targetM, 0) - offsetMsToday;
  let targetDate = new Date(targetUtcMs);

  // If targetDate is already in the past or now, target tomorrow
  if (targetDate.getTime() <= now.getTime()) {
    // Tomorrow
    const offsetMsTomorrow = getTzOffsetMs(new Date(now.getTime() + 24 * 3600 * 1000), resolvedTz);
    targetUtcMs = Date.UTC(y, m - 1, d + 1, targetH, targetM, 0) - offsetMsTomorrow;
    targetDate = new Date(targetUtcMs);
  }

  return targetDate;
}

export function shouldSendCatchUpReminder(
  timezone = null,
  reminderTimeStr = "22:00",
  cutoffTimeStr = "23:30",
  now = new Date()
) {
  const resolvedTz = resolveTimezone(timezone);
  const [startH, startM] = (reminderTimeStr || "22:00").split(":").map(Number);
  const [endH, endM] = (cutoffTimeStr || "23:30").split(":").map(Number);

  const todayStr = getLocalDate(resolvedTz, now);
  const [y, m, d] = todayStr.split("-").map(Number);
  const offsetMs = getTzOffsetMs(now, resolvedTz);

  const startUtcMs = Date.UTC(y, m - 1, d, startH, startM, 0) - offsetMs;
  const endUtcMs = Date.UTC(y, m - 1, d, endH, endM, 0) - offsetMs;
  const nowMs = now.getTime();

  return nowMs >= startUtcMs && nowMs <= endUtcMs;
}

export async function sendCheckinReminders({
  db,
  pushRepo,
  notificationRepo = null,
  webPushClient = webpush,
  timezone = null,
  reminderTime = "22:00",
  now = new Date(),
  concurrency = 10,
  isEnabled = () => true,
} = {}) {
  if (typeof isEnabled === "function" && !isEnabled()) {
    return { sentCount: 0, skipped: true, reason: "disabled" };
  }

  const resolvedTz = resolveTimezone(timezone);
  const today = getLocalDate(resolvedTz, now);

  const eligibleUsers = pushRepo.listEligibleUsersForCheckinReminder(today);
  if (!eligibleUsers.length) {
    return { sentCount: 0, eligibleCount: 0 };
  }

  let sentCount = 0;

  // Process users in chunks of concurrency
  for (let i = 0; i < eligibleUsers.length; i += concurrency) {
    const chunk = eligibleUsers.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (user) => {
        const streak = Math.max(0, Number(user.current_streak) || 0);
        const title = streak > 0 ? "🔥 Chuỗi điểm danh sắp tắt!" : "✨ Điểm danh hôm nay!";
        const body = streak > 0
          ? `Chuỗi ${streak} ngày của bạn sắp tắt! Điểm danh trước 0h để giữ chuỗi nhé.`
          : "Điểm danh hôm nay để nhận điểm vote và bắt đầu chuỗi streak mới!";

        const payload = JSON.stringify({
          title,
          body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "checkin-reminder",
          data: {
            url: "/guest?checkin=1",
          },
        });

        // In-app notification
        if (notificationRepo && typeof notificationRepo.createNotification === "function") {
          try {
            notificationRepo.createNotification({
              userId: user.id,
              title,
              message: body,
              sourceType: "checkin_reminder",
              sourceKey: `reminder:${today}:${user.id}`,
            });
          } catch (err) {
            console.warn("[checkinReminder] Failed to create in-app notification:", err.message);
          }
        }

        const subs = pushRepo.getSubscriptionsForUser(user.id);
        for (const sub of subs) {
          const pushSubscription = {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          };

          try {
            await webPushClient.sendNotification(pushSubscription, payload);
            pushRepo.recordDeliverySuccess(sub.endpoint);
          } catch (err) {
            const statusCode = err.statusCode || (err.response && err.response.statusCode);
            pushRepo.recordDeliveryFailure(sub.endpoint, statusCode || 500);
          }
        }

        pushRepo.recordReminderSent(user.id, today, "checkin_reminder");
        sentCount++;
      })
    );
  }

  return { sentCount, eligibleCount: eligibleUsers.length };
}

export function startCheckinReminderScheduler({
  db,
  pushRepo,
  notificationRepo = null,
  webPushClient = webpush,
  timezone = null,
  reminderTime = "22:00",
  isEnabled = () => true,
  logger = console,
} = {}) {
  let timerId = null;
  let isRunning = true;

  async function triggerReminder() {
    try {
      const res = await sendCheckinReminders({
        db,
        pushRepo,
        notificationRepo,
        webPushClient,
        timezone,
        reminderTime,
        isEnabled,
      });
      if (res.sentCount > 0) {
        logger.log(`[checkinReminder] Sent ${res.sentCount} reminder(s).`);
      }
    } catch (err) {
      logger.error("[checkinReminder] Failed to send reminders:", err);
    }
  }

  function scheduleNext() {
    if (!isRunning) return;
    const now = new Date();
    const nextDate = calculateNextReminderDate(timezone, reminderTime, now);
    const delayMs = Math.max(1000, nextDate.getTime() - now.getTime());

    timerId = setTimeout(async () => {
      if (!isRunning) return;
      await triggerReminder();
      scheduleNext();
    }, delayMs);

    timerId.unref?.();
  }

  // Catch-up check on boot
  if (shouldSendCatchUpReminder(timezone, reminderTime)) {
    triggerReminder().finally(() => {
      scheduleNext();
    });
  } else {
    scheduleNext();
  }

  return {
    stop() {
      isRunning = false;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}
