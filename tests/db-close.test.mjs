import test from "node:test";
import assert from "node:assert/strict";
import { closeDb, initDb } from "../src/db.js";

test("closeDb closes the requested connection without closing a newer one", () => {
  const firstDb = initDb({ dbPath: ":memory:" });
  const secondDb = initDb({ dbPath: ":memory:" });

  try {
    closeDb(firstDb);
    assert.throws(() => firstDb.query("SELECT 1").get());
    assert.equal(secondDb.query("SELECT 1 AS ok").get().ok, 1);
  } finally {
    try { firstDb.close(); } catch {}
    try { closeDb(secondDb); } catch {}
  }
});
