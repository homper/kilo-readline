import { describe, it } from "node:test";
import assert from "node:assert";
import {
  wildcardMatch,
  fromConfig,
  mergePermissionInto,
  evaluate,
  decide,
  callPatterns,
} from "../src/permissionEval.js";
import { bashCallPatterns } from "../src/permission.js";

describe("wildcardMatch", () => {
  it("matches with trailing *", () => {
    assert.ok(wildcardMatch("npm install foo", "npm install *"));
  });
  it("trailing * is optional (matches the bare prefix)", () => {
    assert.ok(wildcardMatch("npm install", "npm install *"));
  });
  it("rm * matches rm -rf /", () => {
    assert.ok(wildcardMatch("rm -rf /", "rm *"));
  });
  it("* matches any permission key", () => {
    assert.ok(wildcardMatch("bash", "*"));
    assert.ok(wildcardMatch("github_create_pr", "*"));
  });
  it("non-matching pattern returns false", () => {
    assert.ok(!wildcardMatch("npm install foo", "rm *"));
  });
  it("normalizes backslashes", () => {
    assert.ok(wildcardMatch("C:/foo/bar", "C:\\foo\\*"));
  });
});

describe("fromConfig", () => {
  it("scalar -> {*, action}", () => {
    assert.deepStrictEqual(fromConfig({ bash: "allow" }), [{ permission: "bash", pattern: "*", action: "allow" }]);
  });
  it("object -> one rule per entry (null skipped)", () => {
    assert.deepStrictEqual(
      fromConfig({ bash: { "npm install *": "allow", "rm *": null } }),
      [{ permission: "bash", pattern: "npm install *", action: "allow" }],
    );
  });
  it("top-level null is skipped", () => {
    assert.deepStrictEqual(fromConfig({ bash: null, read: "ask" }), [
      { permission: "read", pattern: "*", action: "ask" },
    ]);
  });
});

describe("mergePermissionInto", () => {
  it("higher scalar dominates lower object", () => {
    const acc: Record<string, unknown> = { bash: { "rm *": "deny" } };
    mergePermissionInto(acc, { bash: "allow" });
    assert.deepStrictEqual(fromConfig(acc), [{ permission: "bash", pattern: "*", action: "allow" }]);
  });
  it("higher object specifics override lower scalar (order: * first, specifics after)", () => {
    const acc: Record<string, unknown> = { bash: "allow" };
    mergePermissionInto(acc, { bash: { "rm *": "deny" } });
    assert.deepStrictEqual(fromConfig(acc), [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ]);
  });
  it("top-level null deletes the tool", () => {
    const acc: Record<string, unknown> = { bash: "allow" };
    mergePermissionInto(acc, { bash: null });
    assert.deepStrictEqual(fromConfig(acc), []);
  });
  it("pattern null deletes that pattern", () => {
    const acc: Record<string, unknown> = { bash: { "rm *": "deny", "npm install *": "allow" } };
    mergePermissionInto(acc, { bash: { "rm *": null } });
    assert.deepStrictEqual(fromConfig(acc), [{ permission: "bash", pattern: "npm install *", action: "allow" }]);
  });
});

describe("evaluate", () => {
  it("findLast wins (project deny after global allow)", () => {
    const rules = fromConfig({ bash: "allow" }).concat(fromConfig({ bash: { "rm *": "deny" } }));
    assert.strictEqual(evaluate("bash", "rm -rf /", rules).action, "deny");
    assert.strictEqual(evaluate("bash", "npm install", rules).action, "allow");
  });
  it("default ask when nothing matches", () => {
    assert.strictEqual(evaluate("bash", "npm install", []).action, "ask");
  });
  it("blanket * rule matches any tool", () => {
    const rules = fromConfig({ "*": "allow" });
    assert.strictEqual(evaluate("bash", "anything", rules).action, "allow");
    assert.strictEqual(evaluate("github_create_pr", "x", rules).action, "allow");
  });
});

describe("decide", () => {
  it("any deny -> deny", async () => {
    const rules = fromConfig({ bash: { "rm *": "deny", "npm install *": "allow" } });
    assert.strictEqual((await decide("bash", { command: "npm install && rm -rf /" }, rules)).action, "deny");
  });
  it("all allow -> allow", async () => {
    const rules = fromConfig({ bash: "allow" });
    assert.strictEqual((await decide("bash", { command: "npm install foo" }, rules)).action, "allow");
  });
  it("no rule -> ask", async () => {
    assert.strictEqual((await decide("bash", { command: "npm install foo" }, [])).action, "ask");
  });
  it("skill allow by name", async () => {
    const rules = fromConfig({ skill: { "kilo-config": "allow" } });
    assert.strictEqual((await decide("skill", { name: "kilo-config" }, rules)).action, "allow");
    assert.strictEqual((await decide("skill", { name: "other" }, rules)).action, "ask");
  });
  it("read scalar allow", async () => {
    const rules = fromConfig({ read: "allow" });
    assert.strictEqual((await decide("read", { filePath: "src/index.ts" }, rules)).action, "allow");
  });
  it("read specific allow matches the file path", async () => {
    // A rule matching both the file and its parent dir ("src*" covers both)
    const rules = fromConfig({ read: { "src*": "allow" } });
    assert.strictEqual((await decide("read", { filePath: "src/index.ts" }, rules)).action, "allow");
  });
  it("read 'src/*' asks for src/index.ts (parent dir 'src' doesn't match — mirrors kilo)", async () => {
    const rules = fromConfig({ read: { "src/*": "allow" } });
    assert.strictEqual((await decide("read", { filePath: "src/index.ts" }, rules)).action, "ask");
  });
  it("read non-matching path -> ask", async () => {
    const rules = fromConfig({ read: { "src/*": "allow" } });
    assert.strictEqual((await decide("read", { filePath: "secret/key" }, rules)).action, "ask");
  });
  it("external_directory dir glob", async () => {
    const rules = fromConfig({ external_directory: { "/tmp/*": "allow" } });
    assert.strictEqual((await decide("external_directory", { parentDir: "/tmp" }, rules)).action, "allow");
    assert.strictEqual((await decide("external_directory", { parentDir: "/etc" }, rules)).action, "ask");
  });
  it("legacy external_dir alias normalizes to external_directory on merge", async () => {
    const acc: Record<string, unknown> = {};
    mergePermissionInto(acc, { external_dir: { "/tmp/*": "allow" } });
    assert.ok(!("external_dir" in acc), "external_dir alias should be folded into external_directory");
    assert.ok("external_directory" in acc);
    const rules = fromConfig(acc);
    assert.strictEqual((await decide("external_directory", { parentDir: "/tmp" }, rules)).action, "allow");
    assert.strictEqual((await decide("external_directory", { parentDir: "/etc" }, rules)).action, "ask");
  });
  it("external_dir and external_directory consolidate (specifics win)", async () => {
    const acc: Record<string, unknown> = {};
    mergePermissionInto(acc, { external_directory: { "/tmp/*": "allow" } });
    mergePermissionInto(acc, { external_dir: { "/etc/*": "deny" } });
    assert.ok(!("external_dir" in acc));
    const rules = fromConfig(acc);
    assert.strictEqual((await decide("external_directory", { parentDir: "/tmp" }, rules)).action, "allow");
    assert.strictEqual((await decide("external_directory", { parentDir: "/etc" }, rules)).action, "deny");
  });
});

describe("bashCallPatterns", () => {
  it("returns source text per sub-command", async () => {
    assert.deepStrictEqual(await bashCallPatterns("npm install foo"), ["npm install foo"]);
  });
  it("splits piped/chained commands", async () => {
    const pats = await bashCallPatterns("ls -la | grep foo && echo done");
    assert.ok(pats.includes("ls -la"));
    assert.ok(pats.includes("grep foo"));
    assert.ok(pats.includes("echo done"));
  });
  it("skips CWD-only commands", async () => {
    assert.deepStrictEqual(await bashCallPatterns("cd /foo"), []);
  });
  it("matches an arity-prefix rule", async () => {
    const rules = fromConfig({ bash: { "npm install *": "allow" } });
    assert.strictEqual((await decide("bash", { command: "npm install foo" }, rules)).action, "allow");
  });
});
