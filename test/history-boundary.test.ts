import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

type HistoryEntry = { text: string; isMultiline: boolean };
const H = (text: string, isMultiline = false): HistoryEntry => ({ text, isMultiline });
const UP = Buffer.from([0x1b, 0x5b, 0x41]);
const DOWN = Buffer.from([0x1b, 0x5b, 0x42]);

// A stdout that records every chunk passed to each separate write() call, so
// tests can assert that two logical outputs (e.g. a clear and a redraw) landed
// in a SINGLE write instead of two — which is what avoids the visible blink.
function recordingStdout(rows = 24): Writable & {
  chunks: string[];
  output: string;
  columns: number;
  rows: number;
} {
  const chunks: string[] = [];
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString();
      chunks.push(s);
      output += s;
      cb();
    },
  }) as Writable & { chunks: string[]; output: string; columns: number; rows: number };
  Object.defineProperty(ws, "chunks", { get: () => chunks, configurable: true });
  Object.defineProperty(ws, "output", { get: () => output, configurable: true });
  Object.defineProperty(ws, "columns", { value: 80, configurable: true });
  Object.defineProperty(ws, "rows", { value: rows, configurable: true });
  return ws;
}

// Minimal terminal simulator tracking the physical cursor row/col so we can
// assert where a render left the cursor after a boundary keypress.
class Term {
  rows: string[] = [""];
  curRow = 0;
  curCol = 0;
  width = 80;
  height: number;
  constructor(height: number) {
    this.height = height;
  }
  private ensureRow(r: number): void {
    while (this.rows.length <= r) this.rows.push("");
  }
  private put(ch: string): void {
    this.ensureRow(this.curRow);
    let row = this.rows[this.curRow];
    while (row.length < this.curCol) row += " ";
    row = row.slice(0, this.curCol) + ch + row.slice(this.curCol + 1);
    this.rows[this.curRow] = row;
    this.curCol++;
  }
  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\x1b") {
        if (s[i + 1] === "[") {
          let j = i + 2;
          let params = "";
          while (j < s.length && /[0-9;?<>=]/.test(s[j])) {
            params += s[j];
            j++;
          }
          const final = s[j] ?? "";
          j++;
          this.csi(params, final);
          i = j;
          continue;
        }
        i += 2;
        continue;
      } else if (ch === "\r") {
        this.curCol = 0;
        i++;
      } else if (ch === "\n") {
        this.curRow++;
        this.ensureRow(this.curRow);
        i++;
      } else if (ch === "\b") {
        this.curCol = Math.max(0, this.curCol - 1);
        i++;
      } else {
        this.put(ch);
        i++;
      }
    }
  }
  private csi(params: string, final: string): void {
    const nums = params.replace(/[?<>=]/g, "").split(";").filter(Boolean).map(Number);
    switch (final) {
      case "A": this.curRow = Math.max(0, this.curRow - (nums[0] || 1)); break;
      case "B":
        this.curRow += nums[0] || 1;
        this.ensureRow(this.curRow);
        break;
      case "C": this.curCol += nums[0] || 1; break;
      case "D": this.curCol = Math.max(0, this.curCol - (nums[0] || 1)); break;
      case "G": this.curCol = Math.max(0, (nums[0] || 1) - 1); break;
      case "H":
      case "f":
        this.curRow = Math.max(0, (nums[0] || 1) - 1);
        this.curCol = Math.max(0, (nums[1] || 1) - 1);
        this.ensureRow(this.curRow);
        break;
      case "K":
        this.ensureRow(this.curRow);
        if (nums[0] === 2) this.rows[this.curRow] = "";
        else this.rows[this.curRow] = this.rows[this.curRow].slice(0, this.curCol);
        break;
      case "J":
        this.ensureRow(this.curRow);
        if (nums[0] === 0) {
          this.rows[this.curRow] = this.rows[this.curRow].slice(0, this.curCol);
          this.rows.length = this.curRow + 1;
        } else if (nums[0] === 2) {
          this.rows = [""];
          this.curRow = 0;
          this.curCol = 0;
        }
        break;
      default: break;
    }
  }
}

describe("history boundary cursor cue", () => {
  it("pressing Up at the top of history moves the cursor to the start of the input", () => {
    const stdout = recordingStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello")],
    });
    ri.read(true);

    const term = new Term(24);
    term.write(stdout.output);
    stdout.chunks.length = 0;

    ri.handleBytes(UP); // load the only entry -> historyIndex 0, cursor at end
    ri.handleBytes(UP); // already at top -> boundary cue to start

    term.write(stdout.output);
    // Cursor should sit right after the prompt (col == prefixLen, row 0),
    // i.e. at the START of the input, not at its end.
    assert.strictEqual(term.curRow, 0, `cursor row should be 0:\n${term.rows.join("\n")}`);
    assert.strictEqual(term.curCol, 2, `cursor col should be 2 (after "> "):\n${term.rows.join("\n")}`);
  });

  it("pressing Down at the bottom moves the cursor to the end of the input", () => {
    const stdout = recordingStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("older")],
    });
    ri.read(true);
    ri.handleBytes(Buffer.from("abc")); // fresh draft, cursor at end

    const term = new Term(24);
    term.write(stdout.output);
    stdout.chunks.length = 0;

    ri.handleBytes(DOWN); // already at the bottom draft -> boundary cue to end

    term.write(stdout.output);
    // Cursor should be at the END of the input: row 0, col == prefixLen + 3.
    assert.strictEqual(term.curRow, 0, `cursor row should be 0:\n${term.rows.join("\n")}`);
    assert.strictEqual(term.curCol, 5, `cursor col should be 5 ("> " + "abc"):\n${term.rows.join("\n")}`);
  });
});

describe("history navigation does not blink", () => {
  it("clear and redraw are flushed in a single write when loading a history entry", () => {
    const stdout = recordingStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("first entry")],
    });
    ri.read(true);
    stdout.chunks.length = 0;

    ri.handleBytes(UP); // loads "first entry", swapping out the empty prompt

    const writes = stdout.chunks;
    // There must be no write that clears the region without also redrawing the
    // new content — that bare-clear frame is exactly the "kilo> blink".
    const bareClears = writes.filter((w) => /\x1b\[0J/.test(w) && !/> first entry/.test(w));
    assert.strictEqual(
      bareClears.length,
      0,
      `expected no bare-clear write, got: ${JSON.stringify(bareClears)}`,
    );
    // And the combined clear+redraw must be present together in one write.
    const combined = writes.filter((w) => /\x1b\[0J/.test(w) && /> first entry/.test(w));
    assert.ok(combined.length >= 1, "clear and redraw should appear in the same write");
  });
});
