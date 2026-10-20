// Z.AI GLM Coding Plan quota usage reporting.
//
// Kilo stores its own Z.AI Coding Plan API key in ~/.local/share/kilo/auth.json
// (the `zai-coding-plan` section, type "api", with a `key`). That key
// authorizes the dashboard backend the z.ai manage-apikey page itself uses:
//
//   GET https://api.z.ai/api/monitor/usage/quota/limit
//     → { code, msg, data: { level, limits: [
//          { type:"CREDIT_LIMIT", unit, number, usage, currentValue, remaining,
//            percentage, nextResetTime }, ...
//        ] } }
//
//   `percentage` is the USED percent (0..100). `unit` selects the window:
//     3 = hours   (number 5 → the rolling 5-hour prompt pool)
//     6 = weeks   (number 1 → the weekly quota)
//     5 = month   (MCP monthly, not surfaced here)
//   `nextResetTime` is unix milliseconds (absent for a window with nothing
//   consumed yet, since it resets 5h/7d after first consumption).
//
//   GET https://api.z.ai/api/biz/subscription/list
//     → { code, data: [{ productName:"GLM Coding Lite", status, billingCycle,
//          autoRenew, nextRenewTime:"2026-10-25",
//          valid:"2026-10-25 22:09:20-2026-11-25 22:09:20", ... }] }
//   Best-effort: used to label the plan name and (when present) the renewal/
//   end date in the full /zai-balance view. `autoRenew` is 0/1: when off the
//   plan ends at the end of the `valid` range instead of renewing.
//
// Unlike codexUsage.ts there is no OAuth token here to protect: the
// `zai-coding-plan` entry is a plain API key, so there is no acp token-rotation
// race. An invalid/revoked key surfaces as an HTTP 401 from the API.

import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";
import {
  colorRemainingPercent,
  remainingPercent,
  renderBar,
  formatDuration,
  formatResetClock,
  kiloAuthPath,
  type FetchLike,
} from "./codexUsage.js";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";
const NETWORK_TIMEOUT_MS = 12_000;

// Auth-file sections that hold a Z.AI Coding Plan API key. The Coding Plan
// usage endpoint is account-scoped, so any of these keys works; the first one
// present wins.
const ZAI_AUTH_KEYS = ["zai-coding-plan", "zhipuai-coding-plan"];

// ANSI colors, mirroring the C map in index.ts so this renders the same.
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

export type ZaiWindow = {
  type: string; // "CREDIT_LIMIT" | "TOKENS_LIMIT" | ...
  unit: number; // 3=hour, 4=day, 5=month, 6=week
  number: number; // count of units
  usage: number; // total quota (credits/tokens)
  currentValue: number; // consumed
  remaining: number; // remaining
  usedPercent: number; // 0..100 used
  nextResetMs: number | null; // unix ms, or null when absent
};

export type ZaiUsage = {
  planName: string | null; // "GLM Coding Lite"
  level: string | null; // "lite" | "pro" | "max"
  windows: ZaiWindow[];
  renewal: ZaiRenewal | null; // from /biz/subscription/list, best-effort
};

// Best-effort subscription renewal info from /biz/subscription/list. Fields
// are raw strings from the API; null when the endpoint failed or lacked them.
export type ZaiRenewal = {
  autoRenew: boolean | null; // autoRenew !== 0; null when absent
  nextRenewTime: string | null; // "2026-10-25" — next billing date when renewing
  validEnd: string | null; // end of the `valid` range — when the plan ends
};

// Remaining percent per window, for the live status line.
export type ZaiRemaining = {
  fiveHour: number | null;
  weekly: number | null;
  fiveHourResetMs: number | null;
  weeklyResetMs: number | null;
};

export type HandleZaiUsageOptions = {
  fetchFn?: FetchLike;
  // Override for testing: point at a temp kilo auth.json.
  authPath?: string;
  authContent?: string;
};

// --- parsing helpers (pure, exported for tests) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toWindow(raw: unknown): ZaiWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = num(raw.percentage);
  if (usedPercent === null) return null;
  return {
    type: typeof raw.type === "string" ? raw.type : "",
    unit: num(raw.unit) ?? 0,
    number: num(raw.number) ?? 0,
    usage: num(raw.usage) ?? 0,
    currentValue: num(raw.currentValue) ?? 0,
    remaining: num(raw.remaining) ?? 0,
    usedPercent,
    nextResetMs: num(raw.nextResetTime),
  };
}

// Parse the quota/limit envelope (and an optional subscription envelope for the
// plan name). Returns null when there are no usable windows so the caller can
// report an unexpected response.
export function parseZaiUsageJson(quota: unknown, subscription?: unknown): ZaiUsage | null {
  const qdata = rec(rec(quota)?.data);
  const limitsRaw = qdata?.limits;
  const windows: ZaiWindow[] = [];
  if (Array.isArray(limitsRaw)) {
    for (const l of limitsRaw) {
      const w = toWindow(l);
      if (w) windows.push(w);
    }
  }
  if (windows.length === 0) return null;
  const level = typeof qdata?.level === "string" ? qdata.level : null;

  let planName: string | null = null;
  let renewal: ZaiRenewal | null = null;
  const subsRaw = rec(subscription)?.data;
  const subs = Array.isArray(subsRaw) ? subsRaw : subsRaw == null ? [] : [subsRaw];
  if (subs.length > 0) {
    const first = rec(subs[0]);
    if (first && typeof first.productName === "string") planName = first.productName;
    if (first) {
      const autoRenew = num(first.autoRenew);
      renewal = {
        autoRenew: autoRenew === null ? null : autoRenew !== 0,
        nextRenewTime: typeof first.nextRenewTime === "string" ? first.nextRenewTime : null,
        validEnd: parseValidEnd(typeof first.valid === "string" ? first.valid : null),
      };
    }
  }
  return { planName, level, windows, renewal };
}

// The `valid` field is a dash-joined range like
// "2026-10-25 22:09:20-2026-11-25 22:09:20"; return just the end bound.
function parseValidEnd(valid: string | null): string | null {
  if (!valid) return null;
  const m = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?)-(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.exec(valid.trim());
  return m ? m[2] : null;
}

// --- auth ---

function readZaiApiKey(opts: HandleZaiUsageOptions = {}): string | null {
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
  for (const k of ZAI_AUTH_KEYS) {
    const auth = all[k];
    if (
      auth &&
      typeof auth === "object" &&
      (auth as Record<string, unknown>).type === "api" &&
      typeof (auth as Record<string, unknown>).key === "string"
    ) {
      return (auth as Record<string, unknown>).key as string;
    }
  }
  return null;
}

// --- usage fetch ---

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

// Call the quota/limit endpoint with a Z.AI Coding Plan API key. Throws on
// HTTP/network failure (the caller decides how to surface that).
export async function fetchZaiQuota(
  apiKey: string,
  fetchFn: FetchLike = globalFetch,
): Promise<unknown> {
  const res = await fetchFn(ZAI_QUOTA_URL, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  if (!res.ok) {
    throw new Error(`usage fetch failed (${res.status}): ${await safeText(res)}`);
  }
  return res.json();
}

// Best-effort plan-name fetch: never throws, returns null on any failure so a
// flaky subscription endpoint can't hide the quota numbers.
export async function fetchZaiSubscription(
  apiKey: string,
  fetchFn: FetchLike = globalFetch,
): Promise<unknown> {
  try {
    const res = await fetchFn(ZAI_SUBSCRIPTION_URL, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Read the API key Kilo uses for the Z.AI Coding Plan provider and return the
// full usage payload. Returns null for an absent/malformed login or an
// unparseable response; throws on network/HTTP errors (so callers can
// distinguish "no login" from "request failed").
export async function fetchKiloZaiUsage(
  opts: HandleZaiUsageOptions = {},
): Promise<ZaiUsage | null> {
  const key = readZaiApiKey(opts);
  if (!key) return null;
  const fetchFn = opts.fetchFn ?? globalFetch;
  const [quota, subscription] = await Promise.all([
    fetchZaiQuota(key, fetchFn),
    fetchZaiSubscription(key, fetchFn),
  ]);
  return parseZaiUsageJson(quota, subscription);
}

// Convenience wrapper for the live status line: the full usage via Kilo's
// login, reduced to the remaining percent of the 5-hour pool and the weekly
// quota (each null when absent/unavailable). Same null-vs-throw contract as
// fetchKiloZaiUsage.
export async function fetchKiloZaiRemaining(
  opts: HandleZaiUsageOptions = {},
): Promise<ZaiRemaining | null> {
  const key = readZaiApiKey(opts);
  if (!key) return null;
  const quota = await fetchZaiQuota(key, opts.fetchFn ?? globalFetch);
  const parsed = parseZaiUsageJson(quota, null);
  if (!parsed) return null;
  const five = parsed.windows.find((w) => w.unit === 3);
  const weekly = parsed.windows.find((w) => w.unit === 6);
  return {
    fiveHour: five ? remainingPercent(five.usedPercent) : null,
    weekly: weekly ? remainingPercent(weekly.usedPercent) : null,
    fiveHourResetMs: five ? five.nextResetMs : null,
    weeklyResetMs: weekly ? weekly.nextResetMs : null,
  };
}

// --- format ---

// "2026-10-25" / "2026-10-25 22:09:20" → "Oct 25" (+" 2026" when the year is
// not the current one). Returns the raw string when it doesn't parse.
const ZAI_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatZaiDate(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return raw;
  const year = Number(m[1]);
  const mon = ZAI_MONTHS[Number(m[2]) - 1];
  if (!mon) return raw;
  const day = Number(m[3]);
  const nowYear = new Date().getFullYear();
  return year === nowYear ? `${mon} ${day}` : `${mon} ${day} ${year}`;
}

// Human label for a window's span, derived from its unit + count.
export function zaiWindowLabel(unit: number, number: number): string {
  if (unit === 3) return `${number}h`; // hours
  if (unit === 6) return `${number * 7}d`; // weeks -> days
  if (unit === 4) return `${number}d`; // days
  if (unit === 5) return "mo"; // month
  return "window";
}

function formatWindowRow(label: string, w: ZaiWindow): string {
  const rem = remainingPercent(w.usedPercent);
  const bar = renderBar(rem);
  const pct = colorRemainingPercent(rem);
  let reset = "";
  if (w.nextResetMs !== null) {
    const clock = formatResetClock(Math.floor(w.nextResetMs / 1000));
    const durSec = Math.floor((w.nextResetMs - Date.now()) / 1000);
    const dur = durSec > 0 ? formatDuration(durSec) : "now";
    reset = `  ${C.dim}resets in ${dur}${clock ? ` (${clock})` : ""}${C.reset}`;
  }
  const credits = `  ${C.dim}${Math.round(w.currentValue)} / ${Math.round(w.usage)} credits${C.reset}`;
  return `  ${C.bold}${label.padEnd(8)}${C.reset} ${bar} ${pct} left${reset}${credits}`;
}

export function formatZaiUsage(u: ZaiUsage): string {
  const lines: string[] = [];
  lines.push(`${C.bold}zai-balance${C.reset}`);
  if (u.planName || u.level) {
    const plan =
      u.planName && u.level
        ? `${u.planName} (${u.level})`
        : (u.planName ?? u.level);
    lines.push(`  ${C.dim}plan${C.reset}    : ${plan}`);
  }
  const r = u.renewal;
  if (r) {
    if (r.autoRenew === false) {
      const end = r.validEnd ?? r.nextRenewTime;
      if (end) {
        lines.push(
          `  ${C.dim}ends${C.reset}    : ${formatZaiDate(end)} ${C.dim}(auto-renew off)${C.reset}`,
        );
      }
    } else {
      const renew = r.nextRenewTime ?? r.validEnd;
      if (renew) {
        lines.push(`  ${C.dim}renews${C.reset}  : ${formatZaiDate(renew)}`);
      }
    }
  }
  for (const w of u.windows) {
    lines.push(formatWindowRow(zaiWindowLabel(w.unit, w.number), w));
  }
  if (u.windows.length === 0) {
    lines.push(`  ${C.dim}(no usage windows reported)${C.reset}`);
  }
  return lines.join("\n");
}

// --- orchestrator ---

// Run the full flow: read Kilo's Coding Plan API key → fetch → format. Returns
// the rendered string to print; throws with a friendly message on failure (no
// API key, network error, etc.).
export async function handleZaiUsage(
  opts: HandleZaiUsageOptions = {},
): Promise<string> {
  let parsed: ZaiUsage | null;
  try {
    parsed = await fetchKiloZaiUsage(opts);
  } catch (err) {
    throw new Error((err as Error).message);
  }
  if (!parsed) {
    throw new Error(
      "No Kilo Z.AI Coding Plan API key found (~/.local/share/kilo/auth.json, " +
        "the `zai-coding-plan` section). Log in with kilo (Z.AI Coding Plan) " +
        "and run a turn to establish it.",
    );
  }
  return formatZaiUsage(parsed);
}

// --- helpers ---

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
