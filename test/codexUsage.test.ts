import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  parseUsageJson,
  formatCodexUsage,
  colorRemainingPercent,
  remainingPercent,
  renderBar,
  windowLabel,
  formatDuration,
  formatResetClock,
  fetchKiloCodexFiveHourPercent,
  handleCodexUsage,
  type FetchLike,
} from "../src/codexUsage.ts";

// --- parseUsageJson ---

const REAL_SAMPLE = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 1,
      limit_window_seconds: 18000,
      reset_after_seconds: 14461,
      reset_at: 1788368570,
    },
    secondary_window: {
      used_percent: 12,
      limit_window_seconds: 604800,
      reset_after_seconds: 583023,
      reset_at: 1788937132,
    },
    additional_rate_limits: null,
  },
  code_review_rate_limit: null,
};

test("parseUsageJson parses the real sample with both windows", () => {
  const u = parseUsageJson(REAL_SAMPLE)!;
  assert.equal(u.planType, "plus");
  assert.equal(u.allowed, true);
  assert.equal(u.limitReached, false);
  assert.equal(u.primary?.usedPercent, 1);
  assert.equal(u.primary?.windowSeconds, 18000);
  assert.equal(u.primary?.resetAt, 1788368570);
  assert.equal(u.secondary?.usedPercent, 12);
  assert.equal(u.secondary?.windowSeconds, 604800);
  assert.equal(u.extra.length, 0);
});

test("parseUsageJson tolerates a null secondary window", () => {
  const u = parseUsageJson({
    plan_type: "pro",
    rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 5 }, secondary_window: null },
  })!;
  assert.equal(u.primary?.usedPercent, 5);
  assert.equal(u.secondary, null);
});

test("parseUsageJson handles missing rate_limit block", () => {
  const u = parseUsageJson({ plan_type: "free" })!;
  assert.equal(u.planType, "free");
  assert.equal(u.primary, null);
  assert.equal(u.secondary, null);
});

test("parseUsageJson surfaces additional_rate_limits as extras", () => {
  const u = parseUsageJson({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 1 },
      additional_rate_limits: [
        { used_percent: 3, limit_window_seconds: 3600 },
        { used_percent: 9 },
      ],
    },
  })!;
  assert.equal(u.extra.length, 2);
  assert.equal(u.extra[0].usedPercent, 3);
  assert.equal(u.extra[1].windowSeconds, 0);
});

test("parseUsageJson flags limit_reached and not allowed", () => {
  const u = parseUsageJson({
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } },
  })!;
  assert.equal(u.allowed, false);
  assert.equal(u.limitReached, true);
});

test("parseUsageJson returns null for non-object input", () => {
  assert.equal(parseUsageJson(null), null);
  assert.equal(parseUsageJson("hi"), null);
});

// --- fetchKiloCodexFiveHourPercent ---

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

test("fetchKiloCodexFiveHourPercent uses Kilo's OpenAI OAuth and returns only the 5h window", async () => {
  let headers: Record<string, string> | undefined;
  const percent = await fetchKiloCodexFiveHourPercent({
    authContent: JSON.stringify({
      openai: { type: "oauth", access: "access-token", accountId: "account-1" },
    }),
    fetchFn: async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return mockFetchOk(REAL_SAMPLE)();
    },
  });
  assert.equal(percent, 1);
  assert.equal(headers?.Authorization, "Bearer access-token");
  assert.equal(headers?.["ChatGPT-Account-Id"], "account-1");
});

test("fetchKiloCodexFiveHourPercent ignores OpenAI API-key auth", async () => {
  let fetched = false;
  const percent = await fetchKiloCodexFiveHourPercent({
    authContent: JSON.stringify({ openai: { type: "api", key: "sk-test" } }),
    fetchFn: async () => {
      fetched = true;
      return mockFetchOk(REAL_SAMPLE)();
    },
  });
  assert.equal(percent, null);
  assert.equal(fetched, false);
});

test("fetchKiloCodexFiveHourPercent does not substitute the 7d window", async () => {
  const percent = await fetchKiloCodexFiveHourPercent({
    authContent: JSON.stringify({
      openai: { type: "oauth", access: "access-token", accountId: "account-1" },
    }),
    fetchFn: mockFetchOk({
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 604800 },
      },
    }),
  });
  assert.equal(percent, null);
});

test("fetchKiloCodexFiveHourPercent derives accountId from the JWT when absent", async () => {
  // A fake JWT whose payload carries chatgpt_account_id = "acct-from-jwt".
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-from-jwt" })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  let sentAccountId: string | undefined;
  const percent = await fetchKiloCodexFiveHourPercent({
    authContent: JSON.stringify({ openai: { type: "oauth", access: token } }),
    fetchFn: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      sentAccountId = headers?.["ChatGPT-Account-Id"];
      return mockFetchOk(REAL_SAMPLE)();
    },
  });
  assert.equal(sentAccountId, "acct-from-jwt");
  assert.equal(percent, 1);
});

test("fetchKiloCodexFiveHourPercent returns null when the auth file is missing", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-noauth-"));
  try {
    const percent = await fetchKiloCodexFiveHourPercent({
      authPath: join(dir, "nope.json"),
      fetchFn: async () => mockFetchOk(REAL_SAMPLE)(),
    });
    assert.equal(percent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- format helpers ---

test("remainingPercent converts used percentage and clamps", () => {
  assert.equal(remainingPercent(1), 99);
  assert.equal(remainingPercent(100), 0);
  assert.equal(remainingPercent(-5), 100);
  assert.equal(remainingPercent(150), 0);
});

test("colorRemainingPercent thresholds: red <=20, yellow 21-50, green >50", () => {
  assert.match(colorRemainingPercent(0), /\x1b\[31m/); // red
  assert.match(colorRemainingPercent(20), /\x1b\[31m/);
  assert.match(colorRemainingPercent(21), /\x1b\[33m/); // yellow
  assert.match(colorRemainingPercent(50), /\x1b\[33m/);
  assert.match(colorRemainingPercent(51), /\x1b\[32m/); // green
  assert.match(colorRemainingPercent(100), /\x1b\[32m/);
});

test("renderBar fills proportionally and clamps", () => {
  assert.ok(renderBar(0).includes("░".repeat(20)));
  assert.ok(renderBar(100).includes("█".repeat(20)));
  assert.ok(renderBar(50).includes("█".repeat(10)));
  assert.ok(renderBar(150).includes("█".repeat(20))); // clamp high
  assert.ok(renderBar(-5).includes("░".repeat(20))); // clamp low
});

test("windowLabel derives a label from seconds", () => {
  assert.equal(windowLabel(18000), "5h");
  assert.equal(windowLabel(604800), "7d");
  assert.equal(windowLabel(600), "10m");
  assert.equal(windowLabel(0), "window");
});

test("formatDuration formats seconds into human ranges", () => {
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(61), "1m");
  assert.equal(formatDuration(14461), "4h 1m");
  assert.equal(formatDuration(583023), "6d 17h");
});

test("formatResetClock returns HH:MM or empty", () => {
  const d = new Date(1788368570 * 1000);
  const expected = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  assert.equal(formatResetClock(1788368570), expected);
  assert.equal(formatResetClock(null), "");
});

// --- formatCodexUsage ---

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatCodexUsage renders the real sample", () => {
  const u = parseUsageJson(REAL_SAMPLE)!;
  const out = strip(formatCodexUsage(u));
  assert.match(out, /codex-usage/);
  assert.match(out, /plan\s+: plus/);
  assert.match(out, /5h\s+.*\[.*\]\s+99% left/);
  assert.match(out, /7d\s+.*\[.*\]\s+88% left/);
  assert.match(out, /resets in 4h 1m/);
  assert.match(out, /6d 17h/);
});

test("formatCodexUsage warns when rate limit is reached", () => {
  const u = parseUsageJson({
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } },
  })!;
  const out = strip(formatCodexUsage(u));
  assert.match(out, /rate limit reached/);
  assert.match(out, /0% left/);
});

test("formatCodexUsage shows a placeholder when no windows are reported", () => {
  const u = parseUsageJson({ plan_type: "free" })!;
  const out = strip(formatCodexUsage(u));
  assert.match(out, /no rate-limit windows reported/);
});

// --- handleCodexUsage end-to-end (mocked) ---

test("handleCodexUsage reads Kilo's OAuth login and formats usage", async () => {
  let usageAuth: string | undefined;
  const out = await handleCodexUsage({
    authContent: JSON.stringify({
      openai: { type: "oauth", access: "kilo-access", accountId: "account-1" },
    }),
    fetchFn: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      usageAuth = headers?.Authorization;
      return mockFetchOk(REAL_SAMPLE)();
    },
  });
  assert.equal(usageAuth, "Bearer kilo-access");
  assert.match(strip(out), /codex-usage/);
  assert.match(strip(out), /plan\s+: plus/);
});

test("handleCodexUsage throws a friendly message when there is no OAuth login", async () => {
  await assert.rejects(
    handleCodexUsage({
      authContent: JSON.stringify({ openai: { type: "api", key: "sk-test" } }),
      fetchFn: async () => mockFetchOk(REAL_SAMPLE)(),
    }),
    /No Kilo ChatGPT OAuth login found/,
  );
});

test("handleCodexUsage suggests running a kilo turn when the usage fetch fails", async () => {
  await assert.rejects(
    handleCodexUsage({
      authContent: JSON.stringify({
        openai: { type: "oauth", access: "kilo-access", accountId: "account-1" },
      }),
      fetchFn: mockFetchStatus(401, "expired"),
    }),
    /Run any kilo turn so kilo refreshes its access token/,
  );
});
