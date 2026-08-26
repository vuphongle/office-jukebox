export function createFixedWindowRateLimiter({
  windowMs,
  max,
  key,
  reason = "Bạn thao tác quá nhanh. Vui lòng thử lại sau.",
  now = Date.now,
}) {
  const buckets = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const timestamp = now();
    const bucketKey = String(key(req) || "unknown");
    let bucket = buckets.get(bucketKey);

    if (!bucket || timestamp >= bucket.resetAt) {
      bucket = { count: 0, resetAt: timestamp + windowMs };
      buckets.set(bucketKey, bucket);
    }

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(Math.max(0, max - bucket.count - 1)));
    res.set("RateLimit-Reset", String(retryAfter));

    if (bucket.count >= max) {
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ ok: false, reason, retryAfter });
    }

    bucket.count += 1;

    if (buckets.size > 5000) {
      for (const [storedKey, storedBucket] of buckets) {
        if (timestamp >= storedBucket.resetAt) buckets.delete(storedKey);
      }
    }

    next();
  };
}
