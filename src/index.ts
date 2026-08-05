#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { join } from "node:path";
import os from "node:os";
import fs from "node:fs";
import { RawInput } from "./rawinput.js";
import { stripBracketedPaste } from "./paste.js";
import { displayWidth } from "./width.js";
import {
  applyUsageUpdate,
  summarizeSessions,
  type SessionUsage,
  type UsageUpdate,
} from "./sessionStats.js";
import {
  serializeHistory,
  serializeHistoryEntry,
  trimHistoryEntries,
  parseHistory,
  type HistoryEntry,
} from "./history.js";

const HISTORY_DIR = join(process.cwd(), ".kilo");
const HISTORY_FILE = join(HISTORY_DIR, "history");
const LAST_SESSION_FILE = join(HISTORY_DIR, "last_session");

// Ensure history dir exists before loading/writing
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// Agent capabilities advertised at initialize. Used to gate client-side
// features (session resume via session/load) that some agents may not support.
let agentCapabilities: {
  loadSession?: boolean;
  sessionCapabilities?: { list?: unknown | null; [k: string]: unknown } | null;
  [k: string]: unknown;
} | null = null;

function writeLastSession(id: string): void {
  try {
    fs.writeFileSync(LAST_SESSION_FILE, id, "utf-8");
  } catch {
    /* ignore write failures — best-effort pointer */
  }
}

function readLastSession(): string | null {
  try {
    if (!fs.existsSync(LAST_SESSION_FILE)) return null;
    const id = fs.readFileSync(LAST_SESSION_FILE, "utf-8").trim();
    return id || null;
  } catch {
    return null;
  }
}

// Per-session usage accounting, keyed by session id and never deleted, so
// sessions that were compacted away (disposed) still appear in /status. Each
// entry is the most recent usage_update seen for that session.
const sessionUsage = new Map<string, SessionUsage>();

function recordUsage(
  sessionId: string,
  role: "main" | "summarizer",
  update: UsageUpdate,
): void {
  applyUsageUpdate(sessionUsage, sessionId, role, update);
}

// Minimal interface the main prompt loop needs from a session. Both the SDK's
// ActiveSession (new sessions) and the local ManualSession (resumed sessions,
// routed via session/update notifications) conform to it.
type MainSession = {
  readonly sessionId: string;
  prompt(prompt: string | unknown | unknown[]): unknown;
  nextUpdate(): Promise<SessionUpdateKind>;
  dispose(): void;
};

let cliContinue = false;
let cliSessionTarget: string | undefined;
let elicitationPolicy = "ask";

const SYSTEM_INSTRUCTIONS = `# Tool usage policy
- You MUST only make ONE tool call per response.
- Do NOT call multiple tools in parallel or batch tool calls together.
- If you need information from multiple tools or files, execute them strictly one at a time sequentially across turns.`;

{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "--continue") {
      cliContinue = true;
    } else if (args[i] === "-s" || args[i] === "--session") {
      if (i + 1 < args.length) {
        cliSessionTarget = args[i + 1];
        i++;
      }
    }
  }
  const raw = process.env.KILO_ACP_ELICITATION_PERMISSION?.trim().toLowerCase();
  if (raw === "deny" || raw === "allow") {
    elicitationPolicy = raw;
  }
}

// Thinking-summary via a second ACP session: instead of streaming the model's
// raw thoughts, we ask a background session to summarize them. To keep cost and
// latency down we summarize periodically, not on every chunk:
//   - the first summary of a thinking block fires after SHORT_GAP (15s) so
//     progress is visible instead of a silent "thinking…" line;
//   - each subsequent summary in the same block waits GAP_STEP (10s) longer
//     than the previous one, backing off until it reaches LONG_GAP (2 minutes),
//     so a long reasoning session doesn't hammer the rate-limited small model.
// Summarization is also skipped for thinking shorter than MIN_CHARS. All
// tunable via env. Cap on sent text keeps the small-model prompt small.
const THINK_SUMMARY_SHORT_GAP = (() => {
  const n = Number.parseInt(process.env.KILO_THINK_SUMMARY_SHORT_GAP ?? process.env.KILO_THINK_SUMMARY_MIN_GAP ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 15000;
})();
const THINK_SUMMARY_LONG_GAP = (() => {
  const n = Number.parseInt(process.env.KILO_THINK_SUMMARY_LONG_GAP ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 120000;
})();
// How much the gap grows each time a summary fires within a thinking block,
// so the summarizer backs off over a long reasoning session. Capped at
// THINK_SUMMARY_LONG_GAP.
const THINK_SUMMARY_GAP_STEP = (() => {
  const n = Number.parseInt(process.env.KILO_THINK_SUMMARY_GAP_STEP ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
})();
const THINK_SUMMARY_MIN_CHARS = (() => {
  const n = Number.parseInt(process.env.KILO_THINK_SUMMARY_MIN_CHARS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 400;
})();
// Cap how much thinking text we send to the summarizer so the prompt stays small.
const THINK_SUMMARY_MAX_CHARS = 8000;

function findKiloConfigPath(): string | null {
  const base = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "kilo")
    : join(os.homedir(), ".config", "kilo");
  const p = join(base, "kilo.jsonc");
  return fs.existsSync(p) ? p : null;
}

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

function loadKiloConfig(): { path: string; config: Record<string, unknown> } | null {
  const path = findKiloConfigPath();
  if (!path) return null;
  try {
    return { path, config: parseJsonc(fs.readFileSync(path, "utf-8")) as Record<string, unknown> };
  } catch (err) {
    console.error(`⚠️  Could not parse kilo config at ${path}: ${(err as Error).message}`);
    return null;
  }
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function colorize(text: string, code: string): string {
  return `${code}${text}${C.reset}`;
}

function visibleWidth(text: string): number {
  return displayWidth(text);
}

function padVisible(str: string, width: number): string {
  const current = displayWidth(str);
  if (current >= width) return str;
  return str + " ".repeat(width - current);
}

function formatMarkdownLine(line: string): string {
  const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
  if (headerMatch) {
    return `${C.bold}${line}${C.reset}`;
  }

  let result = line;

  // Protect inline code spans from any markdown processing. Their content is
  // extracted, the rest of the line is formatted, then the spans are restored
  // so markdown like **bold** inside backticks is left untouched.
  const codeSpans: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, text) => {
    codeSpans.push(text);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  result = result.replace(/\*\*(.+?)\*\*/g, (_, text) => `${C.bold}${text}${C.reset}`);
  result = result.replace(/__([^_].*?)__/g, (_, text) => `${C.bold}${text}${C.reset}`);

  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, text) => `${C.italic}${text}${C.reset}`);

  // Only treat underscores as underline when the opening `_` starts a word,
  // i.e. it is not preceded by a letter or digit. This avoids false matches on
  // snake_case identifiers such as `foo_bar_baz`.
  result = result.replace(/(?<![A-Za-z0-9])_(?!_)(.+?)(?<!_)_(?!_)/g, (_, text) => `${C.underline}${text}${C.reset}`);

  result = result.replace(/\u0000(\d+)\u0000/g, (_m, idx) => `${C.reverse}${codeSpans[Number(idx)]}${C.reset}`);

  return result;
}

function isTableRow(line: string): boolean {
  return /^\|.*\|$/.test(line.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:]+\|$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  return line.trim().split("|").slice(1, -1).map((c) => c.trim());
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (!cur) {
      cur = word;
      continue;
    }
    const candidate = cur + " " + word;
    if (visibleWidth(candidate) <= maxWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

function renderTable(rows: string[]): string {
  if (rows.length === 0) return "";

  const parsed = rows.map(parseTableRow);
  const sepIdx = rows.findIndex(isTableSeparator);
  const hasHeader = sepIdx > 0;

  const headerRows = hasHeader ? parsed.slice(0, sepIdx) : [];
  const bodyRows = hasHeader ? parsed.slice(sepIdx + 1) : parsed;
  const allRows = [...headerRows, ...bodyRows];

  const colCount = Math.max(...parsed.map((r) => r.length), 1);

  const padRow = (r: string[]) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push("");
    return padded;
  };

  const cols: string[][] = Array.from({ length: colCount }, () => []);
  for (const r of allRows) {
    const padded = padRow(r);
    padded.forEach((c, i) => cols[i].push(c));
  }

  const termWidth = process.stdout.columns || 80;
  const overhead = 3 * colCount + 1;
  const available = termWidth - overhead;

  const naturalWidths = cols.map((c) => Math.max(...c.map((v) => visibleWidth(v)), 3));
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

  let widths: number[];
  let needsWrap = false;

  if (available <= 0 || totalNatural <= available) {
    widths = naturalWidths;
  } else {
    needsWrap = true;
    const minWidths = cols.map((c) => {
      let min = 3;
      for (const cell of c) {
        for (const word of cell.split(/\s+/)) {
          min = Math.max(min, visibleWidth(word));
        }
      }
      return Math.min(min, naturalWidths[cols.indexOf(c)]);
    });

    const totalMin = minWidths.reduce((a, b) => a + b, 0);
    if (totalMin >= available) {
      widths = naturalWidths;
      needsWrap = false;
    } else {
      const slack = available - totalMin;
      const extra = naturalWidths.map((w, i) => w - minWidths[i]);
      const totalExtra = extra.reduce((a, b) => a + b, 0);
      if (totalExtra === 0) {
        widths = naturalWidths;
        needsWrap = false;
      } else {
        const w = minWidths.map((min, i) => min + Math.round(slack * extra[i] / totalExtra));
        let diff = available - w.reduce((a, b) => a + b, 0);
        const order = naturalWidths
          .map((nw, i) => i)
          .sort((a, b) => naturalWidths[b] - naturalWidths[a]);
        let oi = 0;
        while (diff > 0) { w[order[oi % colCount]]++; diff--; oi++; }
        oi = 0;
        while (diff < 0 && oi < colCount * 16) {
          const ci = order[oi % colCount];
          if (w[ci] > 3) { w[ci]--; diff++; }
          oi++;
        }
        widths = w;
      }
    }
  }

  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  let out = "";

  if (!needsWrap) {
    for (let ri = 0; ri < headerRows.length; ri++) {
      const r = padRow(headerRows[ri]).map((c) => formatMarkdownLine(c));
      out += sep + "\n";
      out +=
        "| " +
        r.map((c, i) => padVisible(c, widths[i])).join(` ${C.reset}|${C.bold} `) +
        ` ${C.reset}|\n`;
    }
    if (headerRows.length > 0) out += sep + "\n";

    for (let ri = 0; ri < bodyRows.length; ri++) {
      const r = padRow(bodyRows[ri]).map((c) => formatMarkdownLine(c));
      out +=
        "| " +
        r.map((c, i) => padVisible(c, widths[i])).join(` ${C.dim}|${C.reset} `) +
        ` ${C.dim}|${C.reset}\n`;
    }
    if (bodyRows.length > 0) out += sep + "\n";
  } else {
    // Wrap mode — header rows stay single-line, body cells may wrap
    if (headerRows.length > 0) {
      for (let ri = 0; ri < headerRows.length; ri++) {
        const r = padRow(headerRows[ri]).map((c) => formatMarkdownLine(c));
        out += sep + "\n";
        out +=
          "| " +
          r.map((c, i) => padVisible(c, widths[i])).join(` ${C.reset}|${C.bold} `) +
          ` ${C.reset}|\n`;
      }
      out += sep + "\n";
    }

    // Pre-wrap all body cells for consistent column widths within each row group
    const wrappedBody = bodyRows.map((row) =>
      padRow(row).map((cell, ci) => {
        const plainText = cell;
        const wrapped = wrapText(plainText, widths[ci]);
        return wrapped.map((line) => formatMarkdownLine(line));
      }),
    );

    for (let ri = 0; ri < bodyRows.length; ri++) {
      if (!(ri === 0 && hasHeader)) {
        out += sep + "\n";
      }
      const wrapped = wrappedBody[ri];
      const height = Math.max(...wrapped.map((c) => c.length));

      for (let si = 0; si < height; si++) {
        out += "| ";
        for (let ci = 0; ci < colCount; ci++) {
          const line = si < wrapped[ci].length ? wrapped[ci][si] : "";
          out += padVisible(line, widths[ci]);
          if (ci < colCount - 1) {
            out += ` ${C.dim}|${C.reset} `;
          } else {
            out += ` ${C.dim}|${C.reset}`;
          }
        }
        out += "\n";
      }
    }
    if (bodyRows.length > 0) out += sep + "\n";
  }

  return out;
}

class TableAccumulator {
  rows: string[] = [];
  push(line: string): string | null {
    if (isTableRow(line)) {
      this.rows.push(line);
      return null;
    }
    return this.flush();
  }
  flush(): string | null {
    if (this.rows.length === 0) return null;
    const table = renderTable(this.rows);
    this.rows = [];
    return table;
  }
}

const KIND_ICON: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "⚡",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔀",
  todowrite: "📋",
  other: "🔧",
};

type ToolCallLike = {
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  locations?: Array<{ path: string; line?: number | null }> | null;
  content?: unknown[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

function isUnknownOrInvalidToolCall(update: ToolCallLike): boolean {
  const toolName = (update.title ?? "").toLowerCase();
  return toolName === "unknown" || toolName === "invalid";
}

type DiffLike = { path: string; oldText?: string | null; newText: string };

function diffLines(
  oldLines: string[],
  newLines: string[],
): Array<{ type: " " | "-" | "+"; text: string }> {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: Array<{ type: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: " ", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "-", text: oldLines[i] });
      i++;
    } else {
      result.push({ type: "+", text: newLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: "-", text: oldLines[i] });
    i++;
  }
  while (j < n) {
    result.push({ type: "+", text: newLines[j] });
    j++;
  }
  return result;
}

function renderDiff(diff: DiffLike): void {
  const oldLines = (diff.oldText ?? "").split("\n");
  const newLines = diff.newText.split("\n");
  console.log(`${C.cyan}   📝 diff ${diff.path}${C.reset}`);
  for (const line of diffLines(oldLines, newLines)) {
    if (line.type === "-") console.log(`${C.red}   - ${line.text}${C.reset}`);
    else if (line.type === "+") console.log(`${C.green}   + ${line.text}${C.reset}`);
    else console.log(`     ${line.text}`);
  }
}

// Render an edit's change from its rawInput, before the user is asked to approve
// it. Prefers a structured old/new pair (matching the post-approval diff style);
// falls back to a unified-diff string some agents attach to the permission
// request. Returns true if anything was printed.
function renderEditDiffFromRaw(rawInput: unknown, id: string): boolean {
  if (!rawInput || typeof rawInput !== "object") return false;
  const obj = rawInput as Record<string, unknown>;
  const path = (obj.filePath ?? obj.filepath ?? obj.path) as string | undefined;
  const oldStr = (obj.oldString ?? obj.old_str ?? obj.oldText) as string | null | undefined;
  const newStr = (obj.newString ?? obj.new_str ?? obj.newText) as string | undefined;
  if (typeof newStr === "string") {
    renderDiff({ path: path ?? "(file)", oldText: oldStr ?? null, newText: newStr });
    return true;
  }
  // Full-file write tool: the new content arrives as `content` (not
  // `newString`). Read the existing file so we can show a real diff before
  // the user is asked to approve; if the file doesn't exist yet, treat the
  // old text as empty so the whole file renders as additions.
  const fullContent = (obj.content ?? obj.contents) as string | undefined;
  if (typeof fullContent === "string") {
    let oldText: string | null = null;
    if (typeof path === "string") {
      try {
        oldText = fs.readFileSync(path, "utf-8");
      } catch {
        oldText = null;
      }
    }
    renderDiff({ path: path ?? "(file)", oldText, newText: fullContent });
    return true;
  }
  const diffStr = obj.diff as string | undefined;
  if (typeof diffStr === "string" && diffStr.trim()) {
    console.log(`${C.cyan}   📝 diff ${path ?? "(file)"}${C.reset}`);
    for (const line of diffStr.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:") || line.startsWith("===") || line.startsWith("diff ")) {
        console.log(`${C.dim}   ${line}${C.reset}`);
      } else if (line.startsWith("@@")) {
        console.log(`${C.cyan}   ${line}${C.reset}`);
      } else if (line.startsWith("+")) {
        console.log(`${C.green}   ${line}${C.reset}`);
      } else if (line.startsWith("-")) {
        console.log(`${C.red}   ${line}${C.reset}`);
      } else {
        console.log(`   ${line}`);
      }
    }
    return true;
  }
  return false;
}

// Fields we know how to show nicely, in priority order. Anything here that is a
// primitive gets rendered as a labeled part so exploration tools (grep/glob/etc)
// reveal *what* they're searching for instead of just a title.
const INPUT_FIELD_LABELS: Array<[string, string]> = [
  ["command", ""],
  ["pattern", "pattern"],
  ["query", "query"],
  ["regex", "regex"],
  ["include", "include"],
  ["glob", "glob"],
  ["filePath", "file"],
  ["path", "path"],
  ["description", ""],
];

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [key, label] of INPUT_FIELD_LABELS) {
    // `path` is only shown when `filePath` wasn't (they're near-synonyms).
    if (key === "path" && seen.has("filePath")) continue;
    const val = obj[key];
    if (typeof val !== "string" || val === "") continue;
    seen.add(key);
    if (key === "command") parts.push(`${C.green}$ ${val}${C.reset}`);
    else if (label) parts.push(`${C.dim}${label}:${C.reset} ${colorize(val, C.yellow)}`);
    else parts.push(val);
  }
  // For the read tool, show the line range (offset/limit) if provided.
  if (typeof obj.filePath === "string" && obj.filePath !== "") {
    const offset = Number(obj.offset);
    const limit = Number(obj.limit);
    if (Number.isFinite(offset) && offset > 0) {
      const start = offset;
      const end = Number.isFinite(limit) && limit > 0 ? offset + limit - 1 : null;
      const range = end !== null ? `${start}-${end}` : `from ${start}`;
      parts.push(`${C.dim}lines:${C.reset} ${colorize(range, C.yellow)}`);
    } else if (Number.isFinite(limit) && limit > 0) {
      parts.push(`${C.dim}lines:${C.reset} ${colorize(`1-${limit}`, C.yellow)}`);
    }
  }
  return parts.join(`  ${C.dim}|${C.reset}  `);
}

// A plain (uncolored), short description of what a tool call is operating on —
// e.g. the file a read is reading, or the command a bash call is running. Used
// by the heartbeat so "still running …" names the target instead of just the
// tool title.
function plainWhat(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "pattern", "query", "regex", "include", "glob", "filePath", "path", "description"]) {
    const val = obj[key];
    if (typeof val === "string" && val !== "") {
      if (key === "command") return val;
      return val;
    }
  }
  return "";
}

// Try to boil a completed tool call down to a one-line result summary, e.g.
// "found 12 matches" for a grep. Looks at rawOutput first, then text content.
function summarizeResult(update: ToolCallLike): string | null {
  const out = (update as { rawOutput?: unknown }).rawOutput;
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (typeof o.matchCount === "number") return `${o.matchCount} match(es)`;
    if (Array.isArray(o.matches)) return `${o.matches.length} match(es)`;
    if (Array.isArray(o.files)) return `${o.files.length} file(s)`;
    if (Array.isArray(o.results)) return `${o.results.length} result(s)`;
  }
  // Fall back to counting non-empty lines of the first text content block.
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const c = item as { type?: string; content?: { type?: string; text?: string } };
      if (c.type === "content" && c.content?.type === "text" && c.content.text) {
        const lines = c.content.text.split("\n").filter((l) => l.trim()).length;
        if (lines > 0) return `${lines} line(s) of output`;
      }
    }
  }
  return null;
}

// Tracks tool-call IDs we've already printed a header for, so status updates
// (pending -> in_progress -> completed) don't reprint the whole block. Reset at
// the start of every turn.
const announcedToolCalls = new Set<string>();
const renderedContentCount = new Map<string, number>();
const renderedTodoCount = new Map<string, number>();
const knownTodowriteIds = new Set<string>();
// Last compact status we printed for a tool call, so a repeated non-terminal
// status (e.g. the agent re-sending `in_progress` after a permission prompt)
// doesn't produce a duplicate `↳ in_progress` line.
const lastStatus = new Map<string, string>();
// Tool-call IDs whose input summary (the "what it's doing" line: file path,
// command, pattern, …) has already been printed. The first announcement or the
// first compact status update that carries a rawInput prints it once; later
// updates reuse the line above instead of duplicating it.
const printedInputSummary = new Set<string>();
// Tool-call IDs for which we've already rendered an edit diff from its rawInput.
// Edits stream their old/new text in the `in_progress` update, which arrives
// *before* the permission prompt — so we can show the diff for approval. The
// `completed` update later carries the same diff as a content block; this set
// suppresses that duplicate (the change was already shown before approval).
const renderedEditDiffIds = new Set<string>();

// Render grep/search tool output like regular grep: one `path:line: content`
// line per match, all gray. Output is capped at MAX matches; a trailing
// "... (N more)" line (also gray) is shown when the result set is larger.
function renderSearchOutput(text: string): void {
  const MAX = 15;
  let foundTotal: number | null = null;
  let current: string | null = null;
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const found = raw.match(/^Found\s+(\d+)\s+match/i);
    if (found) {
      foundTotal = Number(found[1]);
      continue;
    }
    const indented = /^\s+\S/.test(raw);
    if (!indented && raw.endsWith(":")) {
      current = raw.slice(0, -1);
    } else if (indented) {
      const match = raw.replace(/\s+/g, " ").trim();
      if (match) lines.push(current ? `${current}:${match}` : match);
    } else {
      lines.push(raw);
      current = null;
    }
  }
  const shown = lines.slice(0, MAX);
  for (const l of shown) console.log(`   ${C.dim}${l}${C.reset}`);
  const more = (foundTotal ?? lines.length) - shown.length;
  if (more > 0) console.log(`   ${C.dim}... (${more} more)${C.reset}`);
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return C.green;
    case "failed":
      return C.red;
    case "in_progress":
      return C.yellow;
    default:
      return C.dim;
  }
}

function renderToolCall(
  update: ToolCallLike,
  isUpdate: boolean,
  showBody: boolean,
  force = false,
): void {
  const kind = (update.kind ?? "other").toLowerCase();
  const title = update.title?.toLowerCase() ?? "";
  const displayTitle = update.title ?? update.toolCallId ?? "(untitled)";
  const id = update.toolCallId ?? title;
  const isTodowrite = kind === "todowrite" || title === "todowrite";
  if (isTodowrite) knownTodowriteIds.add(id);
  const icon = KIND_ICON[kind] ?? KIND_ICON.other;
  const status = update.status ?? (isUpdate ? "" : "pending");
  const terminal = status === "completed" || status === "failed";

  // First time we see this tool call (or a forced full render, e.g. a permission
  // prompt): print the header + what it's doing.
  if (force || !announcedToolCalls.has(id)) {
    announcedToolCalls.add(id);
    const statusLabel = status ? ` ${statusColor(status)}${status}${C.reset}` : "";
    console.log(`\n${icon} ${C.bold}${displayTitle}${C.reset} ${C.blue}[${kind}]${C.reset}${statusLabel}`);

    if (Array.isArray(update.locations)) {
      for (const loc of update.locations) {
        console.log(`   ${C.dim}📄 ${loc.path}${loc.line ? `:${loc.line}` : ""}${C.reset}`);
      }
    }
    const summary = summarizeInput(update.rawInput);
    if (summary) {
      console.log(`   ${summary}`);
      printedInputSummary.add(id);
    }
    if (status) lastStatus.set(id, status);
  } else if (status) {
    // Already announced: show a compact one-line status transition instead of
    // reprinting the whole block. Include a result summary when finishing.
    // Skip a non-terminal status that is identical to the last one we printed
    // (e.g. the agent re-sending `in_progress` after a permission prompt) so
    // we don't emit a duplicate `↳ in_progress` line.
    if (!terminal && lastStatus.get(id) === status) return;
    lastStatus.set(id, status);
    // If the first announcement didn't carry a rawInput (so the "what it's
    // doing" line was never printed), print it now from the first update that
    // does — this is what makes a `read` show what it's reading, and an
    // `in_progress` show what's in progress, instead of a bare status word.
    if (!printedInputSummary.has(id)) {
      const summary = summarizeInput(update.rawInput);
      if (summary) {
        printedInputSummary.add(id);
        console.log(`   ${summary}`);
      }
    }
    const result = terminal ? summarizeResult(update) : null;
    const resultLabel = result ? ` ${C.dim}(${result})${C.reset}` : "";
    console.log(`   ${statusColor(status)}↳ ${status}${C.reset}${resultLabel}`);
  }

  // Edits: show the diff for approval as soon as the old/new text is available,
  // which is the `in_progress` update — before the permission prompt. Rendered
  // once per call; the later `completed` content diff is suppressed by
  // renderedEditDiffIds so the change isn't printed again after approval.
  if (kind === "edit" && !renderedEditDiffIds.has(id)) {
    if (renderEditDiffFromRaw(update.rawInput, id)) {
      renderedEditDiffIds.add(id);
    }
  }

  if (isTodowrite && update.rawInput) {
    const input = update.rawInput as { todos?: Array<{ content: string; status: string; priority: string }> };
    if (Array.isArray(input.todos)) {
      const prevCount = renderedTodoCount.get(id) ?? 0;
      const currentCount = input.todos.length;
      if (force || currentCount !== prevCount || !announcedToolCalls.has(id)) {
        renderedTodoCount.set(id, currentCount);
        for (const todo of input.todos) {
          const icon = todo.status === "completed" ? `${C.green}✓${C.reset}`
            : todo.status === "in_progress" ? `${C.yellow}▶${C.reset}`
            : todo.status === "cancelled" ? `${C.red}✗${C.reset}`
            : `${C.dim}☐${C.reset}`;
          const prio = todo.priority === "high" ? ` ${C.red}[!]${C.reset}`
            : todo.priority === "medium" ? ` ${C.yellow}[·]${C.reset}`
            : "";
          const text = todo.status === "completed" ? `${C.dim}${todo.content}${C.reset}`
            : todo.status === "cancelled" ? `${C.dim}${todo.content}${C.reset}`
            : todo.content;
          console.log(`   ${icon}${prio} ${text}`);
        }
      }
    }
  }

  // Stream intermediate content as it arrives instead of waiting for the tool
  // to finish. Tracks how many content items have been rendered per call so only
  // new items are emitted on each update.
  if (showBody && kind !== "read" && !isTodowrite && !knownTodowriteIds.has(id) && Array.isArray(update.content)) {
    const prevCount = renderedContentCount.get(id) ?? 0;
    const total = update.content.length;
    const showFrom = terminal || !status || force ? prevCount : prevCount;
    for (let i = showFrom; i < total; i++) {
      const item = update.content[i];
      const c = item as { type?: string; content?: { type?: string; text?: string }; path?: string; oldText?: string | null; newText?: string };
      if (c.type === "diff") {
        // Already shown before approval (renderEditDiffFromRaw); skip the
        // duplicate that the completed update carries.
        if (kind === "edit" && renderedEditDiffIds.has(id)) continue;
        renderDiff(c as DiffLike);
      } else if (c.type === "content" && c.content?.type === "text" && c.content.text) {
        if (kind === "search") {
          renderSearchOutput(c.content.text);
        } else {
          const text = c.content.text.split("\n").join(`\n   `);
          console.log(`   ${C.dim}${text}${C.reset}`);
        }
      }
    }
    if (total > prevCount) renderedContentCount.set(id, total);
  }
}

const history: HistoryEntry[] = [];
if (fs.existsSync(HISTORY_FILE)) {
  const content = fs.readFileSync(HISTORY_FILE, "utf-8");
  history.push(...parseHistory(content));
}

// Append a prompt (or slash command) to the on-disk history, deduping against
// the most recent entry. Every submitted line — including slash commands like
// /status, /help, /exit — is recorded, so history reflects what was actually
// typed. If the file then exceeds HISTORY_MAX_BYTES it is rewritten to keep
// only the most recent entries (HISTORY_KEEP_ON_TRIM), so it stays bounded.
function appendHistory(text: string): void {
  if (history.length > 0 && history[history.length - 1].text === text) return;
  try {
    fs.appendFileSync(HISTORY_FILE, serializeHistoryEntry(text));
  } catch {
    return;
  }
  history.push({ text, isMultiline: text.includes("\n") });
  trimHistoryFile();
}

// Rewrite the history file in place, keeping only `keep`. Also drops the
// trimmed entries from the in-memory array so the two stay in sync.
function trimHistoryFile(): void {
  let byteLength: number;
  try {
    byteLength = fs.statSync(HISTORY_FILE).size;
  } catch {
    return;
  }
  const keep = trimHistoryEntries(history, byteLength);
  if (keep === null) return;
  try {
    fs.writeFileSync(HISTORY_FILE, serializeHistory(keep), "utf-8");
  } catch {
    return;
  }
  history.splice(0, history.length - keep.length);
}

const COMMAND_HELP: Record<string, string> = {
  "/exit": "Exit the interactive client",
  "/quit": "Exit the interactive client",
  "/sessions": "Switch to another session (alias: /resume, /continue)",
  "/resume": "Resume / switch to a previous session",
  "/continue": "Continue the most recent session",
  "/new": "Start a new session (alias: /clear)",
  "/clear": "Clear and start a new session",
  "/share": "Create a read-only shareable link for the session",
  "/unshare": "Remove the shareable link",
  "/rename": "Rename the current session",
  "/timeline": "Jump to a specific message in the timeline",
  "/fork": "Fork the session from a chosen message",
  "/compact": "Compact/summarize the session to save context (alias: /summarize)",
  "/summarize": "Summarize the session to save context",
  "/undo": "Undo the previous message",
  "/redo": "Redo an undone message",
  "/copy": "Copy the latest agent response",
  "/copy-session": "Copy the full session transcript",
  "/export": "Export the session transcript",
  "/timestamps": "Toggle message timestamps (alias: /toggle-timestamps)",
  "/toggle-timestamps": "Toggle message timestamps",
  "/thinking": "Toggle display of thinking blocks (alias: /toggle-thinking)",
  "/toggle-thinking": "Toggle display of thinking blocks",
  "/models": "Switch the active model",
  "/agents": "Switch the active agent",
  "/mcps": "Toggle MCP servers on/off",
  "/connect": "Connect/add a provider and its API credentials",
  "/status": "Show sessions, models, and token/cost usage",
  "/themes": "Switch the UI theme",
  "/help": "Show this list of commands and what they do",
  "/reload": "Reload config, skills, agents, and commands from disk",
  "/editor": "Open an external editor for the prompt",
  "/q": "Exit the client",
  "/profile": "Show your Kilo Gateway profile (alias: /me, /whoami)",
  "/me": "Show your Kilo Gateway profile",
  "/whoami": "Show your Kilo Gateway profile",
  "/teams": "Switch Kilo Gateway teams (alias: /team, /org, /orgs)",
  "/team": "Switch Kilo Gateway team",
  "/org": "Switch Kilo Gateway organization",
  "/orgs": "Switch Kilo Gateway organization",
  "/remote": "Toggle remote mode for Cloud Agent access",
  "/init": "Create/update the project AGENTS.md file",
  "/review": "Review code changes locally",
  "/tasks": "Show tasks (alias: /t, /history)",
};

const COMMANDS: string[] = Object.keys(COMMAND_HELP);

const IMPLEMENTED_COMMANDS = new Set(["/exit", "/quit", "/help", "/status", "/compact", "/summarize"]);
const STUB_COMMANDS = new Set(
  COMMANDS.filter((c) => !IMPLEMENTED_COMMANDS.has(c)),
);

function buildAgentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LOG_LEVEL = "debug";
  // The prebuilt kilo binary auto-adds `"bash": "allow"` to its global config,
  // which would let the agent run any shell command (e.g. `rm`) without a prompt.
  // Force `bash` to a safer default via KILO_CONFIG_CONTENT, which is loaded
  // after the global/project configs and therefore wins the deep-merge.
  // Override with KILO_ACP_BASH_PERMISSION (e.g. "deny", "allow").
  // `task` is disabled because it blocks waiting for user input that this client
  // cannot provide (it expects a TUI). `suggest` and `question` are also disabled:
  // the stock `kilo acp` agent never relays them as a client request, so the tool
  // call would hang in pending forever. If a future kilo version bridges them to
  // `client/elicitation.create`, set these back to "ask".
  const forced = process.env.KILO_ACP_BASH_PERMISSION ?? "ask";
  let config: Record<string, unknown> = {};
  if (process.env.KILO_CONFIG_CONTENT) {
    try {
      config = JSON.parse(process.env.KILO_CONFIG_CONTENT) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const permission = (config.permission as Record<string, unknown>) ?? {};
  if (forced) {
    env.KILO_CONFIG_CONTENT = JSON.stringify({
      ...config,
      permission: { ...permission, suggest: "deny", question: "deny", task: "deny", bash: forced },
    });
  } else {
    env.KILO_CONFIG_CONTENT = JSON.stringify({
      ...config,
      permission: { ...permission, suggest: "deny", question: "deny", task: "deny" },
    });
  }
  return env;
}

// How long to block the agent's response for while waiting on the small-model
// thinking summary. Tunable via env. The summary is best-effort: if the small
// model is slow we fall back to a one-line stats summary after this delay.
const SUMMARY_WAIT_MS = (() => {
  const n = Number.parseInt(process.env.KILO_THINK_SUMMARY_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 6000;
})();

// Resolve the small model to use for thinking summarization. Priority:
// explicit env override > kilo config `small_model` > the kilo free dispatcher.
function resolveSmallModel(kiloConfig: { config: Record<string, unknown> } | null): string {
  const env = process.env.KILO_THINK_SUMMARY_MODEL?.trim();
  if (env) return env;
  const fromConfig = kiloConfig?.config.small_model;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim();
  return "kilo/kilo-auto/free";
}

// Build the environment for the summarizer subagent. It runs a separate `kilo
// acp` process whose config is forced to the small model (e.g. the kilo free
// dispatcher, which needs no user-supplied API key) and denies every tool, so
// it can only summarize text — never run commands or touch files.
function buildSummarizerEnv(model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LOG_LEVEL = "debug";
  let config: Record<string, unknown> = {};
  if (process.env.KILO_CONFIG_CONTENT) {
    try {
      config = JSON.parse(process.env.KILO_CONFIG_CONTENT) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const existingAgent = (config.agent as Record<string, Record<string, unknown>>) ?? {};
  const agent: Record<string, unknown> = {};
  for (const key of Object.keys(existingAgent)) {
    agent[key] = { ...existingAgent[key], model };
  }
  for (const key of ["code", "explore", "general", "ask"]) {
    agent[key] = { ...(agent[key] as Record<string, unknown> | undefined), model };
  }
  // Force the `kilo` provider into the summarizer config when the small model is
  // a `kilo/*` model (e.g. the free dispatcher). Without an explicit `kilo`
  // provider entry, kilo may resolve `kilo/kilo-auto/free` only when it can, and
  // fall back to the user's main provider/model (e.g. openrouter/glm) when the
  // free tier is rate-limited — which silently bills the summarizer to glm.
  const provider = { ...((config.provider as Record<string, unknown>) ?? {}) };
  if (model.startsWith("kilo/") && !provider.kilo) {
    provider.kilo = {};
  }
  env.KILO_CONFIG_CONTENT = JSON.stringify({
    ...config,
    provider,
    model,
    small_model: model,
    agent,
    permission: { "*": "deny" },
  });
  return env;
}

// Redact secret values (api keys / tokens) from a config object so it can be
// logged safely. Returns a JSON string.
function redactConfigForLog(obj: unknown): string {
  const redact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/key|token|secret|password|auth/i.test(k) && typeof val === "string") {
          out[k] = val ? "***" : val;
        } else {
          out[k] = redact(val);
        }
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(redact(obj));
  } catch {
    return "(unserializable)";
  }
}

// A dedicated summarizer subagent: its own `kilo acp` process configured to use
// the small model, exposed as a long-lived ACP session we prompt with thinking
// text. Optional and best-effort — if it fails to start we fall back to a plain
// stats summary, so the main client keeps working.
class ThinkSummarizer {
  readonly model: string;
  private proc: ReturnType<typeof spawn> | null = null;
  private connection: acp.ClientConnection | null = null;
  private session: acp.ActiveSession | null = null;
  private logStream: fs.WriteStream | null = null;
  private ready = false;
  private starting: Promise<string> | null = null;
  // Latest usage_update seen from the summarizer session, surfaced by /status.
  lastUsage = { used: 0, size: 0, costAmount: 0, costCurrency: "" };

  constructor(model: string) {
    this.model = model;
  }

  get available(): boolean {
    return this.ready && this.session !== null;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  private log(msg: string): void {
    if (!this.logStream) return;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { this.logStream.write(line); } catch { /* ignore */ }
  }

  start(agentCmd: string, agentArgs: string[], cwd: string): Promise<string> {
    if (this.starting) return this.starting as Promise<string>;
    this.starting = (async (): Promise<string> => {
      const logPath = join(HISTORY_DIR, "summarizer.log");
      this.logStream = fs.createWriteStream(logPath, { flags: "a" });
      const env = buildSummarizerEnv(this.model);
      this.log(`start model=${this.model} agentCmd=${agentCmd} ${agentArgs.join(" ")} cwd=${cwd}`);
      try {
        this.log(`start env KILO_CONFIG_CONTENT=${redactConfigForLog(JSON.parse(env.KILO_CONFIG_CONTENT ?? "{}"))}`);
      } catch { /* ignore */ }
      this.proc = spawn(agentCmd, agentArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      this.proc.stderr!.pipe(this.logStream);
      this.proc.on("error", (e) => { this.log(`proc error: ${e.message}`); this.ready = false; this.proc = null; });
      this.proc.on("exit", (code, sig) => { this.log(`proc exit code=${code} signal=${sig}`); this.ready = false; this.proc = null; });
      try {
        const input = Writable.toWeb(this.proc.stdin!);
        const output = Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>;
        const stream = acp.ndJsonStream(input, output);
        this.connection = acp
          .client({ name: "kilo-acp-summarizer" })
          .onRequest(acp.methods.client.session.requestPermission, () => ({
            outcome: { outcome: "cancelled" as const },
          }))
          .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
          .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: "" }))
          .onRequest(acp.methods.client.elicitation.create, () => ({
            action: "cancel" as const,
          }))
          .connect(stream);
        const cx = this.connection.agent;
        await cx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            elicitation: { form: {}, url: {} },
          },
        });
        this.session = await cx.buildSession(cwd).start();
        this.ready = true;
        this.log(`ready model=${this.model} session=${this.session.sessionId}`);
        return "ready";
      } catch (err) {
        this.log(`start failed: ${(err as Error).message}`);
        this.disposeInternal();
        return `unavailable: ${(err as Error).message}`;
      }
    })();
    return this.starting;
  }

  async summarize(prompt: string): Promise<string | null> {
    if (!this.available || !this.session) return null;
    this.log(`summarize promptLen=${prompt.length} session=${this.session.sessionId}`);
    try {
      await this.session.prompt(prompt);
      // Drain updates ourselves instead of readText() so we can capture
      // usage_update notifications for /status. Only agent_message_chunk
      // text contributes to the summary; everything else is ignored.
      let text = "";
      for (;;) {
        const msg = await this.session.nextUpdate();
        if (msg.kind === "stop") break;
        const upd = msg.update as Record<string, any>;
        if (upd.sessionUpdate === "agent_message_chunk" && upd.content?.type === "text") {
          text += upd.content.text;
        } else if (upd.sessionUpdate === "usage_update") {
          this.lastUsage = {
            used: Number(upd.used) || 0,
            size: Number(upd.size) || 0,
            costAmount: Number(upd.cost?.amount ?? 0) || 0,
            costCurrency: typeof upd.cost?.currency === "string" ? upd.cost.currency : "",
          };
          const sid = this.session?.sessionId;
          if (sid) recordUsage(sid, "summarizer", upd);
        }
      }
      this.log(`summarize ok resultLen=${text.length}`);
      return text.trim();
    } catch (err) {
      this.log(`summarize failed: ${(err as Error).message}`);
      return null;
    }
  }

  private disposeInternal() {
    try { this.session?.dispose(); } catch { /* ignore */ }
    try { this.connection?.close(); } catch { /* ignore */ }
    this.session = null;
    this.connection = null;
    this.ready = false;
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      this.proc = null;
    }
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = null;
  }

  dispose() {
    this.disposeInternal();
  }
}

let thinkSummarizer: ThinkSummarizer | null = null;

// Holds the latest thinking summary for a turn and prints it at safe points:
// immediately when a mid-thinking summary resolves (so long thinking isn't
// silent), after the user answers a permission/elicitation prompt, or just
// before the agent's response text. While a prompt is on screen the deferred
// summary is held so it never interleaves with it; only the most recent one is
// shown.
class SummaryGate {
  private summarizer: ThinkSummarizer | null;
  private pending: Promise<string | null> | null = null;
  private latest: string | null = null;
  private fallback: string | null = null;
  private dirty = false;
  private inFlight = false;
  private lastAt = 0;
  private token = 0;
  // Start of the current thinking block, used by the adaptive gap (short gap
  // while the block is fresh, long gap once it has run a long time).
  private blockStart = 0;
  // How many summaries have fired in the current thinking block. The gap
  // grows by THINK_SUMMARY_GAP_STEP each fire so a long block backs off from
  // SHORT_GAP toward LONG_GAP instead of running at a fixed cadence.
  private gapCount = 0;
  // True while a prompt turn is in progress. Once the turn ends (the agent has
  // finished and we're back at the `kilo>` prompt) this is false, so a
  // late-resolving summary is dropped instead of being printed into the prompt
  // line and corrupting the user's input.
  private turnActive = false;
  // True once the current turn has produced any "real" output (a tool call, a
  // tool-call update, or the agent's response text). While set, the mid-block
  // "summarizing thinking…" marker and the immediate mid-block summary emit
  // are suppressed so the stderr chrome can't interleave with stdout tool/
  // response output. The single pre-response summary (emitBeforeResponse) and
  // the post-permission emit (emitIfResolved at a safe point) still fire.
  realOutputSeen = false;

  constructor(summarizer: ThinkSummarizer | null) {
    this.summarizer = summarizer;
  }

  // Adaptive gap: start at SHORT_GAP and add GAP_STEP for every summary that
  // has already fired in this block, so the cadence backs off toward LONG_GAP
  // (2 minutes) instead of a fixed interval over a long reasoning session.
  private gapMs(): number {
    const gap = THINK_SUMMARY_SHORT_GAP + this.gapCount * THINK_SUMMARY_GAP_STEP;
    return gap > THINK_SUMMARY_LONG_GAP ? THINK_SUMMARY_LONG_GAP : gap;
  }

  private statsLine(dur: number, usedTokens: number, thoughtChars: number): string {
    const usage = usedTokens > 0 ? ` · ${usedTokens} tokens` : "";
    const chars = thoughtChars > 0 ? ` · ${thoughtChars} chars` : "";
    return `💭 thought ${dur}s${usage}${chars}`;
  }

  // Start a small-model summary of `text` if the adaptive gap has elapsed, the
  // text is substantial, and the summarizer is free. Always records the stats
  // fallback (printed if no real summary lands). Only the last portion of the
  // thinking is sent to keep the small-model prompt tiny. When `printImmediate`
  // is true (mid-thinking ticks) the result is printed as soon as it resolves;
  // otherwise it is left for emitBeforeResponse/emitIfResolved at a safe point.
  private fire(
    text: string,
    dur: number,
    usedTokens: number,
    thoughtChars: number,
    printImmediate: boolean,
  ): void {
    this.fallback = this.statsLine(dur, usedTokens, thoughtChars);
    this.dirty = true;
    if (!this.summarizer || !this.summarizer.available || this.inFlight) return;
    if (text.length < THINK_SUMMARY_MIN_CHARS) return;
    if (Date.now() - this.lastAt < this.gapMs()) return;
    this.lastAt = Date.now();
    this.gapCount++;
    this.inFlight = true;
    // Suppress the live "summarizing thinking…" marker once the turn has
    // produced real (stdout) output — writing it to stderr then would
    // interleave with the tool/response output and read as noise.
    if (printImmediate && !awaitingUserInput && !this.realOutputSeen) {
      process.stderr.write(`   ${C.gray}💭 summarizing thinking…${C.reset}\n`);
    }
    const tok = ++this.token;
    const snippet = text.slice(-THINK_SUMMARY_MAX_CHARS);
    const prompt =
      "Summarize the following reasoning in one short sentence. " +
      "Do not use any tools. Reply with only the summary, no preamble.\n\n" +
      `"""${snippet}"""`;
    const startedDur = dur;
    this.pending = this.summarizer
      .summarize(prompt)
      .then((s) => {
        if (tok !== this.token) return null;
        const t = (s ?? "").trim();
        if (t) this.latest = `💭 summary (${startedDur}s): ${t}`;
        return t || null;
      })
      .catch(() => null)
      .finally(() => {
        if (tok === this.token) this.inFlight = false;
        // Print immediately only at a safe point (no permission/elicitation
        // prompt on screen) and only when no real output has been emitted this
        // turn; otherwise leave it for emitIfResolved/emitBeforeResponse to
        // print at the next safe point.
        if (printImmediate && !awaitingUserInput && !this.realOutputSeen) this.emitIfResolved();
      });
  }

  // Mark the start of a thinking block so the adaptive gap can measure how long
  // the current block has been running. Also seed `lastAt` to the block start:
  // `reset()` leaves it at 0, which would make `Date.now() - lastAt` enormous and
  // so the gap check in `fire()` would pass on the very first heartbeat (~2s),
  // firing a summary far earlier than the intended SHORT_GAP. That premature
  // summary tends to resolve right as a quick tool call shows its permission
  // prompt, and (being `printImmediate`) it lands on the prompt line. Seeding
  // `lastAt` here keeps the first summary SHORT_GAP after the block starts.
  beginThinking(): void {
    this.blockStart = Date.now();
    this.lastAt = this.blockStart;
    this.gapCount = 0;
  }

  // Called from the heartbeat while a thinking block is active. Fires a summary
  // (printed immediately on resolve) so long thinking shows progress instead of
  // a silent "thinking…" line.
  tickThinking(text: string, dur: number, usedTokens: number, thoughtChars: number): void {
    this.fire(text, dur, usedTokens, thoughtChars, true);
  }

  // Called when a thinking block ends. Fires a summary for the deferred emit
  // before the response; always records the stats fallback so something shows.
  onThinkingEnd(text: string, dur: number, usedTokens: number, thoughtChars: number): void {
    this.blockStart = 0;
    this.fire(text, dur, usedTokens, thoughtChars, false);
  }

  // After a permission/elicitation is answered: print the summary only if it has
  // already occurred (resolved). Never block — an in-flight summary is left for
  // the before-response flush.
  //
  // Never print while a permission/elicitation prompt is on screen: the prompt
  // is written to stdout with no trailing newline, and this line goes to stderr,
  // so emitting here would append onto the prompt line and corrupt it. Leave the
  // summary dirty for the post-answer emit (handleRequestPermission/
  // handleElicitation call this again once awaitingUserInput is false).
  emitIfResolved(): void {
    if (!this.turnActive) return;
    if (!this.dirty) return;
    if (awaitingUserInput) return;
    if (this.pending !== null && this.latest === null) return;
    const line = this.latest ?? this.fallback;
    this.dirty = false;
    this.latest = null;
    if (line) process.stderr.write(`   ${C.gray}${line}${C.reset}\n`);
  }

  // Before the agent's response text: wait briefly for the small-model summary
  // and print it (or the stats fallback). Prints at most once per dirty cycle.
  async emitBeforeResponse(): Promise<void> {
    if (!this.turnActive) return;
    if (!this.dirty) return;
    if (awaitingUserInput) return;
    if (this.pending !== null) {
      try {
        await Promise.race([
          this.pending,
          new Promise<null>((r) => setTimeout(() => r(null), SUMMARY_WAIT_MS)),
        ]);
      } catch {
        /* ignore */
      }
      this.pending = null;
    }
    // A permission/elicitation prompt may have appeared while we waited for
    // the small-model summary. Don't print onto its line (the prompt is on
    // stdout with no trailing newline, this goes to stderr): leave the
    // summary dirty for the post-answer emitIfResolved to flush at a safe
    // point once awaitingUserInput is false again.
    if (awaitingUserInput) return;
    const line = this.latest ?? this.fallback;
    this.dirty = false;
    this.latest = null;
    if (line) process.stderr.write(`   ${C.gray}${line}${C.reset}\n`);
  }

  reset() {
    this.turnActive = true;
    this.dirty = false;
    this.pending = null;
    this.latest = null;
    this.fallback = null;
    this.blockStart = 0;
    this.lastAt = 0;
    this.gapCount = 0;
    this.realOutputSeen = false;
  }

  // Called when the agent's turn has ended and we're returning to the prompt.
  // Late-resolving summaries are dropped rather than printed into the prompt.
  endTurn(): void {
    this.turnActive = false;
  }
}

let summaryGate: SummaryGate | null = null;

function colorCommand(c: string): string {
  const implemented = IMPLEMENTED_COMMANDS.has(c);
  const code = implemented ? C.green : C.cyan;
  return colorize(c, code);
}

function printCommandHelp(): void {
  const items = COMMANDS.map((c) => ({
    cmd: colorCommand(c),
    desc: colorize(COMMAND_HELP[c], C.dim),
    width: visibleWidth(colorCommand(c)),
  }));
  const colWidth = Math.max(...items.map((i) => i.width));
  const lines = items.map(
    (it) => `  ${it.cmd.padEnd(colWidth)}  ${it.desc}`,
  );
  process.stderr.write(
    `\n${C.bold}Commands${C.reset}  ${C.dim}(${C.green}green${C.reset}${C.dim}=available, ` +
      `${C.cyan}cyan${C.reset}${C.dim}=agent-side)${C.reset}\n${lines.join("\n")}\n`,
  );
}

const COMPLETABLE_COMMANDS: string[] = COMMANDS.filter(
  (c) => IMPLEMENTED_COMMANDS.has(c),
);

function completer(line: string): [string[], string] {
  const prefix = line.toLowerCase();
  const hits = COMPLETABLE_COMMANDS.filter((c) =>
    c.toLowerCase().startsWith(prefix),
  );
  if (hits.length === 0) return [[], line];
  return [hits, line];
}

const rawInput = new RawInput(process.stdout, {
  prompt: "kilo> ",
  history,
  completer,
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

type InputTarget = "main" | "confirm" | "discard";

let stdinDetach: (() => void) | null = null;
let inBracketedPaste = false;
let pasteResidue: Buffer = Buffer.alloc(0);

function splitUtf8Residue(buf: Buffer): { complete: Buffer; residue: Buffer } {
  let residueLen = 0;
  for (let i = buf.length - 1; i >= 0 && residueLen < 3; i--) {
    const b = buf[i];
    if (b >= 0xc0) {
      const expectedLen = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      const remaining = buf.length - i;
      if (remaining < expectedLen) residueLen = remaining;
      break;
    }
  }
  if (residueLen === 0) return { complete: buf, residue: Buffer.alloc(0) };
  const cutPos = buf.length - residueLen;
  return {
    complete: buf.subarray(0, cutPos),
    residue: buf.subarray(cutPos),
  } as { complete: Buffer; residue: Buffer };
}
const setInputTarget = (target: InputTarget): void => {
  if (stdinDetach) {
    stdinDetach();
    stdinDetach = null;
  }
  process.stdin.resume();

  const handler = (chunk: Buffer) => {
    if (chunk.length === 0) return;

    const idx03 = chunk.indexOf(0x03);
    const idx04 = chunk.indexOf(0x04);

    if (idx03 !== -1) {
      if (rawInput.isSearching) {
        rawInput.handleBytes(chunk);
        return;
      }
      if (
        !inMainLoop ||
        (target === "main" && rawInput.isEmpty) ||
        cancelController.signal.aborted
      ) {
        cleanup(0);
        return;
      }
      cancelController.abort();
      if (target === "main" || target === "confirm") {
        rawInput.abort();
      }
      return;
    }

    if (idx04 !== -1) {
      if (target === "main" && rawInput.isEmpty) {
        cleanup(0);
        return;
      }
      if (target === "main") {
        rawInput.handleBytes(chunk);
      }
      return;
    }

    if (target === "discard") return;
    // While a permission/elicitation prompt is on screen, `readSingleLine` owns
    // the real input reading (its own listener). Here we just discard the chunk
    // so typed/pasted permission input is never fed into the main `rawInput`
    // buffer, and the shared `inBracketedPaste` flag can't get stuck on a paste.
    if (target === "confirm") return;

    const str = chunk.toString("utf-8");
    if (str.includes("\x1b[200~")) {
      inBracketedPaste = true;
      rawInput.setPasteMode(true);
      pasteResidue = Buffer.alloc(0);
      const idx = chunk.indexOf(Buffer.from("\x1b[200~"));
      if (idx !== -1) {
        const rest = chunk.subarray(idx + 6);
        if (rest.length > 0) {
          const brkIdx = rest.indexOf(Buffer.from("\x1b[201~"));
          if (brkIdx !== -1) {
            const pasteContent = rest.subarray(0, brkIdx);
            const trailing = rest.subarray(brkIdx + 6);
            inBracketedPaste = false;
            if (target === "main") {
              const converted = pasteContent
                .toString("utf-8")
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n");
              rawInput.handleBytes(Buffer.from(converted, "utf-8"));
            }
            rawInput.setPasteMode(false);
            if (trailing.length > 0 && target === "main") {
              rawInput.handleBytes(trailing);
            }
          } else {
            pasteResidue = rest;
          }
        }
      }
      return;
    }
    if (str.includes("\x1b[201~")) {
      inBracketedPaste = false;
      const brkIdx = chunk.indexOf(Buffer.from("\x1b[201~"));
      if (brkIdx !== -1) {
        const before = chunk.subarray(0, brkIdx);
        let pasteBuf = pasteResidue;
        if (before.length > 0) {
          pasteBuf = Buffer.concat([pasteResidue, before]) as Buffer;
        }
        if (pasteBuf.length > 0 && target === "main") {
          const converted = pasteBuf
            .toString("utf-8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          rawInput.handleBytes(Buffer.from(converted, "utf-8"));
        }
        rawInput.setPasteMode(false);
        pasteResidue = Buffer.alloc(0);
        const trailing = chunk.subarray(brkIdx + 6);
        if (trailing.length > 0 && target === "main") {
          rawInput.handleBytes(trailing);
        }
      } else {
        if (pasteResidue.length > 0 && target === "main") {
          const converted = pasteResidue
            .toString("utf-8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          rawInput.handleBytes(Buffer.from(converted, "utf-8"));
          pasteResidue = Buffer.alloc(0);
        }
        rawInput.setPasteMode(false);
      }
      return;
    }

    if (inBracketedPaste && target === "main") {
      const full: Buffer = Buffer.concat([pasteResidue, chunk]) as Buffer;
      const brkIdx = full.indexOf(Buffer.from("\x1b[201~"));
      if (brkIdx !== -1) {
        const pasteContent = full.subarray(0, brkIdx);
        const trailing = full.subarray(brkIdx + 6);
        inBracketedPaste = false;
        pasteResidue = Buffer.alloc(0);
        const converted = pasteContent
          .toString("utf-8")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        rawInput.handleBytes(Buffer.from(converted, "utf-8"));
        rawInput.setPasteMode(false);
        if (trailing.length > 0) {
          const { complete: tsComplete, residue: tsResidue } = splitUtf8Residue(trailing);
          if (tsComplete.length > 0) rawInput.handleBytes(tsComplete);
          if (tsResidue.length > 0) pasteResidue = Buffer.from(tsResidue);
        }
        return;
      }
      const { complete, residue } = splitUtf8Residue(full);
      pasteResidue = Buffer.from(residue);
      const converted = complete
        .toString("utf-8")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      rawInput.handleBytes(Buffer.from(converted, "utf-8"));
      return;
    }

    rawInput.handleBytes(chunk);
  };

  process.stdin.on("data", handler);
  stdinDetach = () => process.stdin.removeListener("data", handler);
};

// Start discarding: nothing should be consumed until we explicitly open the
// main prompt (or a permission prompt) below.
setInputTarget("discard");

// Enable bracketed paste so we can distinguish real terminal pastes from
// typed keystrokes and drop pasted content during output / permission prompts.
if (process.stdin.isTTY) {
  process.stdout.write("\x1b[?2004h");
}

let inMainLoop = false;

// A single abort controller drives cancel-on-Ctrl+C behaviour. Pressing
// Ctrl+C sets this; pending `ask()` calls reject and loops bail out so we can
// return to the prompt instead of exiting or spamming error messages.
let cancelController = new AbortController();
const resetCancel = () => {
  cancelController = new AbortController();
};

// True while we're blocked at a prompt waiting for the *user* (e.g. a permission
// choice). The heartbeat checks this so it stays quiet instead of printing
// "still working…" while the agent is actually waiting on you.
let awaitingUserInput = false;
// When the last user-input wait ended, so the heartbeat doesn't immediately fire
// a stale "idle" message right after you answer a prompt.
let lastUserInputEndedAt = 0;

let userInputResolve: (() => void) | null = null;

function startAwaitingUserInput() {
  awaitingUserInput = true;
  setInputTarget("confirm");
}

function stopAwaitingUserInput() {
  awaitingUserInput = false;
  lastUserInputEndedAt = Date.now();
  setInputTarget("discard");
  if (userInputResolve) {
    userInputResolve();
    userInputResolve = null;
  }
}

function waitForUserInput(): Promise<void> {
  if (!awaitingUserInput) return Promise.resolve();
  return new Promise<void>((resolve) => {
    userInputResolve = resolve;
  });
}

// Stored so handleRequestPermission can send a session/cancel when the user
// hits Ctrl+C during a permission prompt.
let connectCtx: acp.ClientContext | null = null;
let activeSession: MainSession | null = null;

// Optional hook run once at the very start of cleanup(), before any
// subprocesses are torn down. Registered by main() once a session exists so
// every exit path (normal /exit, Ctrl+C, Ctrl+D, SIGTERM, errors) prints the
// final /status view and persists the just-exited session as last_session.
let beforeExitHook: (() => void) | null = null;

// Latest usage_update seen for the *current* main session, surfaced in the
// per-turn token line. Mirrors the entry for the current main session in the
// `sessionUsage` map; kept as a convenience for the streaming `usage_update`
// case in the main loop. `used` is tokens currently in context, `size` is the
// context window, `cost` is the cumulative session cost reported by the agent.
let mainUsage = { used: 0, size: 0, costAmount: 0, costCurrency: "" };

class CancelError extends Error {
  constructor() {
    super("cancel");
    this.name = "CancelError";
  }
}

async function readMainPrompt(): Promise<string> {
  const text = await rawInput.read(true);
  return text;
}

function readSingleLine(opts?: { allow?: string }): Promise<string> {
  const allow = opts?.allow;
  let buf = "";
  const pasteState = { inPaste: false };
  return new Promise((resolve) => {
    if (cancelController.signal.aborted) {
      resolve("");
      return;
    }
    const onAbort = () => {
      process.stdin.removeListener("data", onData);
      cancelController.signal.removeEventListener("abort", onAbort);
      resolve("");
    };
    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (str.includes("\x03")) {
        process.stdin.removeListener("data", onData);
        cancelController.signal.removeEventListener("abort", onAbort);
        resolve("");
        return;
      }
      // Drop any pasted content (bracketed paste) entirely; only real typed
      // keystrokes are processed. Uses a local state so it can't be desynced
      // from a paste by the shared input handler.
      const typed = stripBracketedPaste(str, pasteState);
      if (typed.length === 0) return;
      // Drop any chunk that still contains an escape sequence after paste
      // stripping (e.g. arrow keys, or a stray CSI 201~ with no matching begin).
      // Only printable typed characters form the answer.
      if (typed.includes("\x1b")) return;
      const nlIdx = typed.search(/[\r\n]/);
      const line = nlIdx === -1 ? typed : typed.slice(0, nlIdx);
      for (const ch of line) {
        if (ch === "\x7f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          if (allow && !allow.includes(ch)) continue;
          process.stdout.write(ch);
          buf += ch;
        }
      }
      if (nlIdx !== -1) {
        process.stdin.removeListener("data", onData);
        cancelController.signal.removeEventListener("abort", onAbort);
        resolve(buf);
      }
    };
    cancelController.signal.addEventListener("abort", onAbort, { once: true });
    process.stdin.on("data", onData);
  });
}

let agentProcess: ReturnType<typeof spawn> | null = null;
let agentExited = false;

function cleanup(exitCode = 0): void {
  if (agentExited) return;
  agentExited = true;
  // Print the final /status view and persist the just-exited session as
  // last_session before tearing anything down (so the summarizer state and
  // active session id are still intact for display). Best-effort: never let
  // an error here block the exit.
  if (beforeExitHook) {
    try { beforeExitHook(); } catch { /* ignore */ }
  }
  process.stdout.write("\n");
  if (agentProcess) {
    try {
      agentProcess.kill("SIGTERM");
    } catch {
      // ignore
    }
    agentProcess = null;
  }
  try { thinkSummarizer?.dispose(); } catch { /* ignore */ }
  thinkSummarizer = null;
  rawInput.close();
  if (process.stdin.isTTY) {
    try { process.stdout.write("\x1b[?2004l"); } catch { /* ignore */ }
    try { process.stdout.write("\x1b[?25h"); } catch { /* ignore */ }
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  process.exitCode = exitCode;
  try {
    process.stdin.end();
  } catch {
    // ignore
  }
  // Flush stdout then exit so the event loop stops immediately.
  setImmediate(() => process.exit(exitCode));
}

type SessionUpdateKind =
  | { kind: "session_update"; notification: { sessionId: string; update: Record<string, unknown> }; update: Record<string, unknown> }
  | { kind: "stop"; response: Record<string, unknown>; stopReason: string };

class ManualSession {
  public sessionId: string;
  private cx: acp.ClientContext;
  private queue: SessionUpdateKind[] = [];
  private waiter: ((v: SessionUpdateKind) => void) | null = null;
  private deregister: (() => void) | null = null;

  constructor(
    sessionId: string,
    cx: acp.ClientContext,
    registerPush: (sid: string, fn: (u: SessionUpdateKind) => void) => (() => void),
  ) {
    this.sessionId = sessionId;
    this.cx = cx;
    this.deregister = registerPush(sessionId, (update) => {
      this.pushUpdate(update);
    });
  }

  prompt(promptText: string) {
    this.queue = this.queue.filter((m) => m.kind !== "stop");
    const response = this.cx.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    response.then(
      (value: unknown) => {
        const v = value as { stopReason: string };
        this.pushUpdate({
          kind: "stop",
          response: v,
          stopReason: v.stopReason,
        });
      },
      (err: unknown) => {
        this.pushUpdate({
          kind: "stop",
          response: { stopReason: "error" },
          stopReason: "error",
        });
        throw err;
      },
    );
    return response;
  }

  pushUpdate(msg: SessionUpdateKind) {
    this.queue.push(msg);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(this.queue.shift()!);
    }
  }

  async nextUpdate(): Promise<SessionUpdateKind> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<SessionUpdateKind>((resolve) => {
      this.waiter = resolve;
    });
  }

  dispose() {
    if (this.deregister) {
      this.deregister();
      this.deregister = null;
    }
  }
}

const manualSessionDispatch = new Map<string, (update: SessionUpdateKind) => void>();

// Registers a push callback for a resumed (loaded) session id and returns a
// deregister function. Used by ManualSession. Incoming session/update
// notifications are routed here by the client notification handler wired in
// main().
function registerManualPush(
  sid: string,
  fn: (u: SessionUpdateKind) => void,
): () => void {
  manualSessionDispatch.set(sid, fn);
  return () => {
    if (manualSessionDispatch.get(sid) === fn) manualSessionDispatch.delete(sid);
  };
}

// Drain replayed conversation history that the agent streams back after a
// session/load, without rendering it as live output. Updates are pulled until
// the stream goes quiet for `quietMs` (no update) or `maxMs` elapses. The last
// usage_update seen is recorded so /status reflects the resumed session's
// context/cost. The first user message text is captured as a one-line summary
// of what the resumed session was about. Returns the number of updates
// discarded plus the captured summary (or "" if none).
async function drainHistory(
  session: MainSession,
  opts: { quietMs?: number; maxMs?: number } = {},
): Promise<{ count: number; summary: string }> {
  const quietMs = opts.quietMs ?? 400;
  const maxMs = opts.maxMs ?? 8000;
  const start = Date.now();
  let count = 0;
  let summary = "";
  let lastUsage: { used?: number; size?: number; cost?: { amount?: number; currency?: string } | null } | null = null;
  for (;;) {
    const elapsed = Date.now() - start;
    const remaining = maxMs - elapsed;
    if (remaining <= 0) break;
    const wait = Math.min(quietMs, remaining);
    const next = await Promise.race([
      session.nextUpdate().then((u) => u),
      new Promise<SessionUpdateKind | null>((r) => setTimeout(() => r(null), wait)),
    ]);
    if (next === null) break; // quiet window -> history replay finished
    count++;
    if (next.kind === "session_update") {
      const upd = next.update as Record<string, any>;
      if (upd?.sessionUpdate === "usage_update") {
        lastUsage = {
          used: Number(upd.used) || 0,
          size: Number(upd.size) || 0,
          cost: {
            amount: Number(upd.cost?.amount ?? 0) || 0,
            currency: typeof upd.cost?.currency === "string" ? upd.cost.currency : "",
          },
        };
      } else if (
        !summary &&
        upd?.sessionUpdate === "user_message_chunk" &&
        upd.content?.type === "text" &&
        typeof upd.content.text === "string"
      ) {
        summary = upd.content.text.replace(/\s+/g, " ").trim();
      }
    }
  }
  if (lastUsage) recordUsage(session.sessionId, "main", lastUsage);
  return { count, summary };
}

// Look up a session's human-readable title via session/list when the agent
// advertises the listSessions capability. Returns null if unavailable or the
// session is not found.
async function fetchSessionTitle(
  ctx: acp.ClientContext,
  sessionId: string,
): Promise<string | null> {
  if (!agentCapabilities?.sessionCapabilities?.list) return null;
  try {
    const res = await ctx.request(acp.methods.agent.session.list, {});
    const sessions = (res as { sessions?: Array<{ sessionId: string; title?: string | null }> }).sessions ?? [];
    const hit = sessions.find((s) => s.sessionId === sessionId);
    return hit?.title ?? null;
  } catch {
    return null;
  }
}

// Resolve the initial main session based on CLI flags and agent capabilities.
// - `-s <id>` / `-c` resume an existing session via session/load when the agent
//   advertises loadSession; otherwise (or on failure) a fresh session is made.
// On resume the replayed history is drained silently (see drainHistory). The
// resumed session's title (via session/list) and the first user message (from
// the replayed history) are returned as a quick `name`/`summary` so the caller
// can print them at startup. Errors are surfaced but startup stays quiet on
// success.
async function resolveInitialSession(
  ctx: acp.ClientContext,
): Promise<{ session: MainSession; name: string | null; summary: string }> {
  const cwd = process.cwd();
  const canLoad = !!agentCapabilities?.loadSession;
  const target =
    (cliSessionTarget && canLoad && cliSessionTarget) ||
    (cliContinue && canLoad ? readLastSession() : null);

  if (target) {
    try {
      await ctx.request(acp.methods.agent.session.load, {
        sessionId: target,
        cwd,
        mcpServers: [],
      });
      const ms = new ManualSession(target, ctx, registerManualPush);
      recordUsage(target, "main", {});
      const { summary } = await drainHistory(ms);
      const name = await fetchSessionTitle(ctx, target);
      writeLastSession(target);
      return { session: ms, name, summary };
    } catch (err) {
      console.error(
        `⚠️  Could not resume session ${target}: ${(err as Error).message ?? err} — starting a new session instead.`,
      );
    }
  } else if ((cliSessionTarget || cliContinue) && !canLoad) {
    console.error(
      `⚠️  This agent does not advertise the loadSession capability, so -c/-s are ignored. Starting a new session.`,
    );
  }

  const fresh = await ctx.buildSession(cwd).start();
  writeLastSession(fresh.sessionId);
  recordUsage(fresh.sessionId, "main", {});
  return { session: fresh as unknown as MainSession, name: null, summary: "" };
}

// Prompt the agent to summarize the conversation so far into a compact brief a
// fresh session can use to continue. ACP has no native compaction method, so
// this is a client-side summarize-then-seed: ask the current main session for a
// brief, start a new main session, and send the brief as its first message.
const COMPACT_REQUEST =
  "Summarize the conversation so far into a concise context brief that a fresh " +
  "agent session needs to continue the work. Include: the goal, decisions " +
  "made, in-progress tasks, key files/paths touched, and open questions. Be " +
  "terse and information-dense. Output only the brief, no preamble.";

async function handleCompact(
  ctx: acp.ClientContext,
  getSession: () => MainSession,
  setSession: (s: MainSession) => void,
  deps: {
    kiloConfig: { config: Record<string, unknown> } | null;
    agentCmd: string;
    agentArgs: string[];
  },
): Promise<void> {
  const oldSession = getSession();
  console.log(`\n${C.bold}Compacting main session…${C.reset}`);

  // 1. Ask the current session for a brief; drain the turn, collecting text.
  resetCancel();
  setInputTarget("discard");
  oldSession.prompt(COMPACT_REQUEST);
  let brief = "";
  try {
    for (;;) {
      if (cancelController.signal.aborted) {
        ctx.notify(acp.methods.agent.session.cancel, { sessionId: oldSession.sessionId }).catch(() => {});
        console.log(`\n${C.dim}Compact cancelled. Keeping current session.${C.reset}\n`);
        setInputTarget("main");
        return;
      }
      const msg = await oldSession.nextUpdate();
      if (msg.kind === "stop") break;
      const upd = msg.update as Record<string, any>;
      if (upd?.sessionUpdate === "agent_message_chunk" && upd.content?.type === "text") {
        brief += String(upd.content.text ?? "");
      } else if (upd?.sessionUpdate === "usage_update") {
        recordUsage(oldSession.sessionId, "main", upd);
      }
    }
  } catch {
    /* fall through with whatever brief we have */
  }

  brief = brief.trim();
  if (!brief) {
    console.log(`\n⚠️  Compaction produced no summary; keeping current session ${oldSession.sessionId}.\n`);
    setInputTarget("main");
    return;
  }

  // 2. Dispose the old session and start a fresh one.
  try {
    oldSession.dispose();
  } catch {
    /* ignore */
  }
  const fresh = (await ctx.buildSession(process.cwd()).start()) as unknown as MainSession;
  writeLastSession(fresh.sessionId);
  recordUsage(fresh.sessionId, "main", {});
  setSession(fresh);
  mainUsage = { used: 0, size: 0, costAmount: 0, costCurrency: "" };

  // 3. Seed the new session with the brief as its first message. Drain the
  //    agent's acknowledgement silently (we just need the turn to complete).
  console.log(`   seeding new session ${fresh.sessionId}…`);
  resetCancel();
  fresh.prompt(
    `Context brief from the previous (compacted) session — continue from here:\n\n${brief}`,
  );
  try {
    for (;;) {
      if (cancelController.signal.aborted) {
        ctx.notify(acp.methods.agent.session.cancel, { sessionId: fresh.sessionId }).catch(() => {});
        break;
      }
      const msg = await fresh.nextUpdate();
      if (msg.kind === "stop") break;
      const upd = msg.update as Record<string, any>;
      if (upd?.sessionUpdate === "usage_update") {
        recordUsage(fresh.sessionId, "main", upd);
      }
    }
  } catch {
    /* ignore — seed turn is best-effort */
  }

  // 4. Restart the summarizer subagent so it does not accumulate stale state.
  try {
    thinkSummarizer?.dispose();
  } catch {
    /* ignore */
  }
  const smallModel = resolveSmallModel(deps.kiloConfig);
  thinkSummarizer = new ThinkSummarizer(smallModel);
  summaryGate = new SummaryGate(thinkSummarizer);
  thinkSummarizer.start(deps.agentCmd, deps.agentArgs, process.cwd()).catch(() => {});

  console.log(`\n✅ Compacted → new session ${fresh.sessionId}\n`);
  setInputTarget("main");
}

async function main(): Promise<void> {
  const agentCmd = process.env.KILO_AGENT_CMD || "kilo";
  const agentArgs = process.env.KILO_AGENT_ARGS
    ? process.env.KILO_AGENT_ARGS.split(" ")
    : ["acp"];

  const kiloConfig = loadKiloConfig();

  agentProcess = spawn(agentCmd, agentArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildAgentEnv(),
  });

  agentProcess.on("error", (err) => {
    console.error(`\n❌ Failed to spawn agent "${agentCmd}": ${err.message}`);
    cleanup(1);
  });

  agentProcess.on("exit", (code, signal) => {
    if (!agentExited && (code !== null || signal !== null)) {
      console.error(`\n❌ Agent process exited unexpectedly (code=${code}, signal=${signal})`);
      cleanup(1);
    }
  });

  const input = Writable.toWeb(agentProcess.stdin!);
  const output = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const handleRequestPermission = async (
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> => {
    if (isUnknownOrInvalidToolCall(params.toolCall)) {
        return { outcome: { outcome: "cancelled" } };
      }
      startAwaitingUserInput();
      try {
        console.log(`\n${C.yellow}🔐 Permission requested${C.reset}`);
        // For edits the `in_progress` update arrives (and is announced) before
        // the permission prompt, already printing the header, the "what it's
        // doing" line, and the diff. Re-rendering with force would reprint that
        // header, so merge into a single block: only render the diff if it
        // somehow wasn't shown yet (e.g. the in_progress update lacked the
        // rawInput). Tool calls seen here for the first time still get a full
        // force render (header + diff + summary).
        const tc = params.toolCall;
        const tcId = tc.toolCallId ?? tc.title;
        if (announcedToolCalls.has(tcId)) {
          const kind = (tc.kind ?? "other").toLowerCase();
          // Print the "what it's doing" line if the first announcement didn't
          // carry a rawInput (e.g. a bash tool_call that arrived pending
          // without the command, which only shows up on the permission
          // request).
          if (!printedInputSummary.has(tcId)) {
            const summary = summarizeInput(tc.rawInput);
            if (summary) {
              console.log(`   ${summary}`);
              printedInputSummary.add(tcId);
            }
          }
          if (kind === "edit" && !renderedEditDiffIds.has(tcId)) {
            if (renderEditDiffFromRaw(tc.rawInput, tcId)) {
              renderedEditDiffIds.add(tcId);
            }
          }
        } else {
          renderToolCall(tc, false, true, true);
        }

        for (let i = 0; i < params.options.length; i++) {
          console.log(`   ${i + 1}. ${params.options[i].name} (${params.options[i].kind})`);
        }

        // Only typed digits and 'c' are accepted; pasted input is dropped by
        // readSingleLine, and any other typed character is filtered out here.
        const allow = "0123456789cC";
        process.stdout.write("\nChoose an option (or 'c' to cancel): ");
        while (true) {
          const answer = await readSingleLine({ allow });
          if (cancelController.signal.aborted) {
            if (connectCtx && activeSession) {
              connectCtx.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
            }
            return { outcome: { outcome: "cancelled" } };
          }
          const trimmed = answer.trim().toLowerCase();

          if (trimmed === "c" || trimmed === "cancel") {
            process.stdout.write("\n");
            return { outcome: { outcome: "cancelled" } };
          }

          const optionIndex = parseInt(trimmed, 10) - 1;
          if (optionIndex >= 0 && optionIndex < params.options.length) {
            process.stdout.write("\n");
            return {
              outcome: {
                outcome: "selected",
                optionId: params.options[optionIndex].optionId,
              },
            };
          }

          console.log("Invalid option. Please try again.");
          process.stdout.write("Choose an option (or 'c' to cancel): ");
        }
      } finally {
        stopAwaitingUserInput();
      }
      // The user has answered: emit any thinking summary that occurred while the
      // prompt was on screen. Only the last summary is shown, and only if the
      // small-model result already arrived — otherwise it's left for the
      // before-response flush so the user isn't made to wait.
      summaryGate?.emitIfResolved();
  };

  const handleWriteTextFile = async (
    _params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> => {
    return {};
  };

  const handleReadTextFile = async (
    _params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> => {
    console.error("[Client] Read text file called:", JSON.stringify(_params, null, 2));
    return { content: "Mock file content" };
  };

  const renderSchemaField = async (
    key: string,
    prop: acp.ElicitationPropertySchema,
    required: boolean,
  ): Promise<void> => {
    const title = prop.title ?? key;
    const desc = prop.description ?? "";
    const reqTag = required ? ` ${C.red}(required)${C.reset}` : "";
    const indent = "   ";

    if (acp.ElicitationPropertySchema.isString(prop)) {
      if (prop.oneOf && prop.oneOf.length > 0) {
        console.log(`\n${indent}${C.bold}${title}${C.reset}${reqTag}`);
        if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
        for (let i = 0; i < prop.oneOf.length; i++) {
          const opt = prop.oneOf[i];
          console.log(`${indent}  ${i + 1}. ${opt.title}${opt.description ? ` ${C.dim}(${opt.description})${C.reset}` : ""}`);
        }
      } else if (prop.enum && prop.enum.length > 0) {
        console.log(`\n${indent}${C.bold}${title}${C.reset}${reqTag}`);
        if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
        for (let i = 0; i < prop.enum.length; i++) {
          console.log(`${indent}  ${i + 1}. ${prop.enum[i]}`);
        }
      } else {
        console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(string)${C.reset}${reqTag}`);
        if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
        if (prop.default !== undefined && prop.default !== null) {
          console.log(`${indent}${C.dim}(default: "${prop.default}")${C.reset}`);
        }
      }
    } else if (acp.ElicitationPropertySchema.isNumber(prop)) {
      console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(number)${C.reset}${reqTag}`);
      if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
      const range = [];
      if (prop.minimum !== undefined && prop.minimum !== null) range.push(`min: ${prop.minimum}`);
      if (prop.maximum !== undefined && prop.maximum !== null) range.push(`max: ${prop.maximum}`);
      if (range.length > 0) console.log(`${indent}${C.dim}(${range.join(", ")})${C.reset}`);
      if (prop.default !== undefined && prop.default !== null) {
        console.log(`${indent}${C.dim}(default: ${prop.default})${C.reset}`);
      }
    } else if (acp.ElicitationPropertySchema.isInteger(prop)) {
      console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(integer)${C.reset}${reqTag}`);
      if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
      const range = [];
      if (prop.minimum !== undefined && prop.minimum !== null) range.push(`min: ${prop.minimum}`);
      if (prop.maximum !== undefined && prop.maximum !== null) range.push(`max: ${prop.maximum}`);
      if (range.length > 0) console.log(`${indent}${C.dim}(${range.join(", ")})${C.reset}`);
      if (prop.default !== undefined && prop.default !== null) {
        console.log(`${indent}${C.dim}(default: ${prop.default})${C.reset}`);
      }
    } else if (acp.ElicitationPropertySchema.isBoolean(prop)) {
      console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(boolean)${C.reset}${reqTag}`);
      if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
      console.log(`${indent}  y/yes = true, n/no = false`);
    } else if (acp.ElicitationPropertySchema.isArray(prop)) {
      console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(multi-select)${C.reset}${reqTag}`);
      if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
      if (prop.minItems !== undefined && prop.minItems !== null) {
        console.log(`${indent}${C.dim}(min selections: ${prop.minItems})${C.reset}`);
      }
      if (prop.maxItems !== undefined && prop.maxItems !== null) {
        console.log(`${indent}${C.dim}(max selections: ${prop.maxItems})${C.reset}`);
      }
      const items = prop.items as { anyOf?: Array<{ const: string; title: string; description?: string | null }>; enum?: string[] };
      if (items.anyOf && items.anyOf.length > 0) {
        for (let i = 0; i < items.anyOf.length; i++) {
          const opt = items.anyOf[i];
          console.log(`${indent}  ${i + 1}. ${opt.title}${opt.description ? ` ${C.dim}(${opt.description})${C.reset}` : ""}`);
        }
      } else if (items.enum && items.enum.length > 0) {
        for (let i = 0; i < items.enum.length; i++) {
          console.log(`${indent}  ${i + 1}. ${items.enum[i]}`);
        }
      }
    } else {
      console.log(`\n${indent}${C.bold}${title}${C.reset} ${C.dim}(${prop.type || "unknown"})${C.reset}${reqTag}`);
      if (desc) console.log(`${indent}${C.dim}${desc}${C.reset}`);
    }
  };

  const promptFieldInput = async (
    key: string,
    prop: acp.ElicitationPropertySchema,
    required: boolean,
  ): Promise<acp.ElicitationContentValue | undefined> => {
    while (true) {
      if (cancelController.signal.aborted) throw new CancelError();

      const hint = prop.default !== undefined && prop.default !== null
        ? ` (default: ${JSON.stringify(prop.default)})`
        : "";
      process.stdout.write(`   ${C.cyan}${key}${C.reset}${hint}${required ? ` ${C.red}*${C.reset}` : ""}: `);

      const answer = await readSingleLine();
      if (cancelController.signal.aborted) throw new CancelError();

      const trimmed = answer.trim().toLowerCase();

      if (trimmed === "c" || trimmed === "cancel") {
        throw new CancelError();
      }

      if (trimmed === "" || trimmed === "s" || trimmed === "skip") {
        if (required) {
          console.log(`${C.yellow}   This field is required.${C.reset}`);
          continue;
        }
        if (prop.default !== undefined && prop.default !== null) {
          return prop.default as acp.ElicitationContentValue;
        }
        return undefined;
      }

      if (acp.ElicitationPropertySchema.isString(prop)) {
        if (prop.oneOf && prop.oneOf.length > 0) {
          const idx = parseInt(trimmed, 10) - 1;
          if (idx >= 0 && idx < prop.oneOf.length) {
            return prop.oneOf[idx].const;
          }
          console.log(`${C.yellow}   Invalid choice. Select 1-${prop.oneOf.length} or enter "s" to skip.${C.reset}`);
          continue;
        }
        if (prop.enum && prop.enum.length > 0) {
          const idx = parseInt(trimmed, 10) - 1;
          if (idx >= 0 && idx < prop.enum.length) {
            return prop.enum[idx];
          }
          console.log(`${C.yellow}   Invalid choice. Select 1-${prop.enum.length} or enter "s" to skip.${C.reset}`);
          continue;
        }
        return answer.trim();
      }

      if (acp.ElicitationPropertySchema.isNumber(prop)) {
        const val = parseFloat(trimmed);
        if (isNaN(val)) {
          console.log(`${C.yellow}   Invalid number.${C.reset}`);
          continue;
        }
        return val;
      }

      if (acp.ElicitationPropertySchema.isInteger(prop)) {
        const val = parseInt(trimmed, 10);
        if (isNaN(val)) {
          console.log(`${C.yellow}   Invalid integer.${C.reset}`);
          continue;
        }
        return val;
      }

      if (acp.ElicitationPropertySchema.isBoolean(prop)) {
        if (trimmed === "y" || trimmed === "yes" || trimmed === "true" || trimmed === "1") {
          return true;
        }
        if (trimmed === "n" || trimmed === "no" || trimmed === "false" || trimmed === "0") {
          return false;
        }
        console.log(`${C.yellow}   Enter "y/yes" or "n/no".${C.reset}`);
        continue;
      }

      if (acp.ElicitationPropertySchema.isArray(prop)) {
        const items = prop.items as { anyOf?: Array<{ const: string; title: string; description?: string | null }>; enum?: string[] };
        let options: string[] = [];
        if (items.anyOf && items.anyOf.length > 0) {
          options = items.anyOf.map((o) => o.const);
        } else if (items.enum && items.enum.length > 0) {
          options = items.enum;
        }
        if (options.length > 0) {
          const parts = trimmed.split(/[\s,]+/).filter(Boolean);
          const indices = parts.map((p) => parseInt(p, 10) - 1);
          const selected = indices
            .filter((idx) => idx >= 0 && idx < options.length)
            .map((idx) => options[idx]);
          if (selected.length > 0) {
            return selected;
          }
          if (trimmed === "" || trimmed === "s" || trimmed === "skip") {
            return [];
          }
          console.log(`${C.yellow}   Invalid selection. Enter numbers (e.g. "1,3" or "1 3") or "s" to skip.${C.reset}`);
          continue;
        }
        return answer.trim();
      }

      return answer.trim();
    }
  };

  type QuestionItem = {
    question?: string;
    header?: string;
    options?: Array<{ label: string; description?: string | null }>;
    multiple?: boolean;
  };

  const handleElicitation = async (
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> => {
    console.error(`[DEBUG] handleElicitation called with full params: ${JSON.stringify(params, null, 2)}`);
    if (elicitationPolicy === "deny") {
      if (connectCtx && activeSession) {
        connectCtx.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
      }
      return { action: "cancel" };
    }

    startAwaitingUserInput();
    setInputTarget("confirm");

    try {

    const mode = (params as Record<string, unknown>).mode ?? "<none>";
    const isForm = acp.CreateElicitationRequest.isForm(params);
    const isUrl = acp.CreateElicitationRequest.isUrl(params);
    
    const rawParams = params as Record<string, unknown>;
    const hasQuestions = Array.isArray(rawParams.questions) && (rawParams.questions as unknown[]).length > 0;
    
    console.error(`[DEBUG] handleElicitation: mode=${mode}, isForm=${isForm}, isUrl=${isUrl}, hasQuestions=${hasQuestions}`);
    
    if (hasQuestions) {
      const questions = rawParams.questions as QuestionItem[];
      console.log(`\n${C.yellow}❓ Questions${C.reset}`);
      
      const answers: Record<string, unknown> = {};
      for (let qi = 0; qi < questions.length; qi++) {
        const q: QuestionItem = questions[qi];
        if (cancelController.signal.aborted) return { action: "cancel" };

        const header = q.header ?? q.question ?? `Question ${qi + 1}`;
        const questionText = q.question ?? header;
        const options = q.options ?? [];

        console.log(`\n   ${C.bold}${header}${C.reset}`);
        console.log(`   ${questionText}`);

        if (options.length > 0) {
          for (let i = 0; i < options.length; i++) {
            console.log(`   ${i + 1}. ${options[i].label}${options[i].description ? ` ${C.dim}(${options[i].description})${C.reset}` : ""}`);
          }
          process.stdout.write(`\n   Choose 1-${options.length} (or 'c' to cancel): `);
          while (true) {
            const answer = await readSingleLine();
            if (cancelController.signal.aborted) return { action: "cancel" };
            const trimmed = answer.trim().toLowerCase();
            if (trimmed === "c" || trimmed === "cancel") return { action: "cancel" };
            const idx = parseInt(trimmed, 10) - 1;
            if (idx >= 0 && idx < options.length) {
              const key = q.header || `question_${qi}`;
              if (q.multiple) {
                answers[key] = [options[idx].label];
              } else {
                answers[key] = options[idx].label;
              }
              break;
            }
            if (q.multiple && (trimmed === "" || trimmed === "s" || trimmed === "skip")) {
              const key = q.header || `question_${qi}`;
              answers[key] = [];
              break;
            }
            process.stdout.write(`   Invalid. Enter 1-${options.length} (or 'c' to cancel): `);
          }
        } else {
          process.stdout.write("   Enter your answer (or 'c' to cancel): ");
          while (true) {
            const answer = await readSingleLine();
            if (cancelController.signal.aborted) return { action: "cancel" };
            const trimmed = answer.trim();
            if (trimmed.toLowerCase() === "c" || trimmed.toLowerCase() === "cancel") return { action: "cancel" };
            if (trimmed !== "") {
              const key = q.header || `question_${qi}`;
              answers[key] = trimmed;
              break;
            }
            process.stdout.write("   Please enter a response (or 'c' to cancel): ");
          }
        }
      }
      console.log(`\n${C.green}   ✓ Answers collected${C.reset}`);
      return { action: "accept", content: answers as Record<string, acp.ElicitationContentValue> };
    }
    
    console.log(`\n${C.yellow}❓ Input requested${C.reset}`);
    console.log(`   ${params.message}`);
      if (isUrl) {
        console.log(`\n   ${C.cyan}Open this URL and follow the instructions:${C.reset}`);
        console.log(`   ${C.cyan}${params.url}${C.reset}\n`);

        while (true) {
          process.stdout.write("   Press Enter when done, or 'c' to cancel: ");
          const answer = await readSingleLine();
          if (cancelController.signal.aborted || answer.trim().toLowerCase() === "c") {
            if (connectCtx && activeSession) {
              connectCtx.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
            }
            return { action: "cancel" };
          }
          if (answer.trim() === "") {
            return { action: "accept" };
          }
        }
      }

      if (isForm) {
        const schema = params.requestedSchema;
        const properties = schema.properties ?? {};
        const requiredFields = new Set(schema.required ?? []);

        if (Object.keys(properties).length === 0) {
          console.log("   (no form fields to fill)");
          return { action: "accept", content: {} };
        }

        if (schema.title) {
          console.log(`\n   ${C.bold}${schema.title}${C.reset}`);
        }
        if (schema.description) {
          console.log(`   ${C.dim}${schema.description}${C.reset}`);
        }

        for (const [key, prop] of Object.entries(properties)) {
          await renderSchemaField(key, prop, requiredFields.has(key));
        }

        console.log(`\n   ${C.dim}Enter "s"/"skip" to skip optional fields, "c"/"cancel" to abort.${C.reset}`);
        console.log(`   ${C.dim}Press Enter for defaults where available.${C.reset}\n`);

        const content: Record<string, acp.ElicitationContentValue> = {};
        for (const [key, prop] of Object.entries(properties)) {
          const value = await promptFieldInput(key, prop, requiredFields.has(key));
          if (value !== undefined) {
            content[key] = value;
          }
        }

        return { action: "accept", content };
      }

      console.error(`   ${C.gray}⚠ unknown elicitation mode: ${String(mode)}${C.reset}`);

      process.stdout.write("\n   Enter your response (or 'c' to cancel): ");
      while (true) {
        const answer = await readSingleLine();
        if (cancelController.signal.aborted || answer.trim().toLowerCase() === "c") {
          if (connectCtx && activeSession) {
            connectCtx.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
          }
          return { action: "cancel" };
        }
        if (answer.trim() !== "") {
          return { action: "accept", content: { response: answer.trim() } };
        }
        process.stdout.write("   Please enter a response (or 'c' to cancel): ");
      }
    } catch (err) {
      if (err instanceof CancelError) {
        if (connectCtx && activeSession) {
          connectCtx.notify(acp.methods.agent.session.cancel, { sessionId: activeSession.sessionId }).catch(() => {});
        }
        return { action: "cancel" };
      }
      throw err;
    } finally {
      stopAwaitingUserInput();
    }
    // Mirrors the permission handler: show the last thinking summary that
    // occurred while the user was answering, but only if it already resolved.
    summaryGate?.emitIfResolved();
  };

  try {
    await acp
      .client({ name: "kilo-readline" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        handleRequestPermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        handleWriteTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        handleReadTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        handleElicitation(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        // Route session/update notifications for resumed (loaded) sessions into
        // their ManualSession queue. For new sessions the SDK's ActiveSession
        // router handles delivery; here we only act on ids registered below.
        const n = ctx.params as { sessionId: string; update: Record<string, unknown> };
        const fn = manualSessionDispatch.get(n.sessionId);
        if (fn) fn({ kind: "session_update", notification: n, update: n.update });
      })
      .connectWith(stream, async (ctx) => {
        connectCtx = ctx;
        const initResult = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            elicitation: {
              form: {},
              url: {},
            },
          },
        });
        agentCapabilities = (initResult as { agentCapabilities?: { loadSession?: boolean; [k: string]: unknown } | null }).agentCapabilities ?? null;

        const { session: initialSession, name: resumedName, summary: resumedSummary } = await resolveInitialSession(ctx);
        let session: MainSession = initialSession;
        activeSession = session;

        // Thinking summaries run on a separate subagent forced to the small
        // model (e.g. the kilo free dispatcher). Started in the background so it
        // never delays the main loop; if it fails the summary falls back to a
        // plain stats line. We wait briefly for it to come up so the status
        // output reflects the real summarizer state; on failure we surface the
        // error but otherwise stay quiet.
        const smallModel = resolveSmallModel(kiloConfig);
        thinkSummarizer = new ThinkSummarizer(smallModel);
        summaryGate = new SummaryGate(thinkSummarizer);
        let summarizerStatus: string | null = null;
        try {
          summarizerStatus = await Promise.race([
            thinkSummarizer.start(agentCmd, agentArgs, process.cwd()),
            new Promise<string>((r) => setTimeout(() => r("timeout"), 10000)),
          ]);
        } catch (err) {
          summarizerStatus = `unavailable: ${(err as Error).message}`;
        }
        if (summarizerStatus === "timeout") {
          // Still starting — let it finish in the background without chatter.
          thinkSummarizer
            .start(agentCmd, agentArgs, process.cwd())
            .catch(() => {});
        } else if (summarizerStatus && summarizerStatus !== "ready") {
          console.error(`⚠️  Summarizer subagent ${summarizerStatus}.`);
        }

        const formatCost = (amount: number, currency: string): string => {
          const sym = currency.toUpperCase() === "USD" ? "$" : currency ? `${currency} ` : "$";
          return `${sym}${amount.toFixed(6)}`;
        };

        const printStatus = (): void => {
          const mainModel = (kiloConfig?.config.model as string | undefined) ?? "(kilo default)";
          const mainId = activeSession?.sessionId ?? null;

          console.log(`\n${C.bold}Status${C.reset}`);

          // Per-session accounting (sessions seen this run, including ones
          // compacted away — entries are never removed from sessionUsage).
          const entries = Array.from(sessionUsage.entries());
          if (entries.length > 0) {
            console.log(`  ${C.bold}sessions${C.reset}`);
            for (const [id, u] of entries) {
              const cur = id === mainId && u.role === "main";
              const mark = cur ? `${C.green}*${C.reset}` : " ";
              const role = u.role === "summarizer" ? `${C.magenta}summarizer${C.reset}` : `${C.cyan}main${C.reset}`;
              const ctx =
                u.size > 0
                  ? `${u.used.toLocaleString()} / ${u.size.toLocaleString()}`
                  : u.used > 0
                    ? `${u.used.toLocaleString()}`
                    : "-";
              const cost = u.costAmount > 0 ? formatCost(u.costAmount, u.costCurrency) : "-";
              const tag = cur ? ` ${C.dim}(current)${C.reset}` : "";
              console.log(`  ${mark} ${role.padEnd(0)} ${C.dim}${id}${C.reset}  ctx ${ctx}  cost ${cost}${tag}`);
            }
            // Totals across all sessions.
            const { totalCost, count } = summarizeSessions(sessionUsage, mainId);
            console.log(`  ${C.dim}totals: ${count} session(s), cumulative cost ${formatCost(totalCost, "USD")}${C.reset}`);
          }

          console.log(`  ${C.cyan}main${C.reset}`);
          console.log(`     session : ${mainId ?? "(none)"}`);
          console.log(`     model   : ${mainModel}`);
          if (mainUsage.size > 0) {
            console.log(`     context : ${mainUsage.used.toLocaleString()} / ${mainUsage.size.toLocaleString()} tokens`);
          } else if (mainUsage.used > 0) {
            console.log(`     context : ${mainUsage.used.toLocaleString()} tokens`);
          }
          console.log(`     cost    : ${formatCost(mainUsage.costAmount, mainUsage.costCurrency)} (cumulative)`);

          console.log(`  ${C.magenta}summarizer${C.reset}`);
          const sumId = thinkSummarizer?.sessionId ?? null;
          const sumReady = thinkSummarizer?.available ?? false;
          console.log(`     session : ${sumId ?? "(none)"}`);
          console.log(`     model   : ${smallModel}`);
          console.log(`     state   : ${sumReady ? `${C.green}ready${C.reset}` : `${C.dim}not running${C.reset}`}`);
          const u = thinkSummarizer?.lastUsage;
          if (u && (u.used > 0 || u.size > 0 || u.costAmount > 0)) {
            if (u.size > 0) {
              console.log(`     context : ${u.used.toLocaleString()} / ${u.size.toLocaleString()} tokens`);
            } else if (u.used > 0) {
              console.log(`     context : ${u.used.toLocaleString()} tokens`);
            }
            if (u.costAmount > 0) {
              console.log(`     cost    : ${formatCost(u.costAmount, u.costCurrency)} (cumulative)`);
            }
          }
          console.log();
        };

        // Print the /status view and persist the current session as
        // last_session on every exit. Registered here (after printStatus and
        // activeSession exist) so cleanup() can fire it on any exit path —
        // including Ctrl+C and Ctrl+D, which bypass the normal /exit break.
        beforeExitHook = () => {
          if (!activeSession) return;
          printStatus();
          writeLastSession(activeSession.sessionId);
        };

        // Startup output: just the models and session ids (the /status view),
        // plus — when resuming via -c/-s — a quick name and one-line summary of
        // the resumed session.
        printStatus();
        if (session instanceof ManualSession) {
          const label = resumedName ? `name: ${resumedName}` : `session: ${session.sessionId}`;
          const summaryLine = resumedSummary
            ? `  ${C.dim}summary: ${resumedSummary.slice(0, 200)}${resumedSummary.length > 200 ? "…" : ""}${C.reset}`
            : "";
          console.log(`${C.bold}Resumed${C.reset}  ${C.dim}${label}${C.reset}${summaryLine ? `\n${summaryLine}` : ""}\n`);
        }

        inMainLoop = true;
        while (true) {
          resetCancel();
          setInputTarget("main");
          const promptText = await readMainPrompt();
          setInputTarget("discard");

          if (!promptText.trim()) {
            continue;
          }

          const trimmed = promptText.trim().toLowerCase();

          // Record every submitted line — including slash commands (/status,
          // /help, /exit, …) — so the history reflects what was actually typed.
          // Done before the command dispatch so commands that `continue` or
          // `break` are still saved. Dedups against the most recent entry and
          // trims the file if it has grown past the size limit.
          appendHistory(promptText);

          if (trimmed === "/exit" || trimmed === "/quit") {
            break;
          }
          if (trimmed === "/help" || trimmed === "/h" || trimmed === "/?") {
            printCommandHelp();
            continue;
          }
          if (trimmed === "/status") {
            printStatus();
            continue;
          }

          if (trimmed === "/compact" || trimmed === "/summarize") {
            await handleCompact(ctx, () => session, (s) => {
              session = s;
              activeSession = s;
            }, { kiloConfig, agentCmd, agentArgs });
            continue;
          }

          if (STUB_COMMANDS.has(trimmed)) {
            console.error(
              `\n⚠️  "${trimmed}" is not implemented in this client yet. ` +
                `See /help for the list of available commands.\n`,
            );
            continue;
          }

          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
          const clearHeartbeat = () => {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
          };

          try {
          const finalPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${promptText}`;
          // Confirm the input was handed off to the agent: written to stderr (so
          // it never collides with the streamed response on stdout) right after
          // the submitted prompt, making it obvious the turn is in flight even
          // when the model stalls (e.g. a provider 529 retry).
          process.stderr.write(`   ${C.gray}↳ sent${C.reset}\n`);
          session.prompt(finalPrompt);
          announcedToolCalls.clear();
          renderedContentCount.clear();
          renderedTodoCount.clear();
          knownTodowriteIds.clear();
          lastStatus.clear();
          printedInputSummary.clear();
          renderedEditDiffIds.clear();

          let responseText = "";
          let outputLineBuffer = "";
          let inCodeFence = false;
          const tableAccum = new TableAccumulator();
          let gotText = false;
          let gotTool = false;
          let usedTokens = 0;
          let thinkingHeaderShown = false;
          let thinkingActive = false;
          let thinkingStart = 0;
          let thoughtChars = 0;
          let thoughtText = "";
          // The trimmed text of the most recently ended thinking block, kept so
          // we can echo its last few lines when the agent starts a tool call.
          let lastThoughtText = "";
          // True once we've echoed the recent thinking for the current block, so
          // consecutive tool calls without new thinking don't reprint the same
          // lines. Reset when a new thinking block begins.
          let recentThinkingShown = false;
          // A provider 529 (overloaded) error sometimes surfaces inside the
          // streamed thinking text while the model retries. We emit a tiny red
          // "529" marker once per thinking block so the user can see the retry
          // without the noise of the full error. Written to stderr so it never
          // interferes with the input prompt or the agent's response text.
          let thought529Shown = false;
          let responseSummaryEmitted = false;
          let stopReason: string | undefined;
          const deferredOutputs: string[] = [];
          summaryGate?.reset();
          responseSummaryEmitted = false;

          // When a thinking block ends, hand it to the summary gate. The gate
          // starts a small-model summary (or records the stats fallback) but
          // prints nothing yet — output is deferred to a safe point: after the
          // user answers a permission/elicitation prompt, or just before the
          // agent's response text. See SummaryGate.
          const endThinking = () => {
            if (!thinkingActive) return;
            thinkingActive = false;
            const dur = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
            const text = thoughtText.trim();
            lastThoughtText = text;
            summaryGate?.onThinkingEnd(text, dur, usedTokens, thoughtChars);
          };

          // Echo the last few non-empty lines of the most recent thinking block
          // before a tool call, so the user can see what reasoning led to the
          // action. Printed once per thinking block (see recentThinkingShown).
          // Lines are capped in length to keep the output compact.
          const RECENT_THINKING_LINES = 3;
          const RECENT_THINKING_LINE_MAX = 200;
          const printRecentThinking = () => {
            if (recentThinkingShown) return;
            if (!lastThoughtText) return;
            const lines = lastThoughtText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(-RECENT_THINKING_LINES);
            if (lines.length === 0) return;
            process.stderr.write(`   ${C.gray}💭 last thoughts:${C.reset}\n`);
            for (let l of lines) {
              if (l.length > RECENT_THINKING_LINE_MAX) {
                l = l.slice(0, RECENT_THINKING_LINE_MAX - 1) + "…";
              }
              process.stderr.write(`   ${C.gray}  ${l}${C.reset}\n`);
            }
            recentThinkingShown = true;
          };

          const turnStart = Date.now();
          let lastActivity = Date.now();
          // Track what the agent is currently doing so the heartbeat can say
          // *what* it is waiting on (e.g. a running grep) instead of going
          // silent. Set when a tool call starts, cleared when it completes.
          let activeToolLabel: string | null = null;
          let lastHeartbeatEmit = 0;
          heartbeatTimer = setInterval(() => {
            if (awaitingUserInput) return;
            if (Date.now() - lastUserInputEndedAt < 5000) return;

            // Periodic thinking summary: while a block is active, ask the small
            // model to summarize progress at least once per SHORT_GAP, backing
            // off to LONG_GAP once the block has run a long time. The summary is
            // printed as soon as it resolves (see SummaryGate.tickThinking), so
            // long thinking isn't silent. Runs before the idle-heartbeat guards
            // below so it still fires while chunks are arriving.
            if (thinkingActive) {
              const dur = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
              summaryGate?.tickThinking(thoughtText.trim(), dur, usedTokens, thoughtChars);
            }

            const idle = Date.now() - lastActivity;
            if (idle < 3000) return;
            const idleSecs = Math.round(idle / 1000);
            // Slower backoff: first heartbeat at 3s, then stretch up to 10s max
            // so long tool calls like explore/task don't look completely frozen.
            const minGap = Math.min(10000, 3000 + idle / 3);
            if (Date.now() - lastHeartbeatEmit < minGap) return;

            const elapsed = Math.round((Date.now() - turnStart) / 1000);
            const what = activeToolLabel
              ? `running ${activeToolLabel}`
              : thinkingActive
                ? "thinking"
                : "working";
            const hint = idle >= 10000 ? `  ${C.dim}(Ctrl+C to cancel)${C.reset}` : "";
            process.stderr.write(
              `   ${C.gray}⏳ still ${what}… (${idleSecs}s idle, ${elapsed}s total)${C.reset}${hint}\n`,
            );
            lastHeartbeatEmit = Date.now();
          }, 2000);

          const updateBuffer: SessionUpdateKind[] = [];

          const processUpdate = async (message: SessionUpdateKind): Promise<boolean> => {
            lastActivity = Date.now();
            if (message.kind === "stop") {
              endThinking();
              stopReason = message.response?.stopReason as string | undefined;
              return true;
            }

            const update = message.notification.update as Record<string, any>;
            switch (update.sessionUpdate) {
              case "user_message_chunk":
                break;
              case "agent_message_chunk":
                endThinking();
                summaryGate && (summaryGate.realOutputSeen = true);
                if (update.content.type === "text") {
                  if (!responseSummaryEmitted) {
                    responseSummaryEmitted = true;
                    await summaryGate?.emitBeforeResponse();
                  }
                  gotText = true;
                  responseText += update.content.text;
                  outputLineBuffer += update.content.text;
                  let nl = outputLineBuffer.indexOf("\n");
                  while (nl !== -1) {
                    const line = outputLineBuffer.slice(0, nl);
                    const isFenceDelimiter = line.trim().startsWith("```");
                    if (inCodeFence) {
                      // Inside a fenced code block: emit raw, no markdown and no
                      // table interpretation. A fence delimiter closes the block.
                      process.stdout.write(line + "\n");
                      if (isFenceDelimiter) inCodeFence = false;
                    } else {
                      if (isFenceDelimiter) inCodeFence = true;
                      const isTable = isTableRow(line);
                      const flushedTable = tableAccum.push(line);
                      if (flushedTable !== null) {
                        process.stdout.write(flushedTable);
                      }
                      if (!isTable) {
                        process.stdout.write(formatMarkdownLine(line) + "\n");
                      }
                    }
                    outputLineBuffer = outputLineBuffer.slice(nl + 1);
                    nl = outputLineBuffer.indexOf("\n");
                  }
                }
                break;
              case "agent_thought_chunk":
                if (!thinkingHeaderShown) {
                  thinkingHeaderShown = true;
                  process.stderr.write(`${C.gray}💭 thinking…${C.reset}\n`);
                }
                if (!thinkingActive) {
                  thinkingActive = true;
                  thinkingStart = Date.now();
                  thoughtChars = 0;
                  thoughtText = "";
                  thought529Shown = false;
                  recentThinkingShown = false;
                  summaryGate?.beginThinking();
                }
                if (update.content.type === "text") {
                  thoughtChars += update.content.text.length;
                  thoughtText += update.content.text;
                  // Surface a provider 529 (overloaded) retry as a small red
                  // marker, once per thinking block. Only checked while we are
                  // actively thinking, and written to stderr so it can't collide
                  // with the input line or the streamed response.
                  if (
                    !thought529Shown &&
                    /\b529\b/.test(update.content.text)
                  ) {
                    thought529Shown = true;
                    process.stderr.write(`${C.red}529${C.reset}\n`);
                  }
                }
                break;
              case "tool_call":
                endThinking();
                if (isUnknownOrInvalidToolCall(update)) {
                  gotTool = true;
                  break;
                }
                gotTool = true;
                summaryGate && (summaryGate.realOutputSeen = true);
                // Echo the last few lines of the just-ended thinking block so
                // the user sees what reasoning led to the action.
                printRecentThinking();
                // Remember what's running so the heartbeat can name it while we
                // wait for the result (e.g. a slow grep won't look frozen).
                {
                  const what = plainWhat(update.rawInput);
                  activeToolLabel = what
                    ? `${update.title ?? "tool"} ${what}`.trim()
                    : `${update.title ?? "tool"} [${(update.kind ?? "other").toLowerCase()}]`;
                }
                renderToolCall(update, false, true);
                break;
              case "tool_call_update":
                endThinking();
                if (isUnknownOrInvalidToolCall(update)) {
                  activeToolLabel = null;
                  break;
                }
                summaryGate && (summaryGate.realOutputSeen = true);
                // A terminal status means this tool is done; stop naming it.
                if (update.status === "completed" || update.status === "failed") {
                  activeToolLabel = null;
                }
                renderToolCall(update, true, true);
                break;
              case "plan":
                endThinking();
                deferredOutputs.push("📋 [plan]");
                break;
              case "available_commands_update":
                endThinking();
                deferredOutputs.push(
                  `📋 ${update.availableCommands.length} commands available`,
                );
                break;
              case "usage_update":
                endThinking();
                usedTokens = update.used;
                mainUsage = {
                  used: Number(update.used) || 0,
                  size: Number(update.size) || 0,
                  costAmount: Number(update.cost?.amount ?? 0) || 0,
                  costCurrency: typeof update.cost?.currency === "string" ? update.cost.currency : "",
                };
                recordUsage(session.sessionId, "main", update);
                deferredOutputs.push(
                  `🔢 ${update.used} tokens used, cost $${(update.cost?.amount ?? 0).toFixed(6)}`,
                );
                break;
              default:
                endThinking();
                deferredOutputs.push(
                  `[${update.sessionUpdate}] ${JSON.stringify(update)}`,
                );
                break;
            }
            return false;
          };

          turnLoop: for (;;) {
            if (cancelController.signal.aborted) {
              clearHeartbeat();
              ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {});
              const waitStart = Date.now();
              while (true) {
                if (Date.now() - waitStart > 15000) {
                  console.log(`\nCanceled. No response from agent after 15s.`);
                  break;
                }
                let msg: Awaited<ReturnType<typeof session.nextUpdate>>;
                try {
                  msg = await Promise.race([
                    session.nextUpdate(),
                    new Promise<never>((_, reject) => {
                      setTimeout(() => reject(new Error("timeout")), 5000);
                    }),
                  ]);
                } catch {
                  continue;
                }
                if (msg.kind === "stop") {
                  stopReason = msg.response?.stopReason as string | undefined;
                  break;
                }
                const upd = msg.notification.update as Record<string, any>;
                if (upd.sessionUpdate === "usage_update") {
                  usedTokens = upd.used;
                  mainUsage = {
                    used: Number(upd.used) || 0,
                    size: Number(upd.size) || 0,
                    costAmount: Number(upd.cost?.amount ?? 0) || 0,
                    costCurrency: typeof upd.cost?.currency === "string" ? upd.cost.currency : "",
                  };
                  recordUsage(session.sessionId, "main", upd);
                  deferredOutputs.push(
                    `🔢 ${upd.used} tokens used, cost $${(upd.cost?.amount ?? 0).toFixed(6)}`,
                  );
                }
              }
              console.log("\nCanceled.");
              break;
            }

            while (updateBuffer.length > 0 && !awaitingUserInput) {
              const buffered = updateBuffer.shift()!;
              const stopped = await processUpdate(buffered);
              if (stopped) break turnLoop;
            }
            if (updateBuffer.length > 0 && awaitingUserInput) {
              await waitForUserInput();
              continue;
            }
            if (updateBuffer.length > 0) continue;

            let message: Awaited<ReturnType<typeof session.nextUpdate>>;
            try {
              message = await Promise.race([
                session.nextUpdate(),
                new Promise<never>((_, reject) => {
                  if (cancelController.signal.aborted) reject(new CancelError());
                  cancelController.signal.addEventListener(
                    "abort",
                    () => reject(new CancelError()),
                    { once: true },
                  );
                }),
              ]);
            } catch (err) {
              if (err instanceof CancelError) {
                continue;
              }
              throw err;
            }

            if (awaitingUserInput) {
              updateBuffer.push(message);
              continue;
            }

            const stopped = await processUpdate(message);
            if (stopped) break;
          }

          // If the turn ended without any response text (e.g. only tool calls),
          // the thinking summary was never flushed before a response. Emit any
          // already-resolved summary now; we don't block here so a cancel or a
          // tool-only turn ends promptly.
          if (!responseSummaryEmitted) {
            summaryGate?.emitIfResolved();
          }

          if (outputLineBuffer.length > 0) {
            if (inCodeFence) {
              process.stdout.write(outputLineBuffer);
            } else {
              // The leftover buffer is the agent's final line, which never got a
              // trailing newline and so was never offered to the table
              // accumulator during streaming. Feed it through now so a trailing
              // table row is rendered inside the box (with wrapping + a closing
              // border) instead of leaking out as a raw single-line markdown
              // string past the box.
              const isTable = isTableRow(outputLineBuffer);
              const flushedMid = tableAccum.push(outputLineBuffer);
              if (flushedMid) process.stdout.write(flushedMid);
              if (!isTable) {
                process.stdout.write(formatMarkdownLine(outputLineBuffer));
              }
            }
            outputLineBuffer = "";
          }
          const flushedTable = tableAccum.flush();
          if (flushedTable) process.stdout.write(flushedTable);
          if (!responseText.endsWith("\n")) console.log("");

          if (deferredOutputs.length > 0) {
            for (const out of deferredOutputs) {
              console.log(`\n${out}`);
            }
          }

          if (!gotText && !gotTool && usedTokens === 0) {
            console.error(
              "\n⚠️  The agent ended the turn without producing any response.\n" +
                "   This usually means no AI provider/model is configured, or it could not be reached.\n" +
                "   Configure a provider/model in ~/.config/kilo/kilo.jsonc (e.g. provider + model),\n" +
                "   or pass one via KILO_AGENT_ARGS.",
            );
          } else if (stopReason && stopReason !== "end_turn") {
            console.log(`\n⚠️  Agent stopped: ${stopReason}`);
          }

          clearHeartbeat();
          summaryGate?.endTurn();

          console.log("\n------------------------------------------------");
          } catch (err) {
            if (!cancelController.signal.aborted) {
              console.error(
                `\n❌ Agent error: ${(err as Error).message}`,
              );
            }
            clearHeartbeat();
            summaryGate?.endTurn();
          }
        }

        // Final /status print + last_session persistence are handled by
        // beforeExitHook inside cleanup(), so they run on every exit path
        // (not just the normal /exit break below).
        session.dispose();
      });
  } catch (error) {
    if (!agentExited) {
      console.error("[Client] Error:", error);
      cleanup(1);
    }
  } finally {
    cleanup(0);
  }
}

let sigintCount = 0;
process.on("SIGINT", () => {
  sigintCount++;
  // In raw mode, Ctrl+C arrives as data (\x03) and is handled by the stdin
  // handler.  SIGINT only fires from external signals (kill -INT) or during
  // the brief window before raw mode is enabled.  In those cases, hard-exit
  // immediately unless we're in the main loop where a cancel is sufficient.
  if (!inMainLoop || sigintCount >= 2) {
    console.log("\nInterrupted.");
    cleanup(0);
    return;
  }
  cancelController.abort();
});

process.on("SIGTERM", () => {
  cleanup(0);
});

process.stdout.on("resize", () => {
  rawInput.onResize();
});

main();
