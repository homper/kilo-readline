import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeHistory,
  serializeHistoryEntry,
  parseHistory,
  trimHistoryEntries,
  HISTORY_MAX_BYTES,
  HISTORY_KEEP_ON_TRIM,
  type HistoryEntry,
} from "../src/history.ts";

test("serializeHistoryEntry uses \\x01 for single-line and \\x02 for multiline", () => {
  assert.equal(serializeHistoryEntry("hello"), "\x01hello\x00");
  assert.equal(serializeHistoryEntry("line1\nline2"), "\x02line1\nline2\x00");
});

test("parseHistory round-trips serialized entries", () => {
  const entries: HistoryEntry[] = [
    { text: "single", isMultiline: false },
    { text: "multi\nline", isMultiline: true },
  ];
  const serialized = serializeHistory(entries);
  const parsed = parseHistory(serialized);
  assert.deepEqual(parsed, entries);
});

test("parseHistory tolerates legacy blocks without a marker", () => {
  const parsed = parseHistory("legacy\x00\x01ok\x00");
  assert.deepEqual(parsed, [
    { text: "legacy", isMultiline: false },
    { text: "ok", isMultiline: false },
  ]);
  // A legacy block containing a newline is classified as multiline.
  const ml = parseHistory("a\nb\x00");
  assert.equal(ml[0].isMultiline, true);
  assert.equal(ml[0].text, "a\nb");
});

test("parseHistory skips empty/whitespace-only blocks", () => {
  const parsed = parseHistory("\x01hi\x00\x00   \x00");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "hi");
});

test("trimHistoryEntries returns null when under the size limit", () => {
  const entries: HistoryEntry[] = [{ text: "a", isMultiline: false }];
  assert.equal(trimHistoryEntries(entries, HISTORY_MAX_BYTES - 1), null);
});

test("trimHistoryEntries returns null when at the limit but few entries", () => {
  const entries = Array.from({ length: 5 }, () => ({ text: "x", isMultiline: false }));
  // Over the size limit, but not enough entries to trim down.
  assert.equal(trimHistoryEntries(entries, HISTORY_MAX_BYTES + 1), null);
});

test("trimHistoryEntries keeps the last HISTORY_KEEP_ON_TRIM entries when over the limit", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({
    text: `entry${i}`,
    isMultiline: false,
  }));
  const keep = trimHistoryEntries(entries, HISTORY_MAX_BYTES + 1);
  assert.ok(keep !== null);
  assert.equal(keep!.length, HISTORY_KEEP_ON_TRIM);
  // Last 10 are entries 20..29.
  assert.deepEqual(
    keep!.map((e) => e.text),
    Array.from({ length: 10 }, (_, i) => `entry${i + 20}`),
  );
});

test("trim + reserialize keeps file size bounded for the kept entries", () => {
  const entries: HistoryEntry[] = [];
  // Build entries that together exceed the limit.
  for (let i = 0; i < 1000; i++) {
    entries.push({ text: "x".repeat(8000), isMultiline: false });
  }
  const serialized = serializeHistory(entries);
  assert.ok(serialized.length > HISTORY_MAX_BYTES);
  const keep = trimHistoryEntries(entries, serialized.length);
  assert.ok(keep !== null);
  const trimmed = serializeHistory(keep!);
  assert.ok(trimmed.length < HISTORY_MAX_BYTES);
});
