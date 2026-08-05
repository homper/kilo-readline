import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  parsePrepaidBalance,
  parseKiloPassState,
  readKiloAccessToken,
  isFreeModelId,
  kiloDbPath,
  usd,
  fmtTokens,
  formatKiloBalance,
  formatKiloSessions,
  formatKiloGatewayRequests,
  readKiloSessions,
  readKiloGatewayRequests,
  readKiloCachedTokens,
  handleKiloSessions,
  handleKiloGatewayRequests,
  KILO_PAGE_SIZE,
  type KiloSession,
  type KiloGatewayRequest,
} from "../src/kiloBalance.ts";

// --- parsePrepaidBalance ---

test("parsePrepaidBalance parses balance and isDepleted", () => {
  const b = parsePrepaidBalance({ balance: 17.553412, isDepleted: false })!;
  assert.equal(b.balance, 17.553412);
  assert.equal(b.isDepleted, false);
  const d = parsePrepaidBalance({ balance: 0, isDepleted: true })!;
  assert.equal(d.isDepleted, true);
});

test("parsePrepaidBalance coerces a missing isDepleted to false", () => {
  const b = parsePrepaidBalance({ balance: 1 })!;
  assert.equal(b.isDepleted, false);
});

test("parsePrepaidBalance returns null when balance is absent or not an object", () => {
  assert.equal(parsePrepaidBalance(null), null);
  assert.equal(parsePrepaidBalance({}), null);
  assert.equal(parsePrepaidBalance("x"), null);
});

// --- parseKiloPassState: the live tRPC envelope (result.data.subscription) ---

test("parseKiloPassState parses the live envelope with subscription figures", () => {
  const value = [
    {
      result: {
        data: {
          subscription: {
            tier: "tier_19",
            cadence: "monthly",
            currentPeriodBaseCreditsUsd: 19,
            currentPeriodBonusCreditsUsd: 9.5,
            currentPeriodUsageUsd: 1.94,
            nextBillingAt: "2026-10-22T15:16:50.000Z",
            isBonusUnlocked: false,
            currentPeriodBonus: { status: "available", projectedAmountUsd: 9.5 },
          },
        },
      },
    },
  ];
  const p = parseKiloPassState(value)!;
  assert.equal(p.baseCreditsUsd, 19);
  assert.equal(p.bonusCreditsUsd, 9.5);
  assert.equal(p.usageUsd, 1.94);
  assert.equal(p.tier, "tier_19");
  assert.equal(p.cadence, "monthly");
  assert.equal(p.nextBillingAt, "2026-10-22T15:16:50.000Z");
  assert.equal(p.bonusUnlocked, false);
  assert.equal(p.bonusStatus, "available");
});

test("parseKiloPassState tolerates the data.json nesting path", () => {
  const p = parseKiloPassState({
    result: { data: { json: { subscription: { currentPeriodBaseCreditsUsd: 5, currentPeriodUsageUsd: 1, nextRenewalAt: "2026-11-01T00:00:00.000Z" } } } },
  })!;
  assert.equal(p.baseCreditsUsd, 5);
  assert.equal(p.usageUsd, 1);
  assert.equal(p.nextBillingAt, "2026-11-01T00:00:00.000Z");
});

test("parseKiloPassState returns null without a subscription or figures", () => {
  assert.equal(parseKiloPassState([{ result: { data: {} } }]), null);
  assert.equal(parseKiloPassState([{ result: { data: { subscription: {} } } }]), null);
  assert.equal(parseKiloPassState(null), null);
});

// --- readKiloAccessToken ---

test("readKiloAccessToken reads the oauth kilo access token", () => {
  const tok = readKiloAccessToken({
    authContent: JSON.stringify({ kilo: { type: "oauth", access: "abc", refresh: "r" } }),
  });
  assert.equal(tok, "abc");
});

test("readKiloAccessToken returns null for non-oauth or missing kilo sections", () => {
  assert.equal(
    readKiloAccessToken({ authContent: JSON.stringify({ kilo: { type: "api", key: "k" } }) }),
    null,
  );
  assert.equal(readKiloAccessToken({ authContent: JSON.stringify({ openai: {} }) }), null);
});

test("readKiloAccessToken returns null for an unparseable / missing file", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-auth-"));
  try {
    assert.equal(readKiloAccessToken({ authPath: join(dir, "nope.json") }), null);
    fs.writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readKiloAccessToken({ authPath: join(dir, "bad.json") }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloAccessToken honors the KILO_AUTH_CONTENT env override", () => {
  const tok = readKiloAccessToken({
    authContent: JSON.stringify({ kilo: { type: "oauth", access: "envtok" } }),
  });
  assert.equal(tok, "envtok");
});

// --- isFreeModelId ---

test("isFreeModelId flags /free and :free suffixes only", () => {
  assert.equal(isFreeModelId("kilo-auto/free"), true);
  assert.equal(isFreeModelId("stepfun/step-3.7-flash:free"), true);
  assert.equal(isFreeModelId("z-ai/glm-5.2"), false);
  assert.equal(isFreeModelId("deepseek/deepseek-v4-pro:discounted"), false);
  assert.equal(isFreeModelId("stealth/claude-sonnet-4.6"), false);
});

// --- kiloDbPath ---

test("kiloDbPath honors an absolute KILO_DB override", () => {
  assert.equal(kiloDbPath({ ...process.env, KILO_DB: "/custom/dir/kilo.db" }), "/custom/dir/kilo.db");
});

test("kiloDbPath keeps :memory: from being treated as a path and falls back to default", () => {
  // :memory: is not a usable on-disk path here, so the resolver must not join
  // it into the data dir; with no kilo.db present it scans then returns default.
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "kilo-db-"));
  try {
    const p = kiloDbPath({ XDG_DATA_HOME: tmp, KILO_DB: undefined });
    assert.equal(p, join(tmp, "kilo", "kilo.db"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kiloDbPath scans for a channel-suffixed db when kilo.db is absent", async () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "kilo-db-"));
  try {
    const dir = join(tmp, "kilo");
    fs.mkdirSync(dir, { recursive: true });
    const newer = join(dir, "kilo-beta.db");
    const older = join(dir, "kilo-dev.db");
    fs.writeFileSync(newer, "");
    // make `older` older so the mtime sort picks `newer`
    const past = new Date(Date.now() - 100000);
    fs.writeFileSync(older, "");
    fs.utimesSync(older, past, past);
    // No kilo.db present → should pick the newest kilo-*.db
    const got = kiloDbPath({ XDG_DATA_HOME: tmp, KILO_DB: undefined });
    assert.equal(got, newer);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kiloDbPath prefers an existing kilo.db over a channel-suffixed one", () => {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "kilo-db-"));
  try {
    const dir = join(tmp, "kilo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "kilo.db"), "");
    fs.writeFileSync(join(dir, "kilo-beta.db"), "");
    assert.equal(kiloDbPath({ XDG_DATA_HOME: tmp, KILO_DB: undefined }), join(dir, "kilo.db"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- format helpers ---

test("usd formats to two decimals with a dollar sign", () => {
  assert.equal(usd(17.5), "$17.50");
  assert.equal(usd(0), "$0.00");
});

test("fmtTokens shortens large token counts", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1500), "1.5K");
  assert.equal(fmtTokens(2_000_000), "2.00M");
});

// --- formatKiloBalance ---

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatKiloBalance renders prepaid and Kilo Pass with remaining + reset", () => {
  const out = strip(
    formatKiloBalance(
      { balance: 17.55, isDepleted: false },
      {
        baseCreditsUsd: 19,
        bonusCreditsUsd: 9.5,
        usageUsd: 1.94,
        nextBillingAt: "2026-10-22T15:16:50.000Z",
        tier: "tier_19",
        cadence: "monthly",
        bonusUnlocked: false,
        bonusStatus: "available",
      },
    ),
  );
  assert.match(out, /kilo-gateway-balance/);
  assert.match(out, /Prepaid credits\s+\$17\.55/);
  assert.match(out, /Kilo Pass/);
  assert.match(out, /tier_19 · monthly/);
  assert.match(out, /included credits\s+\$19\.00/);
  assert.match(out, /bonus credits\s+\$9\.50/);
  assert.match(out, /projected — available to unlock/);
  assert.match(out, /used this period\s+\$1\.94/);
  // remaining = base + bonus - usage = 26.56
  assert.match(out, /remaining\s+\$26\.56/);
  assert.match(out, /resets\s+2026-10-22/);
});

test("formatKiloBalance flags a depleted prepaid balance", () => {
  const out = strip(formatKiloBalance({ balance: 0, isDepleted: true }, null));
  assert.match(out, /\$0\.00.*\(depleted\)/);
  assert.doesNotMatch(out, /Kilo Pass/);
});

test("formatKiloBalance shows a placeholder when neither is available", () => {
  const out = strip(formatKiloBalance(null, null));
  assert.match(out, /no Kilo Gateway account data available/);
});

// --- readKiloSessions / readKiloGatewayRequests against a temp kilo.db ---

// Build a minimal session table matching the columns the reader queries.
async function buildTempDb(dir: string, rows: Omit<KiloSession, "free">[]): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session (
       id TEXT PRIMARY KEY,
       time_created INTEGER,
       title TEXT,
       cost REAL,
       tokens_input INTEGER,
       tokens_output INTEGER,
       tokens_cache_read INTEGER,
       model TEXT
     )`,
  );
  const ins = db.prepare(
    `INSERT INTO session (id, time_created, title, cost, tokens_input, tokens_output, tokens_cache_read, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    ins.run(
      r.sessionId,
      r.timeCreated,
      r.title,
      r.cost,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      JSON.stringify({ providerID: r.provider, id: r.modelId }),
    );
  }
  db.close();
  return dbPath;
}

// Build a minimal message + session pair of tables matching the columns the
// per-request reader queries (data JSON holds role/cost/tokens/provider).
async function buildMessagesDb(dir: string, msgs: KiloGatewayRequest[]): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
     CREATE TABLE message (
       id TEXT PRIMARY KEY,
       session_id TEXT,
       time_created INTEGER,
       time_updated INTEGER,
       data TEXT
     )`,
  );
  const insSes = db.prepare(`INSERT INTO session (id, title) VALUES (?, ?)`);
  const titles = new Map<string, string>();
  for (const m of msgs) {
    if (m.title && !titles.has(m.sessionId)) titles.set(m.sessionId, m.title);
  }
  for (const [sid, title] of titles) insSes.run(sid, title);
  const ins = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const m of msgs) {
    ins.run(
      m.messageId,
      m.sessionId,
      m.timeCreated,
      m.timeCreated,
      JSON.stringify({
        role: "assistant",
        providerID: m.provider,
        modelID: m.modelId,
        cost: m.cost,
        tokens: {
          input: m.inputTokens,
          output: m.outputTokens,
          cache: { read: m.cacheReadTokens, write: 0 },
        },
      }),
    );
  }
  db.close();
  return dbPath;
}

function seedRows(): Omit<KiloSession, "free">[] {
  return [
    // non-free kilo — should appear (not greyed)
    { sessionId: "s1", timeCreated: 3000, title: "GLM work", cost: 1.5, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, provider: "kilo", modelId: "z-ai/glm-5.2" },
    // free kilo-auto /free — included, flagged free
    { sessionId: "s2", timeCreated: 2000, title: "free auto", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, provider: "kilo-auto", modelId: "kilo-auto/free" },
    // free kilo :free — included, flagged free
    { sessionId: "s3", timeCreated: 4000, title: "free flash", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, provider: "kilo", modelId: "stepfun/step-3.7-flash:free" },
    // non-kilo provider — included
    { sessionId: "s4", timeCreated: 5000, title: "openrouter", cost: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, provider: "openrouter", modelId: "z-ai/glm-5.2" },
    // non-free kilo-auto :discounted — included (newest)
    { sessionId: "s5", timeCreated: 6000, title: "discounted deepseek", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, provider: "kilo-auto", modelId: "deepseek/deepseek-v4-pro:discounted" },
    // a session with a NULL model column — excluded (covered by a dedicated
    // test below); not added here so the model IS NOT NULL filter is the only
    // thing dropping it.
  ];
}

test("readKiloSessions includes all providers and flags free sessions, newest first", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const dbPath = await buildTempDb(dir, seedRows());
    const got = readKiloSessions(0, { dbPath });
    assert.deepEqual(
      got.map((r) => [r.sessionId, r.free]),
      [
        ["s5", false],
        ["s4", false],
        ["s3", true],
        ["s1", false],
        ["s2", true],
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloSessions excludes a session whose model column is NULL", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(dir, "kilo.db");
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, title TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, model TEXT)`,
    );
    db.prepare(
      `INSERT INTO session (id, time_created, title, cost, tokens_input, tokens_output, tokens_cache_read, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sNull", 9000, "no model", 0, 0, 0, 0, null);
    db.close();
    const got = readKiloSessions(0, { dbPath });
    assert.equal(got.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloSessions pages with OFFSET = page * KILO_PAGE_SIZE", async () => {
  assert.equal(KILO_PAGE_SIZE, 10);
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    // 12 rows → page 0 has 10, page 1 has 2, page 2 empty.
    const rows: Omit<KiloSession, "free">[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push({
        sessionId: `p${i}`,
        timeCreated: 1000 + i,
        title: `row ${i}`,
        cost: i / 10,
        inputTokens: i,
        outputTokens: 0,
        cacheReadTokens: 0,
        provider: "kilo",
        modelId: "z-ai/glm-5.2",
      });
    }
    const dbPath = await buildTempDb(dir, rows);
    const page0 = readKiloSessions(0, { dbPath });
    const page1 = readKiloSessions(1, { dbPath });
    const page2 = readKiloSessions(2, { dbPath });
    assert.equal(page0.length, 10);
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 0);
    // newest first: page0[0] is the highest time_created = p11
    assert.equal(page0[0].sessionId, "p11");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloSessions returns [] for a db with no session table", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = join(dir, "kilo.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();
    const got = readKiloSessions(0, { dbPath });
    assert.deepEqual(got, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloSessions throws a friendly error when the db file is missing", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    assert.throws(
      () => readKiloSessions(0, { dbPath: join(dir, "does-not-exist.db") }),
      /Could not open kilo CLI database/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedRequests(): KiloGatewayRequest[] {
  const mk = (id: string, sessionId: string, t: number, provider: string, modelId: string, cost: number, i: number, o: number, cache: number, title = ""): KiloGatewayRequest => ({
    messageId: id,
    sessionId,
    timeCreated: t,
    title,
    cost,
    inputTokens: i,
    outputTokens: o,
    cacheReadTokens: cache,
    provider,
    modelId,
  });
  return [
    // non-free kilo request — included (newest)
    mk("m1", "ses_a", 5000, "kilo", "z-ai/glm-5.2", 0.01, 4570, 157, 36864, "Session A"),
    // free :free kilo request — excluded
    mk("m2", "ses_b", 4000, "kilo", "stepfun/step-3.7-flash:free", 0, 100, 10, 1000),
    // free /free kilo-auto request — excluded
    mk("m3", "ses_b", 3000, "kilo-auto", "kilo-auto/free", 0, 100, 10, 1000),
    // non-kilo provider request — excluded
    mk("m4", "ses_c", 2000, "openrouter", "z-ai/glm-5.2", 0.02, 2000, 200, 2000, "Session C"),
    // non-free kilo-auto :discounted request — included
    mk("m5", "ses_b", 1000, "kilo-auto", "deepseek/deepseek-v4-pro:discounted", 0.003, 300, 30, 3000, "Session B"),
  ];
}

test("readKiloGatewayRequests lists per-request rows with title, cost, and cached tokens, newest first", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    const dbPath = await buildMessagesDb(dir, seedRequests());
    const got = readKiloGatewayRequests(0, { dbPath });
    assert.deepEqual(
      got.map((r) => r.messageId),
      ["m1", "m5"],
    );
    assert.equal(got[0].sessionId, "ses_a");
    assert.equal(got[0].title, "Session A");
    assert.equal(got[0].cost, 0.01);
    assert.equal(got[0].inputTokens, 4570);
    assert.equal(got[0].outputTokens, 157);
    assert.equal(got[0].cacheReadTokens, 36864);
    assert.equal(got[1].title, "Session B");
    assert.equal(got[1].cacheReadTokens, 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloGatewayRequests pages with OFFSET = page * KILO_PAGE_SIZE", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    const msgs: KiloGatewayRequest[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({
        messageId: `r${i}`,
        sessionId: "ses_p",
        timeCreated: 1000 + i,
        title: `req ${i}`,
        cost: i / 100,
        inputTokens: i,
        outputTokens: 0,
        cacheReadTokens: i * 10,
        provider: "kilo",
        modelId: "z-ai/glm-5.2",
      });
    }
    const dbPath = await buildMessagesDb(dir, msgs);
    const page0 = readKiloGatewayRequests(0, { dbPath });
    const page1 = readKiloGatewayRequests(1, { dbPath });
    const page2 = readKiloGatewayRequests(2, { dbPath });
    assert.equal(page0.length, 10);
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 0);
    assert.equal(page0[0].messageId, "r11");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloGatewayRequests returns [] for a db with no message table", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    const dbPath = await buildTempDb(dir, seedRows());
    assert.deepEqual(readKiloGatewayRequests(0, { dbPath }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloGatewayRequests throws a friendly error when the db file is missing", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    assert.throws(
      () => readKiloGatewayRequests(0, { dbPath: join(dir, "does-not-exist.db") }),
      /Could not open kilo CLI database/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloCachedTokens sums cached reads per session from assistant messages", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-cache-"));
  try {
    const msgs: KiloGatewayRequest[] = [
      { messageId: "a1", sessionId: "ses_x", timeCreated: 100, title: "X", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, provider: "kilo", modelId: "z-ai/glm-5.2" },
      { messageId: "a2", sessionId: "ses_x", timeCreated: 200, title: "X", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, provider: "kilo", modelId: "z-ai/glm-5.2" },
      { messageId: "a3", sessionId: "ses_y", timeCreated: 300, title: "Y", cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 250, provider: "kilo", modelId: "z-ai/glm-5.2" },
    ];
    const dbPath = await buildMessagesDb(dir, msgs);
    const got = readKiloCachedTokens(["ses_x", "ses_y", "ses_missing"], { dbPath });
    assert.equal(got.get("ses_x"), 1500);
    assert.equal(got.get("ses_y"), 250);
    assert.equal(got.has("ses_missing"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readKiloCachedTokens is best-effort: empty map for a missing db or no ids", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-cache-"));
  try {
    assert.deepEqual(readKiloCachedTokens(["ses_x"], { dbPath: join(dir, "nope.db") }), new Map());
    assert.deepEqual(readKiloCachedTokens([], { dbPath: join(dir, "nope.db") }), new Map());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatKiloSessions shows session id and provider and greys out free models only", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const dbPath = await buildTempDb(dir, seedRows());
    const entries = readKiloSessions(0, { dbPath });
    const raw = formatKiloSessions(entries);
    const out = strip(raw);
    // header line + footer notes are dim (\x1b[2m), not gray; the two free
    // rows (s3 :free and s2 /free) must be the only gray-wrapped rows.
    const freeRows = raw.split("\n").filter((l) => /step-3\.7-flash:free|kilo-auto\/free/.test(l));
    assert.equal(freeRows.length, 2);
    for (const l of freeRows) assert.ok(l.includes("\x1b[90m"), `free row not greyed: ${l}`);
    const paidRows = raw.split("\n").filter((l) => /z-ai\/glm-5\.2|deepseek-v4-pro:discounted/.test(l));
    for (const l of paidRows) assert.ok(!l.includes("\x1b[90m"), `paid row greyed: ${l}`);
    assert.match(out, /date\s+session id\s+provider\s+model/);
    assert.match(out, /s4\s+openrouter\s+z-ai\/glm-5\.2/);
    assert.ok(out.includes("free-model sessions are greyed out"));
    assert.ok(!out.includes("non-Kilo providers are filtered out"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleKiloSessions renders a range line and the source db path", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const dbPath = await buildTempDb(dir, seedRows());
    const out = strip(handleKiloSessions(0, { dbPath }));
    assert.match(out, /sessions/);
    assert.match(out, /offset 0 · sessions 1-5 by recency \(page 0\)/);
    assert.match(out, /source: /);
    // Sessions from each provider appear with their ids and model names.
    assert.match(out, /s4\s+openrouter\s+z-ai\/glm-5\.2/);
    assert.match(out, /deepseek\/deepseek-v4-pro:discounted/);
    assert.match(out, /z-ai\/glm-5\.2/);
    assert.match(out, /kilo-auto\/free/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleKiloSessions empty page renders a no-sessions note", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-log-"));
  try {
    const dbPath = await buildTempDb(dir, seedRows());
    const out = strip(handleKiloSessions(5, { dbPath }));
    assert.match(out, /offset 50 · no sessions on this page/);
    assert.match(out, /no sessions found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleKiloGatewayRequests renders a request range line and the filtered-out note", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    const dbPath = await buildMessagesDb(dir, seedRequests());
    const out = strip(handleKiloGatewayRequests(0, { dbPath }));
    assert.match(out, /kilo-gateway-logs/);
    assert.match(out, /individual requests through the Kilo Gateway/);
    assert.match(out, /offset 0 · requests 1-2 by recency \(page 0\)/);
    assert.match(out, /free models and non-Kilo providers are filtered out/);
    assert.match(out, /z-ai\/glm-5\.2/);
    assert.match(out, /Session A/);
    assert.doesNotMatch(out, /stepfun\/step-3\.7-flash:free/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handleKiloGatewayRequests empty page renders a no-requests note", async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "kilo-req-"));
  try {
    const dbPath = await buildMessagesDb(dir, seedRequests());
    const out = strip(handleKiloGatewayRequests(5, { dbPath }));
    assert.match(out, /offset 50 · no requests on this page/);
    assert.match(out, /no non-free Kilo Gateway requests found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
