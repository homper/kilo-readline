import { describe, it } from "node:test";
import assert from "node:assert";
import { bashAlwaysPatterns, alwaysPatterns, applyPermissionRule } from "../src/permission.js";

describe("bashAlwaysPatterns", () => {
  it("npm install → npm install *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("npm install"), ["npm install *"]);
  });
  it("npm run dev → npm run dev *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("npm run dev"), ["npm run dev *"]);
  });
  it("git checkout main → git checkout *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("git checkout main"), ["git checkout *"]);
  });
  it("grep -n pat file → grep *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("grep -n pat file"), ["grep *"]);
  });
  it("python script.py → python script.py *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("python script.py"), ["python script.py *"]);
  });
  it("cd /foo (cwd command) → []", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("cd /foo"), []);
  });
  it("piped ls -la | grep foo → ls *, grep *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("ls -la | grep foo"), ["ls *", "grep *"]);
  });
  it("chained && with redirect → ls *, echo *", async () => {
    assert.deepStrictEqual(
      await bashAlwaysPatterns('ls /home/x 2>/dev/null && echo "---EXISTS---" || echo "---NOT FOUND---"'),
      ["ls *", "echo *"],
    );
  });
  it("piped with fd redirect 2>&1 → no phantom `1 *`", async () => {
    assert.deepStrictEqual(
      await bashAlwaysPatterns("npm run build 2>&1 | head -40"),
      ["npm run build *", "head *"],
    );
  });
  it("fd redirect to stderr >&2 stays in one command", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("echo hi >&2"), ["echo *"]);
  });
  it("&> redirect both streams stays in one command", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("cmd &>file"), ["cmd *"]);
  });
  it("real background & still splits", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("sleep 10 & echo hi"), ["sleep *", "echo *"]);
  });
  it("unknown command mytool arg → mytool *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("mytool arg"), ["mytool *"]);
  });
  it("dedupes repeated sub-commands", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("echo a && echo b"), ["echo *"]);
  });
  it("cwd-only command falls back to []", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("cd /foo && pushd /bar"), []);
  });
  it("respects quotes around args", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns('echo "hello world"'), ["echo *"]);
  });
  it("bare assignment PID=$! is skipped (no PID=$! *)", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("PID=$!"), []);
  });
  it("env-prefixed command FOO=bar ls → ls *", async () => {
    assert.deepStrictEqual(await bashAlwaysPatterns("FOO=bar ls -la"), ["ls *"]);
  });
  it("backgrounded true with PID capture omits the assignment", async () => {
    assert.deepStrictEqual(
      await bashAlwaysPatterns(
        "true > /tmp/true.log & PID=$!; sleep 2; kill $PID 2>/dev/null; wait $PID 2>/dev/null; head -n 5 /tmp/true.log | sed 's/.*/\\U&/'",
      ),
      ["true *", "sleep *", "kill *", "wait *", "head *", "sed *"],
    );
  });
});

describe("alwaysPatterns (per-tool)", () => {
  it("bash dispatches to bashAlwaysPatterns", async () => {
    assert.deepStrictEqual(await alwaysPatterns("bash", { command: "npm install lodash" }), ["npm install *"]);
  });
  it("grep → [*]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("grep", { pattern: "elicitation", path: "/x" }), ["*"]);
  });
  it("read → [*]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("read", { filePath: "/a/b.ts" }), ["*"]);
  });
  it("edit → [*]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("edit", { filePath: "/a/b.ts" }), ["*"]);
  });
  it("skill with name → [name]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("skill", { name: "kilo-config" }), ["kilo-config"]);
  });
  it("skill without name → [*]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("skill", {}), ["*"]);
  });
  it("recall with directory → [directory]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("recall", { directory: "/proj" }), ["/proj"]);
  });
  it("recall without directory → search", async () => {
    assert.deepStrictEqual(await alwaysPatterns("recall", {}), ["search"]);
  });
  it("external_directory uses dirname glob, not the file", async () => {
    assert.deepStrictEqual(
      await alwaysPatterns("external_directory", { filePath: "/home/bdebribuh/projects/kilocode-src/packages/opencode/src/tool/question.ts" }),
      ["/home/bdebribuh/projects/kilocode-src/packages/opencode/src/tool/*"],
    );
  });
  it("external_directory with parentDir", async () => {
    assert.deepStrictEqual(await alwaysPatterns("external_directory", { parentDir: "/x/y" }), ["/x/y/*"]);
  });
  it("external_directory prefers parentDir over filepath (matches kilo directory-kind glob)", async () => {
    // kilo's assertExternalDirectory sends both `filepath` and `parentDir`;
    // for a directory the glob is the dir itself, not path.dirname(filepath).
    assert.deepStrictEqual(
      await alwaysPatterns("external_directory", { filepath: "/home/bdebribuh/projects/cockblockd", parentDir: "/home/bdebribuh/projects/cockblockd" }),
      ["/home/bdebribuh/projects/cockblockd/*"],
    );
  });
  it("external_directory with patterns array", async () => {
    assert.deepStrictEqual(await alwaysPatterns("external_directory", { patterns: ["/z/*"] }), ["/z/*"]);
  });
  it("mcp tool with server → mcp:<server>:*", async () => {
    assert.deepStrictEqual(await alwaysPatterns("mcp_myserver_search", { server: "myserver" }), ["mcp:myserver:*"]);
  });
  it("unknown tool → [*]", async () => {
    assert.deepStrictEqual(await alwaysPatterns("frobnicate", { x: 1 }), ["*"]);
  });
});

describe("applyPermissionRule", () => {
  it("blanket pattern ['*'] → scalar decision string", () => {
    assert.deepStrictEqual(applyPermissionRule({}, "read", ["*"], "allow"), { read: "allow" });
  });
  it("bash + ['npm install *'] → map", () => {
    assert.deepStrictEqual(applyPermissionRule({}, "bash", ["npm install *"], "allow"), {
      bash: { "npm install *": "allow" },
    });
  });
  it("merges into existing map, keeping prior patterns", () => {
    const before = { bash: { "echo *": "allow" } };
    assert.deepStrictEqual(applyPermissionRule(before, "bash", ["grep *"], "allow"), {
      bash: { "echo *": "allow", "grep *": "allow" },
    });
  });
  it("scalar string base is replaced by a pattern map", () => {
    assert.deepStrictEqual(applyPermissionRule({ bash: "ask" }, "bash", ["grep *"], "allow"), {
      bash: { "grep *": "allow" },
    });
  });
  it("reject decision persists as 'reject'", () => {
    assert.deepStrictEqual(applyPermissionRule({}, "bash", ["rm -rf *"], "reject"), {
      bash: { "rm -rf *": "reject" },
    });
  });
  it("does not mutate the input object", () => {
    const before = { bash: { "echo *": "allow" } };
    const frozen = JSON.parse(JSON.stringify(before));
    applyPermissionRule(before, "bash", ["grep *"], "allow");
    assert.deepStrictEqual(before, frozen);
  });
  it("preserves unrelated top-level keys", () => {
    assert.deepStrictEqual(
      applyPermissionRule({ read: "allow", bash: { "echo *": "allow" } }, "bash", ["grep *"], "allow"),
      { read: "allow", bash: { "echo *": "allow", "grep *": "allow" } },
    );
  });
});
