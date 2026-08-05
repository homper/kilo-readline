import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractModelWords,
  isFullPathToken,
  matchModelWords,
  matchModelPaths,
  matchModels,
  exactModelMatch,
  effortDisplayName,
  formatEffortDisplay,
  type ModelOption,
} from "../src/modelSearch.ts";

const MODELS: ModelOption[] = [
  { value: "anthropic/claude-sonnet-5-20250929", name: "Claude Sonnet 5" },
  { value: "anthropic/claude-haiku-4", name: "Claude Haiku 4" },
  { value: "openrouter/anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
  { value: "kilo/kilo-auto/free", name: "Kilo Free" },
  { value: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
];

test("extractModelWords splits ids/names on / - _ . and whitespace, deduped lowercased", () => {
  const words = extractModelWords(MODELS);
  assert.ok(words.includes("anthropic"));
  assert.ok(words.includes("claude"));
  assert.ok(words.includes("sonnet"));
  assert.ok(words.includes("5"));
  assert.ok(words.includes("haiku"));
  assert.ok(words.includes("gemini"));
  assert.ok(words.includes("pro"));
  assert.ok(words.includes("kilo"));
  assert.ok(words.includes("free"));
  // No empty fragments.
  assert.ok(!words.includes(""));
});

test("isFullPathToken is true only when the token contains a slash", () => {
  assert.equal(isFullPathToken("claude"), false);
  assert.equal(isFullPathToken("son"), false);
  assert.equal(isFullPathToken("anthropic/claude"), true);
  assert.equal(isFullPathToken("kilo/"), true);
  assert.equal(isFullPathToken(""), false);
});

test("matchModelWords: a bare fragment completes to words, not full ids", () => {
  const words = extractModelWords(MODELS);
  const hits = matchModelWords("son", words);
  assert.ok(hits.includes("sonnet"), `got ${JSON.stringify(hits)}`);
  // The result must be words, not full model ids (no "/" in any hit here).
  assert.ok(hits.every((h) => !h.includes("/")), "word-mode hits contain no '/'");
});

test("matchModelWords: prefix matches rank before fuzzy matches", () => {
  const words = extractModelWords([
    { value: "x/sonnet", name: "Sonnet" },
    { value: "x/masonry", name: "Masonry" },
  ]);
  const hits = matchModelWords("son", words);
  // "sonnet" (prefix) should come before "masonry" (fuzzy subsequence).
  assert.equal(hits[0], "sonnet");
  assert.ok(hits.includes("masonry"));
});

test("matchModelPaths: a full-path token completes to full model ids by prefix", () => {
  const hits = matchModelPaths("anthropic/claude", MODELS);
  assert.ok(hits.includes("anthropic/claude-sonnet-5-20250929"));
  assert.ok(hits.includes("anthropic/claude-haiku-4"));
  // openrouter/anthropic/... should NOT match (prefix differs).
  assert.ok(!hits.includes("openrouter/anthropic/claude-3.5-sonnet"));
});

test("matchModels: empty query returns kilo/* models", () => {
  const matches = matchModels("", MODELS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "kilo/kilo-auto/free");
});

test("matchModels: a single word fuzzy-matches value or name", () => {
  const matches = matchModels("gemini", MODELS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "google/gemini-2.5-pro");
});

test("matchModels: multi-word query AND-matches per word against each model", () => {
  // "claude sonnet" must match models whose id/name contain BOTH words.
  const matches = matchModels("claude sonnet", MODELS);
  const ids = matches.map((m) => m.value);
  assert.ok(ids.includes("anthropic/claude-sonnet-5-20250929"), `got ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("openrouter/anthropic/claude-3.5-sonnet"), `got ${JSON.stringify(ids)}`);
  // "claude haiku" should NOT include the sonnet models.
  const haiku = matchModels("claude haiku", MODELS).map((m) => m.value);
  assert.ok(haiku.includes("anthropic/claude-haiku-4"));
  assert.ok(!haiku.includes("anthropic/claude-sonnet-5-20250929"));
});

test("matchModels: provider-prefixed query uses plain prefix match on value", () => {
  const matches = matchModels("anthropic/claude-", MODELS);
  const ids = matches.map((m) => m.value);
  assert.ok(ids.includes("anthropic/claude-sonnet-5-20250929"));
  assert.ok(ids.includes("anthropic/claude-haiku-4"));
  assert.ok(!ids.includes("openrouter/anthropic/claude-3.5-sonnet"));
});

test("exactModelMatch: full model id surrounded by whitespace selects it", () => {
  const m = exactModelMatch("  anthropic/claude-sonnet-5-20250929  ", MODELS);
  assert.ok(m !== null);
  assert.equal(m!.value, "anthropic/claude-sonnet-5-20250929");
});

test("exactModelMatch: case-insensitive, no extra tokens", () => {
  const m = exactModelMatch("ANTHROPIC/CLAUDE-HAIKU-4", MODELS);
  assert.ok(m !== null);
  assert.equal(m!.value, "anthropic/claude-haiku-4");
});

test("exactModelMatch: a non-exact query returns null (Enter falls back to filter)", () => {
  assert.equal(exactModelMatch("claude", MODELS), null);
  assert.equal(exactModelMatch("", MODELS), null);
});

// --- effort / thinking-level display -----------------------------------------

const EFFORT_OPTS = [
  { value: "high", name: "High" },
  { value: "max", name: "Max" },
  { value: "default", name: "Default" },
];

test("effortDisplayName: an openrouter-canonical id shows the agent name unchanged", () => {
  assert.equal(effortDisplayName("high", "High"), "High");
  assert.equal(effortDisplayName("HIGH", "High"), "High");
});

test("effortDisplayName: a known alias appends the openrouter name in parens", () => {
  // "max" is not an openrouter name; it maps to "high".
  assert.equal(effortDisplayName("max", "Max"), "Max (high)");
});

test("effortDisplayName: an unknown non-canonical id shows just the agent name", () => {
  // A literal "default" variant (no mapping) → no parenthetical.
  assert.equal(effortDisplayName("default", "Default"), "Default");
  assert.equal(effortDisplayName("turbo", "Turbo"), "Turbo");
});

test("formatEffortDisplay: resolves current to its option name, then applies the alias rule", () => {
  // "high" is canonical → "High".
  assert.equal(formatEffortDisplay("high", EFFORT_OPTS), "High");
  // "max" is an alias → "Max (high)".
  assert.equal(formatEffortDisplay("max", EFFORT_OPTS), "Max (high)");
  // "default" has no mapping → "Default".
  assert.equal(formatEffortDisplay("default", EFFORT_OPTS), "Default");
});

test("formatEffortDisplay: a current not in options falls back to the raw id", () => {
  assert.equal(formatEffortDisplay("weird", EFFORT_OPTS), "weird");
});

test("formatEffortDisplay: null/empty current and empty options yield (none)", () => {
  assert.equal(formatEffortDisplay(null, EFFORT_OPTS), "(none)");
  assert.equal(formatEffortDisplay("", EFFORT_OPTS), "(none)");
  assert.equal(formatEffortDisplay("high", []), "(none)");
});
