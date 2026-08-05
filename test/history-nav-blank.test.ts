import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(rows = 24): Writable & { output: string; columns: number; rows: number; reset: () => void } {
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as Writable & { output: string; columns: number; rows: number; reset: () => void };
  Object.defineProperty(ws, "output", { get: () => output, configurable: true });
  Object.defineProperty(ws, "columns", { value: 80, configurable: true });
  Object.defineProperty(ws, "rows", { value: rows, configurable: true });
  ws.reset = () => {
    output = "";
  };
  return ws;
}

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
  screen(): string[] {
    return this.rows.map((r) => r.replace(/\s+$/g, ""));
  }
}

type HistoryEntry = { text: string; isMultiline: boolean };
const H = (text: string, isMultiline = false): HistoryEntry => ({ text, isMultiline });
const UP = Buffer.from([0x1b, 0x5b, 0x41]);
const DOWN = Buffer.from([0x1b, 0x5b, 0x42]);

describe("history nav blank lines", () => {
  it("down past end does not leave blank rows above the fresh prompt", () => {
    const stdout = makeStdout();
    const cap = stdout as Writable & { output: string; reset: () => void };
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("line1\nline2\nline3", true)],
    });
    ri.read(true);
    const initial = cap.output;
    cap.reset();

    const term = new Term(24);
    term.write(initial);
    const startRow = term.curRow;

    ri.handleBytes(UP); // load 3-line history entry
    term.write(cap.output);
    cap.reset();

    ri.handleBytes(DOWN); // back to fresh empty input
    term.write(cap.output);

    const screen = term.screen();
    // Find the prompt row (fresh empty input renders as just the prompt, which
    // trims to ">").
    const promptRow = screen.findIndex((r) => r === ">" || r.startsWith("> "));
    assert.ok(promptRow >= 0, `expected a prompt row:\n${screen.join("\n")}`);
    // The prompt should reappear at the same row it started (no blank band above
    // it beyond what was already there).
    assert.strictEqual(promptRow, startRow, `prompt should stay at row ${startRow}:\n${screen.join("\n")}`);
    // No leftover content rows from the history entry above the prompt.
    for (let r = 0; r < promptRow; r++) {
      assert.strictEqual(screen[r], "", `row ${r} should be blank:\n${screen.join("\n")}`);
    }
  });
});
