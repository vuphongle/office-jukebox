import test from "node:test";
import assert from "node:assert/strict";
import { parsePagination } from "../src/pagination.js";

test("pagination parsing applies defaults and bounds malformed values", () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 50, offset: 0 });
  assert.deepEqual(parsePagination({ page: "3", limit: "200" }), { page: 3, limit: 100, offset: 200 });
  assert.deepEqual(parsePagination({ page: "nope", limit: "-2" }, { defaultLimit: 20 }), {
    page: 1,
    limit: 1,
    offset: 0,
  });
});

test("pagination parsing keeps SQLite offsets within safe integer range", () => {
  const result = parsePagination({ page: "999999999999999999999", limit: "100" });
  assert.ok(Number.isSafeInteger(result.offset));
  assert.ok(result.offset <= Number.MAX_SAFE_INTEGER);
});
