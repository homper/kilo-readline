import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  parseZaiUsageJson,
  formatZaiUsage,
  formatZaiDate,
  zaiWindowLabel,
  fetchKiloZaiRemaining,
  handleZaiUsage,
  type FetchLike,
} from "../src/zaiUsage.ts";

// Real sample (lightly redacted) from GET /monitor/usage/quota/limit.
const QUOTA_SAMPLE = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 2000,
        currentValue: 0,
        remaining: 2000,
        percentage: 0,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 5920,
        remaining: 4079,
        percentage: 59,
        nextResetTime: 1790950159983,
      },
    ],
    level: "lite",
  },
  success: true,
};

const SUBSCRIPTION_SAMPLE = {
  code: 200,
  data: [
    {
      productName: "GLM Coding Lite",
      status: "VALID",
      billingCycle: "monthly",
      autoRenew: 0,
      nextRenewTime: "2026-10-25",
      valid: "2026-10-25 22:09:20-2026-11-25 22:09:20",
    },
  ],
  success: true,
};

// --- parseZaiUsageJson ---

test("parseZaiUsageJson parses the real sample with both windows + plan name", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, SUBSCRIPTION_SAMPLE)!;
  assert.equal(u.planName, "GLM Coding Lite");
  assert.equal(u.level, "lite");
  assert.equal(u.windows.length, 2);
  const five = u.windows[0];
  assert.equal(five.unit, 3);
  assert.equal(five.number, 5);
  assert.equal(five.usage, 2000);
  assert.equal(five.usedPercent, 0);
  assert.equal(five.nextResetMs, null);
  const weekly = u.windows[1];
  assert.equal(weekly.unit, 6);
  assert.equal(weekly.usedPercent, 59);
  assert.equal(weekly.nextResetMs, 1790950159983);
  assert.equal(u.renewal?.autoRenew, false);
  assert.equal(u.renewal?.nextRenewTime, "2026-10-25");
  assert.equal(u.renewal?.validEnd, "2026-11-25 22:09:20");
});

test("parseZaiUsageJson tolerates a missing subscription envelope", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, undefined)!;
  assert.equal(u.planName, null);
  assert.equal(u.level, "lite");
  assert.equal(u.windows.length, 2);
  assert.equal(u.renewal, null);
});

test("parseZaiUsageJson extracts renewal info when auto-renew is on", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, {
    data: [{ productName: "GLM Coding Pro", autoRenew: 1, nextRenewTime: "2026-11-01", valid: "2026-10-01-2026-11-01" }],
  })!;
  assert.equal(u.renewal?.autoRenew, true);
  assert.equal(u.renewal?.nextRenewTime, "2026-11-01");
  assert.equal(u.renewal?.validEnd, "2026-11-01");
});

test("parseZaiUsageJson tolerates a malformed valid range", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, {
    data: [{ autoRenew: 0, valid: "garbage" }],
  })!;
  assert.equal(u.renewal?.validEnd, null);
  assert.equal(u.renewal?.nextRenewTime, null);
});

test("parseZaiUsageJson returns null when there are no usable windows", () => {
  assert.equal(parseZaiUsageJson({ code: 200, data: { limits: [] } }), null);
  assert.equal(parseZaiUsageJson({}), null);
  assert.equal(parseZaiUsageJson("hi"), null);
});

test("parseZaiUsageJson ignores windows without a percentage", () => {
  const u = parseZaiUsageJson({
    data: {
      level: "pro",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, percentage: 10 },
        { type: "CREDIT_LIMIT", unit: 6 }, // no percentage -> dropped
      ],
    },
  })!;
  assert.equal(u.windows.length, 1);
  assert.equal(u.windows[0].unit, 3);
});

// --- fetchKiloZaiRemaining ---

function mockFetchOk(body: unknown): FetchLike {
  return async () =>
    ({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    }) as unknown as Response;
}

function mockFetchByPath(map: Record<string, unknown>): FetchLike {
  return async (url) => {
    for (const key of Object.keys(map)) {
      if (url.includes(key)) return mockFetchOk(map[key])();
    }
    return mockFetchOk({ code: 200, data: { limits: [] } })();
  };
}

test("fetchKiloZaiRemaining reads the zai-coding-plan key and returns remaining percents", async () => {
  let auth: string | undefined;
  const r = await fetchKiloZaiRemaining({
    authContent: JSON.stringify({
      "zai-coding-plan": { type: "api", key: "zai-secret" },
    }),
    fetchFn: async (url, init) => {
      if (url.includes("/quota/limit")) {
        auth = (init?.headers as Record<string, string>)?.Authorization;
        return mockFetchOk(QUOTA_SAMPLE)();
      }
      return mockFetchOk(SUBSCRIPTION_SAMPLE)();
    },
  });
  assert.equal(auth, "Bearer zai-secret");
  assert.equal(r!.fiveHour, 100);
  assert.equal(r!.weekly, 41); // 100 - 59
});

test("fetchKiloZaiRemaining accepts the zhipuai-coding-plan key alias", async () => {
  const r = await fetchKiloZaiRemaining({
    authContent: JSON.stringify({
      "zhipuai-coding-plan": { type: "api", key: "zhipu-secret" },
    }),
    fetchFn: mockFetchByPath({
      "/quota/limit": QUOTA_SAMPLE,
      "/subscription/list": SUBSCRIPTION_SAMPLE,
    }),
  });
  assert.equal(r!.fiveHour, 100);
  assert.equal(r!.weekly, 41);
});

test("fetchKiloZaiRemaining returns null when there is no API-key login", async () => {
  let fetched = false;
  const r = await fetchKiloZaiRemaining({
    authContent: JSON.stringify({
      "zai-coding-plan": { type: "oauth", access: "not-an-api-key" },
    }),
    fetchFn: async () => {
      fetched = true;
      return mockFetchOk(QUOTA_SAMPLE)();
    },
  });
  assert.equal(r, null);
  assert.equal(fetched, false);
});

test("fetchKiloZaiRemaining returns null when the auth file is missing", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-noauth-"));
  try {
    const r = await fetchKiloZaiRemaining({
      authPath: join(dir, "nope.json"),
      fetchFn: async () => mockFetchOk(QUOTA_SAMPLE)(),
    });
    assert.equal(r, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchKiloZaiRemaining returns null when the response has no windows", async () => {
  const r = await fetchKiloZaiRemaining({
    authContent: JSON.stringify({
      "zai-coding-plan": { type: "api", key: "zai-secret" },
    }),
    fetchFn: mockFetchByPath({
      "/quota/limit": { code: 200, data: { limits: [] } },
      "/subscription/list": SUBSCRIPTION_SAMPLE,
    }),
  });
  assert.equal(r, null);
});

// --- format helpers ---

test("zaiWindowLabel maps unit + number to a span label", () => {
  assert.equal(zaiWindowLabel(3, 5), "5h");
  assert.equal(zaiWindowLabel(6, 1), "7d");
  assert.equal(zaiWindowLabel(4, 2), "2d");
  assert.equal(zaiWindowLabel(5, 1), "mo");
  assert.equal(zaiWindowLabel(0, 0), "window");
});

// --- formatZaiUsage ---

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatZaiUsage renders the real sample", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, SUBSCRIPTION_SAMPLE)!;
  const out = strip(formatZaiUsage(u));
  assert.match(out, /zai-balance/);
  assert.match(out, /plan\s+: GLM Coding Lite \(lite\)/);
  assert.match(out, /5h\s+.*\[.*\]\s+100% left/);
  assert.match(out, /7d\s+.*\[.*\]\s+41% left/);
  assert.match(out, /credits/);
});

test("formatZaiUsage shows the end date when auto-renew is off", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, SUBSCRIPTION_SAMPLE)!;
  const out = strip(formatZaiUsage(u));
  assert.match(out, /ends\s+: Nov 25( \d{4})? \(auto-renew off\)/);
});

test("formatZaiUsage shows the renewal date when auto-renew is on", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, {
    data: [{ productName: "GLM Coding Pro", autoRenew: 1, nextRenewTime: "2026-11-01" }],
  })!;
  const out = strip(formatZaiUsage(u));
  assert.match(out, /renews\s+: Nov 1( \d{4})?/);
});

test("formatZaiUsage omits the renewal line when there is no date", () => {
  const u = parseZaiUsageJson(QUOTA_SAMPLE, {
    data: [{ productName: "GLM Coding Lite" }],
  })!;
  const out = strip(formatZaiUsage(u));
  assert.doesNotMatch(out, /renews|ends/);
});

test("formatZaiDate renders month + day, adding the year when it differs", () => {
  const nowYear = new Date().getFullYear();
  assert.match(formatZaiDate(`${nowYear}-10-25`), /^Oct 25$/);
  assert.match(formatZaiDate(`${nowYear}-10-25 22:09:20`), /^Oct 25$/);
  assert.equal(formatZaiDate(`${nowYear + 1}-01-02`), `Jan 2 ${nowYear + 1}`);
  assert.equal(formatZaiDate("garbage"), "garbage");
});

test("formatZaiUsage shows a placeholder when no windows are reported", () => {
  const out = strip(
    formatZaiUsage({ planName: null, level: null, windows: [], renewal: null }),
  );
  assert.match(out, /no usage windows reported/);
});

// --- handleZaiUsage end-to-end (mocked) ---

test("handleZaiUsage reads Kilo's API key and formats usage", async () => {
  let auth: string | undefined;
  const out = await handleZaiUsage({
    authContent: JSON.stringify({
      "zai-coding-plan": { type: "api", key: "zai-secret" },
    }),
    fetchFn: async (url, init) => {
      if (url.includes("/quota/limit")) {
        auth = (init?.headers as Record<string, string>)?.Authorization;
        return mockFetchOk(QUOTA_SAMPLE)();
      }
      return mockFetchOk(SUBSCRIPTION_SAMPLE)();
    },
  });
  assert.equal(auth, "Bearer zai-secret");
  assert.match(strip(out), /zai-balance/);
  assert.match(strip(out), /plan\s+: GLM Coding Lite \(lite\)/);
});

test("handleZaiUsage throws a friendly message when there is no API-key login", async () => {
  await assert.rejects(
    handleZaiUsage({
      authContent: JSON.stringify({ "zai-coding-plan": { type: "oauth", access: "x" } }),
      fetchFn: async () => mockFetchOk(QUOTA_SAMPLE)(),
    }),
    /No Kilo Z\.AI Coding Plan API key found/,
  );
});

test("handleZaiUsage surfaces a fetch failure without retry advice", async () => {
  await assert.rejects(
    handleZaiUsage({
      authContent: JSON.stringify({
        "zai-coding-plan": { type: "api", key: "zai-secret" },
      }),
      fetchFn: async () =>
        ({
          ok: false,
          status: 401,
          text: () => Promise.resolve("invalid"),
          json: () => Promise.resolve({}),
        }) as unknown as Response,
    }),
    /usage fetch failed \(401\)/,
  );
});
