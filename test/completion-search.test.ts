import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(): Writable & { output: string; columns: number; rows: number } {
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as Writable & { output: string; columns: number; rows: number };
  Object.defineProperty(ws, "output", { get: () => output });
  Object.defineProperty(ws, "columns", { value: 80, configurable: true });
  Object.defineProperty(ws, "rows", { value: 24, configurable: true });
  return ws;
}

describe("completion: substring search preserves the typed token", () => {
  it("keeps the typed text when matches share no common prefix", () => {
    const stdout = makeStdout();
    // A substring completer like /model's search: matches contain the query
    // but begin with different providers, so their common prefix is empty.
    const completer = (line: string): [string[], string] => {
      const q = line.trim().toLowerCase();
      if (q === "claude") {
        return [["anthropic/claude-sonnet", "openrouter/claude-haiku"], line];
      }
      return [[], line];
    };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
      completer,
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("claude"));

    // Tab enters cycling. Since the matches share no common prefix that extends
    // "claude", the typed token is preserved (not deleted to "").
    ri.handleBytes(Buffer.from([0x09])); // Tab
    assert.strictEqual(ri.text, "claude", "typed token preserved on first Tab");
  });

  it("cycles to a full match on the next Tab", () => {
    const stdout = makeStdout();
    const completer = (line: string): [string[], string] => {
      const q = line.trim().toLowerCase();
      if (q === "claude") {
        return [["anthropic/claude-sonnet", "openrouter/claude-haiku"], line];
      }
      return [[], line];
    };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
      completer,
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("claude"));
    ri.handleBytes(Buffer.from([0x09])); // Tab → preserve token, show overlay
    ri.handleBytes(Buffer.from([0x09])); // Tab → cycle to first full match
    assert.strictEqual(ri.text, "anthropic/claude-sonnet", "cycled to first match");
  });

  it("still extends the token for prefix completions (paths/commands)", () => {
    const stdout = makeStdout();
    // Prefix-style completer: every hit starts with the typed token, so the
    // common prefix extends it. This must behave as before (token grows).
    const completer = (line: string): [string[], string] => {
      const token = line.trim();
      if (token === "ab") return [["abc1", "abc2"], line];
      return [[], line];
    };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
      completer,
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("ab"));
    ri.handleBytes(Buffer.from([0x09])); // Tab → common prefix "abc" extends "ab"
    assert.strictEqual(ri.text, "abc", "token extended to common prefix");
  });

  it("Escape mid-cycling reverts the input to the originally typed token", () => {
    const stdout = makeStdout();
    const completer = (line: string): [string[], string] => {
      const q = line.trim().toLowerCase();
      if (q === "claude") {
        return [["anthropic/claude-sonnet", "openrouter/claude-haiku"], line];
      }
      return [[], line];
    };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
      completer,
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("claude"));
    ri.handleBytes(Buffer.from([0x09])); // Tab → preserve token, show overlay
    ri.handleBytes(Buffer.from([0x09])); // Tab → cycle to first full match
    assert.strictEqual(ri.text, "anthropic/claude-sonnet", "cycled to first match");
    // A lone Escape (the Escape key, in its own chunk) reverts to the typed
    // query — the user gets their search string back, not the cycled model id.
    ri.handleBytes(Buffer.from([0x1b]));
    assert.strictEqual(ri.text, "claude", "Escape reverts to the typed token");
    // The cursor must land at the end of the restored token so further typing
    // appends to it rather than overwriting/inserting elsewhere.
    ri.handleBytes(Buffer.from("x"));
    assert.strictEqual(ri.text, "claudex", "typing after Escape appends to the reverted token");
  });

  it("Escape with no completion active is a no-op (does not drop typed text)", () => {
    const stdout = makeStdout();
    const completer = (line: string): [string[], string] => {
      const q = line.trim().toLowerCase();
      if (q === "claude") {
        return [["anthropic/claude-sonnet", "openrouter/claude-haiku"], line];
      }
      return [[], line];
    };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
      completer,
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("claude"));
    // No Tab pressed, so no cycling is active: a lone Escape must do nothing.
    ri.handleBytes(Buffer.from([0x1b]));
    assert.strictEqual(ri.text, "claude", "Escape with no completion leaves the text intact");
  });

  it("Up loads a history entry when history navigation is enabled (default)", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [{ text: "older", isMultiline: false }],
      completer: () => [[], ""],
    });
    ri.read(false); // single-line mode, like /model's search
    ri.handleBytes(Buffer.from("now"));
    ri.handleBytes(Buffer.from("\x1b[A")); // Up
    assert.strictEqual(ri.text, "older", "Up loads the previous history entry");
  });

  it("Up does NOT load history when setHistoryEnabled(false) (used by /model search)", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [{ text: "older", isMultiline: false }],
      completer: () => [[], ""],
    });
    ri.setHistoryEnabled(false);
    ri.read(false); // single-line mode, like /model's search
    ri.handleBytes(Buffer.from("now"));
    ri.handleBytes(Buffer.from("\x1b[A")); // Up
    assert.strictEqual(ri.text, "now", "Up is a no-op when history is disabled");
    // Down should likewise be a no-op (historyIndex stayed at -1).
    ri.handleBytes(Buffer.from("\x1b[B")); // Down
    assert.strictEqual(ri.text, "now", "Down is a no-op when history is disabled");
  });

  it("Ctrl+R does NOT start reverse-search when setHistoryEnabled(false)", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [{ text: "older", isMultiline: false }],
      completer: () => [[], ""],
    });
    ri.setHistoryEnabled(false);
    ri.read(false);
    ri.handleBytes(Buffer.from("now"));
    ri.handleBytes(Buffer.from([0x12])); // Ctrl+R
    assert.strictEqual(ri.isSearching, false, "Ctrl+R did not start reverse-search");
    assert.strictEqual(ri.text, "now", "input unchanged after disabled Ctrl+R");
  });
});
