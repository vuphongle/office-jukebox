export function parseDurationSeconds(value, { maxSeconds = Infinity } = {}) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+(?::\d{2}){1,2}$/.test(normalized) && !/^\d+$/.test(normalized)) return null;
  const parts = normalized.split(":");
  if (parts.length > 1 && parts.slice(1).some((part) => Number(part) >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxSeconds) return null;
  return seconds;
}
