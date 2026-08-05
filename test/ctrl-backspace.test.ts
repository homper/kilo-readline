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

describe("Ctrl+Backspace deletes the word before the cursor", () => {
  it("C0 BS byte (0x08) deletes the previous word", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(false);
    ri.handleBytes(Buffer.from("hello world"));
    ri.handleBytes(Buffer.from([0x08])); // Ctrl+Backspace -> delete "world"
    assert.strictEqual(ri.text, "hello ");
    ri.handleBytes(Buffer.from([0x17])); // Ctrl+W as a sanity check
    assert.strictEqual(ri.text, "");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Kitty CSI-u (CSI 127;5u) deletes the previous word", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(false);
    ri.handleBytes(Buffer.from("foo bar baz"));
    ri.handleBytes(Buffer.from("\x1b[127;5u")); // Ctrl+Backspace (kitty)
    assert.strictEqual(ri.text, "foo bar ");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });

  it("Ctrl+Backspace at start of input is a no-op", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(false);
    ri.handleBytes(Buffer.from([0x08]));
    assert.strictEqual(ri.text, "");
    ri.handleBytes(Buffer.from([0x0a]));
    await readPromise;
  });
});
