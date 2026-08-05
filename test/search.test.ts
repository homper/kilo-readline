import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(): Writable & { output: string; columns: number } {
  let output = "";
  const ws = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  }) as Writable & { output: string; columns: number };
  Object.defineProperty(ws, "output", { get: () => output });
  Object.defineProperty(ws, "columns", { value: 80, configurable: true });
  return ws;
}

type HistoryEntry = { text: string; isMultiline: boolean };
const H = (text: string, isMultiline = false): HistoryEntry => ({ text, isMultiline });

// A minimal terminal emulator: tracks screen rows + cursor so we can assert
// where the prompt and the search box actually land after all the escape codes.
class TermBuffer {
  rows: string[] = [""];
  curRow = 0;
  curCol = 0;
  width: number;

  constructor(width = 80) {
    this.width = width;
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
        } else if (s[i + 1] === "]") {
          let j = i + 2;
          while (j < s.length && s[j] !== "\x07") j++;
          i = j + 1;
          continue;
        } else {
          i += 2;
          continue;
        }
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
      case "A":
        this.curRow = Math.max(0, this.curRow - (nums[0] || 1));
        break;
      case "B":
        this.curRow += nums[0] || 1;
        this.ensureRow(this.curRow);
        break;
      case "C":
        this.curCol += nums[0] || 1;
        break;
      case "D":
        this.curCol = Math.max(0, this.curCol - (nums[0] || 1));
        break;
      case "G":
        this.curCol = Math.max(0, (nums[0] || 1) - 1);
        break;
      case "H":
      case "f":
        this.curRow = Math.max(0, (nums[0] || 1) - 1);
        this.curCol = Math.max(0, (nums[1] || 1) - 1);
        this.ensureRow(this.curRow);
        break;
      case "K":
        this.ensureRow(this.curRow);
        this.rows[this.curRow] = this.rows[this.curRow].slice(0, this.curCol);
        break;
      case "J": {
        const mode = nums[0] || 0;
        this.ensureRow(this.curRow);
        if (mode === 0) {
          this.rows[this.curRow] = this.rows[this.curRow].slice(0, this.curCol);
          this.rows.length = this.curRow + 1;
        } else if (mode === 2) {
          this.rows = [""];
          this.curRow = 0;
          this.curCol = 0;
        }
        break;
      }
      default:
        break;
    }
  }

  screen(): string[] {
    return this.rows.map((r) => r.replace(/\s+$/g, ""));
  }
}

function screenAfter(stdout: Writable & { output: string }): string[] {
  const term = new TermBuffer(80);
  term.write((stdout as Writable & { output: string }).output);
  return term.screen();
}

describe("reverse-i-search (ctrl-r)", () => {
  it("ctrl-r with empty history is a no-op (does not enter search)", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    assert.strictEqual(ri.isSearching, false);
    ri.handleBytes(Buffer.from([0x0d])); // Enter → finish empty
    assert.strictEqual(await readPromise, "");
  });

  it("search box is drawn BELOW the prompt, not above", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("h")); // type search term

    const screen = screenAfter(stdout);
    // Row 0 is the prompt; the box border starts on row 1 (below the prompt).
    assert.match(screen[0] ?? "", /^>/, "prompt should be on the top row");
    assert.match(screen[1] ?? "", /^┌/, "search box top border should be directly below the prompt");
    // The matched entry is now always previewed inside the box body, even for a
    // single-line match, so the bottom border lands one row further down.
    assert.match(screen[2] ?? "", /^│/, "search box body should show the matched entry");
    assert.match(screen[3] ?? "", /^└/, "search box bottom border below the body");
  });

  it("accept on Enter loads the matched entry into the prompt and sends on next Enter", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world"), H("goodbye")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("hello")); // matches "hello world"
    ri.handleBytes(Buffer.from([0x0d])); // Enter → acceptSearch (does not finish)
    assert.ok(!ri.isSearching, "search should be inactive after accept");
    ri.handleBytes(Buffer.from([0x0d])); // Enter → send the accepted text
    assert.strictEqual(await readPromise, "hello world");
  });

  it("ctrl-c cancels the search and cleans the box off the screen", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("h")); // box appears below prompt
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c → cancel

    assert.ok(!ri.isSearching, "search should be inactive after ctrl-c");
    const screen = screenAfter(stdout);
    assert.match(screen[0] ?? "", /^>/, "prompt remains on top row after cancel");
    // Everything below the prompt must be cleared — no leftover box characters.
    for (let r = 1; r < screen.length; r++) {
      assert.strictEqual(screen[r], "", `row ${r} should be cleared after ctrl-c`);
    }
  });

  it("escape cancels the search and cleans the box off the screen", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("h")); // box appears below prompt
    ri.handleBytes(Buffer.from([0x1b])); // bare Escape → cancel

    assert.ok(!ri.isSearching, "search should be inactive after escape");
    const screen = screenAfter(stdout);
    assert.match(screen[0] ?? "", /^>/, "prompt remains on top row after escape");
    for (let r = 1; r < screen.length; r++) {
      assert.strictEqual(screen[r], "", `row ${r} should be cleared after escape`);
    }
    ri.handleBytes(Buffer.from([0x0d])); // Enter sends empty
    assert.strictEqual(await readPromise, "");
  });

  it("kitty-encoded escape (CSI 27 u) cancels the search", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("h")); // box appears below prompt
    ri.handleBytes(Buffer.from("\x1b[27u")); // kitty Escape → cancel

    assert.ok(!ri.isSearching, "search should be inactive after kitty-escape");
    const screen = screenAfter(stdout);
    assert.match(screen[0] ?? "", /^>/, "prompt remains on top row after kitty-escape");
    for (let r = 1; r < screen.length; r++) {
      assert.strictEqual(screen[r], "", `row ${r} should be cleared after kitty-escape`);
    }
    ri.handleBytes(Buffer.from([0x0d])); // Enter sends empty
    assert.strictEqual(await readPromise, "");
  });

  it("ctrl-c preserves the text the user had typed before invoking search", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from("abc")); // typed before search
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    assert.ok(ri.isSearching);
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c cancel
    ri.handleBytes(Buffer.from([0x0d])); // Enter → send preserved "abc"
    assert.strictEqual(await readPromise, "abc");
  });

  it("does not drift upward across multiple keystrokes (no skipped line)", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("apple"), H("apricot"), H("avocado")],
    });
    ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("a")); // matches all three → avocado
    ri.handleBytes(Buffer.from("p")); // "ap" → apricot
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r again → cycle to apple

    const screen = screenAfter(stdout);
    // After several keystrokes the prompt must still be on the top row and the
    // box directly beneath it. A drift bug would move the box onto row 0.
    assert.match(screen[0] ?? "", /^>/, "prompt must stay on the top row after multiple keystrokes");
    assert.match(screen[1] ?? "", /^┌/, "box must stay directly below the prompt after multiple keystrokes");
  });

  it("repeated ctrl-r cycles through multiple matches and accept selects the cycled one", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("apple"), H("apricot"), H("avocado")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("a")); // matches: avocado(0), apricot(1), apple(2)
    ri.handleBytes(Buffer.from([0x12])); // cycle → apricot
    ri.handleBytes(Buffer.from([0x12])); // cycle → apple
    ri.handleBytes(Buffer.from([0x0d])); // accept → "apple"
    ri.handleBytes(Buffer.from([0x0d])); // send
    assert.strictEqual(await readPromise, "apple");
  });

  it("backspace in search shortens the term and re-renders the box below the prompt", () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world"), H("help")],
    });
    ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r
    ri.handleBytes(Buffer.from("hell")); // matches hello world + help
    ri.handleBytes(Buffer.from([0x7f])); // backspace → "hell" -> "hel"? still matches both
    ri.handleBytes(Buffer.from([0x7f])); // -> "he"
    const screen = screenAfter(stdout);
    assert.match(screen[0] ?? "", /^>/, "prompt stays on top after backspaces");
    assert.match(screen[1] ?? "", /^┌/, "box stays below the prompt after backspaces");
    assert.ok(ri.isSearching, "backspace should keep search active while the term is non-empty");
  });

  it("backspace on empty search term cancels the search", async () => {
    const stdout = makeStdout();
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [H("hello world")],
    });
    const readPromise = ri.read(true);
    ri.handleBytes(Buffer.from([0x12])); // ctrl-r (empty term)
    ri.handleBytes(Buffer.from([0x7f])); // backspace on empty → cancel
    assert.ok(!ri.isSearching, "backspace on empty term should cancel search");
    const screen = screenAfter(stdout);
    assert.match(screen[0] ?? "", /^>/, "prompt remains after cancel-via-backspace");
    for (let r = 1; r < screen.length; r++) {
      assert.strictEqual(screen[r], "", `row ${r} should be cleared`);
    }
    ri.handleBytes(Buffer.from([0x0d])); // Enter sends empty
    assert.strictEqual(await readPromise, "");
  });
});
