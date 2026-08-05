import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyUsageUpdate,
  summarizeSessions,
  type SessionUsage,
} from "../src/sessionStats.ts";

function emptyMap(): Map<string, SessionUsage> {
  return new Map();
}

test("applyUsageUpdate creates an entry on first report", () => {
  const m = emptyMap();
  const u = applyUsageUpdate(m, "s1", "main", { used: 100, size: 2000, cost: { amount: 0.5, currency: "USD" } });
  assert.equal(u.used, 100);
  assert.equal(u.size, 2000);
  assert.equal(u.costAmount, 0.5);
  assert.equal(u.costCurrency, "USD");
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("s1"), u);
});

test("applyUsageUpdate overwrites used/size with the latest report (context is not cumulative)", () => {
  const m = emptyMap();
  applyUsageUpdate(m, "s1", "main", { used: 100, size: 2000 });
  applyUsageUpdate(m, "s1", "main", { used: 250, size: 2000 });
  const u = m.get("s1")!;
  assert.equal(u.used, 250);
  assert.equal(u.size, 2000);
});

test("applyUsageUpdate preserves currency when an update omits it", () => {
  const m = emptyMap();
  applyUsageUpdate(m, "s1", "main", { cost: { amount: 1, currency: "USD" } });
  applyUsageUpdate(m, "s1", "main", { used: 10, cost: { amount: 2 } });
  const u = m.get("s1")!;
  assert.equal(u.costAmount, 2);
  assert.equal(u.costCurrency, "USD");
});

test("applyUsageUpdate tolerates missing/zeroed fields", () => {
  const m = emptyMap();
  const u = applyUsageUpdate(m, "s1", "summarizer", {});
  assert.equal(u.used, 0);
  assert.equal(u.size, 0);
  assert.equal(u.costAmount, 0);
  assert.equal(u.costCurrency, "");
  assert.equal(u.role, "summarizer");
});

test("entries are never deleted — compacted-away sessions persist", () => {
  const m = emptyMap();
  applyUsageUpdate(m, "old", "main", { used: 500, cost: { amount: 3 } });
  applyUsageUpdate(m, "new", "main", { used: 10 });
  // Simulate compaction: only "new" is active, but "old" must remain.
  assert.equal(m.size, 2);
  assert.ok(m.has("old"));
  assert.ok(m.has("new"));
});

test("summarizeSessions marks the current main session and sums cost", () => {
  const m = emptyMap();
  applyUsageUpdate(m, "a", "main", { used: 100, cost: { amount: 1, currency: "USD" } });
  applyUsageUpdate(m, "b", "main", { used: 200, cost: { amount: 2, currency: "USD" } });
  applyUsageUpdate(m, "c", "summarizer", { used: 50, cost: { amount: 0.1, currency: "USD" } });
  const { rows, totalCost, count } = summarizeSessions(m, "b");
  assert.equal(count, 3);
  assert.equal(totalCost, 3.1);
  const cur = rows.find((r) => r.current);
  assert.equal(cur?.id, "b");
  assert.equal(cur?.role, "main");
  // The summarizer row and the other main row are not marked current.
  assert.equal(rows.filter((r) => r.current).length, 1);
});

test("summarizeSessions: a current id that is a summarizer is not marked current", () => {
  const m = emptyMap();
  applyUsageUpdate(m, "sum", "summarizer", { used: 1 });
  const { rows } = summarizeSessions(m, "sum");
  assert.equal(rows[0].current, false);
});

test("summarizeSessions with empty map yields no rows and zero totals", () => {
  const m = emptyMap();
  const { rows, totalCost, count } = summarizeSessions(m, null);
  assert.equal(count, 0);
  assert.equal(rows.length, 0);
  assert.equal(totalCost, 0);
});
