import { getNextMidnight, getLocalDate } from "./checkin.js";

export function startDayRolloverScheduler({
  timezone = null,
  broadcast = () => {},
  nowFn = () => new Date(),
  onRollover = () => {},
} = {}) {
  let timer = null;
  let running = true;

  function scheduleNext() {
    if (!running) return;
    const now = nowFn();
    const nextMidnight = getNextMidnight(timezone, now);
    // Add small buffer (+250ms) to ensure local date has definitely rolled over
    const diff = nextMidnight.getTime() - now.getTime() + 250;
    const delayMs = Math.max(200, Math.min(diff, 24 * 60 * 60 * 1000));

    timer = setTimeout(() => {
      if (!running) return;
      const rolloverNow = nowFn();
      const localDate = getLocalDate(timezone, rolloverNow);
      try {
        broadcast({ type: "day_rollover", localDate });
      } catch (err) {
        console.warn("[day-rollover] Broadcast error:", err);
      }
      try {
        onRollover(localDate);
      } catch (err) {
        console.warn("[day-rollover] onRollover callback error:", err);
      }
      scheduleNext();
    }, delayMs);
    timer.unref?.();
  }

  scheduleNext();

  return {
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
