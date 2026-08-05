import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(rows = 24): Writable & { output: string; columns: number; rows: number } {
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as Writable & { output: string; columns: number; rows: number };
  Object.defineProperty(ws, "output", { get: () => output });
  Object.defineProperty(ws, "columns", { value: 80, configurable: true });
  Object.defineProperty(ws, "rows", { value: rows, configurable: true });
  return ws;
}

type HistoryEntry = { text: string; isMultiline: boolean };
const H = (text: string, isMultiline = false): HistoryEntry => ({ text, isMultiline });

const UP = Buffer.from([0x1b, 0x5b, 0x41]);
const DOWN = Buffer.from([0x1b, 0x5b, 0x42]);
const ENTER = Buffer.from([0x0d]);
const CTRL_C = Buffer.from([0x03]);

describe("history drafts", () => {
  it("edits to a history entry persist when navigating away and back with Up/Down", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("alpha"), H("beta")],
    });
    ri.read(true);

    ri.handleBytes(UP); // -> "beta" (index 1)
    ri.handleBytes(Buffer.from("X")); // edit -> "betaX"
    ri.handleBytes(UP); // -> "alpha" (index 0)
    assert.strictEqual(ri.text, "alpha");
    ri.handleBytes(DOWN); // back to index 1 — draft "betaX" should be restored
    assert.strictEqual(ri.text, "betaX", "edited draft should persist across navigation");
  });

  it("sending the input clears all drafts", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("alpha"), H("beta")],
    });
    const readPromise = ri.read(true);

    ri.handleBytes(UP); // -> "beta"
    ri.handleBytes(Buffer.from("X")); // -> "betaX"
    ri.handleBytes(ENTER); // send
    assert.strictEqual(await readPromise, "betaX");

    // New prompt: drafts should be gone.
    const readPromise2 = ri.read(true);
    ri.handleBytes(UP); // -> "beta" (raw, not the draft)
    assert.strictEqual(ri.text, "beta", "draft should be cleared after sending");
    ri.handleBytes(ENTER);
    await readPromise2;
  });

  it("ctrl-c clears all drafts", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("alpha"), H("beta")],
    });
    const readPromise = ri.read(true);

    ri.handleBytes(UP); // -> "beta"
    ri.handleBytes(Buffer.from("X")); // -> "betaX"
    ri.handleBytes(CTRL_C); // abort — clears drafts
    await readPromise;

    const readPromise2 = ri.read(true);
    ri.handleBytes(UP); // -> "beta" (raw, draft cleared)
    assert.strictEqual(ri.text, "beta", "draft should be cleared after ctrl-c");
    ri.handleBytes(ENTER);
    await readPromise2;
  });

  it("drafts from ctrl-r search persist after accepting", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world"), H("goodbye")],
    });
    ri.read(true);

    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("hello")); // match "hello world" (index 0)
    ri.handleBytes(ENTER); // accept -> loads "hello world", historyIndex = 0
    ri.handleBytes(Buffer.from("!!!")); // edit -> "hello world!!!"
    ri.handleBytes(DOWN); // -> index 1 "goodbye"
    ri.handleBytes(DOWN); // down past end -> fresh empty input
    assert.strictEqual(ri.text, "");
    ri.handleBytes(UP); // -> index 1 "goodbye"
    ri.handleBytes(UP); // back up -> index 0 draft "hello world!!!"
    assert.strictEqual(ri.text, "hello world!!!", "draft after search-accept should persist");
  });

  it("navigating down to fresh input and back restores the fresh input, not a draft", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("alpha")],
    });
    ri.read(true);

    ri.handleBytes(Buffer.from("fresh")); // type new input
    ri.handleBytes(UP); // -> "alpha" (index 0)
    ri.handleBytes(DOWN); // back down past end -> "fresh"
    assert.strictEqual(ri.text, "fresh", "fresh input should be restored");
  });
});
