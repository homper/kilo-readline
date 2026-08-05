// OpenRouter per-key remaining balance and usage reporting.
//
// Reads the OpenRouter API-key login kilo stores in
// ~/.local/share/kilo/auth.json (the `openrouter` section, type "api", with a
// `key`) and calls OpenRouter's account endpoints at
// https://openrouter.ai/api/v1 (overridable via OPENROUTER_API_URL):
//
//   GET /key
//     → { data: { label, usage, usage_daily, usage_weekly, usage_monthly,
//          limit, limit_remaining, limit_reset, is_free_tier, expires_at, ... } }
//     The used key's own spending limit (null = unlimited) with
//     limit_remaining = how much is still available on the key, plus its
//     reset cadence (daily | weekly | monthly | null) and rolling UTC
//     day/week/month spend.
//
//   GET /credits
//     → { data: { total_credits, total_usage } }
//     Account-level credit ledger. Only used when the key has NO spending
//     limit of its own — such a key draws straight from the account credit
//     pool, so the key's remaining = total_credits − total_usage. Best-effort:
//     some keys (free-tier / BYOK-only) have no credit ledger and the
//     endpoint errors; that only degrades the remaining figure, never the
//     per-key usage block.
//
// The headline figure is therefore what is left for THE USED KEY (its limit
// headroom, else the account credits behind it), not the raw account balance;
// the full account ledger is shown as a dim context line only when the key
// has its own limit.
//
// Unlike codexUsage.ts / kiloBalance.ts there is no OAuth token here to
// protect: the `openrouter` entry is a plain API key (sk-or-…), so there is
// no acp token-rotation race to worry about. An invalid/revoked key surfaces
// as an HTTP 401 from the API.

import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";

const DEFAULT_OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
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

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

// --- paths ---

// Same auth file codexUsage.ts / kiloBalance.ts read; resolved to
// $XDG_DATA_HOME/kilo/auth.json else ~/.local/share/kilo/auth.json.
export function openrouterAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  return join(dataHome, "kilo", "auth.json");
}

function openrouterApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENROUTER_API_URL || DEFAULT_OPENROUTER_API_URL;
}

// --- parsing helpers (pure, exported for tests) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export type OpenRouterKeyInfo = {
  label: string | null;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  isFreeTier: boolean | null;
  expiresAt: string | null;
};

export type OpenRouterCredits = {
  totalCredits: number;
  totalUsage: number;
};

// Parse the /key payload ({ data: {...} }). Returns null when the envelope or
// the usage figure is missing so the caller can report an unexpected response.
export function parseOpenRouterKeyInfo(value: unknown): OpenRouterKeyInfo | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : null;
  if (!data) return null;
  if (data.usage == null && data.usage_daily == null) return null;
  return {
    label: typeof data.label === "string" ? data.label : null,
    usage: num(data.usage),
    usageDaily: num(data.usage_daily),
    usageWeekly: num(data.usage_weekly),
    usageMonthly: num(data.usage_monthly),
    limit: numOrNull(data.limit),
    limitRemaining: numOrNull(data.limit_remaining),
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
  };
}

export function parseOpenRouterCredits(value: unknown): OpenRouterCredits | null {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : null;
  if (!data) return null;
  if (data.total_credits == null && data.total_usage == null) return null;
  return {
    totalCredits: num(data.total_credits),
    totalUsage: num(data.total_usage),
  };
}

// --- key read ---

export type OpenRouterKeyOptions = {
  authPath?: string;
  authContent?: string;
};

// Read the OpenRouter API key from the `openrouter` section of auth.json.
// Only a type "api" entry carries a usable key (OpenRouter has no OAuth flow
// here); returns null for a missing/malformed file or other auth types.
export function readOpenRouterKey(opts: OpenRouterKeyOptions = {}): string | null {
  let raw = opts.authContent;
  if (raw === undefined && opts.authPath === undefined) {
    raw = process.env.KILO_AUTH_CONTENT;
  }
  if (!raw) {
    try {
      raw = fs.readFileSync(opts.authPath ?? openrouterAuthPath(), "utf8");
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
  const entry = all.openrouter;
  if (!isRecord(entry)) return null;
  if (entry.type !== "api" || typeof entry.key !== "string") return null;
  return entry.key;
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

async function fetchOpenRouterJson(
  path: string,
  key: string,
  opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const base = openrouterApiBase(opts.env);
  const res = await (opts.fetchFn ?? globalFetch)(`${base}${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`openrouter ${path} fetch failed (${res.status}): ${await safeText(res)}`);
  }
  return res.json();
}

export async function fetchOpenRouterKeyInfo(
  key: string,
  opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<OpenRouterKeyInfo> {
  const parsed = parseOpenRouterKeyInfo(await fetchOpenRouterJson("/key", key, opts));
  if (!parsed) {
    throw new Error("openrouter /key returned an unexpected response shape");
  }
  return parsed;
}

export async function fetchOpenRouterCredits(
  key: string,
  opts: { fetchFn?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<OpenRouterCredits> {
  const parsed = parseOpenRouterCredits(await fetchOpenRouterJson("/credits", key, opts));
  if (!parsed) {
    throw new Error("openrouter /credits returned an unexpected response shape");
  }
  return parsed;
}

// --- format helpers (pure, exported for tests) ---

export function usd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function dateOnly(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Green/yellow/red on the remaining figure, mirroring codexUsage's
// colorRemainingPercent thresholds (red ≤20%, yellow ≤50%, green above).
function colorRemaining(remaining: number, total: number): string {
  const pct = total > 0 ? (remaining / total) * 100 : 0;
  const code = pct <= 20 ? C.red : pct <= 50 ? C.yellow : C.green;
  return `${code}${usd(remaining)}${C.reset}`;
}

// How much is left for THE USED KEY: its own spending-limit headroom
// (limit_remaining, falling back to limit − usage) when a limit is set,
// otherwise the account credit pool the unlimited key draws from
// (total_credits − total_usage). Null when neither source is available.
export function openRouterKeyRemaining(
  info: OpenRouterKeyInfo | null,
  credits: OpenRouterCredits | null,
): number | null {
  if (info?.limit != null) {
    return info.limitRemaining ?? Math.max(0, info.limit - info.usage);
  }
  if (credits) {
    return Math.max(0, credits.totalCredits - credits.totalUsage);
  }
  return null;
}

export function formatOpenRouterBalance(
  info: OpenRouterKeyInfo | null,
  credits: OpenRouterCredits | null,
): string {
  const lines: string[] = [];
  lines.push(`${C.bold}openrouter-balance${C.reset}`);

  // Fixed-width dim labels keep the value column aligned across rows.
  const label = (s: string): string => s.padEnd(15);

  if (info) {
    const tag = info.isFreeTier ? `  ${C.dim}(free tier)${C.reset}` : "";
    const expires = info.expiresAt ? `  ${C.dim}expires ${dateOnly(info.expiresAt)}${C.reset}` : "";
    lines.push(`  ${C.dim}${label("key")}${C.reset} ${info.label ?? "(unnamed key)"}${tag}${expires}`);

    // Headline: what is left for this key — its spending-limit headroom when
    // one is set, else the account credits it draws from.
    const remaining = openRouterKeyRemaining(info, credits);
    if (info.limit != null) {
      const reset = info.limitReset ? ` (resets ${info.limitReset})` : "";
      const colored =
        remaining == null ? `${C.red}?${C.reset}` : colorRemaining(remaining, info.limit);
      lines.push(
        `  ${C.bold}${label("remaining")}${C.reset} ${colored} left of ${usd(info.limit)} key limit${reset}`,
      );
    } else if (credits) {
      lines.push(
        `  ${C.bold}${label("remaining")}${C.reset} ${colorRemaining(remaining!, credits.totalCredits)} of account credits (no key limit)`,
      );
    } else {
      lines.push(
        `  ${C.bold}${label("remaining")}${C.reset} ${C.red}unknown${C.reset} (no key limit, no credit ledger)`,
      );
    }

    lines.push(`  ${C.dim}${label("usage today")}${C.reset} ${usd(info.usageDaily)}`);
    lines.push(`  ${C.dim}${label("usage week")}${C.reset} ${usd(info.usageWeekly)}`);
    lines.push(`  ${C.dim}${label("usage month")}${C.reset} ${usd(info.usageMonthly)}`);
    lines.push(`  ${C.dim}${label("usage total")}${C.reset} ${usd(info.usage)}`);

    // The full account ledger only as context when the key has its own limit
    // (otherwise the remaining line already IS the account credit pool).
    if (info.limit != null && credits) {
      const accountRemaining = Math.max(0, credits.totalCredits - credits.totalUsage);
      lines.push(
        `  ${C.dim}${label("account credits")}${C.reset} ${usd(accountRemaining)} remaining of ${usd(credits.totalCredits)} purchased`,
      );
    }
  } else {
    lines.push(`  ${C.dim}(no OpenRouter key info available)${C.reset}`);
  }

  lines.push(`  ${C.dim}per-request detail: https://openrouter.ai/activity${C.reset}`);
  return lines.join("\n");
}

// --- orchestrator ---

export type HandleOptions = {
  fetchFn?: FetchLike;
  authPath?: string;
  authContent?: string;
};

// Run the full flow: read the OpenRouter API key → fetch key info + credits →
// format. Returns the rendered string to print; throws with a friendly
// message when no key is configured. The /credits fetch is best-effort (a
// key without a credit ledger must not hide the usage block).
export async function handleOpenRouterBalance(opts: HandleOptions = {}): Promise<string> {
  const key = readOpenRouterKey(opts);
  if (!key) {
    throw new Error(
      "No OpenRouter API key found (~/.local/share/kilo/auth.json, `openrouter` section). " +
        "Connect the openrouter provider in kilo (`/connect` or `kilo auth login`) and retry.",
    );
  }
  const [info, credits] = await Promise.all([
    fetchOpenRouterKeyInfo(key, opts),
    fetchOpenRouterCredits(key, opts).catch(() => null),
  ]);
  return formatOpenRouterBalance(info, credits);
}
