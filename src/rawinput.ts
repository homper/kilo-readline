import { WriteStream } from "node:tty";

const CSI = "\x1b[";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function visibleLen(text: string): number {
  return stripAnsi(text).length;
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let s = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const o = strings[i];
    let j = 0;
    while (j < s.length && j < o.length && s[j] === o[j]) j++;
    s = s.slice(0, j);
    if (s === "") break;
  }
  return s;
}

function write(stdout: WriteStream, s: string): void {
  stdout.write(s);
}

export class RawInput {
  private stdout: WriteStream;
  private prompt: string;
  private history: Array<{ text: string; isMultiline: boolean }>;
  private completer: ((line: string, cursorCol: number) => [string[], string]) | null;

  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorCol = 0;
  private historyIndex = -1;
  private savedLines: string[] | null = null;
  // Edits made to a history entry while navigating with Up/Down or Ctrl+R. The
  // key is the history index; the value is the edited lines. These drafts are
  // temporary: they are cleared when the input is sent (finish) or cancelled
  // with Ctrl+C (abort), so the on-disk history is never mutated by them.
  private drafts: Map<number, string[]> = new Map();
  private renderedRows = 0;
  // A clear sequence (e.g. from clearForRerender) deferred until the next render()
  // so it can be flushed in the SAME write as the redraw. Emitting the clear and
  // the new content in separate writes left a brief blank frame between them —
  // the visible "kilo> blink" when iterating history.
  private pendingClearPrefix = "";
  private lastPhysCursorRow = 0;
  // Cache of the exact physical-row strings drawn by the last renderShort, used
  // to skip redrawing rows whose content hasn't changed (e.g. a pure cursor
  // move, or an edit that only touches the last line of a long block). Cleared
  // whenever the on-screen region is invalidated (renderedRows reset to 0).
  private lastContentRows: string[] = [];

  private resolve: ((value: string) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  private active = false;
  private multiline = true;
  private aborted = false;
  // When false, Up/Down and Ctrl+R never navigate prompt history. Used by
  // /model's single-line search view so arrow keys don't clobber the query
  // box with old prompt-history entries. Default true for the main prompt.
  private historyEnabled = true;

  private searchActive = false;
  private searchTerm = "";
  private searchMatches: number[] = [];
  private searchCursor = 0;
  private savedBeforeSearch: string[] | null = null;
  private kittyPushed = false;
  private inPaste = false;
  private residue: Buffer = Buffer.alloc(0);
  private searchOverlayRows = 0;
  // Physical row (0 = top of the input) where the cursor was left after the last
  // search render. Used to move back to the top of the region before clearing.
  private searchLastCursorRow = 0;
  // Tab-completion cycling state. When active (after Tab produced multiple
  // matches), successive Tabs cycle through the matches and Shift-Tab cycles
  // backwards. Any other key breaks out of cycling and clears the variant list.
  private completionActive = false;
  private completionMatches: string[] = [];
  // -1 = the common-prefix-completed state (no specific variant selected);
  // 0..N-1 = the currently selected full match.
  private completionIndex = -1;
  private completionTokenStart = 0;
  // The original token text and its length, captured when cycling starts. Used
  // to keep the user's typed text when the matches share no common prefix that
  // extends it (e.g. substring model search: typing "claude" and pressing Tab
  // shouldn't delete "claude" just because the matches begin with different
  // providers). For prefix completions (paths, commands) the common prefix
  // always extends the token, so this never triggers there.
  private completionToken = "";
  private completionTokenLen = 0;
  private completionOverlayRows = 0;
  // Distance (in physical rows) from the top of the input region to the cursor,
  // captured at the start of each completion render. Moving up by this many
  // rows returns to the region top so the overlay+input can be redrawn cleanly.
  private completionTopPhysRow = 0;
  // Reserved for compatibility; tall mode no longer commits hidden rows to the
  // terminal scrollback (they are kept in memory and scrolled in-app instead).
  private committed = 0;
  // When true, the prompt is pinned to the bottom of the screen and the
  // completion overlay is drawn ABOVE the prompt (in reserved screen rows).
  // Used for /model's search view so the overlay never pushes content off-screen.
  private bottomPinnedMode = false;
  // Number of screen rows reserved at the bottom for the bottom-pinned UI
  // (prompt row + overlay rows). Set when entering bottom-pinned mode.
  private bottomPinnedReservedRows = 0;
  // Once the input has grown taller than the screen we keep the region pinned to
  // the top of the screen (row 0) and use absolute (CUP) redraws, even if it
  // later shrinks. This avoids mixing the bottom-anchored short-mode layout with
  // the top-anchored tall-mode layout.
  private tallLatched = false;
  // In tall mode the input is taller than the screen, so only a window of it is
  // visible. `viewTop` is the physical row (0 = top of the input) shown at the
  // top of the live content area. Hidden rows are kept in memory (NOT committed
  // to the terminal scrollback) so they can be scrolled back into view and
  // edited: pressing Up at the top border, or Ctrl+Home/Ctrl+End, moves the
  // cursor and the window follows to keep it visible.
  private viewTop = 0;
  // When non-null, all writes routed through `write(this.stdout, ...)` during a
  // render are accumulated here instead of flushed to the terminal. This lets
  // callers assemble a clear + redraw + overlay into a SINGLE physical write so
  // the terminal never shows an intermediate blank frame (the "blink" between
  // erasing the old region and drawing the new one).
  private renderCapture: string[] | null = null;

  // Run `fn` (typically this.render()) with output captured into a string
  // instead of written to stdout. The fake stdout mirrors the real stream's
  // columns/rows so layout math is unaffected. Returns the captured bytes.
  private captureRender(fn: () => void): string {
    const real = this.stdout;
    const sink = this.renderCapture === null ? [] : this.renderCapture;
    const fake = {
      write: (s: string) => {
        sink.push(typeof s === "string" ? s : String(s));
      },
      columns: real.columns,
      rows: real.rows,
    } as unknown as WriteStream;
    const prevCapture = this.renderCapture;
    this.renderCapture = sink;
    this.stdout = fake;
    try {
      fn();
    } finally {
      this.stdout = real;
      this.renderCapture = prevCapture;
    }
    return sink.join("");
  }

  constructor(
    stdout: WriteStream,
    opts: {
      prompt: string;
      history: Array<{ text: string; isMultiline: boolean }>;
      completer?: (line: string, cursorCol: number) => [string[], string];
    },
  ) {
    this.stdout = stdout;
    this.prompt = opts.prompt;
    this.history = opts.history;
    this.completer = opts.completer ?? null;
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0].length === 0;
  }

  get isSearching(): boolean {
    return this.searchActive;
  }

  private get atEnd(): boolean {
    return (
      this.cursorRow === this.lines.length - 1 &&
      this.cursorCol === this.lines[this.cursorRow].length
    );
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  // Swap the active completer. Used by /model's search view to reuse the
  // Tab-cycling completion overlay (2 rows, iterate with Tab) for filtering
  // models, then restored to the normal path/command completer afterwards.
  setCompleter(c: ((line: string, cursorCol: number) => [string[], string]) | null): void {
    this.completer = c;
  }

  // Enable or disable bottom-pinned mode. When enabled, the prompt is drawn at
  // the bottom of the terminal and the completion overlay appears above it —
  // so it never pushes content off-screen. Used for /model's search view.
  // `reservedRows` is the total number of rows to reserve (prompt + overlay).
  setBottomPinned(enabled: boolean, reservedRows = 0): void {
    this.bottomPinnedMode = enabled;
    this.bottomPinnedReservedRows = reservedRows;
    if (!enabled) {
      // Restore normal rendering state when leaving bottom-pinned mode.
      this.renderedRows = 0;
      this.lastPhysCursorRow = 0;
      this.completionOverlayRows = 0;
      this.completionTopPhysRow = 0;
    }
  }

  // Enable or disable prompt-history navigation. When disabled, Up/Down do not
  // load history entries (and Ctrl+R does not start reverse-search) — they fall
  // through to no-ops. Used by /model's single-line search view so arrows don't
  // replace the query with old prompt history.
  setHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled;
  }

  // Prefix drawn in front of every continuation line (any line after the first)
  // while editing. A dim ">" plus enough spaces to match the prompt's visible
  // width, so multi-line drafts read as a quoted block and it's visually obvious
  // the input is still being composed (not yet sent). Visible width matches the
  // prompt, so all cursor-column math is unaffected.
  private get continuationPrefix(): string {
    const promptLen = visibleLen(this.prompt);
    return `\x1b[2m>\x1b[0m${" ".repeat(Math.max(0, promptLen - 1))}`;
  }

  onResize(): void {
    // Wipe the currently-rendered input region in place (at its old width)
    // BEFORE dropping the cached render state. Without this, a resize while a
    // long wrapped input is on screen leaves the old rows visible and the
    // fresh render() — which runs with renderedRows=0 (hadRegion=false) and so
    // draws from the current cursor without clearing — overprints them,
    // producing a corrupted display: a stale first row plus a miswrapped body
    // at the new width.
    if (!this.searchActive && this.renderedRows > 0) {
      if (this.lastPhysCursorRow > 0) {
        write(this.stdout, `${CSI}${this.lastPhysCursorRow}A`);
      }
      write(this.stdout, "\r");
      write(this.stdout, `${CSI}0J`);
    }
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;
    this.searchOverlayRows = 0;
    this.searchLastCursorRow = 0;
    this.committed = 0;
    this.tallLatched = false;
    this.viewTop = 0;
    this.lastContentRows = [];
    if (this.searchActive) {
      this.searchActive = false;
      this.searchTerm = "";
      this.searchMatches = [];
      this.searchCursor = 0;
      this.savedBeforeSearch = null;
      write(this.stdout, "\r");
      write(this.stdout, `${CSI}0J`);
      this.render();
    } else {
      this.render();
    }
  }

  get text(): string {
    return this.lines.join("\n");
  }

  set text(value: string) {
    if (value === "") {
      this.lines = [""];
      this.cursorRow = 0;
      this.cursorCol = 0;
    } else {
      this.lines = value.split("\n");
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow].length;
    }
  }

  read(multiline: boolean): Promise<string> {
    this.multiline = multiline;
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.historyIndex = -1;
    this.savedLines = null;
    this.drafts.clear();
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;
    this.active = true;
    this.aborted = false;
    this.searchActive = false;
    this.searchTerm = "";
    this.searchMatches = [];
    this.searchCursor = 0;
    this.savedBeforeSearch = null;
    this.searchOverlayRows = 0;
    this.searchLastCursorRow = 0;
    this.committed = 0;
    this.tallLatched = false;
    this.viewTop = 0;
    this.lastContentRows = [];
    this.completionActive = false;
    this.completionMatches = [];
    this.completionIndex = -1;
    this.completionToken = "";
    this.completionTokenLen = 0;
    this.completionOverlayRows = 0;
    this.completionTopPhysRow = 0;

    if (!this.kittyPushed) {
      write(this.stdout, "\x1b[>3u");
      this.kittyPushed = true;
    }

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      write(this.stdout, "\x1b[?25h");
      if (this.bottomPinnedMode) {
        // Reserve rows at the bottom: move to the last row and emit newlines
        // so the terminal scrolls to make room for the search UI. The prompt
        // renders at the bottom row, the overlay above it.
        const screenH = this.stdout.rows || 24;
        const reserved = Math.max(1, this.bottomPinnedReservedRows);
        // Move to the bottom of the screen and emit newlines to create space.
        write(this.stdout, `${CSI}${screenH};1H`);
        write(this.stdout, "\n".repeat(reserved - 1));
      }
      this.render();
    });
  }

  abort(): void {
    if (!this.active) return;
    // If a Tab-cycling variant overlay is on screen below the input, remember
    // it so we can wipe those rows after reprinting — otherwise the abandoned
    // variants linger above whatever the caller draws next (e.g. /model's
    // favourites menu after Ctrl+C backs out of the search).
    const hadCompletionOverlay = this.completionOverlayRows > 0;
    const wasBottomPinned = this.bottomPinnedMode;
    this.aborted = true;
    this.active = false;
    // Ctrl+C discards any temporary edits made to history entries.
    this.drafts.clear();
    this.completionActive = false;
    this.completionMatches = [];
    this.completionIndex = -1;
    this.completionToken = "";
    this.completionTokenLen = 0;
    this.completionOverlayRows = 0;
    this.completionTopPhysRow = 0;
    this.searchActive = false;
    this.searchTerm = "";
    this.searchMatches = [];
    this.searchCursor = 0;
    this.savedBeforeSearch = null;
    if (wasBottomPinned) {
      // In bottom-pinned mode, clear the reserved rows at the bottom and leave
      // the cursor on a new line above the cleared area so the caller's output
      // (e.g. the favourites menu) starts in the right place.
      const screenH = this.stdout.rows || 24;
      const reserved = Math.max(1, this.bottomPinnedReservedRows);
      const topRow = screenH - reserved + 1;
      let buf = "";
      for (let r = topRow; r <= screenH; r++) {
        buf += `${CSI}${r};1H${CSI}2K`;
      }
      // Move cursor to the top of the cleared area so following output lands there.
      buf += `${CSI}${topRow};1H`;
      write(this.stdout, buf);
      this.resetRenderState();
      write(this.stdout, "\x1b[?25h");
      if (this.resolve) {
        this.resolve("");
        this.resolve = null;
        this.reject = null;
      }
      return;
    }
    // Print the full input (so nothing stays hidden behind a "… rows hidden"
    // marker) with "^C" stamped at the cursor: it replaces the character under
    // the cursor if there is one, otherwise it is appended at the end. This
    // mirrors a regular shell, where Ctrl+C echoes "^C" at the cursor and
    // abandons the line.
    this.printFullInput("^C");
    if (hadCompletionOverlay) {
      // printFullInput leaves the cursor on the row just below the reprinted
      // input — exactly where the first overlay row sat — so a clear-to-end-of
      // -screen erases the leftover variants without touching the input above.
      write(this.stdout, `${CSI}0J`);
    }
    this.resetRenderState();
    write(this.stdout, "\x1b[?25h");
    if (this.resolve) {
      this.resolve("");
      this.resolve = null;
      this.reject = null;
    }
  }

  // Clear all bookkeeping that tracks the on-screen region so the next render
  // starts fresh (used after sending/aborting and before redrawing a new
  // history entry).
  private resetRenderState(): void {
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;
    this.committed = 0;
    this.tallLatched = false;
    this.viewTop = 0;
    this.lastContentRows = [];
  }

  // Reprint the whole input from the top of the rendered region, so the full
  // text is committed to the terminal output/scrollback instead of only the
  // visible window. If `marker` (e.g. "^C") is given, it is spliced in at the
  // cursor position, replacing the character under the cursor (or appended at
  // the end when the cursor is past the last character). Long lines are emitted
  // raw and left to wrap naturally, exactly as they would render.
  private printFullInput(marker: string | null): void {
    if (this.tallLatched) {
      // Tall mode is top-anchored: the region occupies rows 0..renderedRows-1.
      // Move to the top and clear to the end of the screen, then reprint.
      write(this.stdout, `${CSI}1;1H${CSI}0J`);
    } else if (this.renderedRows > 0) {
      // Short mode is bottom-anchored: move to the top of the region and clear
      // the rows we previously drew, then reprint in place.
      this.clear();
    }
    let buf = "";
    for (let i = 0; i < this.lines.length; i++) {
      let line = this.lines[i];
      if (marker !== null && i === this.cursorRow) {
        const atEnd = this.cursorCol >= line.length;
        line = atEnd
          ? line.slice(0, this.cursorCol) + marker + line.slice(this.cursorCol)
          : line.slice(0, this.cursorCol) + marker + line.slice(this.cursorCol + 1);
      }
      if (i === 0) {
        buf += this.prompt + line;
      } else {
        buf += "\r\n" + this.continuationPrefix + line;
      }
    }
    buf += "\r\n";
    write(this.stdout, buf);
  }

  close(): void {
    if (this.kittyPushed) {
      write(this.stdout, "\x1b[<u");
      this.kittyPushed = false;
    }
    this.active = false;
    this.resolve = null;
    this.reject = null;
  }

  setPasteMode(mode: boolean): void {
    this.inPaste = mode;
  }

  private splitUtf8Residue(buf: Buffer): { complete: Buffer; residue: Buffer } {
    let residueLen = 0;
    for (let i = buf.length - 1; i >= 0 && residueLen < 3; i--) {
      const b = buf[i];
      if (b >= 0xC0) {
        const expectedLen = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2;
        const remaining = buf.length - i;
        if (remaining < expectedLen) {
          residueLen = remaining;
        }
        break;
      }
    }
    if (residueLen === 0) return { complete: buf, residue: Buffer.alloc(0) };
    const cutPos = buf.length - residueLen;
    return {
      complete: buf.subarray(0, cutPos),
      residue: buf.subarray(cutPos),
    } as { complete: Buffer; residue: Buffer };
  }

  handleBytes(chunk: Buffer): void {
    if (!this.active) return;
    if (this.searchActive) {
      this.handleSearchBytes(chunk);
      return;
    }
    const full: Buffer = Buffer.concat([this.residue, chunk]) as Buffer;
    const { complete, residue } = this.splitUtf8Residue(full);
    this.residue = residue as Buffer;
    const len = complete.length;
    let i = 0;

    while (i < len) {
      const b = complete[i];

      // Any literal key other than Tab breaks out of completion cycling
      // (escape sequences are handled in parseCSI, which skips Shift-Tab).
      if (b !== 0x09 && b !== 0x1b && this.completionActive) this.breakCompletion();

      if (b >= 0xC2 && b <= 0xF4) {
        const result = this.decodeUtf8(complete, i);
        this.insertChar(result.char);
        i += result.bytes;
      } else       if (b === 0x1b) {
        const result = this.parseEscape(complete, i);
        if (result === i) {
          i++;
        } else {
          i = result;
        }
      } else if (b === 0x03) {
        this.abort();
        i++;
      } else if (b === 0x04) {
        if (this.isEmpty) {
          this.finish("");
          i++;
          break;
        }
        i++;
      } else if (b === 0x7f) {
        this.backspace();
        i++;
      } else if (b === 0x08) {
        this.deleteWordBefore();
        i++;
      } else if (b === 0x0a) {
        if (this.inPaste) {
          this.insertNewline();
        } else {
          this.finish(this.text);
        }
        i++;
        if (!this.active) break;
      } else if (b === 0x0d) {
        this.handleEnter();
        i++;
        if (i < len && complete[i] === 0x0a) i++;
        if (!this.active) break;
      } else if (b === 0x17) {
        this.deleteWordBefore();
        i++;
      } else if (b === 0x09) {
        this.doTab();
        i++;
      } else if (b === 0x12) {
        if (this.historyEnabled) this.startSearch();
        i++;
      } else if (b >= 0x80) {
        i++;
      } else if (b >= 0x20) {
        this.insertChar(String.fromCodePoint(b));
        i++;
      } else {
        i++;
      }
      if (this.aborted) break;
    }
    if (!this.searchActive) this.render();
  }

  private parseEscape(chunk: Buffer, start: number): number {
    if (start + 1 >= chunk.length) {
      // A lone Escape (the Escape key) during completion cycling reverts the
      // input to the originally typed token, discarding the cycled match — so
      // the user gets their search string back instead of a half-completed id.
      // Any other time, a lone Escape is a no-op (consumed with no effect).
      if (this.completionActive) this.revertCompletion();
      return start;
    }
    const next = chunk[start + 1];

    if (next === 0x5b) {
      return this.parseCSI(chunk, start + 2);
    }
    if (next === 0x4f) {
      if (this.completionActive) this.breakCompletion();
      return this.parseSS3(chunk, start + 2);
    }
    if (next === 0x0d) {
      if (this.completionActive) this.breakCompletion();
      this.insertNewline();
      return start + 2;
    }
    if (next === 0x0a) {
      if (this.completionActive) this.breakCompletion();
      this.insertNewline();
      return start + 2;
    }
    // Alt+Backspace arrives as ESC+DEL (0x7f) on most terminals, or ESC+BS
    // (0x08) on some. Treat both as bash-style backward-kill-word, which
    // splits on punctuation too (unlike Ctrl+W's whitespace-only rubout).
    if (next === 0x7f || next === 0x08) {
      if (this.completionActive) this.breakCompletion();
      this.deleteBashWordBefore();
      return start + 2;
    }
    if (this.completionActive) this.breakCompletion();
    return start + 1;
  }

  private parseCSI(chunk: Buffer, start: number): number {
    let i = start;
    let params = "";

    while (i < chunk.length) {
      const b = chunk[i];
      // Accept digits, ';' and ':'. The ':' starts a kitty keyboard-protocol
      // sub-parameter (e.g. the event-type suffix in `\x1b[1;5:1H` produced by
      // the `>3` mode we enable). Without accepting ':' here the parser would
      // stop at it, treat ':' as the final byte, and insert the leftover text
      // (e.g. "1B") as literal input — which breaks the key entirely.
      if (b >= 0x30 && b <= 0x3b) {
        params += String.fromCodePoint(b);
        i++;
      } else {
        break;
      }
    }
    if (i >= chunk.length) return i - params.length;

    const final = chunk[i];
    i++;

    // Strip any kitty sub-parameters (":type") so each parameter is just its
    // leading integer, matching the pre-kitty shape the handlers expect.
    const p0 = params.split(";").map((s) => Number(s.split(":")[0]));

    // Shift-Tab arrives as CSI Z (legacy) or CSI 9;2u (kitty keyboard). Tab
    // itself normally arrives as a raw 0x09 byte, but some terminals in kitty
    // mode send CSI 9u / CSI 9;1u instead — handle those here too. These never
    // break out of completion cycling (they drive it); every other CSI final
    // below does.
    if (final === 0x5a) {
      this.doShiftTab();
      return i;
    }
    if (final === 0x75 && p0[0] === 9) {
      if (p0[1] === 2) this.doShiftTab();
      else this.doTab();
      return i;
    }
    if (this.completionActive) this.breakCompletion();

    if (final === 0x7e) {
      if (p0[0] === 200) {
        return i;
      }
      if (p0[0] === 201) {
        return i;
      }
      if ((p0[0] === 13 || p0[0] === 10) && p0[1] > 0) {
        // Modifier 1 = "none" in kitty; treat as a plain Enter.
        const mod = p0[1] || 1;
        if (mod >= 5) {
          this.finish(this.text);
        } else if (mod > 1) {
          this.insertNewline();
        } else {
          this.handleEnter();
        }
        return i;
      }
      if (p0.length >= 3 && (p0[2] === 13 || p0[2] === 10) && p0[1] > 0) {
        this.insertNewline();
        return i;
      }
      if (p0[0] === 3 && p0[1] === 5) {
        this.deleteWordAfter();
        return i;
      }
      if (p0[1] === 5) {
        switch (p0[0]) {
          case 1:
          case 7:
            this.moveDocStart();
            return i;
          case 4:
          case 8:
            this.moveDocEnd();
            return i;
        }
      }
      switch (p0[0]) {
        case 1:
        case 7:
          this.moveHome();
          break;
        case 3:
          this.deleteFwd();
          break;
        case 4:
        case 8:
          this.moveEnd();
          break;
      }
      return i;
    }

    if (final === 0x75 && p0[0] === 127 && p0[1] === 5) {
      this.deleteWordBefore();
      return i;
    }
    // Kitty keyboard may report Ctrl+C as CSI 3;5u (codepoint 3 = ETX, ctrl
    // modifier). Treat it like a raw 0x03: abort the current input.
    if (final === 0x75 && p0[0] === 3 && p0[1] === 5) {
      this.abort();
      return i;
    }
    if (final === 0x75 && (p0[0] === 13 || p0[0] === 10)) {
      // Kitty keyboard reports Enter as CSI 13u (no modifier) or CSI 13;1u
      // (modifier 1 = "none"). Treat modifier 1 the same as absent so a plain
      // Enter submits in single-line mode (and inserts a newline in multiline
      // mode) instead of being misread as a modified key. Modifier >=5 is
      // Ctrl+Enter → submit; 2..4 (shift/alt) → newline (multiline).
      const mod = p0[1] || 1;
      if (mod >= 5) {
        this.finish(this.text);
      } else if (mod > 1) {
        this.insertNewline();
      } else {
        this.handleEnter();
      }
      return i;
    }

    if (final === 0x41) {
      const n = p0[0] || 1;
      if (this.multiline && this.cursorRow > 0) {
        this.moveUp(n);
      } else if (this.historyEnabled) {
        this.historyUp();
      }
      return i;
    }
    if (final === 0x42) {
      const n = p0[0] || 1;
      if (this.multiline && this.cursorRow < this.lines.length - 1) {
        this.moveDown(n);
      } else if (this.historyEnabled) {
        this.historyDown();
      }
      return i;
    }
    if (final === 0x43) {
      const n = p0[0] || 1;
      if (p0[1] === 5) {
        this.moveWordRight();
      } else {
        this.moveRight(n);
      }
      return i;
    }
    if (final === 0x44) {
      const n = p0[0] || 1;
      if (p0[1] === 5) {
        this.moveWordLeft();
      } else {
        this.moveLeft(n);
      }
      return i;
    }
    if (final === 0x48) {
      if (p0[1] === 5) {
        this.moveDocStart();
      } else {
        this.moveHome();
      }
      return i;
    }
    if (final === 0x46) {
      if (p0[1] === 5) {
        this.moveDocEnd();
      } else {
        this.moveEnd();
      }
      return i;
    }

    return i;
  }

  private parseSS3(chunk: Buffer, start: number): number {
    if (start >= chunk.length) return chunk.length - 1;
    const b = chunk[start];
    if (b === 0x48) this.moveHome();
    else if (b === 0x46) this.moveEnd();
    return start + 1;
  }

  private decodeUtf8(buf: Buffer, i: number): { char: string; bytes: number } {
    const b = buf[i];
    if (b >= 0xC2 && b <= 0xDF) {
      const cp = ((b & 0x1F) << 6) | (buf[i + 1] & 0x3F);
      return { char: String.fromCodePoint(cp), bytes: 2 };
    }
    if (b >= 0xE0 && b <= 0xEF) {
      const cp = ((b & 0x0F) << 12) | ((buf[i + 1] & 0x3F) << 6) | (buf[i + 2] & 0x3F);
      return { char: String.fromCodePoint(cp), bytes: 3 };
    }
    const cp = ((b & 0x07) << 18) | ((buf[i + 1] & 0x3F) << 12) | ((buf[i + 2] & 0x3F) << 6) | (buf[i + 3] & 0x3F);
    return { char: String.fromCodePoint(cp), bytes: 4 };
  }

  private insertChar(ch: string): void {
    const line = this.lines[this.cursorRow];
    this.lines[this.cursorRow] =
      line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
    this.cursorCol++;
  }

  private hasUnclosedCodeBlock(): boolean {
    return (this.text.match(/```/g) || []).length % 2 !== 0;
  }

  private hasUnclosedCodeBlockInText(text: string): boolean {
    return (text.match(/```/g) || []).length % 2 !== 0;
  }

  private isClosingCodeBlockLine(): boolean {
    return this.lines[this.cursorRow].trim() === "```";
  }

  private handleEnter(): void {
    if (this.inPaste) {
      this.insertNewline();
      return;
    }
    // Single-line mode (e.g. /model's search): Enter submits the input rather
    // than inserting a newline, so the prompt never grows into a multiline
    // block.
    if (!this.multiline) {
      this.finish(this.text);
      return;
    }
    if (!this.atEnd) {
      this.insertNewline();
      return;
    }

    if (this.lines.length > 1 && this.lines[this.cursorRow].length === 0 && !this.hasUnclosedCodeBlock()) {
      this.finish(this.text);
    } else if (this.lines.length > 1 && this.isClosingCodeBlockLine()) {
      this.finish(this.text);
    } else if (this.lines.length > 1) {
      this.insertNewline();
    } else if (this.hasUnclosedCodeBlock()) {
      this.insertNewline();
    } else {
      this.finish(this.text);
    }
  }

  private insertNewline(): void {
    const line = this.lines[this.cursorRow];
    const before = line.slice(0, this.cursorCol);
    let after = line.slice(this.cursorCol);

    if (after.trimStart().startsWith("```") && this.hasUnclosedCodeBlockInText(before)) {
      this.lines[this.cursorRow] = before;
      this.lines.splice(this.cursorRow + 1, 0, after.trimStart());
    } else {
      this.lines[this.cursorRow] = before;
      this.lines.splice(this.cursorRow + 1, 0, after);
    }
    this.cursorRow++;
    this.cursorCol = 0;
  }

  private backspace(): void {
    if (this.cursorCol > 0) {
      const line = this.lines[this.cursorRow];
      this.lines[this.cursorRow] =
        line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
      this.cursorCol--;
    } else if (this.cursorRow > 0) {
      const prevLen = this.lines[this.cursorRow - 1].length;
      this.lines[this.cursorRow - 1] += this.lines[this.cursorRow];
      this.lines.splice(this.cursorRow, 1);
      this.cursorRow--;
      this.cursorCol = prevLen;
    }
  }

  private deleteFwd(): void {
    if (this.cursorCol < this.lines[this.cursorRow].length) {
      const line = this.lines[this.cursorRow];
      this.lines[this.cursorRow] =
        line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
    } else if (this.cursorRow < this.lines.length - 1) {
      this.lines[this.cursorRow] += this.lines[this.cursorRow + 1];
      this.lines.splice(this.cursorRow + 1, 1);
    }
  }

  private moveUp(n: number): void {
    this.cursorRow = Math.max(0, this.cursorRow - n);
    this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
  }

  private moveDown(n: number): void {
    this.cursorRow = Math.min(this.lines.length - 1, this.cursorRow + n);
    this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
  }

  private moveLeft(n: number): void {
    while (n > 0 && (this.cursorCol > 0 || this.cursorRow > 0)) {
      if (this.cursorCol > 0) {
        this.cursorCol--;
      } else {
        this.cursorRow--;
        this.cursorCol = this.lines[this.cursorRow].length;
      }
      n--;
    }
  }

  private moveRight(n: number): void {
    while (n > 0 && (this.cursorCol < this.lines[this.cursorRow].length || this.cursorRow < this.lines.length - 1)) {
      if (this.cursorCol < this.lines[this.cursorRow].length) {
        this.cursorCol++;
      } else {
        this.cursorRow++;
        this.cursorCol = 0;
      }
      n--;
    }
  }

  private moveHome(): void {
    this.cursorCol = 0;
  }

  private moveEnd(): void {
    this.cursorCol = this.lines[this.cursorRow].length;
  }

  private moveDocStart(): void {
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  private moveDocEnd(): void {
    this.cursorRow = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorRow].length;
  }

  // Bash/readline-style word character test: letters, digits and underscore
  // form words; every other non-whitespace character is its own word boundary.
  private static isWordChar(ch: string | undefined): boolean {
    return ch !== undefined && ch !== "" && /[A-Za-z0-9_]/.test(ch);
  }

  private moveWordLeft(): void {
    if (this.cursorCol === 0) {
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = this.lines[this.cursorRow].length;
      }
      return;
    }
    const line = this.lines[this.cursorRow];
    while (
      this.cursorCol > 0 &&
      line[this.cursorCol - 1] !== undefined &&
      line[this.cursorCol - 1] === " "
    ) {
      this.cursorCol--;
    }
    while (
      this.cursorCol > 0 &&
      line[this.cursorCol - 1] !== undefined &&
      line[this.cursorCol - 1] !== " "
    ) {
      this.cursorCol--;
    }
  }

  private moveWordRight(): void {
    const line = this.lines[this.cursorRow];
    if (this.cursorCol >= line.length) {
      if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = 0;
      }
      return;
    }
    while (
      this.cursorCol < line.length &&
      line[this.cursorCol] !== " "
    ) {
      this.cursorCol++;
    }
    while (
      this.cursorCol < line.length &&
      line[this.cursorCol] === " "
    ) {
      this.cursorCol++;
    }
  }

  private deleteWordBefore(): void {
    if (this.cursorCol === 0 && this.cursorRow === 0) return;
    const savedRow = this.cursorRow;
    const savedCol = this.cursorCol;

    if (this.cursorCol === 0) {
      this.cursorRow--;
      this.cursorCol = this.lines[this.cursorRow].length;
    }

    while (
      this.cursorCol > 0 &&
      this.lines[this.cursorRow][this.cursorCol - 1] === " "
    ) {
      this.cursorCol--;
    }

    while (
      this.cursorCol > 0 &&
      this.lines[this.cursorRow][this.cursorCol - 1] !== " "
    ) {
      this.cursorCol--;
    }

    this.spliceDeleted(savedRow, savedCol);
  }

  // bash/readline `backward-kill-word` (Alt+Backspace): word characters are
  // [A-Za-z0-9_]; every other non-whitespace character is its own word, so
  // '/', '-', '.', etc. act as boundaries. Contrast with deleteWordBefore
  // (Ctrl+W / `unix-word-rubout`) which only splits on whitespace.
  private deleteBashWordBefore(): void {
    if (this.cursorCol === 0 && this.cursorRow === 0) return;
    const savedRow = this.cursorRow;
    const savedCol = this.cursorCol;

    if (this.cursorCol === 0) {
      this.cursorRow--;
      this.cursorCol = this.lines[this.cursorRow].length;
    }

    const line = this.lines[this.cursorRow];

    while (
      this.cursorCol > 0 &&
      line[this.cursorCol - 1] === " "
    ) {
      this.cursorCol--;
    }

    if (this.cursorCol > 0) {
      const wordChar = RawInput.isWordChar(line[this.cursorCol - 1]);
      while (
        this.cursorCol > 0 &&
        line[this.cursorCol - 1] !== " " &&
        RawInput.isWordChar(line[this.cursorCol - 1]) === wordChar
      ) {
        this.cursorCol--;
      }
    }

    this.spliceDeleted(savedRow, savedCol);
  }

  private spliceDeleted(savedRow: number, savedCol: number): void {
    if (this.cursorRow === savedRow) {
      this.lines[this.cursorRow] =
        this.lines[this.cursorRow].slice(0, this.cursorCol) +
        this.lines[this.cursorRow].slice(savedCol);
    } else {
      this.lines[this.cursorRow] = this.lines[this.cursorRow].slice(0, this.cursorCol);
      this.lines.splice(this.cursorRow + 1, savedRow - this.cursorRow - 1);
      const remaining = this.lines[savedRow].slice(savedCol);
      this.lines[this.cursorRow] += remaining;
      this.lines.splice(this.cursorRow + 1, 1);
    }
  }

  private deleteWordAfter(): void {
    if (
      this.cursorRow === this.lines.length - 1 &&
      this.cursorCol >= this.lines[this.cursorRow].length
    ) {
      return;
    }

    const savedRow = this.cursorRow;
    const savedCol = this.cursorCol;

    if (this.cursorCol >= this.lines[this.cursorRow].length) {
      this.cursorRow++;
      this.cursorCol = 0;
    }

    while (
      this.cursorCol < this.lines[this.cursorRow].length &&
      this.lines[this.cursorRow][this.cursorCol] !== " "
    ) {
      this.cursorCol++;
    }

    while (
      this.cursorCol < this.lines[this.cursorRow].length &&
      this.lines[this.cursorRow][this.cursorCol] === " "
    ) {
      this.cursorCol++;
    }

    if (this.cursorRow === savedRow) {
      this.lines[this.cursorRow] =
        this.lines[this.cursorRow].slice(0, savedCol) +
        this.lines[this.cursorRow].slice(this.cursorCol);
      this.cursorCol = savedCol;
    } else {
      const after = this.lines[savedRow].slice(0, savedCol);
      this.lines.splice(savedRow + 1, this.cursorRow - savedRow - 1);
      const end = this.lines[this.cursorRow].slice(this.cursorCol);
      this.lines[savedRow] = after + end;
      this.lines.splice(savedRow + 1, this.cursorRow - savedRow);
      this.cursorRow = savedRow;
      this.cursorCol = savedCol;
    }
  }

  private saveCurrentDraft(): void {
    if (this.historyIndex >= 0) {
      this.drafts.set(this.historyIndex, [...this.lines]);
    }
  }

  // Wipe the currently-rendered region and reset all tall-mode/scroll state so
  // the next render() redraws the new content from scratch. This is needed when
  // swapping in a different history entry: a tall previous entry leaves a
  // top-anchored window (and possibly a "… rows hidden" marker) on screen that
  // must not bleed into the new entry's render.
  private clearForRerender(): void {
    // Defer the actual clear bytes: store them as a prefix the next render()
    // prepends to its own buffer, so the wipe and the redraw land in a single
    // write. Writing them here as a standalone write is what made the prompt
    // visibly blink when iterating history (the region went blank for one
    // frame before the new entry was drawn).
    if (this.tallLatched) {
      // Tall mode is top-anchored at rows 0..renderedRows-1: clearing from the
      // top of the screen to the end wipes the whole live region.
      this.pendingClearPrefix += `${CSI}1;1H${CSI}0J`;
    } else if (this.renderedRows > 0) {
      // Short mode is bottom-anchored, but the next render() (with the cached
      // region dropped) draws from the current cursor row. Repositioning to the
      // TOP of the old region and clearing to the end of the screen — instead
      // of clear(), which leaves the cursor one row past the bottom — makes the
      // new (possibly shorter) entry redraw in place rather than leaving a band
      // of blank rows above it.
      if (this.lastPhysCursorRow > 0) {
        this.pendingClearPrefix += `\r${CSI}${this.lastPhysCursorRow}A`;
      } else {
        this.pendingClearPrefix += "\r";
      }
      this.pendingClearPrefix += `${CSI}0J`;
    }
    this.resetRenderState();
  }

  private loadHistoryEntry(index: number): void {
    this.clearForRerender();
    const draft = this.drafts.get(index);
    if (draft) {
      this.lines = [...draft];
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow].length;
    } else {
      this.text = this.history[index].text;
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedLines = [...this.lines];
      this.historyIndex = this.history.length - 1;
      this.loadHistoryEntry(this.historyIndex);
    } else if (this.historyIndex > 0) {
      this.saveCurrentDraft();
      this.historyIndex--;
      this.loadHistoryEntry(this.historyIndex);
    } else {
      // Already at the top of history: as a boundary cue, jump the cursor to
      // the TOP of the current input instead of doing nothing.
      this.cursorRow = 0;
      this.cursorCol = 0;
    }
  }

  private historyDown(): void {
    if (this.historyIndex === -1) {
      // Already at the bottom (the live draft): as a boundary cue, jump the
      // cursor to the BOTTOM of the current input instead of doing nothing.
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow].length;
      return;
    }
    this.saveCurrentDraft();
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.loadHistoryEntry(this.historyIndex);
    } else {
      this.historyIndex = -1;
      this.clearForRerender();
      if (this.savedLines) {
        this.lines = this.savedLines;
        this.savedLines = null;
        this.cursorRow = this.lines.length - 1;
        this.cursorCol = this.lines[this.cursorRow].length;
      } else {
        this.text = "";
      }
    }
  }

  private doTab(): void {
    if (!this.completer) return;
    if (this.completionActive) {
      this.cycleCompletion(1);
      return;
    }
    this.startCompletion(false);
  }

  private doShiftTab(): void {
    if (!this.completer) return;
    if (this.completionActive) {
      this.cycleCompletion(-1);
      return;
    }
    this.startCompletion(true);
  }

  // Begin a completion cycle. Computes matches for the token to the left of the
  // cursor; a single match is inserted inline (no cycling). Multiple matches
  // enter cycling: the token is replaced by the common prefix of all matches,
  // the variant list is rendered below the input, and the index is left at the
  // common-prefix state (-1) for a forward Tab or jumped to the last match for
  // a backward Shift-Tab start. Directories are listed WITHOUT a trailing "/",
  // so cycling selects the bare name; the user descends by typing "/" and
  // pressing Tab again (which starts a fresh completion in that directory).
  private startCompletion(backward: boolean): void {
    const line = this.lines[this.cursorRow];
    const cursorCol = this.cursorCol;
    const before = line.slice(0, cursorCol);
    const m = before.match(/(\S+)$/);
    const tokenStart = m ? cursorCol - m[1].length : cursorCol;
    const token = m ? m[1] : "";
    const [hits] = this.completer!(line, cursorCol);
    if (hits.length === 0) return;

    if (hits.length === 1) {
      const trail = hits[0].slice(token.length);
      this.lines[this.cursorRow] =
        line.slice(0, cursorCol) + trail + line.slice(cursorCol);
      this.cursorCol += trail.length;
      return;
    }

    // Tall mode is top-anchored and reuses the whole screen for the input, so
    // there's no room to anchor a variant overlay below it. Fall back to just
    // completing the common prefix without entering cycling.
    if (this.tallLatched) {
      const common = commonPrefix(hits);
      const trail = common.slice(token.length);
      this.lines[this.cursorRow] =
        line.slice(0, cursorCol) + trail + line.slice(cursorCol);
      this.cursorCol += trail.length;
      return;
    }

    const common = commonPrefix(hits);
    this.completionActive = true;
    this.completionMatches = hits;
    this.completionTokenStart = tokenStart;
    this.completionToken = token;
    this.completionTokenLen = token.length;
    this.completionIndex = backward ? hits.length - 1 : -1;
    // For the common-prefix state, only replace the token with the common
    // prefix when it actually EXTENDS what was typed; otherwise keep the typed
    // text (substring search where matches share no common prefix).
    const value = this.completionIndex === -1
      ? (common.length >= token.length ? common : token)
      : hits[this.completionIndex];
    this.lines[this.cursorRow] =
      line.slice(0, tokenStart) + value + line.slice(cursorCol);
    this.cursorCol = tokenStart + value.length;
    this.completionTopPhysRow = this.lastPhysCursorRow;
    this.renderCompletion();
  }

  private cycleCompletion(dir: 1 | -1): void {
    const N = this.completionMatches.length;
    const states = N + 1; // -1 (common prefix) plus N full matches
    let pos = this.completionIndex + 1; // map -1->0, 0->1, ..., N-1->N
    pos = (pos + dir + states) % states;
    this.completionIndex = pos - 1;
    const value =
      this.completionIndex === -1
        ? (() => {
            const c = commonPrefix(this.completionMatches);
            return c.length >= this.completionTokenLen ? c : this.completionToken;
          })()
        : this.completionMatches[this.completionIndex];
    const line = this.lines[this.cursorRow];
    const ts = this.completionTokenStart;
    this.lines[this.cursorRow] = line.slice(0, ts) + value + line.slice(this.cursorCol);
    this.cursorCol = ts + value.length;
    this.renderCompletion();
  }

  // Exit completion cycling and clear the variant overlay. Only the overlay
  // rows (below the input) are wiped — the input itself is left on screen so a
  // following render() can update it in place (or finish() can commit it).
  // The clear + cursor restore are emitted in a single write so there's no
  // blank frame between erasing the overlay and repositioning.
  private breakCompletion(): void {
    if (!this.completionActive) return;
    this.completionActive = false;
    this.completionMatches = [];
    this.completionIndex = -1;
    this.completionToken = "";
    this.completionTokenLen = 0;
    if (this.bottomPinnedMode) {
      // In bottom-pinned mode, just re-render to clear the overlay above the prompt.
      this.completionOverlayRows = 0;
      // render() will be called by the main handleBytes loop after this.
      return;
    }
    if (this.completionOverlayRows > 0) {
      const physRows = this.renderedRows - 1;
      const down = physRows - this.lastPhysCursorRow;
      let buf = "";
      if (down > 0) buf += `${CSI}${down}B`;
      buf += `\r${CSI}0J`;
      if (down > 0) buf += `${CSI}${down}A`;
      buf += "\r";
      const col = this.inputCursorCol();
      if (col > 0) buf += `${CSI}${col}C`;
      write(this.stdout, buf);
      this.completionOverlayRows = 0;
    }
  }

  // Like breakCompletion, but also restores the input to the token the user
  // originally typed before Tab-cycling began — discarding the cycled match.
  // Used when the user presses Escape mid-cycling (e.g. /model's search) so
  // they get their search string back instead of a half-completed id. Only the
  // overlay rows are wiped here; the redraw is deferred to the next render()
  // flush — clearForRerender queues a clear-to-end-of-screen that also erases
  // the overlay, then render() reprints the restored input.
  private revertCompletion(): void {
    if (!this.completionActive) return;
    const line = this.lines[this.cursorRow];
    const ts = this.completionTokenStart;
    // Text after the current cursor survives cycling unchanged at the line's
    // tail, so preserve it when shrinking back to the original token.
    const trailing = line.slice(this.cursorCol);
    this.lines[this.cursorRow] = line.slice(0, ts) + this.completionToken + trailing;
    this.cursorCol = ts + this.completionToken.length;
    this.completionActive = false;
    this.completionMatches = [];
    this.completionIndex = -1;
    this.completionToken = "";
    this.completionTokenLen = 0;
    this.completionOverlayRows = 0;
    this.completionTopPhysRow = 0;
    if (this.bottomPinnedMode) {
      // In bottom-pinned mode, render() handles the full redraw cleanly.
      // No need to queue a clearForRerender; just let render() do it.
      return;
    }
    this.clearForRerender();
  }

  // Redraw the input region plus the variant overlay below it. The currently
  // selected match is highlighted in reverse video. The overlay shows at most 2
  // rows of matches (laid out in columns to use the terminal width); when the
  // selection scrolls out of that window the window follows it, and a
  // "... (N above, M below)" indicator is shown when matches don't all fit.
  private renderCompletion(): void {
    // In bottom-pinned mode the overlay is drawn above the prompt row;
    // renderBottomPinned handles the full redraw (prompt + overlay together).
    if (this.bottomPinnedMode) {
      const columns = this.stdout.columns || 80;
      const screenH = this.stdout.rows || 24;
      this.renderBottomPinned(columns, screenH);
      return;
    }
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const rev = "\x1b[7m";
    const columns = this.stdout.columns || 80;

    // Compute the overlay layout BEFORE redrawing the input, so the whole
    // frame (clear + input redraw + overlay + cursor restore) can be assembled
    // in one buffer and flushed in a single write. Emitting the clear and the
    // new content as separate writes leaves a brief blank frame between them —
    // the visible "kilo> blink" on each Tab.
    const hits = this.completionMatches;
    const widths = hits.map((h) => visibleLen(h));
    const maxW = widths.reduce((m, w) => Math.max(m, w), 1);
    const colW = Math.min(maxW + 2, columns);
    const perRow = Math.max(1, Math.floor(columns / colW));
    const MAX_ROWS = 2;

    const cur = this.completionIndex;
    const focus = cur === -1 ? 0 : cur;
    const focusRow = Math.floor(focus / perRow);
    const totalRows = Math.ceil(hits.length / perRow);
    let startRow = Math.max(0, focusRow - (MAX_ROWS - 1));
    const maxStartRow = Math.max(0, totalRows - MAX_ROWS);
    if (startRow > maxStartRow) startRow = maxStartRow;
    const startIdx = startRow * perRow;
    const show = hits.slice(startIdx, startIdx + perRow * MAX_ROWS);
    const moreBefore = startIdx;
    const moreAfter = hits.length - (startIdx + show.length);

    const rows: string[] = [];
    for (let i = 0; i < show.length; i += perRow) {
      const rowHits = show.slice(i, i + perRow);
      let rowStr = "";
      for (let j = 0; j < rowHits.length; j++) {
        const absIdx = startIdx + i + j;
        const cell = rowHits[j];
        const cellStr = absIdx === cur ? `${rev}${cell}${reset}` : cell;
        const pad = Math.max(0, colW - visibleLen(cell));
        rowStr += cellStr + " ".repeat(pad);
      }
      rows.push(rowStr);
    }
    const moreLine =
      moreBefore > 0 || moreAfter > 0
        ? `${dim}... (${moreBefore} above, ${moreAfter} below)${reset}`
        : null;
    const overlayRows = rows.length + (moreLine ? 1 : 0);

    // 1. Move to the top of the region and clear it.
    let pre = "";
    if (this.completionTopPhysRow > 0) {
      pre += `${CSI}${this.completionTopPhysRow}A`;
    }
    pre += `\r${CSI}0J`;
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;

    // 2. Redraw the input with its output captured (not flushed yet).
    const savedActive = this.active;
    this.active = true;
    const inputBuf = this.captureRender(() => this.render());
    this.active = savedActive;

    // 3. Build the overlay + cursor-restore suffix.
    const physRows = this.renderedRows - 1;
    const down = physRows - this.lastPhysCursorRow;
    let post = "";
    if (down > 0) post += `${CSI}${down}B`;
    post += "\r";
    if (rows.length > 0) post += rows.join("\r\n") + "\r\n";
    if (moreLine) post += moreLine + "\r\n";
    const up = (physRows - this.lastPhysCursorRow) + overlayRows;
    if (up > 0) post += `${CSI}${up}A`;
    post += "\r";
    const col = this.inputCursorCol();
    if (col > 0) post += `${CSI}${col}C`;

    // 4. One flush: clear + input + overlay + cursor, no intermediate frame.
    write(this.stdout, pre + inputBuf + post);

    this.completionOverlayRows = overlayRows;
    this.completionTopPhysRow = this.lastPhysCursorRow;
  }

  private submit(): void {
    const text = this.text;
    if (text === "") {
      write(this.stdout, "\r\n");
      this.renderedRows = 0;
      this.render();
      return;
    }
    this.finish(text);
  }

  private finish(value: string): void {
    this.active = false;
    // Sending the input ends the current editing session: drop any in-memory
    // edits made to history entries so the on-disk history stays pristine.
    this.drafts.clear();
    if (this.bottomPinnedMode) {
      // In bottom-pinned mode, clear the entire reserved area at the bottom and
      // leave the cursor at the top of it so the caller's output starts there.
      const screenH = this.stdout.rows || 24;
      const reserved = Math.max(1, this.bottomPinnedReservedRows);
      const topRow = screenH - reserved + 1;
      let buf = "";
      for (let r = topRow; r <= screenH; r++) {
        buf += `${CSI}${r};1H${CSI}2K`;
      }
      buf += `${CSI}${topRow};1H`;
      write(this.stdout, buf);
      this.resetRenderState();
      if (this.resolve) {
        this.resolve(value);
        this.resolve = null;
        this.reject = null;
      }
      return;
    }
    // In tall mode the visible window only shows the bottom of the input and the
    // hidden rows live in memory, so reprint the full input now to commit it to
    // the terminal output/scrollback. In short mode the whole input is already
    // on screen, so just move to the end and emit the trailing newline.
    if (this.tallLatched) {
      this.printFullInput(null);
    } else {
      // If the cursor is sitting in the middle of a multiline block (e.g. after
      // submitting with ctrl-j from anywhere), move it down to the last content
      // row first so the trailing newline — and the agent output that follows —
      // starts below the full input instead of overwriting the lines beneath the
      // cursor. renderedRows includes one trailing rest row, so the last content
      // row is renderedRows - 2. This is a no-op when the cursor is already at
      // or past the end (the common single-line and at-end multiline cases).
      const lastContentRow = this.renderedRows - 2;
      if (this.renderedRows > 0 && this.lastPhysCursorRow < lastContentRow) {
        const down = lastContentRow - this.lastPhysCursorRow;
        write(this.stdout, `${CSI}${down}B`);
      }
      write(this.stdout, "\r\n");
    }
    this.resetRenderState();
    if (this.resolve) {
      this.resolve(value);
      this.resolve = null;
      this.reject = null;
    }
  }

  private startSearch(): void {
    if (this.history.length === 0) return;
    this.searchActive = true;
    this.searchTerm = "";
    this.searchMatches = [];
    this.searchCursor = 0;
    this.savedBeforeSearch = [...this.lines];
    this.searchOverlayRows = 0;
    // The cursor currently sits at the input's physical cursor row. Remember it
    // so the first renderAll can move back to the top of the input before drawing.
    this.searchLastCursorRow = this.lastPhysCursorRow;
    this.renderAll();
  }

  private handleSearchBytes(chunk: Buffer): void {
    const full: Buffer = Buffer.concat([this.residue, chunk]) as Buffer;
    const { complete, residue } = this.splitUtf8Residue(full);
    this.residue = residue as Buffer;
    const len = complete.length;
    let i = 0;

    while (i < len) {
      const b = complete[i];

      if (b >= 0xC2 && b <= 0xF4) {
        const result = this.decodeUtf8(complete, i);
        this.searchTerm += result.char;
        this.doSearch();
        i += result.bytes;
      } else if (b === 0x03 || b === 0x07) {
        this.cancelSearch();
        return;
      } else if (b === 0x1b) {
        // Left/Right arrows (CSI C / CSI D) accept the search like Enter; a
        // bare Escape (or any other escape sequence) cancels it. Ctrl+Left /
        // Ctrl+Right arrive as CSI 1;5C / CSI 1;5D, and are accepted too so a
        // stray Ctrl-arrow doesn't abort the search.
        if (i + 2 < len && complete[i + 1] === 0x5b) {
          const c2 = complete[i + 2];
          if (c2 === 0x43 || c2 === 0x44) {
            this.acceptSearch();
            return;
          }
          if (
            i + 5 < len &&
            c2 === 0x31 &&
            complete[i + 3] === 0x3b &&
            complete[i + 4] === 0x35 &&
            (complete[i + 5] === 0x43 || complete[i + 5] === 0x44)
          ) {
            this.acceptSearch();
            return;
          }
        }
        this.cancelSearch();
        return;
      } else if (b === 0x0d) {
        this.acceptSearch();
        return;
      } else if (b === 0x7f) {
        if (this.searchTerm.length > 0) {
          this.searchTerm = this.searchTerm.slice(0, -1);
          this.doSearch();
        } else {
          this.cancelSearch();
          return;
        }
        i++;
      } else if (b === 0x12) {
        this.nextSearchMatch();
        i++;
      } else if (b >= 0x80) {
        i++;
      } else if (b >= 0x20) {
        this.searchTerm += String.fromCodePoint(b);
        this.doSearch();
        i++;
      } else {
        i++;
      }
    }
    this.renderSearch();
  }

  private doSearch(): void {
    if (this.searchTerm === "") {
      this.searchMatches = [];
      this.searchCursor = 0;
      return;
    }
    const term = this.searchTerm.toLowerCase();
    const matches: number[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].text.toLowerCase().includes(term)) {
        matches.push(i);
      }
    }
    this.searchMatches = matches;
    this.searchCursor = 0;
  }

  private nextSearchMatch(): void {
    if (this.searchMatches.length > 1) {
      this.searchCursor = (this.searchCursor + 1) % this.searchMatches.length;
    }
  }

  private acceptSearch(): void {
    if (this.searchMatches.length > 0 && this.searchCursor < this.searchMatches.length) {
      const idx = this.searchMatches[this.searchCursor];
      // Keep the pre-search fresh input reachable by navigating Down past the
      // end, but only if we didn't already come from history (in which case
      // savedLines already holds it).
      if (this.savedLines === null) {
        this.savedLines = this.savedBeforeSearch;
      }
      this.historyIndex = idx;
      this.loadHistoryEntry(idx);
      // loadHistoryEntry deferred a clear into pendingClearPrefix, but
      // acceptSearch performs its own explicit clear of the (input + overlay)
      // region below. Drop the deferred one so render() doesn't move the
      // cursor up again after we've already repositioned it.
      this.pendingClearPrefix = "";
    }
    this.searchActive = false;
    this.searchTerm = "";
    this.searchMatches = [];
    this.searchCursor = 0;
    this.savedBeforeSearch = null;
    this.searchOverlayRows = 0;

    // The accepted match is now in `this.lines`. Clear the whole region (input
    // + overlay) from the top and redraw the input alone.
    if (this.searchLastCursorRow > 0) {
      write(this.stdout, `${CSI}${this.searchLastCursorRow}A`);
    }
    write(this.stdout, "\r");
    write(this.stdout, `${CSI}0J`);
    this.searchLastCursorRow = 0;
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;
    this.viewTop = 0;
    this.committed = 0;
    const savedActive = this.active;
    this.active = true;
    this.render();
    this.active = savedActive;
  }

  private cancelSearch(): void {
    this.searchActive = false;
    this.searchTerm = "";
    this.searchMatches = [];
    this.searchCursor = 0;
    this.savedBeforeSearch = null;
    this.searchOverlayRows = 0;
    this.searchLastCursorRow = 0;

    // The input itself was never changed during search, so only the overlay
    // (drawn just below the input) needs to be erased. Move down to the overlay
    // top, clear to end of screen, then restore the cursor into the input.
    const physRows = this.renderedRows - 1;
    const physCursor = this.lastPhysCursorRow;
    const down = physRows - physCursor;
    if (down > 0) {
      write(this.stdout, `${CSI}${down}B`);
    }
    write(this.stdout, "\r");
    write(this.stdout, `${CSI}0J`);
    if (down > 0) {
      write(this.stdout, `${CSI}${down}A`);
    }
    write(this.stdout, "\r");
    const col = this.inputCursorCol();
    if (col > 0) {
      write(this.stdout, `${CSI}${col}C`);
    }
  }

  private buildBoxTop(headerText: string, width: number): string {
    const innerWidth = width - 2;
    let hdr = headerText;
    if (hdr.length > innerWidth) hdr = hdr.slice(0, innerWidth - 1) + "…";
    const pad = innerWidth - hdr.length;
    return `┌${hdr}${"─".repeat(Math.max(0, pad))}┐`;
  }

  private getCurrentMatch(): string {
    return this.searchMatches.length > 0 && this.searchCursor < this.searchMatches.length
      ? this.history[this.searchMatches[this.searchCursor]].text
      : "";
  }

  private inputCursorCol(): number {
    const columns = this.stdout.columns || 80;
    const prefixLen = visibleLen(
      this.cursorRow === 0 ? this.prompt : " ".repeat(visibleLen(this.prompt)),
    );
    return (prefixLen + this.cursorCol) % Math.max(1, columns);
  }

  private renderAll(): void {
    if (!this.searchActive) return;
    const columns = this.stdout.columns || 80;
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const boxWidth = Math.max(4, columns);

    const matched = this.getCurrentMatch();
    const matchedLines = matched ? matched.split("\n") : [];

    // The matched entry is always previewed inside the box, regardless of
    // whether it is a single line or many. This keeps the search UI uniform:
    // every kind of match (single-line, multiline, or none) renders the same
    // frame, with the matched content shown in its body when available.
    let previewLines: string[] = [];
    if (matchedLines.length > 0) {
      if (matchedLines.length <= 5) {
        previewLines = matchedLines;
      } else {
        previewLines = [
          ...matchedLines.slice(0, 2),
          "…",
          ...matchedLines.slice(-2),
        ];
      }
    }

    const headerText =
      ` search \`${this.searchTerm}'` +
      (this.searchMatches.length > 0
        ? `  ${this.searchCursor + 1}/${this.searchMatches.length}`
        : " 0/0");
    const boxTop = this.buildBoxTop(headerText, boxWidth);
    const innerWidth = boxWidth - 2;
    // The body leaves a one-column leading space after the left border, so the
    // usable content width is one less than the inner width. Lines longer than
    // that are wrapped across multiple body rows instead of being truncated,
    // so a single long match still fits inside the frame.
    const contentWidth = Math.max(1, innerWidth - 1);
    const wrappedLines: string[] = [];
    for (const line of previewLines) {
      if (line.length === 0) {
        wrappedLines.push("");
        continue;
      }
      for (let i = 0; i < line.length; i += contentWidth) {
        wrappedLines.push(line.slice(i, i + contentWidth));
      }
    }
    const newOverlayRows = 2 + wrappedLines.length;

    // 1. Move to the top of the region (row 0 of the input) and clear the whole
    //    region (input + overlay) down to the end of the screen.
    if (this.searchLastCursorRow > 0) {
      write(this.stdout, `${CSI}${this.searchLastCursorRow}A`);
    }
    write(this.stdout, "\r");
    write(this.stdout, `${CSI}0J`);

    // 2. Redraw the (frozen) input fresh. render() with renderedRows=0 skips its
    //    own clear phase, so it just draws starting at the current cursor row.
    this.renderedRows = 0;
    this.lastPhysCursorRow = 0;
    const savedActive = this.active;
    this.active = true;
    this.render();
    this.active = savedActive;

    // 3. Move down to the overlay top (just below the input) and draw the box.
    const physRows = this.renderedRows - 1;
    const physCursor = this.lastPhysCursorRow;
    const down = physRows - physCursor;
    if (down > 0) {
      write(this.stdout, `${CSI}${down}B`);
    }
    write(this.stdout, "\r");

    write(this.stdout, `${dim}${boxTop}${reset}\r\n`);
    for (const wl of wrappedLines) {
      const pad = Math.max(0, contentWidth - visibleLen(wl));
      write(this.stdout, `${dim}│${reset} ${wl}${" ".repeat(pad)}${dim}│${reset}\r\n`);
    }
    write(this.stdout, `${dim}└${"─".repeat(innerWidth)}┘${reset}\r\n`);

    // 4. Move the cursor back into the input and restore its column.
    const up = physRows + newOverlayRows - physCursor;
    if (up > 0) {
      write(this.stdout, `${CSI}${up}A`);
    }
    write(this.stdout, "\r");
    const col = this.inputCursorCol();
    if (col > 0) {
      write(this.stdout, `${CSI}${col}C`);
    }

    this.searchOverlayRows = newOverlayRows;
    this.searchLastCursorRow = physCursor;
  }

  private renderSearch(): void {
    this.renderAll();
  }

  private clear(): void {
    if (this.renderedRows === 0) return;
    const rows = this.renderedRows;
    if (this.lastPhysCursorRow > 0) {
      write(this.stdout, `\r${CSI}${this.lastPhysCursorRow}A`);
    } else {
      write(this.stdout, `\r`);
    }
    for (let i = 0; i < rows; i++) {
      write(this.stdout, `\r${CSI}K\r\n`);
    }
    // The loop above leaves the cursor one row below the cleared region; callers
    // (printFullInput) reprint "in place" at the region top, so move back up to
    // the top of the cleared region. Without this the reprint lands one row
    // below and the cleared rows stay on screen as blank lines.
    write(this.stdout, `\r${CSI}${rows}A`);
    this.renderedRows = 0;
  }

  private layout(columns: number): {
    physRows: number;
    physCursor: number;
    totalPhysical: number;
    lineRows: number[];
    lineStartPhys: number[];
  } {
    const cont = this.continuationPrefix;
    const getPrefix = (i: number): string => (i === 0 ? this.prompt : cont);
    let physRows = 0;
    let physCursor = 0;
    const lineRows: number[] = [];
    const lineStartPhys: number[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      lineStartPhys.push(physRows);
      const prefix = getPrefix(i);
      const totalLen = visibleLen(prefix) + visibleLen(this.lines[i]);
      const p = Math.max(1, Math.ceil(totalLen / Math.max(1, columns)));
      if (i < this.cursorRow) {
        physCursor += p;
      } else if (i === this.cursorRow) {
        const prefixLen = visibleLen(prefix);
        physCursor += Math.floor((prefixLen + this.cursorCol) / Math.max(1, columns));
      }
      physRows += p;
      lineRows.push(p);
    }
    return { physRows, physCursor, totalPhysical: physRows + 1, lineRows, lineStartPhys };
  }

  private render(): void {
    if (!this.active) return;
    const columns = this.stdout.columns || 80;
    const screenH = this.stdout.rows || 24;
    const lay = this.layout(columns);

    // Bottom-pinned mode: the prompt is always drawn at the bottom of the screen
    // (single line, single-line mode only). Completion overlay goes above it.
    if (this.bottomPinnedMode) {
      this.renderBottomPinned(columns, screenH);
      return;
    }

    // When the input is strictly taller than the screen, pin the live region to
    // the top of the screen and show only a window of it (the rest is kept in
    // memory and can be scrolled into view). Once this mode has been entered it
    // stays latched so we keep using the top-anchored absolute layout even if it
    // later shrinks.
    const tall = lay.totalPhysical > screenH;
    const enteringTall = tall && !this.tallLatched;
    if (tall) this.tallLatched = true;

    if (this.tallLatched && !this.searchActive) {
      // When the input crosses the screen height in a single render (a big
      // paste), short mode never got to scroll the previous output above the
      // prompt into the scrollback — so anchoring tall mode to row 1 would
      // overwrite and discard it. Scroll that previous output into the
      // scrollback first, so the input region's top lands on row 1.
      if (enteringTall) this.scrollPreviousOutputIntoScrollback(screenH);
      this.renderTall(columns, screenH, lay);
      return;
    }

    this.renderShort(columns, lay);
    this.committed = 0;
    this.viewTop = 0;
  }

  // Render the prompt pinned to the bottom of the screen with the completion
  // overlay drawn above it. The prompt occupies the last row; overlay rows sit
  // in the rows above the prompt. This reserves a fixed area at the bottom so
  // the search UI never pushes existing terminal content off-screen.
  private renderBottomPinned(columns: number, screenH: number): void {
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const rev = "\x1b[7m";
    const MAX_OVERLAY_ROWS = 2;

    // The prompt line is always at the last screen row.
    const promptRow = screenH; // 1-indexed

    // Build the prompt content (single line only in bottom-pinned mode).
    const line = this.lines[0] ?? "";
    const promptContent = this.prompt + line;

    let buf = "";

    if (this.completionActive && this.completionMatches.length > 0) {
      const hits = this.completionMatches;
      const widths = hits.map((h) => visibleLen(h));
      const maxW = widths.reduce((m, w) => Math.max(m, w), 1);
      const colW = Math.min(maxW + 2, columns);
      const perRow = Math.max(1, Math.floor(columns / colW));

      const cur = this.completionIndex;
      const focus = cur === -1 ? 0 : cur;
      const focusRow = Math.floor(focus / perRow);
      const totalRows = Math.ceil(hits.length / perRow);
      let startRow = Math.max(0, focusRow - (MAX_OVERLAY_ROWS - 1));
      const maxStartRow = Math.max(0, totalRows - MAX_OVERLAY_ROWS);
      if (startRow > maxStartRow) startRow = maxStartRow;
      const startIdx = startRow * perRow;
      const show = hits.slice(startIdx, startIdx + perRow * MAX_OVERLAY_ROWS);
      const moreBefore = startIdx;
      const moreAfter = hits.length - (startIdx + show.length);

      const rows: string[] = [];
      for (let i = 0; i < show.length; i += perRow) {
        const rowHits = show.slice(i, i + perRow);
        let rowStr = "";
        for (let j = 0; j < rowHits.length; j++) {
          const absIdx = startIdx + i + j;
          const cell = rowHits[j];
          const cellStr = absIdx === cur ? `${rev}${cell}${reset}` : `${dim}${cell}${reset}`;
          const pad = Math.max(0, colW - visibleLen(cell));
          rowStr += cellStr + " ".repeat(pad);
        }
        rows.push(rowStr);
      }

      const moreLine =
        moreBefore > 0 || moreAfter > 0
          ? `${dim}... (${moreBefore} above, ${moreAfter} below)${reset}`
          : null;

      const overlayRowCount = rows.length + (moreLine ? 1 : 0);
      // Draw overlay rows above the prompt, starting from the top of the reserved area.
      const overlayStartRow = promptRow - overlayRowCount;
      for (let i = 0; i < rows.length; i++) {
        buf += `${CSI}${overlayStartRow + i};1H${CSI}2K${rows[i]}`;
      }
      if (moreLine) {
        buf += `${CSI}${overlayStartRow + rows.length};1H${CSI}2K${moreLine}`;
      }
      this.completionOverlayRows = overlayRowCount;
    } else {
      // No overlay: clear the reserved rows above the prompt.
      const reserved = Math.max(1, this.bottomPinnedReservedRows);
      for (let i = 0; i < reserved - 1; i++) {
        buf += `${CSI}${promptRow - (reserved - 1) + i};1H${CSI}2K`;
      }
      this.completionOverlayRows = 0;
    }

    // Draw the prompt line at the last row.
    buf += `${CSI}${promptRow};1H${CSI}2K${promptContent}`;

    // Position cursor within the prompt line.
    const prefixLen = visibleLen(this.prompt);
    const cursorAbsCol = prefixLen + this.cursorCol + 1; // 1-indexed column
    buf += `${CSI}${promptRow};${cursorAbsCol}H`;

    write(this.stdout, buf);
    this.renderedRows = 1;
    this.lastPhysCursorRow = 0;
  }

  // Compute the tall-mode window for the current cursor position: resolve the
  // scroll offset (`viewTop`) and how many header/footer "… rows hidden" rows to
  // reserve. The cursor is always kept inside the visible content rows, so
  // moving it (Up/Down/Ctrl+Home/Ctrl+End) scrolls the window to follow.
  private resolveTallWindow(
    screenH: number,
    physCursor: number,
    totalPhysical: number,
  ): { viewTop: number; headerRows: number; footerRows: number; contentRows: number } {
    let viewTop = this.viewTop;
    let headerRows = 0;
    let footerRows = 0;
    let contentRows = screenH;
    for (let iter = 0; iter < 6; iter++) {
      headerRows = viewTop > 0 ? 1 : 0;
      contentRows = screenH - headerRows;
      const bottomHidden = totalPhysical - (viewTop + contentRows);
      footerRows = bottomHidden > 0 ? 1 : 0;
      contentRows = screenH - headerRows - footerRows;
      if (contentRows < 1) {
        footerRows = 0;
        contentRows = Math.max(1, screenH - headerRows);
      }
      const maxViewTop = Math.max(0, totalPhysical - contentRows);
      let nv = Math.min(viewTop, maxViewTop);
      if (physCursor < nv) nv = physCursor;
      if (physCursor > nv + contentRows - 1) nv = physCursor - contentRows + 1;
      nv = Math.max(0, Math.min(nv, maxViewTop));
      if (nv === viewTop) break;
      viewTop = nv;
    }
    // Final pass with the settled viewTop so header/footer/content match what
    // renderTall will actually draw.
    headerRows = viewTop > 0 ? 1 : 0;
    contentRows = screenH - headerRows;
    const bottomHidden = totalPhysical - (viewTop + contentRows);
    footerRows = bottomHidden > 0 ? 1 : 0;
    contentRows = screenH - headerRows - footerRows;
    if (contentRows < 1) {
      footerRows = 0;
      contentRows = Math.max(1, screenH - headerRows);
    }
    return { viewTop, headerRows, footerRows, contentRows };
  }

  private renderShort(
    columns: number,
    lay: { physRows: number; physCursor: number; totalPhysical: number },
  ): void {
    const cont = this.continuationPrefix;
    const lineCount = this.lines.length;
    const getPrefix = (i: number): string => (i === 0 ? this.prompt : cont);
    const physCursor = lay.physCursor;
    const totalPhysical = lay.totalPhysical;

    // Build the list of physical-row strings we would draw this render. Each
    // entry is exactly the text written to one screen row (the chunk after the
    // `\r\x1b[K` clear), so we can compare against the previous render and only
    // repaint rows that actually changed.
    // Wrap each logical line into physical screen rows by VISIBLE width. The
    // continuation prefix (and any future prompt) may contain ANSI escape codes
    // that take string bytes but no screen columns, so wrapping by string
    // length (text.length / text.slice) would overcount those invisible bytes
    // and produce a row count that diverges from layout()'s visible-width math
    // — leaving the cursor in the wrong spot on long wrapped continuation lines
    // and making backspace look like it only moves the cursor. Input lines
    // themselves contain no ANSI, so their visible width equals their length.
    const newRows: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      const prefix = getPrefix(i);
      const prefixVis = visibleLen(prefix);
      const content = this.lines[i];
      const avail = Math.max(0, columns - prefixVis);
      if (content.length === 0 || avail === 0) {
        newRows.push(prefix + content);
        continue;
      }
      if (content.length <= avail) {
        newRows.push(prefix + content);
        continue;
      }
      newRows.push(prefix + content.slice(0, avail));
      let off = avail;
      while (off < content.length) {
        newRows.push(content.slice(off, off + columns));
        off += columns;
      }
    }

    // renderedRows === 0 means the on-screen region was invalidated (resize,
    // search overlay, submit, …): force a full draw by dropping the cache. We
    // also can't "move to the top of the previous render" in that case (the
    // cursor is wherever the last external write left it), so we draw from the
    // current cursor row instead — matching the original non-cached behaviour.
    const hadRegion = this.renderedRows > 0;
    const oldRows = hadRegion ? this.lastContentRows : [];

    // First physical row whose content differs from what's already on screen.
    let d = 0;
    while (d < newRows.length && d < oldRows.length && newRows[d] === oldRows[d]) {
      d++;
    }
    const contentChanged = d < newRows.length || newRows.length !== oldRows.length;

    // Build the whole frame into one string and flush it in a single write so
    // the terminal never renders an intermediate state where a row has been
    // cleared (\x1b[K) but its new content not yet drawn — that gap is what
    // made each keystroke visibly blink, especially over slower terminals.
    // A deferred clear from clearForRerender (history navigation) is prepended
    // here so the wipe + redraw is atomic — that removes the "kilo> blink".
    let buf = this.pendingClearPrefix;
    this.pendingClearPrefix = "";

    if (hadRegion && !contentChanged) {
      // Nothing on screen changed (e.g. a pure cursor move): just reposition
      // the cursor from where the last render left it to the new cursor row,
      // skipping the clear/redraw of every row entirely.
      const delta = physCursor - this.lastPhysCursorRow;
      if (delta > 0) {
        buf += `${CSI}${delta}B`;
      } else if (delta < 0) {
        buf += `${CSI}${-delta}A`;
      }
      buf += "\r";
    } else {
      // If we have a previous region on screen, move back to its top and down
      // to the first changed row; otherwise draw from the current cursor row.
      if (hadRegion) {
        if (this.lastPhysCursorRow > 0) {
          buf += `${CSI}${this.lastPhysCursorRow}A`;
        }
        buf += "\r";
        if (d > 0) {
          buf += `${CSI}${d}B`;
        }
      }
      for (let i = d; i < newRows.length; i++) {
        buf += `\r${CSI}K${newRows[i]}\r\n`;
      }
      if (hadRegion && newRows.length < oldRows.length) {
        // The new input is shorter: clear everything below the new rest row
        // (wipes leftover old rows) without advancing the cursor further down,
        // so we never risk scrolling the terminal.
        buf += `${CSI}0J`;
      }
      // Reposition to the cursor row from the rest row we ended on. We only
      // ever move UP here (the cursor row is always at or above the rest row),
      // matching the original render which never emitted a cursor-down during
      // repositioning — emitting one here can land right before the trailing
      // newline on submit and leave a stray blank line.
      const upRows = newRows.length - physCursor;
      if (upRows > 0) {
        buf += `${CSI}${upRows}A`;
      }
      buf += "\r";
    }

    this.lastContentRows = newRows;
    this.renderedRows = totalPhysical;
    this.lastPhysCursorRow = physCursor;

    const prefixLen = visibleLen(getPrefix(this.cursorRow));
    const col = (prefixLen + this.cursorCol) % Math.max(1, columns);
    if (col > 0) {
      buf += `${CSI}${col}C`;
    }

    if (buf.length > 0) write(this.stdout, buf);
  }

  // Scroll the rows that were on screen above the input region into the
  // terminal scrollback, so that when tall mode anchors to the top of the
  // screen (row 1) it redraws the input in place instead of overwriting the
  // previous output. The screen cursor currently rests at physical row
  // `lastPhysCursorRow` within the previous (short) region, i.e. at screen row
  // (regionTop + lastPhysCursorRow). Emitting `screenH - 1 - lastPhysCursorRow`
  // line feeds from there scrolls exactly (regionTop - 1) lines — the rows
  // above the region — into the scrollback, regardless of where the prompt
  // actually sits, and leaves the cursor on the bottom screen row (which
  // renderTall repositions anyway). No cursor-position query is needed.
  private scrollPreviousOutputIntoScrollback(screenH: number): void {
    const k = screenH - 1 - this.lastPhysCursorRow;
    if (k > 0) write(this.stdout, "\n".repeat(k));
  }

  private renderTall(
    columns: number,
    screenH: number,
    lay: { physRows: number; physCursor: number; totalPhysical: number },
  ): void {
    const cont = this.continuationPrefix;
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const { physCursor, totalPhysical } = lay;

    // Resolve the visible window. Hidden rows stay in memory (we never commit
    // them to the terminal scrollback), so the window can be scrolled up/down
    // to reveal and edit them. The cursor is always kept visible, so cursor
    // movement drives the scroll offset.
    const { viewTop, headerRows, footerRows, contentRows } =
      this.resolveTallWindow(screenH, physCursor, totalPhysical);
    this.viewTop = viewTop;
    this.committed = 0;

    const startPhys = viewTop;
    const endPhys = Math.min(totalPhysical, viewTop + contentRows);

    // Build the whole frame into one string and flush it in a single write so
    // the terminal never renders a row in its cleared-but-not-yet-redrawn
    // state, which is what caused the per-keystroke blink. A deferred clear from
    // clearForRerender (history navigation) is prepended so the wipe + redraw is
    // atomic, removing the prompt blink.
    let buf = this.pendingClearPrefix;
    this.pendingClearPrefix = "";
    let screenRow = 0;

    const hiddenHint = (hidden: number): string =>
      `${dim}… ${reset}${dim}(${hidden} row${hidden === 1 ? "" : "s"} hidden)${reset}`;

    // Top "…" marker: there are rows above the window (only when scrolled up).
    if (headerRows > 0) {
      buf += `${CSI}1;1H${CSI}2K${hiddenHint(viewTop)}`;
      screenRow = headerRows;
    }

    // Draw the visible content rows (physical rows [startPhys, endPhys)) using
    // absolute positioning, one row at a time, each cleared first.
    let physRow = 0;
    let brokeOut = false;
    for (let i = 0; i < this.lines.length && !brokeOut; i++) {
      const prefix = i === 0 ? this.prompt : cont;
      const prefixVis = visibleLen(prefix);
      const content = this.lines[i];
      // Wrap by visible width (see renderShort): the continuation prefix
      // contains invisible ANSI bytes, so wrapping by string length would
      // diverge from layout()'s visible-width math and misplace the cursor.
      const chunks: string[] = [];
      const avail = Math.max(0, columns - prefixVis);
      if (content.length === 0 || avail === 0) {
        chunks.push(prefix + content);
      } else if (content.length <= avail) {
        chunks.push(prefix + content);
      } else {
        chunks.push(prefix + content.slice(0, avail));
        let off = avail;
        while (off < content.length) {
          chunks.push(content.slice(off, off + columns));
          off += columns;
        }
      }
      for (let k = 0; k < chunks.length; k++) {
        if (physRow >= endPhys) {
          brokeOut = true;
          break;
        }
        if (physRow >= startPhys && screenRow < screenH) {
          buf += `${CSI}${screenRow + 1};1H${CSI}2K${chunks[k]}`;
          screenRow++;
        }
        physRow++;
      }
    }
    // Trailing cursor-rest rows (the +1 in totalPhysical) that fall inside the
    // window, plus any blank rows when the window extends past the input.
    while (physRow < endPhys && screenRow < screenH) {
      buf += `${CSI}${screenRow + 1};1H${CSI}2K`;
      screenRow++;
      physRow++;
    }

    // Bottom "…" marker: there are rows below the window (shown when the view
    // has been scrolled up from the bottom).
    if (footerRows > 0 && screenRow < screenH) {
      const hidden = Math.max(0, totalPhysical - (viewTop + contentRows));
      buf += `${CSI}${screenRow + 1};1H${CSI}2K${hiddenHint(hidden)}`;
      screenRow++;
    }

    // Clear any previously-drawn rows below the new (possibly shorter) window.
    for (let r = screenRow; r < this.renderedRows && r < screenH; r++) {
      buf += `${CSI}${r + 1};1H${CSI}2K`;
    }

    this.renderedRows = screenRow;
    this.lastPhysCursorRow = headerRows + (physCursor - viewTop);

    const prefixLen = visibleLen(this.cursorRow === 0 ? this.prompt : cont);
    const col = (prefixLen + this.cursorCol) % Math.max(1, columns);
    const cursorScreenRow = headerRows + (physCursor - viewTop);
    buf += `${CSI}${cursorScreenRow + 1};1H`;
    if (col > 0) {
      buf += `${CSI}${col + 1}G`;
    }

    if (buf.length > 0) write(this.stdout, buf);
  }
}
