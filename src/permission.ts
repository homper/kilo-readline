import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Mirrors kilo-cli's bash "always" pattern derivation (see
// packages/opencode/src/permission/arity.ts and tool/shell.ts) so the
// "Always allow" option can show the *patterns* the agent will actually
// persist, rather than the full command/target. Display-only: the real
// rule is still computed and stored by the agent.

const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);

// Copy of kilo's ARITY table (generated data — safe to mirror). Longest
// matching prefix wins; its arity decides how many leading tokens form the
// command; fallback = first token only.
const ARITY: Record<string, number> = {
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1, grep: 1,
  kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1, pwd: 1, rm: 1,
  rmdir: 1, sleep: 1, source: 1, tail: 1, touch: 1, unset: 1, which: 1,
  aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3, cargo: 2,
  "cargo add": 3, "cargo run": 3, cdk: 2, cf: 2, cmake: 2, composer: 2, consul: 2,
  "consul kv": 3, crictl: 2, deno: 2, "deno task": 3, doctl: 3, docker: 2,
  "docker builder": 3, "docker compose": 3, "docker container": 3, "docker image": 3,
  "docker network": 3, "docker volume": 3, eksctl: 2, "eksctl create": 3,
  firebase: 2, flyctl: 2, gcloud: 3, gh: 3, git: 2, "git config": 3, "git remote": 3,
  "git stash": 3, go: 2, gradle: 2, helm: 2, heroku: 2, hugo: 2, ip: 2, "ip addr": 3,
  "ip link": 3, "ip netns": 3, "ip route": 3, kind: 2, "kind create": 3,
  kubectl: 2, "kubectl kustomize": 3, "kubectl rollout": 3, kustomize: 2, make: 2,
  mc: 2, "mc admin": 3, minikube: 2, mongosh: 2, mysql: 2, mvn: 2, ng: 2, npm: 2,
  "npm exec": 3, "npm init": 3, "npm run": 3, "npm view": 3, nvm: 2, nx: 2,
  openssl: 2, "openssl req": 3, "openssl x509": 3, pip: 2, pipenv: 2, pnpm: 2,
  "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3, poetry: 2, podman: 2,
  "podman container": 3, "podman image": 3, psql: 2, pulumi: 2, "pulumi stack": 3,
  pyenv: 2, python: 2, rake: 2, rbenv: 2, "redis-cli": 2, rustup: 2, serverless: 2,
  sfdx: 3, skaffold: 2, sls: 2, sst: 2, swift: 2, systemctl: 2, terraform: 2,
  "terraform workspace": 3, tmux: 2, turbo: 2, ufw: 2, vault: 2, "vault auth": 3,
  "vault kv": 3, vercel: 2, volta: 2, wp: 2, yarn: 2, "yarn dlx": 3, "yarn run": 3,
};

function arityPrefix(tokens: string[]): string[] {
  for (let len = tokens.length; len > 0; len--) {
    const arity = ARITY[tokens.slice(0, len).join(" ")];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  if (tokens.length === 0) return [];
  return tokens.slice(0, 1);
}

// Quote-aware whitespace tokenizer. Good enough for arity-1/2 prefixes;
// trailing redirects (e.g. `2>/dev/null`) fall beyond the prefix length and
// are ignored, matching kilo's tree-sitter `parts()` behavior for common
// commands.
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === "\\") {
        cur += cmd[i + 1] ?? "";
        i++;
      } else if (ch === q) {
        q = null;
      }
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Split a shell command into its sub-commands on top-level `&&`, `||`, `;`,
// `|`, and `&`, respecting quotes and parentheses.
function splitShellCommands(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === "\\") {
        cur += cmd[i + 1] ?? "";
        i++;
      } else if (ch === q) {
        q = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (depth === 0) {
      const two = cmd.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        i++;
        continue;
      }
      if (ch === "|" || ch === ";") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      if (ch === "&") {
        // Don't treat `&` as a command separator when it's part of a redirect
        // operator: `>&`/`<&` (fd redirect like `2>&1`) or `&>` (redirect both
        // streams). Otherwise `npm run build 2>&1 | head` splits into a bogus
        // `1` sub-command and yields a phantom `1 *` pattern.
        const prev = cur.length > 0 ? cur[cur.length - 1] : "";
        const nextCh = cmd[i + 1] ?? "";
        if (prev === ">" || prev === "<" || nextCh === ">") {
          cur += ch;
          continue;
        }
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// A leading `NAME=value` token is an environment-variable assignment, not a
// command. Bash grammar parses these as `declaration_command` /
// `variable_assignment` nodes (never `command`), so kilo's tree-sitter scan
// (`node.descendantsOfType("command")`) never emits an "always" pattern for
// them. Mirror that here: strip leading assignments (e.g. `FOO=bar ls` → `ls`,
// matching `parts()` filtering out `environment_variable_assignment` children)
// and skip a sub-command that is *only* assignments (e.g. `PID=$!`), which
// would otherwise yield a bogus `PID=$! *` pattern.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Regex-based fallback used when tree-sitter is unavailable or fails. It
// mirrors the tree-sitter scan's semantics for the common cases
// (assignment stripping, cwd skipping, arity prefix) but cannot match the
// grammar on exotic constructs — the tree-sitter path below is the source of
// truth and is preferred.
function bashAlwaysPatternsRegex(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sub of splitShellCommands(command)) {
    const tokens = tokenize(sub);
    let start = 0;
    while (start < tokens.length && ASSIGNMENT.test(tokens[start])) start++;
    if (start >= tokens.length) continue;
    if (CWD.has(tokens[start].toLowerCase())) continue;
    const pref = arityPrefix(tokens.slice(start)).join(" ");
    const pat = pref ? `${pref} *` : "*";
    if (!seen.has(pat)) {
      seen.add(pat);
      out.push(pat);
    }
  }
  return out;
}

// --- tree-sitter scan (preferred; mirrors kilo agent's `collect()`) --------

// Minimal shape of the web-tree-sitter AST we consume. Typed loosely to keep
// the dynamic import optional (the package may be absent in stripped builds).
interface TSNode {
  type: string;
  text: string;
  childCount: number;
  parent: TSNode | null;
  child(i: number): TSNode | null;
  descendantsOfType(type: string): TSNode[];
}
interface TSTree {
  rootNode: TSNode;
}
interface TSParser {
  parse(input: string): TSTree;
}

let parserPromise: Promise<TSParser | null> | null = null;

function resolveCoreWasm(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("web-tree-sitter/web-tree-sitter.wasm");
}

// Collect candidate grammar wasm paths, in priority order. Callers must
// *load* each one and fall through on failure — a candidate that exists on
// disk can still be unloadable when it's stale relative to the installed
// `web-tree-sitter` runtime (e.g. an older `~/.kilo/bin/...` wasm paired
// with a newer npm runtime). Returning the first hit by `existsSync` alone
// silently forces the regex fallback, which mishandles subshells
// (e.g. `(pid=$$; *`) and other constructs the grammar would parse.
function resolveBashWasmCandidates(): string[] {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null) => {
    if (!p) return;
    try {
      if (!fs.existsSync(p)) return;
    } catch {
      return;
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  // kilo-readline-runtime/permission.js → ../tree-sitter/tree-sitter-bash.wasm
  // (kilo's bundled grammar — preferred for version parity with the agent).
  add(path.resolve(here, "..", "tree-sitter", "tree-sitter-bash.wasm"));
  // Vendored standalone fallback inside the runtime itself.
  add(path.resolve(here, "tree-sitter", "tree-sitter-bash.wasm"));
  // A kilo install on PATH regardless of where this runtime lives.
  add(path.join(os.homedir(), ".kilo", "bin", "tree-sitter", "tree-sitter-bash.wasm"));
  // Dev / standalone: resolve from an installed tree-sitter-bash package.
  // The `.wasm` ships at the *package root* (see its `files: ["*.wasm"]`),
  // NOT beside the node main entry (`bindings/node/index.js`), so derive the
  // root from the package.json — `path.dirname(require.resolve(...))` would
  // point at `bindings/node/` and miss the wasm. This version-matched npm
  // copy is the reliable fallback when a bundled grammar is stale/absent.
  for (const spec of ["tree-sitter-bash/package.json", "tree-sitter-bash"]) {
    try {
      add(path.join(path.dirname(require.resolve(spec)), "tree-sitter-bash.wasm"));
    } catch {
      /* this spec not resolvable, try next */
    }
  }
  return out;
}

async function getBashParser(): Promise<TSParser | null> {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const candidates = resolveBashWasmCandidates();
    if (candidates.length === 0) return null;
    const coreWasm = resolveCoreWasm();
    const wts = await import("web-tree-sitter");
    const Parser = (wts as { Parser: { init(opts: { locateFile: (f: string) => string }): Promise<void> } }).Parser;
    const Language = (wts as { Language: { load(pathOrUrl: string): Promise<unknown> } }).Language;
    await Parser.init({
      locateFile() {
        return coreWasm;
      },
    });
    // Try each candidate grammar until one actually loads; a stale bundled
    // wasm can fail `Language.load` (ABI mismatch) and must not abort the
    // whole path — fall through to the version-matched npm copy below it.
    for (const bashWasm of candidates) {
      try {
        const language = await Language.load(bashWasm);
        const parser = new (wts as { Parser: new () => TSParser }).Parser();
        (parser as unknown as { setLanguage(lang: unknown): void }).setLanguage(language);
        return parser;
      } catch {
        /* this grammar failed to load, try the next candidate */
      }
    }
    return null;
  })();
  return parserPromise;
}

// Ported from kilocode-src `packages/opencode/src/tool/shell.ts` `parts()` so
// the token extraction matches the agent exactly: `command_elements` children
// are flattened (minus separators/redirections), and only command-name/word/
// string token types are kept. Bare `environment_variable_assignment` and
// `declaration_command` wrappers never reach here because we only walk
// `command` nodes (declarations parse as `declaration_command`, not `command`).
function parts(node: TSNode): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  const keep = new Set(["command_name", "command_name_expr", "word", "string", "raw_string", "concatenation"]);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j);
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue;
        out.push({ type: item.type, text: item.text });
      }
      continue;
    }
    if (!keep.has(child.type)) continue;
    out.push({ type: child.type, text: child.text });
  }
  return out;
}

async function bashAlwaysPatternsTs(command: string): Promise<string[] | null> {
  const parser = await getBashParser();
  if (!parser) return null;
  let tree: TSTree;
  try {
    tree = parser.parse(command);
  } catch {
    return null;
  }
  const root = tree.rootNode;
  if (!root) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of root.descendantsOfType("command")) {
    const tokens = parts(node).map((p) => p.text);
    if (tokens.length === 0) continue;
    // Bash is case-sensitive for the command name (kilo does not lowercase it
    // for bash shells). `cd`/`pushd` etc. are skipped entirely.
    const cmd = tokens[0];
    if (cmd && CWD.has(cmd)) continue;
    const pref = arityPrefix(tokens).join(" ");
    const pat = `${pref} *`;
    if (!seen.has(pat)) {
      seen.add(pat);
      out.push(pat);
    }
  }
  return out;
}

export async function bashAlwaysPatterns(command: string): Promise<string[]> {
  const ts = await bashAlwaysPatternsTs(command);
  if (ts) return ts;
  return bashAlwaysPatternsRegex(command);
}

// Mirror kilo's shell `scan.patterns` — the *call's target* patterns (the
// source text of each non-CWD command node, including a wrapping
// `redirected_statement` so `ls > f` keeps the redirect). These are what
// permission rules are matched against, as opposed to `bashAlwaysPatterns`
// (the arity-prefix shape an "always allow" persists). `source(node)` mirrors
// kilo's shell.ts: `(node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()`.
async function bashCallPatternsTs(command: string): Promise<string[] | null> {
  const parser = await getBashParser();
  if (!parser) return null;
  let tree: TSTree;
  try {
    tree = parser.parse(command);
  } catch {
    return null;
  }
  const root = tree.rootNode;
  if (!root) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of root.descendantsOfType("command")) {
    const tokens = parts(node).map((p) => p.text);
    if (tokens.length === 0) continue;
    // Bash is case-sensitive for the command name; kilo skips CWD commands
    // (cd/pushd/...) entirely. Lowercase the check to match the client's
    // existing CWD set (vanishingly rare `CD` diverges; safe default is ask).
    const cmd = tokens[0];
    if (cmd && CWD.has(cmd.toLowerCase())) continue;
    const src = (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim();
    if (src && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

// Regex fallback: splitShellCommands yields the sub-command strings (the
// source text approximation). Strip leading `NAME=value` assignments (which
// parse as separate grammar nodes, so source(node) wouldn't include them),
// skip CWD-only sub-commands, and emit the remainder as the call pattern.
function bashCallPatternsRegex(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sub of splitShellCommands(command)) {
    const tokens = tokenize(sub);
    let start = 0;
    while (start < tokens.length && ASSIGNMENT.test(tokens[start])) start++;
    if (start >= tokens.length) continue;
    if (CWD.has(tokens[start].toLowerCase())) continue;
    const src = tokens.slice(start).join(" ");
    if (src && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

export async function bashCallPatterns(command: string): Promise<string[]> {
  const ts = await bashCallPatternsTs(command);
  if (ts) return ts;
  return bashCallPatternsRegex(command);
}

function dirGlob(dir: string): string {
  return path.join(dir, "*").replaceAll("\\", "/");
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Returns the patterns the kilo agent will persist for an "always" reply to
// this tool call. Mirrors each tool's `ctx.ask({ always: [...] })` value.
export async function alwaysPatterns(toolName: string, rawInput: unknown): Promise<string[]> {
  const t = (toolName ?? "").toLowerCase();
  const obj = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  if (t === "bash" || t === "shell") {
    const pats = await bashAlwaysPatterns(asStr(obj.command));
    return pats.length > 0 ? pats : ["*"];
  }
  if (t === "external_directory") {
    // Mirror kilo's `assertExternalDirectory` glob exactly: it globs the
    // kind-aware `parentDir` (the dir itself for a directory, the parent for
    // a file) — NOT path.dirname(filepath), which would always return the
    // parent and mismatch what an "always" reply persists.
    const dir = asStr(obj.parentDir) || asStr(obj.directory);
    if (dir) return [dirGlob(dir)];
    const fp = asStr(obj.filePath) || asStr(obj.filepath) || asStr(obj.path);
    if (fp) return [dirGlob(path.dirname(fp))];
    const pats = obj.patterns;
    if (Array.isArray(pats) && pats.length > 0) return pats.filter((p): p is string => typeof p === "string");
    return ["*"];
  }
  if (t === "skill") {
    const n = asStr(obj.name);
    return n ? [n] : ["*"];
  }
  if (t === "recall") {
    const d = asStr(obj.directory) || asStr(obj.path);
    return d ? [d] : ["search"];
  }
  if (t === "repo_clone") {
    const r = asStr(obj.repository) || asStr(obj.url);
    return r ? [r] : ["*"];
  }
  if (t.startsWith("mcp_") || t === "read_mcp_resource" || t === "list_mcp_resources" || t === "list_mcp_resource_templates") {
    const server = asStr(obj.server);
    return server ? [`mcp:${server}:*`] : ["*"];
  }
  // read, edit, write, apply_patch, glob, grep, warpgrep, webfetch, websearch,
  // lsp, diagnostics, suggest, task, todo/todowrite, plan, code-mode, … → "*"
  return ["*"];
}

// Merge one "always" rule into an in-memory kilo `permission` object,
// returning a NEW object (inputs are never mutated). Mirrors the shape the
// agent persists for a global "always" reply, so the file the client writes
// to `.kilo/kilo.jsonc` is byte-compatible with a hand-edited one.
//
// `tool` is the config key (ruleToolName output, e.g. "bash" /
// "external_dir"). `patterns` are the patterns an "always" reply would
// persist (e.g. ["npm install *"] or ["/tmp/*"]). `decision` is "allow" or
// "reject" — kilo's permission action vocabulary is "allow"/"deny"/"ask",
// but "always reject" persists as "reject" in the agent's `toConfig`, so we
// match that here.
export function applyPermissionRule(
  perm: Record<string, unknown>,
  tool: string,
  patterns: string[],
  decision: "allow" | "reject",
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...perm };
  // A blanket "*" pattern (the fallback for tools without a derivable
  // pattern) is stored as the scalar decision string, matching how kilo
  // persists a blanket rule (e.g. `"read": "allow"`).
  if (patterns.length === 1 && patterns[0] === "*") {
    out[tool] = decision;
    return out;
  }
  const existing = out[tool];
  const map: Record<string, string> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) as Record<string, string> }
      : {};
  for (const p of patterns) {
    if (p) map[p] = decision;
  }
  out[tool] = map;
  return out;
}
