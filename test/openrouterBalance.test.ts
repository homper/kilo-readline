import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  parseOpenRouterKeyInfo,
  parseOpenRouterCredits,
  readOpenRouterKey,
  openRouterKeyRemaining,
  formatOpenRouterBalance,
  fetchOpenRouterKeyInfo,
  fetchOpenRouterCredits,
  handleOpenRouterBalance,
  openrouterAuthPath,
  type FetchLike,
} from "../src/openrouterBalance.ts";

// --- parseOpenRouterKeyInfo ---

// Matches the documented GET /api/v1/key response shape.
const REAL_KEY_SAMPLE = {
  data: {
    label: "sk-or-v1-au7...890",
    usage: 25.5,
    usage_daily: 1.25,
    usage_weekly: 8.4,
    usage_monthly: 22.1,
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: "monthly",
    is_free_tier: false,
    is_management_key: false,
    expires_at: "2027-12-31T23:59:59Z",
    rate_limit: { interval: "1h", note: "deprecated", requests: -1 },
  },
};

test("parseOpenRouterKeyInfo parses the documented /key payload", () => {
  const k = parseOpenRouterKeyInfo(REAL_KEY_SAMPLE)!;
  assert.equal(k.label, "sk-or-v1-au7...890");
  assert.equal(k.usage, 25.5);
  assert.equal(k.usageDaily, 1.25);
  assert.equal(k.usageWeekly, 8.4);
  assert.equal(k.usageMonthly, 22.1);
  assert.equal(k.limit, 100);
  assert.equal(k.limitRemaining, 74.5);
  assert.equal(k.limitReset, "monthly");
  assert.equal(k.isFreeTier, false);
  assert.equal(k.expiresAt, "2027-12-31T23:59:59Z");
});

test("parseOpenRouterKeyInfo treats an unlimited key (null limit) as valid", () => {
  const k = parseOpenRouterKeyInfo({
    data: { usage: 3.5, limit: null, limit_remaining: null, limit_reset: null },
  })!;
  assert.equal(k.limit, null);
  assert.equal(k.limitRemaining, null);
  assert.equal(k.usage, 3.5);
});

test("parseOpenRouterKeyInfo returns null for missing data or usage", () => {
  assert.equal(parseOpenRouterKeyInfo(null), null);
  assert.equal(parseOpenRouterKeyInfo({}), null);
  assert.equal(parseOpenRouterKeyInfo({ data: {} }), null);
  assert.equal(parseOpenRouterKeyInfo({ data: { label: "x" } }), null);
});

test("parseOpenRouterCredits parses the documented /credits payload", () => {
  const c = parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 25.5 } })!;
  assert.equal(c.totalCredits, 100);
  assert.equal(c.totalUsage, 25.5);
});

test("parseOpenRouterCredits returns null without a ledger", () => {
  assert.equal(parseOpenRouterCredits(null), null);
  assert.equal(parseOpenRouterCredits({}), null);
  assert.equal(parseOpenRouterCredits({ data: {} }), null);
});

// --- readOpenRouterKey ---

test("readOpenRouterKey reads the api-key openrouter section", () => {
  const key = readOpenRouterKey({
    authContent: JSON.stringify({ openrouter: { type: "api", key: "sk-or-v1-abc" } }),
  });
  assert.equal(key, "sk-or-v1-abc");
});

test("readOpenRouterKey returns null for non-api or missing openrouter sections", () => {
  assert.equal(
    readOpenRouterKey({ authContent: JSON.stringify({ openrouter: { type: "oauth", key: "k" } }) }),
    null,
  );
  assert.equal(
    readOpenRouterKey({ authContent: JSON.stringify({ openrouter: { type: "api" } }) }),
    null,
  );
  assert.equal(readOpenRouterKey({ authContent: JSON.stringify({ kilo: { type: "api", key: "k" } }) }), null);
});

test("readOpenRouterKey returns null for an unparseable / missing file", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "openrouter-auth-"));
  try {
    assert.equal(readOpenRouterKey({ authPath: join(dir, "nope.json") }), null);
    fs.writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readOpenRouterKey({ authPath: join(dir, "bad.json") }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readOpenRouterKey honors the KILO_AUTH_CONTENT env override", async () => {
  const saved = process.env.KILO_AUTH_CONTENT;
  process.env.KILO_AUTH_CONTENT = JSON.stringify({
    openrouter: { type: "api", key: "sk-or-v1-from-env" },
  });
  try {
    assert.equal(readOpenRouterKey(), "sk-or-v1-from-env");
  } finally {
    if (saved === undefined) delete process.env.KILO_AUTH_CONTENT;
    else process.env.KILO_AUTH_CONTENT = saved;
  }
});

test("openrouterAuthPath resolves under XDG_DATA_HOME", () => {
  const p = openrouterAuthPath({ XDG_DATA_HOME: "/tmp/data" } as NodeJS.ProcessEnv);
  assert.equal(p, "/tmp/data/kilo/auth.json");
});

// --- openRouterKeyRemaining ---

test("openRouterKeyRemaining prefers the key's own limit_remaining", () => {
  const info = parseOpenRouterKeyInfo(REAL_KEY_SAMPLE)!;
  assert.equal(openRouterKeyRemaining(info, null), 74.5);
});

test("openRouterKeyRemaining falls back to limit − usage when limit_remaining is absent", () => {
  const info = parseOpenRouterKeyInfo({
    data: { usage: 30, limit: 50, limit_remaining: null },
  })!;
  assert.equal(openRouterKeyRemaining(info, null), 20);
});

test("openRouterKeyRemaining uses account credits for an unlimited key", () => {
  const info = parseOpenRouterKeyInfo({ data: { usage: 3, limit: null } })!;
  const credits = parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 25.5 } })!;
  assert.equal(openRouterKeyRemaining(info, credits), 74.5);
});

test("openRouterKeyRemaining returns null with no limit and no ledger", () => {
  const info = parseOpenRouterKeyInfo({ data: { usage: 3, limit: null } })!;
  assert.equal(openRouterKeyRemaining(info, null), null);
  assert.equal(openRouterKeyRemaining(null, null), null);
});

// --- fetchers ---

function mockFetchOk(body: unknown): FetchLike {
  return async () =>
    ({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    }) as unknown as Response;
}

function mockFetchStatus(status: number, body: string): FetchLike {
  return async () =>
    ({
      ok: false,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve({}),
    }) as unknown as Response;
}

test("fetchOpenRouterKeyInfo sends the Bearer key and hits /key", async () => {
  let url = "";
  let headers: Record<string, string> | undefined;
  const info = await fetchOpenRouterKeyInfo("sk-or-v1-abc", {
    fetchFn: async (u, init) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      return mockFetchOk(REAL_KEY_SAMPLE)();
    },
  });
  assert.equal(url, "https://openrouter.ai/api/v1/key");
  assert.equal(headers?.Authorization, "Bearer sk-or-v1-abc");
  assert.equal(info.usage, 25.5);
});

test("fetchOpenRouterCredits throws on a non-ok response", async () => {
  await assert.rejects(
    fetchOpenRouterCredits("sk-or-v1-abc", { fetchFn: mockFetchStatus(403, "no ledger") }),
    /\/credits fetch failed \(403\)/,
  );
});

test("fetchOpenRouterKeyInfo throws on an unexpected 200 shape", async () => {
  await assert.rejects(
    fetchOpenRouterKeyInfo("sk-or-v1-abc", { fetchFn: mockFetchOk({ nope: true }) }),
    /unexpected response shape/,
  );
});

// --- formatOpenRouterBalance ---

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatOpenRouterBalance headlines the key-limit remaining", () => {
  const info = parseOpenRouterKeyInfo(REAL_KEY_SAMPLE)!;
  const credits = parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 25.5 } })!;
  const out = strip(formatOpenRouterBalance(info, credits));
  assert.match(out, /openrouter-balance/);
  assert.match(out, /remaining\s+\$74\.50 left of \$100\.00 key limit \(resets monthly\)/);
  // Account ledger is secondary context when the key has its own limit.
  assert.match(out, /account credits\s+\$74\.50 remaining of \$100\.00 purchased/);
  assert.match(out, /usage today\s+\$1\.25/);
  assert.match(out, /usage week\s+\$8\.40/);
  assert.match(out, /usage month\s+\$22\.10/);
  assert.match(out, /usage total\s+\$25\.50/);
  assert.match(out, /per-request detail: https:\/\/openrouter\.ai\/activity/);
});

test("formatOpenRouterBalance shows account credits as remaining for an unlimited key", () => {
  const info = parseOpenRouterKeyInfo({ data: { usage: 3, limit: null } })!;
  const credits = parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 25.5 } })!;
  const out = strip(formatOpenRouterBalance(info, credits));
  assert.match(out, /remaining\s+\$74\.50 of account credits \(no key limit\)/);
  // No secondary account-ledger row beyond the remaining line itself.
  assert.doesNotMatch(out, /account credits\s+\$/);
});

test("formatOpenRouterBalance marks the remaining unknown without limit or ledger", () => {
  const info = parseOpenRouterKeyInfo({ data: { usage: 3, limit: null } })!;
  const out = strip(formatOpenRouterBalance(info, null));
  assert.match(out, /remaining\s+unknown \(no key limit, no credit ledger\)/);
});

test("formatOpenRouterBalance colors a near-depleted key red", () => {
  const info = parseOpenRouterKeyInfo({
    data: { usage: 95, limit: 100, limit_remaining: 5 },
  })!;
  const raw = formatOpenRouterBalance(info, null);
  // Remaining 5% of the limit → red.
  assert.match(raw, /\x1b\[31m\$5\.00\x1b\[0m left of \$100\.00 key limit/);
});

test("formatOpenRouterBalance shows free-tier tag and expiry", () => {
  const info = parseOpenRouterKeyInfo({
    data: { usage: 0, is_free_tier: true, expires_at: "2027-06-15T12:00:00Z" },
  })!;
  const out = strip(formatOpenRouterBalance(info, null));
  assert.match(out, /\(free tier\)/);
  // Rendered in the local timezone; compute the expected day the same way.
  const d = new Date("2027-06-15T12:00:00Z");
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.match(out, new RegExp(`expires ${expected}`));
});

// --- handleOpenRouterBalance end-to-end (mocked) ---

const AUTH = JSON.stringify({ openrouter: { type: "api", key: "sk-or-v1-e2e" } });

test("handleOpenRouterBalance reads the key, fetches both endpoints, and formats", async () => {
  const urls: string[] = [];
  const out = await handleOpenRouterBalance({
    authContent: AUTH,
    fetchFn: async (u) => {
      urls.push(u);
      if (u.endsWith("/key")) return mockFetchOk(REAL_KEY_SAMPLE)();
      return mockFetchOk({ data: { total_credits: 100, total_usage: 25.5 } })();
    },
  });
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"]);
  const plain = strip(out);
  assert.match(plain, /remaining\s+\$74\.50 left of \$100\.00 key limit/);
});

test("handleOpenRouterBalance tolerates a /credits failure (free-tier key)", async () => {
  const out = await handleOpenRouterBalance({
    authContent: AUTH,
    fetchFn: async (u) => {
      if (u.endsWith("/credits")) return mockFetchStatus(403, "no credits")();
      return mockFetchOk(REAL_KEY_SAMPLE)();
    },
  });
  const plain = strip(out);
  assert.match(plain, /remaining\s+\$74\.50 left of \$100\.00 key limit/);
  assert.doesNotMatch(plain, /account credits/);
});

test("handleOpenRouterBalance throws a friendly message when no key is configured", async () => {
  await assert.rejects(
    handleOpenRouterBalance({
      authContent: JSON.stringify({ openai: { type: "api", key: "sk-test" } }),
      fetchFn: mockFetchOk(REAL_KEY_SAMPLE),
    }),
    /No OpenRouter API key found/,
  );
});

test("handleOpenRouterBalance propagates key-info fetch errors (e.g. revoked key)", async () => {
  await assert.rejects(
    handleOpenRouterBalance({
      authContent: AUTH,
      fetchFn: mockFetchStatus(401, "invalid key"),
    }),
    /\/key fetch failed \(401\)/,
  );
});
