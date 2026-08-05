import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { bashCallPatterns } from "./permission.js";

// Client-side permission evaluation. The agent is forced (via KILO_CONFIG_CONTENT
// in buildAgentEnv) to send `requestPermission` for every tool call, so this
// module re-evaluates the *real* user config (global + project files, mtime-cached
// for mid-session hot-reload) and decides allow / ask / deny itself.
//
// The matching semantics mirror kilo-cli (`packages/opencode/src/permission`):
// `evaluate` is a findLast over the ruleset using `Wildcard.match`, with a
// default of "ask" when nothing matches; `decide` returns "deny" if any of the
// call's patterns is denied, "ask" if any is ask (and none deny), else "allow".

// --- JSONC strip-comments parser (duplicated from index.ts; this module is standalone) ---
function parseJsonc(text: string): unknown {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\" && next !== undefined) {
        result += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += ch;
  }
  const noTrailing = result.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailing);
}

// --- Wildcard match: port of @opencode-ai/core util/wildcard `match(input, pattern)` ---
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // A trailing ` *` becomes optional so `npm install *` matches `npm install`.
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}

// --- expand ~/ ~ $HOME (port of permission/expand) ---
function expand(pattern: string): string {
  const home = os.homedir();
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

export type Action = "allow" | "ask" | "deny";
export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

// Build a ruleset (insertion order preserved) from a kilo `permission` object,
// mirroring `fromConfig`: scalar → one `{*, action}` rule; object → one rule per
// entry (null entries are delete sentinels and are skipped); `expand` the pattern.
export function fromConfig(permission: Record<string, unknown>): Rule[] {
  const ruleset: Rule[] = [];
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value as Action, pattern: "*" });
      continue;
    }
    if (value === null) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [pat, act] of Object.entries(value as Record<string, unknown>)) {
        if (act === null) continue;
        ruleset.push({ permission: key, pattern: expand(pat), action: act as Action });
      }
    }
  }
  return ruleset;
}

// Canonical config key for a permission entry. Legacy "always" replies were
// persisted under the shortened alias `external_dir`, but the evaluator matches
// against the full tool name `external_directory` (literal key match, no
// wildcard), so those rules were silently dead. Normalize the alias on read so
// existing configs keep working and the keys consolidate under `external_directory`.
function canonicalKey(key: string): string {
  return key === "external_dir" ? "external_directory" : key;
}

// Deep-merge a higher-precedence `permission` object into an accumulator in a
// way that reproduces kilo's concatenation + findLast semantics:
//  - scalar in the higher config dominates (becomes the only "*" rule, placed
//    after any lower specifics → findLast wins);
//  - object adds/overrides specific patterns (preserving insertion order so a
//    lower "*" stays first and higher specifics come after);
//  - null deletes (a top-level `tool: null` removes the tool; a pattern `null`
//    removes that pattern). A null under the legacy alias deletes the canonical
//  key too.
export function mergePermissionInto(acc: Record<string, unknown>, perm: Record<string, unknown>): void {
  for (const [rawKey, val] of Object.entries(perm)) {
    const key = canonicalKey(rawKey);
    if (val === null) {
      delete acc[key];
      continue;
    }
    if (typeof val === "string") {
      acc[key] = val;
      continue;
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      const existing = acc[key];
      let base: Record<string, unknown>;
      if (existing == null) base = {};
      else if (typeof existing === "string") base = { "*": existing };
      else if (typeof existing === "object" && !Array.isArray(existing)) base = { ...(existing as Record<string, unknown>) };
      else base = {};
      for (const [p, a] of Object.entries(val as Record<string, unknown>)) {
        if (a === null) delete base[p];
        else base[p] = a;
      }
      acc[key] = base;
    }
  }
}

// --- mtime-cached config file reader ---
interface FileCache {
  mtimeMs: number;
  perm: Record<string, unknown> | null;
}
const fileCache = new Map<string, FileCache>();

function loadPermissionFile(p: string): Record<string, unknown> | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    fileCache.delete(p);
    return null;
  }
  const cached = fileCache.get(p);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.perm;
  let perm: Record<string, unknown> | null = null;
  try {
    const obj = parseJsonc(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    const pp = obj.permission;
    if (pp && typeof pp === "object" && !Array.isArray(pp)) perm = pp as Record<string, unknown>;
  } catch (err) {
    console.error(`⚠️  Could not parse config at ${p}: ${(err as Error).message}`);
  }
  fileCache.set(p, { mtimeMs: stat.mtimeMs, perm });
  return perm;
}

// Read + merge the `permission` objects from `globalPath` (lowest) then each
// project path in order (later wins, mirroring kilo's precedence), returning a
// single ruleset. KILO_CONFIG_CONTENT is intentionally NOT consulted here —
// that env carries the client's force-ask override for the agent, not the
// user's real rules. mtime-cached so mid-session edits are picked up.
export function getMergedPermission(globalPath: string | null, projectPaths: string[]): Rule[] {
  const acc: Record<string, unknown> = {};
  if (globalPath) {
    const g = loadPermissionFile(globalPath);
    if (g) mergePermissionInto(acc, g);
  }
  for (const p of projectPaths) {
    const pr = loadPermissionFile(p);
    if (pr) mergePermissionInto(acc, pr);
  }
  return fromConfig(acc);
}

// --- per-tool call-pattern derivation (mirrors kilo's `ctx.ask({ patterns })`) ---
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const WORKTREE = process.cwd();

function relToCwd(p: string): string {
  if (!p) return "";
  const abs = path.isAbsolute(p) ? p : path.resolve(WORKTREE, p);
  let r = path.relative(WORKTREE, abs);
  if (r === "") r = ".";
  return r.replaceAll("\\", "/");
}

function dirGlob(dir: string): string {
  return path.join(dir, "*").replaceAll("\\", "/");
}

// The patterns the agent evaluates for this call. These match the per-tool
// `patterns` in kilocode-src (e.g. read → [rel(file), rel(parent)], bash →
// per-command source text). Defaults to ["*"] when nothing can be derived.
export async function callPatterns(permission: string, rawInput: unknown): Promise<string[]> {
  const t = (permission ?? "").toLowerCase();
  const obj = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  if (t === "bash" || t === "shell") {
    const pats = await bashCallPatterns(asStr(obj.command));
    return pats.length > 0 ? pats : ["*"];
  }
  if (t === "external_directory") {
    const dir = asStr(obj.parentDir) || asStr(obj.directory);
    if (dir) return [dirGlob(dir)];
    const fp = asStr(obj.filePath) || asStr(obj.filepath) || asStr(obj.path);
    if (fp) return [dirGlob(path.dirname(fp))];
    const pats = obj.patterns;
    if (Array.isArray(pats) && pats.length > 0) return pats.filter((p): p is string => typeof p === "string");
    return ["*"];
  }
  if (t === "read" || t === "edit" || t === "write" || t === "apply_patch") {
    const files = obj.files;
    if (Array.isArray(files)) {
      const out: string[] = [];
      for (const f of files) {
        const fo = f as Record<string, unknown>;
        const fp = asStr(fo.filePath) || asStr(fo.filepath) || asStr(fo.path);
        if (fp) out.push(relToCwd(fp));
      }
      if (out.length) return [...new Set(out)];
    }
    const fp = asStr(obj.filePath) || asStr(obj.filepath) || asStr(obj.path);
    if (fp) {
      const rel = relToCwd(fp);
      if (t === "read") {
        const parent = relToCwd(path.dirname(path.resolve(WORKTREE, fp)));
        return [...new Set([rel, parent].filter(Boolean))];
      }
      return [rel];
    }
    return ["*"];
  }
  if (t === "glob" || t === "grep" || t === "warpgrep" || t === "codebase_search") {
    const p = asStr(obj.pattern) || asStr(obj.query) || asStr(obj.regex);
    return p ? [p] : ["*"];
  }
  if (t === "skill") {
    const n = asStr(obj.name);
    return n ? [n] : ["*"];
  }
  if (t === "webfetch") return [asStr(obj.url) || "*"];
  if (t === "websearch") return [asStr(obj.query) || "*"];
  if (t === "repo_clone") {
    const r = asStr(obj.repository) || asStr(obj.url);
    return r ? [r] : ["*"];
  }
  if (t === "recall") {
    const d = asStr(obj.directory) || asStr(obj.path);
    return d ? [d] : ["search"];
  }
  // todowrite, lsp, and unknown/MCP tools: kilo passes patterns=["*"] (or a
  // value we can't reliably derive). Default "*" — blanket rules still match.
  return ["*"];
}

// findLast over the ruleset; default "ask" when no rule matches (matches kilo).
export function evaluate(permission: string, pattern: string, ruleset: Rule[]): Rule {
  let matched: Rule | null = null;
  for (const rule of ruleset) {
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
      matched = rule; // last match wins
    }
  }
  return matched ?? { permission, pattern: "*", action: "ask" };
}

export interface Decision {
  action: Action;
  matched?: Rule;
}

// Evaluate every call pattern: any deny → deny; else any ask → ask; else allow.
export async function decide(permission: string, rawInput: unknown, ruleset: Rule[]): Promise<Decision> {
  const patterns = await callPatterns(permission, rawInput);
  let result: Action = "allow";
  let allowRule: Rule | undefined;
  for (const p of patterns) {
    const rule = evaluate(permission, p, ruleset);
    if (rule.action === "deny") return { action: "deny", matched: rule };
    if (rule.action === "ask") {
      result = "ask";
      continue;
    }
    if (!allowRule) allowRule = rule;
  }
  return { action: result, matched: result === "allow" ? allowRule : undefined };
}
