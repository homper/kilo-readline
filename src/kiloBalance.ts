// Kilo Gateway account balance and usage reporting.
//
// Reads Kilo's own login in ~/.local/share/kilo/auth.json (the `kilo` section,
// type "oauth", with an `access` token) and calls the Kilo Gateway API at
// https://api.kilo.ai (overridable via KILO_API_URL):
//
//   GET /api/profile/balance            → { balance: <USD float>, isDepleted }
//     Prepaid pay-as-you-go credits. Separate from Kilo Pass.
//
//   GET /api/trpc/kiloPass.getState?batch=1&input={"0":null}
//     → [{ result: { data: { subscription: { currentPeriodBaseCreditsUsd,
//        currentPeriodBonusCreditsUsd, currentPeriodUsageUsd, nextBillingAt, ... } } } }]
//     Kilo Pass subscription credits for the current billing period. The bonus
//     credits are the free bonus the user asked about; usage is metered against
//     base + bonus, and the period resets at nextBillingAt.
//
// /kilo-gateway-logs and /sessions do NOT hit the network. Kilo's only usage
// API is daily aggregates (no per-request log endpoint); per-request detail
// lives on the web at app.kilo.ai/usage. Instead, both read kilo CLI's own
// local SQLite database (~/.local/share/kilo/kilo.db, WAL mode — safe to open
// read-only alongside the running kilo process):
//
//   /kilo-gateway-logs lists the most recent individual requests (assistant
//   messages from the `message` table) routed through the Kilo Gateway
//   provider (providerID "kilo" or "kilo-auto", model id not ending in
//   /free or :free). Each message row carries its own cost (USD), token
//   usage (input/output/cache-read), model, and session id, so this
//   reconstructs the per-request spend log the gateway API can't provide.
//
//   /sessions lists the most recent sessions across all providers (the
//   `session` table, aggregate per-session cost/tokens), including free-model
//   sessions — those are rendered greyed out. The arg for both is a page
//   index; offset = arg * KILO_PAGE_SIZE (10) rows, newest first.
//
// readKiloCachedTokens supplements /status with per-session cached-token
// totals summed from the `message` table (the ACP usage_update notification
// only reports used = input + cache.read, with no cache split), best-effort.
//
// Notes on retention: the kilo CLI stores sessions indefinitely in kilo.db
// — there is no age-based purge. The session row has a time_archived field
// (set explicitly, e.g. on manual archive), but no background job deletes
// old rows, so the local log spans the entire history of the install. The
// DB grows unbounded (WAL journal alongside); pruning is manual if needed.
//
// Like codexUsage.ts, the balance fetches in this module NEVER refresh the
// token themselves: the kilo acp child process owns token rotation, and
// touching the one-time-use refresh_token here would race it. If the access
// token is expired, re-run a `kilo` login / a kilo turn that uses the kilo
// provider so it refreshes, then retry.

import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { join, isAbsolute } from "node:path";

const DEFAULT_KILO_API_URL = "https://api.kilo.ai";
const NETWORK_TIMEOUT_MS = 12_000;

// Page size for /kilo-gateway-logs and /sessions: each page lists 10 rows
// (requests / sessions) from the local kilo.db, newest first. The CLI arg is
// a page index; the SQL offset is arg * KILO_PAGE_SIZE.
export const KILO_PAGE_SIZE = 10;

// ANSI colors, mirroring the C map in index.ts so this renders the same.
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

// The auth file is the same one codexUsage.ts reads; reuse its path resolver so
// the resolution (and any future XDG tweak) stays in one place. Resolved to
// $XDG_DATA_HOME/kilo/auth.json else ~/.local/share/kilo/auth.json.
export function kiloAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  return join(dataHome, "kilo", "auth.json");
}

function kiloApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.KILO_API_URL || DEFAULT_KILO_API_URL;
}

// --- parsing helpers (pure, exported for tests) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Plain (non-guard) accessor that recurses one level, or returns undefined.
// Used to walk the tRPC envelope without fighting the type-guard return type.
function rec(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export type KiloPassState = {
  baseCreditsUsd: number;
  bonusCreditsUsd: number;
  usageUsd: number;
  nextBillingAt: string | null;
  tier: string | null;
  cadence: string | null;
  bonusUnlocked: boolean | null;
  bonusStatus: string | null;
};

// Mirrors @kilocode/kilo-gateway's parseKiloPassState, navigating the tRPC
// envelope. The live response nests subscription directly under
// result.data (data.json is absent), but we tolerate the data.json path too.
export function parseKiloPassState(value: unknown): KiloPassState | null {
  const item: unknown = Array.isArray(value) ? value[0] : value;
  const result = rec(rec(item)?.result);
  const data = rec(result?.data);
  const root = rec(data?.json) ?? data ?? rec(value);
  const sub = rec(root?.subscription);
  if (!sub) return null;
  const hasFigures =
    sub.currentPeriodBaseCreditsUsd != null || sub.currentPeriodUsageUsd != null;
  if (!hasFigures) return null;

  const next = sub.nextBillingAt ?? sub.nextRenewalAt;
  const bonus = isRecord(sub.currentPeriodBonus) ? sub.currentPeriodBonus : undefined;
  return {
    baseCreditsUsd: num(sub.currentPeriodBaseCreditsUsd),
    bonusCreditsUsd: num(sub.currentPeriodBonusCreditsUsd),
    usageUsd: num(sub.currentPeriodUsageUsd),
    nextBillingAt: typeof next === "string" ? next : null,
    tier: typeof sub.tier === "string" ? sub.tier : null,
    cadence: typeof sub.cadence === "string" ? sub.cadence : null,
    bonusUnlocked: typeof sub.isBonusUnlocked === "boolean" ? sub.isBonusUnlocked : null,
    bonusStatus: typeof bonus?.status === "string" ? bonus.status : null,
  };
}

export type PrepaidBalance = { balance: number; isDepleted: boolean };

export function parsePrepaidBalance(value: unknown): PrepaidBalance | null {
  if (!isRecord(value)) return null;
  if (value.balance == null) return null;
  return {
    balance: num(value.balance),
    isDepleted: value.isDepleted === true,
  };
}

// --- token read ---

export type KiloTokenOptions = {
  authPath?: string;
  authContent?: string;
};

// Read the Kilo Gateway access token from the oauth `kilo` section of
// auth.json. Returns null for a missing/malformed file or a non-oauth login
// (the kilo provider authenticates via OAuth, so a non-oauth entry can't be
// used for these user-scoped endpoints).
export function readKiloAccessToken(opts: KiloTokenOptions = {}): string | null {
  let raw = opts.authContent;
  if (raw === undefined && opts.authPath === undefined) {
    raw = process.env.KILO_AUTH_CONTENT;
  }
  if (!raw) {
    try {
      raw = fs.readFileSync(opts.authPath ?? kiloAuthPath(), "utf8");
    } catch {
      return null;
    }
  }
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const auth = all.kilo;
  if (!auth || typeof auth !== "object") return null;
  const oauth = auth as Record<string, unknown>;
  if (oauth.type !== "oauth" || typeof oauth.access !== "string") return null;
  return oauth.access;
}

// --- fetch ---

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function globalFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal })
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        throw new Error(`request to ${url} timed out after ${NETWORK_TIMEOUT_MS}ms`);
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

export async function fetchPrepaidBalance(
  token: string,
  opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<PrepaidBalance | null> {
  const base = kiloApiBase(opts.env);
  const res = await (opts.fetchFn ?? globalFetch)(`${base}/api/profile/balance`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`balance fetch failed (${res.status}): ${await safeText(res)}`);
  }
  return parsePrepaidBalance(await res.json());
}

export async function fetchKiloPassState(
  token: string,
  opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<KiloPassState | null> {
  const base = kiloApiBase(opts.env);
  const params = new URLSearchParams({ batch: "1", input: JSON.stringify({ "0": null }) });
  const res = await (opts.fetchFn ?? globalFetch)(
    `${base}/api/trpc/kiloPass.getState?${params}`,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`kilo pass fetch failed (${res.status}): ${await safeText(res)}`);
  }
  return parseKiloPassState(await res.json());
}

// --- format helpers (pure, exported for tests) ---

export function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function dateOnly(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatKiloBalance(prepaid: PrepaidBalance | null, pass: KiloPassState | null): string {
  const lines: string[] = [];
  lines.push(`${C.bold}kilo-gateway-balance${C.reset}`);

  if (prepaid) {
    const depleted = prepaid.isDepleted ? `  ${C.red}(depleted)${C.reset}` : "";
    lines.push(`  ${C.dim}Prepaid credits${C.reset}  ${usd(prepaid.balance)}${depleted}`);
  }

  if (pass) {
    const headerBits: string[] = [];
    if (pass.tier) headerBits.push(pass.tier);
    if (pass.cadence) headerBits.push(pass.cadence);
    const header = headerBits.length > 0 ? `  ${C.dim}${headerBits.join(" · ")}${C.reset}` : "";
    lines.push(`  ${C.bold}Kilo Pass${C.reset}${header}`);
    lines.push(`    ${C.dim}included credits${C.reset}  ${usd(pass.baseCreditsUsd)}`);
    let bonusLine = `    ${C.dim}bonus credits${C.reset}     ${usd(pass.bonusCreditsUsd)}`;
    // Annotate the free bonus with its unlock/projection status so the user
    // can tell a not-yet-unlocked (projected) bonus from a live one. The
    // "available" status and the unlock note both say "available", so drop the
    // redundant standalone status when the unlock note already covers it.
    const bits: string[] = [];
    const unlock = pass.bonusUnlocked === false ? "projected — available to unlock" : null;
    if (pass.bonusStatus && !(unlock && pass.bonusStatus === "available")) bits.push(pass.bonusStatus);
    if (unlock) bits.push(unlock);
    if (bits.length > 0) bonusLine += `  ${C.dim}(${bits.join("; ")})${C.reset}`;
    lines.push(bonusLine);
    lines.push(`    ${C.dim}used this period${C.reset}  ${usd(pass.usageUsd)}`);
    const remaining = Math.max(0, pass.baseCreditsUsd + pass.bonusCreditsUsd - pass.usageUsd);
    lines.push(`    ${C.dim}remaining${C.reset}         ${usd(remaining)}`);
    if (pass.nextBillingAt) {
      lines.push(`    ${C.dim}resets${C.reset}            ${dateOnly(pass.nextBillingAt)}`);
    }
  }

  if (!prepaid && !pass) {
    lines.push(`  ${C.dim}(no Kilo Gateway account data available)${C.reset}`);
  }

  lines.push(`  ${C.dim}per-request detail: https://app.kilo.ai/usage${C.reset}`);
  return lines.join("\n");
}

// --- local kilo.db logs ---

// One row from the kilo CLI's session table. `cost` is USD (kilo stores
// per-session aggregate cost as a real dollar figure, not micro-USD). `free`
// mirrors the model-id suffix check client-side.
export type KiloSession = {
  sessionId: string;
  timeCreated: number; // epoch ms
  title: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  provider: string;
  modelId: string;
  free: boolean;
};

// One individual request: an assistant message row from the kilo CLI's
// message table, filtered to non-free Kilo Gateway models. Carries the
// per-request cost (USD) and token usage the session aggregate is built from.
export type KiloGatewayRequest = {
  messageId: string;
  sessionId: string;
  timeCreated: number; // epoch ms
  title: string; // session title, "" when unknown
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  provider: string;
  modelId: string;
};

// Resolve the kilo CLI's SQLite database path the same way the CLI does
// (Global.Path.data + "kilo.db"), honoring KILO_DB. For dev channels the CLI
// may use kilo-<channel>.db (falling back to opencode-<channel>.db); if the
// default kilo.db is missing, scan the data dir for the most recently
// modified kilo-*.db / opencode-*.db so the log commands still find local history.
export function kiloDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  const dataDir = join(dataHome, "kilo");
  if (env.KILO_DB && env.KILO_DB !== ":memory:" && isAbsolute(env.KILO_DB)) {
    return env.KILO_DB;
  }
  if (env.KILO_DB && env.KILO_DB !== ":memory:") {
    return join(dataDir, env.KILO_DB);
  }
  const def = join(dataDir, "kilo.db");
  try {
    if (fs.existsSync(def)) return def;
  } catch {
    /* fall through to scan */
  }
  let candidates: string[] = [];
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (/^(kilo|opencode)-.+\.db$/.test(name) && name !== "kilo.db") {
        candidates.push(join(dataDir, name));
      }
    }
  } catch {
    /* ignore */
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return candidates[0];
  }
  // Nothing found; return the default path so the open error names kilo.db.
  return def;
}

// Kilo marks free models with a trailing "/free" (e.g. kilo-auto/free) or
// ":free" (OpenRouter-style, e.g. stepfun/step-3.7-flash:free).
export function isFreeModelId(id: string): boolean {
  return /\/free$/i.test(id) || /:free$/i.test(id);
}

// Shared table renderer for the /sessions and /kilo-gateway-logs listings.
// `freeFlags` marks rows to render greyed out (free-model sessions in
// /sessions); the request log passes false for every row.
function formatLogRows(
  header: string,
  headers: string[],
  rows: Record<string, string>[],
  freeFlags: boolean[],
  emptyNote: string,
  range?: string,
  footerNotes: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(header);
  if (range) {
    lines.push(`  ${C.dim}${range}${C.reset}`);
  }

  if (rows.length === 0) {
    lines.push(`  ${C.dim}${emptyNote}${C.reset}`);
  } else {
    const widths = headers.map((h) =>
      Math.max(h.length, ...rows.map((r) => r[h].length)),
    );
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const head = headers
      .map((h, i) => `${C.dim}${pad(h, widths[i])}${C.reset}`)
      .join("  ");
    lines.push("  " + head);
    for (let i = 0; i < rows.length; i++) {
      const row = headers
        .map((h, j) =>
          h === "date" || h === "session id" || h === "provider" || h === "model"
            ? `${C.cyan}${pad(rows[i][h], widths[j])}${C.reset}`
            : pad(rows[i][h], widths[j]),
        )
        .join("  ");
      lines.push("  " + (freeFlags[i] ? `${C.gray}${row}${C.reset}` : row));
    }
  }

  lines.push(`  ${C.dim}source: ${kiloDbPath()}${C.reset}`);
  for (const note of footerNotes) {
    lines.push(`  ${C.dim}${note}${C.reset}`);
  }
  return lines.join("\n");
}

// Build the shared date/model/cost/tokens/title row cells for one entry.
function logRowCells(e: {
  timeCreated: number;
  modelId: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  title: string;
}): Record<string, string> {
  return {
    date: new Date(e.timeCreated).toISOString().slice(0, 16).replace("T", " "),
    model: e.modelId,
    cost: usd(e.cost),
    in: fmtTokens(e.inputTokens),
    out: fmtTokens(e.outputTokens),
    cache: fmtTokens(e.cacheReadTokens),
    title: e.title.replace(/\s+/g, " ").trim().slice(0, 40),
  };
}

export function formatKiloGatewayRequests(entries: KiloGatewayRequest[], range?: string): string {
  return formatLogRows(
    `${C.bold}kilo-gateway-logs${C.reset}  ${C.dim}(individual requests through the Kilo Gateway, from local kilo.db)${C.reset}`,
    ["date", "model", "cost", "in", "out", "cache", "title"],
    entries.map(logRowCells),
    entries.map(() => false),
    "(no non-free Kilo Gateway requests found)",
    range,
    ["free models and non-Kilo providers are filtered out"],
  );
}

export function formatKiloSessions(entries: KiloSession[], range?: string): string {
  return formatLogRows(
    `${C.bold}sessions${C.reset}  ${C.dim}(all providers, from local kilo.db)${C.reset}`,
    ["date", "session id", "provider", "model", "cost", "in", "out", "cache", "title"],
    entries.map((e) => ({
      ...logRowCells(e),
      "session id": e.sessionId,
      provider: e.provider,
    })),
    entries.map((e) => e.free),
    "(no sessions found)",
    range,
    ["free-model sessions are greyed out"],
  );
}

// --- orchestrators ---

export type HandleOptions = {
  fetchFn?: FetchLike;
  authPath?: string;
  authContent?: string;
  dbPath?: string;
};

export async function handleKiloBalance(opts: HandleOptions = {}): Promise<string> {
  const token = readKiloAccessToken(opts);
  if (!token) {
    throw new Error(
      "No Kilo Gateway OAuth login found (~/.local/share/kilo/auth.json, `kilo` section). " +
        "Log in to kilo.ai (`kilo` login / connect the `kilo` provider) and retry.",
    );
  }
  // Fetch both in parallel; a Pass failure (e.g. not subscribed) should not
  // hide the prepaid balance, so treat Pass fetch failures as "no pass".
  const prepaidPromise = fetchPrepaidBalance(token, opts).catch(() => null);
  const passPromise = fetchKiloPassState(token, opts).catch((err) => {
    if (/404|400/.test((err as Error).message)) return null;
    throw err;
  });
  const [prepaid, pass] = await Promise.all([prepaidPromise, passPromise]);
  return formatKiloBalance(prepaid, pass);
}

// node:sqlite is a built-in (unflagged on Node ≥ 22.13 / 23.4; flagged
// --experimental-sqlite on earlier 22.x). Loaded lazily and synchronously
// (via createRequire) so /status can call these helpers on the synchronous
// exit path while the module still loads on runtimes without node:sqlite.
// The load emits an ExperimentalWarning ("SQLite is an experimental
// feature…") that would clutter the interactive prompt's stderr, so it is
// swallowed around the load only — other warnings keep their default
// handling.
let cachedSqlite: typeof import("node:sqlite") | null | undefined;
function loadSqlite(): typeof import("node:sqlite") | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  const origEmit: typeof process.emitWarning = process.emitWarning;
  process.emitWarning = ((warning: unknown, options: unknown) => {
    const msg =
      typeof warning === "string"
        ? warning
        : warning && typeof warning === "object" && "message" in warning
          ? String((warning as { message?: unknown }).message)
          : String(warning);
    if (/SQLite is an experimental/i.test(msg)) return;
    return origEmit.call(process, warning as any, options as any);
  }) as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    cachedSqlite = req("node:sqlite") as typeof import("node:sqlite");
  } catch {
    cachedSqlite = null;
  } finally {
    process.emitWarning = origEmit;
  }
  return cachedSqlite;
}

// Open kilo CLI's local SQLite database read-only. Read-only + WAL mode is
// safe alongside the live kilo acp process that owns the write connection.
function openKiloDb(path: string): import("node:sqlite").DatabaseSync {
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new Error(
      "node:sqlite is not available in this Node build. Use Node ≥ 22.5 " +
        "(pass --experimental-sqlite on 22.5–22.12) so the Kilo Gateway log commands can read kilo.db.",
    );
  }
  try {
    return new sqlite.DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new Error(
      `Could not open kilo CLI database at ${path}: ${(err as Error).message}. ` +
        "Run `kilo` once to create it, or set KILO_DB to a custom path.",
    );
  }
}

// Read a page of sessions across all providers directly from kilo CLI's local
// SQLite database. Free-model sessions are included (flagged via `free` so the
// formatter can grey them out). The arg is a page index; the SQL OFFSET is page
// * KILO_PAGE_SIZE. Exported for testing against a temp .db (opts.dbPath
// overrides the path).
export function readKiloSessions(
  page: number,
  opts: { dbPath?: string } = {},
): KiloSession[] {
  const p = Math.max(0, Math.round(page));
  const offset = p * KILO_PAGE_SIZE;
  const path = opts.dbPath ?? kiloDbPath();
  const db = openKiloDb(path);
  try {
    // Sanity-check the schema; older/pre-kilo databases may lack `session`.
    try {
      db.prepare("SELECT 1 FROM session LIMIT 1").get();
    } catch {
      return [];
    }
    // The model column is JSON with providerID + id. Ordering and paging are
    // done in SQL so a large kilo.db stays cheap to query. Free variants are
    // kept here (flagged client-side below) so /sessions can show them greyed
    // out.
    const stmt = db.prepare(
      `SELECT id, time_created, title, cost,
              tokens_input, tokens_output, tokens_cache_read,
              json_extract(model, '$.providerID') AS provider,
              json_extract(model, '$.id') AS model_id
       FROM session
       WHERE model IS NOT NULL
       ORDER BY time_created DESC
       LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(KILO_PAGE_SIZE, offset) as Array<{
      id: string;
      time_created: number;
      title: string;
      cost: number;
      tokens_input: number;
      tokens_output: number;
      tokens_cache_read: number;
      provider: string;
      model_id: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.id,
      timeCreated: r.time_created,
      title: r.title ?? "",
      cost: Number(r.cost) || 0,
      inputTokens: r.tokens_input ?? 0,
      outputTokens: r.tokens_output ?? 0,
      cacheReadTokens: r.tokens_cache_read ?? 0,
      provider: r.provider ?? "",
      modelId: r.model_id ?? "",
      free: isFreeModelId(r.model_id ?? ""),
    }));
  } finally {
    db.close();
  }
}

// Read a page of individual requests (assistant messages) routed through the
// Kilo Gateway from kilo CLI's local SQLite database. Free variants are
// excluded by suffix (/free or :free); a discounted variant like
// "...:discounted" or "name/free-tier" is kept as non-free. The session
// title is joined in for context. The arg is a page index; the SQL OFFSET is
// page * KILO_PAGE_SIZE. Exported for testing against a temp .db
// (opts.dbPath overrides the path).
export function readKiloGatewayRequests(
  page: number,
  opts: { dbPath?: string } = {},
): KiloGatewayRequest[] {
  const p = Math.max(0, Math.round(page));
  const offset = p * KILO_PAGE_SIZE;
  const path = opts.dbPath ?? kiloDbPath();
  const db = openKiloDb(path);
  try {
    // Sanity-check the schema; older/pre-kilo databases may lack `message`.
    try {
      db.prepare("SELECT 1 FROM message LIMIT 1").get();
    } catch {
      return [];
    }
    // Per-request usage lives on the assistant message JSON under
    // tokens.{input,output,cache.read}; cost is a per-message USD figure.
    const stmt = db.prepare(
      `SELECT m.id AS message_id, m.session_id, m.time_created,
              json_extract(m.data, '$.cost') AS cost,
              json_extract(m.data, '$.tokens.input') AS tokens_input,
              json_extract(m.data, '$.tokens.output') AS tokens_output,
              json_extract(m.data, '$.tokens.cache.read') AS tokens_cache_read,
              json_extract(m.data, '$.providerID') AS provider,
              json_extract(m.data, '$.modelID') AS model_id,
              s.title AS title
       FROM message m
       LEFT JOIN session s ON s.id = m.session_id
       WHERE json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(m.data, '$.providerID') IN ('kilo', 'kilo-auto')
         AND json_extract(m.data, '$.modelID') NOT LIKE '%/free'
         AND json_extract(m.data, '$.modelID') NOT LIKE '%:free'
       ORDER BY m.time_created DESC
       LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(KILO_PAGE_SIZE, offset) as Array<{
      message_id: string;
      session_id: string;
      time_created: number;
      cost: number;
      tokens_input: number;
      tokens_output: number;
      tokens_cache_read: number;
      provider: string;
      model_id: string;
      title: string;
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      sessionId: r.session_id,
      timeCreated: r.time_created,
      title: r.title ?? "",
      cost: Number(r.cost) || 0,
      inputTokens: r.tokens_input ?? 0,
      outputTokens: r.tokens_output ?? 0,
      cacheReadTokens: r.tokens_cache_read ?? 0,
      provider: r.provider ?? "",
      modelId: r.model_id ?? "",
    }));
  } finally {
    db.close();
  }
}

// Sum cached (prompt-cache read) tokens per session id from the message
// table. The ACP usage_update notification only reports used = input +
// cache.read with no cache split, so /status supplements it from kilo.db.
// Strictly best-effort: any failure (no node:sqlite, missing db, missing
// message table) yields an empty map rather than an error.
export function readKiloCachedTokens(
  sessionIds: string[],
  opts: { dbPath?: string } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const ids = sessionIds.filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) return out;
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = openKiloDb(opts.dbPath ?? kiloDbPath());
  } catch {
    return out;
  }
  try {
    try {
      db.prepare("SELECT 1 FROM message LIMIT 1").get();
    } catch {
      return out;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = db.prepare(
      `SELECT session_id, sum(json_extract(data, '$.tokens.cache.read')) AS cache_read
       FROM message
       WHERE session_id IN (${placeholders})
         AND json_extract(data, '$.role') = 'assistant'
       GROUP BY session_id`,
    );
    const rows = stmt.all(...ids) as Array<{ session_id: string; cache_read: number | null }>;
    for (const r of rows) {
      if (r.session_id && r.cache_read != null) {
        out.set(r.session_id, Number(r.cache_read) || 0);
      }
    }
  } catch {
    /* best-effort */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function handleKiloSessions(page: number, opts: HandleOptions = {}): string {
  // The arg is a page index; offset into the newest-first session list is
  // page * KILO_PAGE_SIZE. Page 0 = 10 most recent sessions across all providers.
  const p = Math.max(0, Math.round(page));
  const entries = readKiloSessions(p, opts);
  const offset = p * KILO_PAGE_SIZE;
  const start = offset + 1;
  const end = offset + entries.length;
  const range = entries.length === 0
    ? `offset ${offset} · no sessions on this page`
    : `offset ${offset} · sessions ${start}-${end} by recency (page ${p})`;
  return formatKiloSessions(entries, range);
}

export function handleKiloGatewayRequests(page: number, opts: HandleOptions = {}): string {
  // The arg is a page index; offset into the newest-first request list is
  // page * KILO_PAGE_SIZE. Page 0 = 10 most recent non-free requests.
  const p = Math.max(0, Math.round(page));
  const entries = readKiloGatewayRequests(p, opts);
  const offset = p * KILO_PAGE_SIZE;
  const start = offset + 1;
  const end = offset + entries.length;
  const range = entries.length === 0
    ? `offset ${offset} · no requests on this page`
    : `offset ${offset} · requests ${start}-${end} by recency (page ${p})`;
  return formatKiloGatewayRequests(entries, range);
}
