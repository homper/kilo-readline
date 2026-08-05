import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(): Writable & { output: string } {
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as Writable & { output: string };
  Object.defineProperty(ws, "output", { get: () => output });
  return ws;
}

describe("paste-mode enter handling", () => {
  it("Enter on empty last line sends text after paste mode exits", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    // Simulate typing "hello" then newline during paste mode
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(Buffer.from([0x0a])); // \n during paste → insertNewline
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from([0x0a])); // \n during paste → insertNewline
    ri.setPasteMode(false);

    // Now cursor should be on last empty line (row 2, col 0)
    // lines = ["hello", "world", ""]
    // Pressing Enter should finish (send)

    ri.handleBytes(Buffer.from([0x0d])); // Enter
    const result = await readPromise;

    assert.strictEqual(result, "hello\nworld\n", "Should send text ending with newline");
  });

  it("Enter during paste mode inserts newline, Enter after paste on empty line sends", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    // Simulate paste: "singleline\n\n" arrives during paste mode (content + two blank lines)
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("singleline"));
    ri.handleBytes(Buffer.from([0x0a])); // \n during paste → insertNewline (not finish)
    ri.handleBytes(Buffer.from([0x0a])); // another \n → insertNewline

    ri.setPasteMode(false);

    // Now lines = ["singleline", "", ""], cursor on last empty line
    // Enter on empty last line should finish (not insert yet another newline)
    ri.handleBytes(Buffer.from([0x0d])); // Enter
    const result = await readPromise;

    // lines.join("\n") = "singleline\n\n" (two separators between three elements)
    assert.strictEqual(result, "singleline\n\n", "Paste newlines preserved, Enter sends on empty line");
  });

  it("Enter on non-empty last line inserts newline (not send)", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(Buffer.from([0x0d])); // Enter on single line → finish
    const result = await readPromise;

    assert.strictEqual(result, "hello", "Single line Enter should send plain text");
  });

  it("After paste, Enter on empty last line finishes even with unclosed code block not present", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("line one"));
    ri.handleBytes(Buffer.from([0x0a]));
    ri.handleBytes(Buffer.from("line two"));
    ri.handleBytes(Buffer.from([0x0a]));
    ri.handleBytes(Buffer.from("line three"));
    ri.handleBytes(Buffer.from([0x0a]));
    ri.setPasteMode(false);

    // lines = ["line one", "line two", "line three", ""]
    // Enter on empty last line → finish
    ri.handleBytes(Buffer.from([0x0d]));

    const result = await readPromise;
    assert.strictEqual(result, "line one\nline two\nline three\n", "Multiline paste should send");
  });

  it("Empty first line Enter after paste should still send", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    // Paste that ends with content on the last line (no trailing empty line)
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("foo"));
    ri.handleBytes(Buffer.from([0x0a]));
    ri.handleBytes(Buffer.from("bar"));
    // No trailing \n, so lines = ["foo", "bar"], cursor on "bar" at end
    ri.setPasteMode(false);

    // Enter inserts a newline (since last line has content)
    ri.handleBytes(Buffer.from([0x0d]));
    // Now lines = ["foo", "bar", ""], cursor on empty line
    // Enter on empty line → finish
    ri.handleBytes(Buffer.from([0x0d]));

    const result = await readPromise;
    assert.strictEqual(result, "foo\nbar\n", "Should send after double-enter");
  });

  it("Bracketed paste: newlines in paste content should insert newlines, not finish", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    // Correct flow: process content while in paste mode, then turn off
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("hello\nworld\n")); // Newlines insert because inPaste=true
    ri.setPasteMode(false);

    // After this, lines should be ["hello", "world", ""]
    // Press Enter on empty last line → finish
    ri.handleBytes(Buffer.from([0x0d]));
    const result = await readPromise;

    assert.strictEqual(result, "hello\nworld\n", "Paste newlines should be preserved");
  });

  it("Bracketed paste with content processed after paste mode off should preserve newlines", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    // Correct order: process content while in paste mode, then turn off
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("line1\nline2\nline3\n"));
    ri.setPasteMode(false);

    // lines = ["line1", "line2", "line3", ""], cursor on empty last line
    // Enter should finish
    ri.handleBytes(Buffer.from([0x0d]));
    const result = await readPromise;

    assert.strictEqual(result, "line1\nline2\nline3\n", "All paste newlines preserved");
  });
});
