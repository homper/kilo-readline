// ChatGPT subscription rate-limit usage reporting.
//
// Kilo stores its own ChatGPT OAuth login in ~/.local/share/kilo/auth.json
// (the `openai` section, type "oauth"). Its access token (a JWT, rotated by
// the kilo acp child process) authorizes the undocumented
// chatgpt.com/backend-api/wham/usage endpoint, which reports the
// subscription's rolling rate-limit windows as used_percent + reset times.
// This module reads that login, fetches the usage payload, and formats it
// like /status.
//
// It NEVER refreshes the token itself: the kilo acp process keeps the access
// token rotated, and touching the one-time-use rotating refresh_token here
// would race kilo's own rotation and invalidate it. If the access token is
// expired, run any kilo turn so acp refreshes it, then retry.

import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const NETWORK_TIMEOUT_MS = 12_000;

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

export type CodexWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number | null; // unix seconds, or null when absent
};

export type CodexUsage = {
  planType: string | null;
  allowed: boolean;
  limitReached: boolean;
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  extra: CodexWindow[];
};

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

// --- paths ---

export function kiloAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  return join(dataHome, "kilo", "auth.json");
}

// --- usage fetch ---

// Call the wham/usage endpoint with a ChatGPT OAuth access token. Throws on
// HTTP/network failure (the caller decides how to surface that).
export async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
  fetchFn: FetchLike = globalFetch,
): Promise<unknown> {
  const res = await fetchFn(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "ChatGPT-Account-Id": accountId,
    },
  });
  if (!res.ok) {
    throw new Error(`usage fetch failed (${res.status}): ${await safeText(res)}`);
  }
  return res.json();
}

// --- parse ---

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toWindow(raw: unknown): CodexWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const usedPercent = num(w.used_percent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowSeconds: num(w.limit_window_seconds) ?? 0,
    resetAfterSeconds: num(w.reset_after_seconds) ?? 0,
    resetAt: num(w.reset_at),
  };
}

export function parseUsageJson(obj: unknown): CodexUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const planType = typeof o.plan_type === "string" ? o.plan_type : null;
  const rl = o.rate_limit as Record<string, unknown> | undefined;
  if (!rl) {
    return {
      planType,
      allowed: true,
      limitReached: false,
      primary: null,
      secondary: null,
      extra: [],
    };
  }
  const extra: CodexWindow[] = [];
  const extraRaw = (rl as Record<string, unknown>).additional_rate_limits;
  if (Array.isArray(extraRaw)) {
    for (const e of extraRaw) {
      const w = toWindow(e);
      if (w) extra.push(w);
    }
  }
  return {
    planType,
    allowed: (rl as Record<string, unknown>).allowed !== false,
    limitReached: (rl as Record<string, unknown>).limit_reached === true,
    primary: toWindow((rl as Record<string, unknown>).primary_window),
    secondary: toWindow((rl as Record<string, unknown>).secondary_window),
    extra,
  };
}

// Read the OAuth credentials Kilo itself uses for the OpenAI provider and
// return the full subscription usage payload. Returns null for API-key auth,
// absent auth, malformed files, or an unparseable response; throws on
// network/HTTP errors (so callers can distinguish "no login" from "expired
// token").
export async function fetchKiloCodexUsage(
  opts: {
    fetchFn?: FetchLike;
    authPath?: string;
    authContent?: string;
  } = {},
): Promise<CodexUsage | null> {
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
  const auth = all.openai;
  if (!auth || typeof auth !== "object") return null;
  const oauth = auth as Record<string, unknown>;
  if (oauth.type !== "oauth" || typeof oauth.access !== "string") return null;

  const accountId = typeof oauth.accountId === "string"
    ? oauth.accountId
    : extractAccountIdFromJwt(oauth.access);
  if (!accountId) return null;

  return parseUsageJson(
    await fetchCodexUsage(oauth.access, accountId, opts.fetchFn ?? globalFetch),
  );
}

// Convenience wrapper: the full usage via Kilo's login, reduced to the exact
// five-hour window's used percent (or null when absent/unavailable).
export async function fetchKiloCodexFiveHourPercent(
  opts: {
    fetchFn?: FetchLike;
    authPath?: string;
    authContent?: string;
  } = {},
): Promise<number | null> {
  const parsed = await fetchKiloCodexUsage(opts);
  if (!parsed) return null;
  const fiveHours = [parsed.primary, parsed.secondary, ...parsed.extra]
    .find((window) => window?.windowSeconds === 5 * 60 * 60);
  return fiveHours?.usedPercent ?? null;
}

// Pull the ChatGPT account id out of the access-token JWT when the auth file
// doesn't store it explicitly. OpenAI has stuffed it in a few different claims
// over time, so check each known location.
function extractAccountIdFromJwt(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const nested = claims["https://api.openai.com/auth"];
    if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
    if (nested && typeof nested === "object") {
      const accountId = (nested as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === "string") return accountId;
    }
    const organizations = claims.organizations;
    if (Array.isArray(organizations)) {
      const first = organizations[0];
      if (first && typeof first === "object" && typeof (first as Record<string, unknown>).id === "string") {
        return (first as Record<string, unknown>).id as string;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// --- format ---

export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

export function colorRemainingPercent(p: number): string {
  const remaining = Math.min(100, Math.max(0, p));
  const code = remaining <= 20 ? C.red : remaining <= 50 ? C.yellow : C.green;
  return `${code}${Math.round(remaining)}%${C.reset}`;
}

export function renderBar(percent: number, width = 20): string {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)),
  );
  return `${C.gray}[${C.reset}${"█".repeat(filled)}${C.gray}${"░".repeat(
    width - filled,
  )}${C.gray}]${C.reset}`;
}

// Human label for a window's span, derived from its limit_window_seconds.
export function windowLabel(seconds: number): string {
  if (seconds <= 0) return "window";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// "4h 1m" / "6d 17h" / "5m" style from a seconds duration.
export function formatDuration(sec: number): string {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Local clock time for a unix-seconds reset_at, e.g. "14:42".
export function formatResetClock(unixSec: number | null): string {
  if (unixSec === null) return "";
  const d = new Date(unixSec * 1000);
  return (
    d.getHours().toString().padStart(2, "0") +
    ":" +
    d.getMinutes().toString().padStart(2, "0")
  );
}

function formatWindowRow(label: string, w: CodexWindow): string {
  const remaining = remainingPercent(w.usedPercent);
  const bar = renderBar(remaining);
  const pct = colorRemainingPercent(remaining);
  let reset = "";
  if (w.resetAt !== null) {
    const clock = formatResetClock(w.resetAt);
    const dur = w.resetAfterSeconds > 0 ? formatDuration(w.resetAfterSeconds) : "";
    reset = `  ${C.dim}resets in ${dur}${clock ? ` (${clock})` : ""}${C.reset}`;
  }
  return `  ${C.bold}${label.padEnd(8)}${C.reset} ${bar} ${pct} left${reset}`;
}

export function formatCodexUsage(u: CodexUsage): string {
  const lines: string[] = [];
  lines.push(`${C.bold}codex-usage${C.reset}`);
  if (u.planType) {
    lines.push(`  ${C.dim}plan${C.reset}    : ${u.planType}`);
  }
  if (!u.allowed || u.limitReached) {
    lines.push(`  ${C.red}⚠️  rate limit reached${C.reset}`);
  }
  if (u.primary) lines.push(formatWindowRow(windowLabel(u.primary.windowSeconds), u.primary));
  if (u.secondary) lines.push(formatWindowRow(windowLabel(u.secondary.windowSeconds), u.secondary));
  for (let i = 0; i < u.extra.length; i++) {
    lines.push(formatWindowRow(`extra${i + 1}`, u.extra[i]));
  }
  if (!u.primary && !u.secondary && u.extra.length === 0) {
    lines.push(`  ${C.dim}(no rate-limit windows reported)${C.reset}`);
  }
  return lines.join("\n");
}

// --- orchestrator ---

export type HandleCodexUsageOptions = {
  fetchFn?: FetchLike;
  // Override for testing: point at a temp kilo auth.json.
  authPath?: string;
  authContent?: string;
};

// Run the full flow: read Kilo's OAuth login → fetch → format. Returns the
// rendered string to print; throws with a friendly message on failure (no
// OAuth login, expired token, network error, etc.).
export async function handleCodexUsage(
  opts: HandleCodexUsageOptions = {},
): Promise<string> {
  let parsed: CodexUsage | null;
  try {
    parsed = await fetchKiloCodexUsage(opts);
  } catch (err) {
    // The login exists but the request failed (e.g. the access token expired
    // before kilo acp rotated it). Running any kilo turn refreshes it.
    throw new Error(
      `${(err as Error).message}\n` +
        `Run any kilo turn so kilo refreshes its access token, then retry.`,
    );
  }
  if (!parsed) {
    throw new Error(
      "No Kilo ChatGPT OAuth login found (~/.local/share/kilo/auth.json). " +
        "Log in with kilo (ChatGPT account) and run a turn to establish it.",
    );
  }
  return formatCodexUsage(parsed);
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
