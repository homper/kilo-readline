import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { RawInput } from "../src/rawinput.js";

function makeStdout(rows: number): Writable & { output: string; columns: number; rows: number } {
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

// Minimal terminal emulator with a fixed screen height and a scrollback buffer
// so we can assert behaviour when the input grows taller than the screen.
class TermBuffer {
  rows: string[] = [""];
  scrollback: string[] = [];
  curRow = 0;
  curCol = 0;
  width: number;
  height: number;

  constructor(width = 80, height = 24) {
    this.width = width;
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
        } else {
          i += 2;
          continue;
        }
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
      case "A":
        this.curRow = Math.max(0, this.curRow - (nums[0] || 1));
        break;
      case "B":
        this.curRow += nums[0] || 1;
        if (this.curRow >= this.height) this.curRow = this.height - 1;
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
      case "S":
        this.scrollUp(nums[0] || 1);
        break;
      case "K":
        this.ensureRow(this.curRow);
        if (nums[0] === 2) {
          this.rows[this.curRow] = "";
        } else {
          this.rows[this.curRow] = this.rows[this.curRow].slice(0, this.curCol);
        }
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
      default:
        break;
    }
  }

  screen(): string[] {
    return this.rows.map((r) => r.replace(/\s+$/g, ""));
  }
}

function termAfter(stdout: Writable & { output: string }, height = 24): TermBuffer {
  const term = new TermBuffer(80, height);
  term.write((stdout as Writable & { output: string }).output);
  return term;
}

describe("multiline input taller than the screen", () => {
  it("keeps the cursor visible and the last line on screen after typing many lines", () => {
    const stdout = makeStdout(5);
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    ri.read(true);
    // Build a 10-line input via paste mode so Enter inserts newlines (instead of
    // submitting a single line).
    ri.setPasteMode(true);
    for (let n = 0; n < 10; n++) {
      ri.handleBytes(Buffer.from(`line${n}\n`));
    }
    ri.setPasteMode(false);

    const term = termAfter(stdout, 5);
    const screen = term.screen();
    // Cursor must be on the screen (row within height), not scrolled off the top.
    assert.ok(term.curRow >= 0 && term.curRow < 5, `cursor row ${term.curRow} should be on screen`);
    // The most recent line should be visible somewhere on screen.
    const joined = screen.join("\n");
    assert.ok(joined.includes("line9"), `last line should be visible on screen:\n${joined}`);
    // The first line is taller than the screen, so it is hidden in memory (held
    // for in-app scrolling) rather than on screen.
    assert.ok(!joined.includes("line0"), `first line should be hidden (not on screen):\n${joined}`);
    // Hidden rows are NOT committed to the terminal scrollback anymore; they
    // live in memory and are revealed by scrolling the window in-app.
    assert.ok(
      !term.scrollback.some((r) => r.includes("line0")),
      `first line should be in memory, not scrollback: ${JSON.stringify(term.scrollback)}`,
    );
  });

  it("scrolls the window up to reveal hidden rows when the cursor moves above the top border", () => {
    const stdout = makeStdout(5);
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    ri.read(true);
    ri.setPasteMode(true);
    for (let n = 0; n < 10; n++) {
      ri.handleBytes(Buffer.from(`line${n}\n`));
    }
    ri.setPasteMode(false);

    // Move the cursor all the way to the top of the input. The window follows
    // so the cursor stays visible, which means the previously hidden first line
    // is scrolled back into view (instead of being clamped away).
    for (let n = 0; n < 20; n++) ri.handleBytes(Buffer.from([0x1b, 0x5b, 0x41])); // Arrow Up
    ri.handleBytes(Buffer.from("X"));

    const term = termAfter(stdout, 5);
    const screen = term.screen();
    assert.ok(term.curRow >= 0 && term.curRow < 5, `cursor row ${term.curRow} should stay on screen after moving up + typing`);
    // Scrolled to the top: no header marker, and the first line is visible now.
    assert.ok(!screen[0].includes("hidden"), `top should not show a hidden marker after scrolling up: ${JSON.stringify(screen[0])}`);
    assert.ok(
      screen.some((r) => r.includes("line0")),
      `first line should be scrolled into view:\n${screen.join("\n")}`,
    );
    // The typed X landed on the first line (now editable because it is on screen).
    assert.ok(
      screen.some((r) => r.includes("Xline0")),
      `X should be inserted on the first line after scrolling up:\n${screen.join("\n")}`,
    );
  });

  it("shows a … indicator on the top row when the input is taller than the screen", () => {
    const stdout = makeStdout(5);
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    ri.read(true);
    ri.setPasteMode(true);
    for (let n = 0; n < 10; n++) {
      ri.handleBytes(Buffer.from(`line${n}\n`));
    }
    ri.setPasteMode(false);

    const term = termAfter(stdout, 5);
    const screen = term.screen();
    // The first row of the live region carries the "…" truncation indicator.
    assert.ok(screen[0].includes("…"), `top row should show the … indicator: ${JSON.stringify(screen[0])}`);
    // Content (the most recent line) is shown below the indicator, never above it.
    assert.ok(screen.slice(1).some((r) => r.includes("line9")), `last line should be visible below the indicator:\n${screen.join("\n")}`);
  });

  it("ctrl-c keeps the input visible and stamps ^C at the cursor (tall mode)", () => {
    const stdout = makeStdout(5);
    const ri = new RawInput(stdout as unknown as any, {
      prompt: "> ",
      history: [],
    });
    ri.read(true);
    ri.setPasteMode(true);
    for (let n = 0; n < 10; n++) {
      ri.handleBytes(Buffer.from(`line${n}\n`));
    }
    ri.setPasteMode(false);
    ri.handleBytes(Buffer.from([0x03])); // ctrl-c

    const term = termAfter(stdout, 5);
    const screen = term.screen();
    // The cancellation marker must be shown somewhere on the visible screen.
    assert.ok(
      screen.some((r) => r.includes("^C")),
      `^C should remain on screen after ctrl-c: ${JSON.stringify(screen)}`,
    );
    // The most recent input line is still visible (not cleared away).
    assert.ok(
      screen.some((r) => r.includes("line9")),
      `last input line should remain visible after ctrl-c: ${JSON.stringify(screen)}`,
    );
    // The scrolled-off lines remain reachable via scrollback.
    assert.ok(
      term.scrollback.some((r) => r.includes("line0")),
      `earlier lines should remain in scrollback after ctrl-c: ${JSON.stringify(term.scrollback)}`,
    );
  });
});
