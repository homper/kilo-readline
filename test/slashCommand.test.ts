import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlashCommandInvocation } from "../src/slashCommand.ts";

test("parseSlashCommandInvocation separates normalized command arguments", () => {
  assert.deepEqual(parseSlashCommandInvocation(" /Thinking max "), {
    command: "/thinking",
    args: "max",
  });
  assert.deepEqual(parseSlashCommandInvocation("/codex-usage"), {
    command: "/codex-usage",
    args: "",
  });
});

test("parseSlashCommandInvocation keeps all trailing text as arguments", () => {
  assert.deepEqual(parseSlashCommandInvocation("/status one two\nthree"), {
    command: "/status",
    args: "one two\nthree",
  });
});

test("parseSlashCommandInvocation ignores ordinary prompts", () => {
  assert.equal(parseSlashCommandInvocation("thinking max"), null);
  assert.equal(parseSlashCommandInvocation(""), null);
});
