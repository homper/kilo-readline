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

// Minimal terminal emulator: tracks a screen grid + scrollback so we can assert
// what the user actually sees after a sequence of writes.
class Term {
  rows: string[] = [""];
  scrollback: string[] = [];
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
  private scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      this.scrollback.push(this.rows[0] ?? "");
      this.rows.shift();
      this.rows.push("");
    }
    this.curRow = Math.max(0, this.curRow - n);
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
        if (this.curRow >= this.height) this.scrollUp(this.curRow - this.height + 1);
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
        if (this.curRow >= this.height) this.curRow = this.height - 1;
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
      case "S": this.scrollUp(nums[0] || 1); break;
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

describe("Ctrl+C abort keeps input visible", () => {
  it("stamps ^C at the end of the typed text on the same row", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(false);
    ri.handleBytes(Buffer.from("hello world"));
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c

    const out = (stdout as Writable & { output: string }).output;
    const term = new Term(24);
    term.write(out);
    const screen = term.screen();
    // The marker sits at the end of the typed text on the prompt row, not on a
    // cleared/wiped line.
    assert.ok(
      screen.some((r) => r.includes("> hello world^C")),
      `expected "> hello world^C" on one row:\n${screen.join("\n")}`,
    );
    // No clear-to-end-of-screen is emitted after the text was drawn.
    assert.ok(!out.includes("hello world\x1b[0J"), `screen should not be cleared after the text:\n${out}`);
    const result = await readPromise;
    assert.strictEqual(result, "", "ctrl-c should resolve with empty string");

    void ri;
  });

  it("stamps ^C at the cursor, replacing the character under it", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(false);
    ri.handleBytes(Buffer.from("hello world"));
    // Move the cursor back into the middle of the text (onto the 'w' of "world").
    for (let i = 0; i < 5; i++) ri.handleBytes(Buffer.from([0x1b, 0x5b, 0x44])); // Arrow Left x5
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c

    const out = (stdout as Writable & { output: string }).output;
    const term = new Term(24);
    term.write(out);
    const screen = term.screen();
    // ^C is stamped in place of the cursor, replacing the character that was
    // there; the rest of the line after it is kept.
    assert.ok(
      screen.some((r) => r.includes("> hello ^Corld")),
      `expected "> hello ^Corld" (^C replacing the char under the cursor):\n${screen.join("\n")}`,
    );
    await readPromise;

    void ri;
  });

  it("does not leave blank lines above the committed multiline input", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    // Build a multiline input via paste mode so Enter inserts newlines.
    ri.setPasteMode(true);
    ri.handleBytes(Buffer.from("first line\nsecond line\nthird line\n"));
    ri.setPasteMode(false);
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c

    const out = (stdout as Writable & { output: string }).output;
    const term = new Term(24);
    term.write(out);
    const screen = term.screen();
    // The committed input rows should sit consecutively with no blank rows left
    // between them: the cleared live region must not remain on screen as empty
    // lines above the reprinted text.
    const firstIdx = screen.findIndex((r) => r.includes("> first line"));
    const secondIdx = screen.findIndex((r) => r.includes("second line"));
    const thirdIdx = screen.findIndex((r) => r.includes("third line"));
    assert.ok(firstIdx >= 0, `expected "> first line" row:\n${screen.join("\n")}`);
    assert.ok(secondIdx === firstIdx + 1, `second line should be directly below the first:\n${screen.join("\n")}`);
    assert.ok(thirdIdx === firstIdx + 2, `third line should be directly below the second:\n${screen.join("\n")}`);
    // No blank row may sit above the prompt row: the reprint must land on the
    // row where the live region started, not one row below it.
    assert.ok(firstIdx === 0, `prompt row should be at the top (no blank rows above):\n${screen.join("\n")}`);
    const result = await readPromise;
    assert.strictEqual(result, "", "ctrl-c should resolve with empty string");

    void ri;
  });
});
