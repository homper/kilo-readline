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

const ALT_ENTER = Buffer.from([0x1b, 0x0d]);

describe("Ctrl+J submits from anywhere", () => {
  it("Ctrl+J (0x0a) submits text even when cursor is in the middle", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER); // Alt+Enter inserts a newline (multiline build)
    ri.handleBytes(Buffer.from("world"));
    // Move cursor to start of whole input (not at end)
    ri.handleBytes(Buffer.from("\x1b[1;5H"));
    ri.handleBytes(Buffer.from([0x0a])); // Ctrl+J -> submit anywhere

    const result = await readPromise;
    assert.strictEqual(result, "hello\nworld", "Ctrl+J should submit from any position");
  });

  it("Ctrl+J from mid-block moves cursor to end of input before final newline", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER); // multiline: hello\nworld
    ri.handleBytes(Buffer.from("world"));
    // Move cursor to start of whole input (middle of the block)
    ri.handleBytes(Buffer.from("\x1b[1;5H"));
    ri.handleBytes(Buffer.from([0x0a])); // Ctrl+J -> submit from mid-block

    const result = await readPromise;
    assert.strictEqual(result, "hello\nworld");

    const out = stdout.output;
    // The final render positioned the cursor on the first content row. Before
    // the trailing newline, finish() must emit a cursor-down sequence to reach
    // the last content row so subsequent output starts below the full block.
    const tail = out.slice(out.lastIndexOf("\x1b[?25h") + 0);
    const downMatch = tail.match(/\x1b\[(\d+)B/);
    assert.ok(downMatch, "a cursor-down escape should precede the final newline when submitting from mid-block");
    assert.ok(Number(downMatch![1]) >= 1, "cursor should move down at least one row");
  });

  it("Ctrl+J at end of block does NOT emit an extra cursor-down before newline", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world")); // cursor left at end of block
    ri.handleBytes(Buffer.from([0x0a])); // Ctrl+J -> submit from end

    const result = await readPromise;
    assert.strictEqual(result, "hello\nworld");

    const out = stdout.output;
    // Cursor is already at the last content row, so finish() must not move down
    // before the final newline — otherwise a blank line would appear.
    const lastNewline = out.lastIndexOf("\r\n");
    const before = out.slice(Math.max(0, lastNewline - 16), lastNewline);
    assert.ok(!/\x1b\[\d+B/.test(before), "no cursor-down should precede the final newline when at end of block");
  });

  it("Ctrl+J in paste mode still inserts a newline (not submit)", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });

    const readPromise = ri.read(true);

    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(Buffer.from([0x0a])); // newline during paste -> insert, not submit
    ri.handleBytes(Buffer.from("world"));
    ri.setPasteMode(false);

    // Still active here proves Ctrl+J during paste did NOT submit. Finish via
    // Ctrl+J outside paste mode.
    ri.handleBytes(Buffer.from([0x0a]));
    const result = await readPromise;
    assert.strictEqual(result, "hello\nworld", "Paste newline preserved, Ctrl+J does not submit during paste");
  });
});

describe("Ctrl+Home / Ctrl+End", () => {
  it("Ctrl+Home (CSI 1;5H) moves cursor to start of whole input", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5H"));
    ri.handleBytes(Buffer.from("X"));
    assert.strictEqual(ri.text, "Xhello\nworld");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Ctrl+End (CSI 1;5F) moves cursor to end of whole input", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5H")); // to start
    ri.handleBytes(Buffer.from("\x1b[1;5F")); // Ctrl+End -> end of whole input
    ri.handleBytes(Buffer.from("!"));
    assert.strictEqual(ri.text, "hello\nworld!");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Ctrl+Home via CSI 1;5~ variant", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5~"));
    ri.handleBytes(Buffer.from("X"));
    assert.strictEqual(ri.text, "Xhello\nworld");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Ctrl+End via CSI 4;5~ variant", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[4;5~"));
    ri.handleBytes(Buffer.from("!"));
    assert.strictEqual(ri.text, "hello\nworld!");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Plain Home (CSI H) still moves to start of current line only", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[H")); // plain Home -> current line start
    ri.handleBytes(Buffer.from("X"));
    assert.strictEqual(ri.text, "hello\nXworld");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });
});

// The kitty keyboard protocol (enabled via `\x1b[>3u`) appends an event-type
// sub-parameter to every key, e.g. Ctrl+Home -> `\x1b[1;5:1H`, plain Down ->
// `\x1b[1;1:1B`. The CSI parser must consume the `:type` suffix instead of
// treating `:` as the final byte (which would insert the leftover text and
// leave the key doing nothing).
describe("Kitty event-type suffix (:type)", () => {
  it("Ctrl+Home (CSI 1;5:1H) moves cursor to start of whole input", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5:1H"));
    ri.handleBytes(Buffer.from("X"));
    assert.strictEqual(ri.text, "Xhello\nworld");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Ctrl+End (CSI 1;5:1F) moves cursor to end of whole input", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5:1H"));
    ri.handleBytes(Buffer.from("\x1b[1;5:1F"));
    ri.handleBytes(Buffer.from("!"));
    assert.strictEqual(ri.text, "hello\nworld!");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("plain Down (CSI 1;1:1B) does not insert leftover text", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("hello"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("world"));
    ri.handleBytes(Buffer.from("\x1b[1;5:1H"));
    ri.handleBytes(Buffer.from("\x1b[1;1:1B")); // Down at the top -> moves down a line
    ri.handleBytes(Buffer.from("X"));
    assert.strictEqual(ri.text, "hello\nXworld");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("round-trip ctrl+home/up/ctrl+end/down restores multiline (event-typed)", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [{ text: "old single line", isMultiline: false }],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("line1"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("line2"));
    ri.handleBytes(ALT_ENTER);
    ri.handleBytes(Buffer.from("line3"));
    ri.handleBytes(Buffer.from("\x1b[1;5:1H")); // ctrl+home
    ri.handleBytes(Buffer.from("\x1b[1;1:1A")); // up -> history (single-line entry)
    ri.handleBytes(Buffer.from("\x1b[1;5:1F")); // ctrl+end
    ri.handleBytes(Buffer.from("\x1b[1;1:1B")); // down -> restore multiline
    assert.strictEqual(ri.text, "line1\nline2\nline3");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });
});
