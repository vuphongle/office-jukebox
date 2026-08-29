/**
 * Parse a bounded page/limit pair from an Express query object.
 *
 * Keeping this at the HTTP boundary prevents malformed query values from
 * leaking NaN into SQLite LIMIT/OFFSET clauses and keeps endpoint behavior
 * consistent.
 */
export function parsePagination(query = {}, { defaultLimit = 50, maxLimit = 100 } = {}) {
  const parsedPage = Number.parseInt(query.page, 10);
  const parsedLimit = Number.parseInt(query.limit, 10);
  const page = Number.isSafeInteger(parsedPage) ? Math.max(1, parsedPage) : 1;
  const limit = Number.isSafeInteger(parsedLimit)
    ? Math.min(maxLimit, Math.max(1, parsedLimit))
    : defaultLimit;
  const safePage = Math.min(page, Math.floor(Number.MAX_SAFE_INTEGER / limit));
  return { page: safePage, limit, offset: (safePage - 1) * limit };
}
