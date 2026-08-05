import { describe, it } from "node:test";
import assert from "node:assert";
import { displayWidth, displaySlice, stripAnsi } from "../src/width.js";

describe("displayWidth", () => {
  it("counts plain ASCII one column per character", () => {
    assert.strictEqual(displayWidth("hello"), 5);
    assert.strictEqual(displayWidth(""), 0);
  });

  it("ignores SGR color escape sequences", () => {
    // The kind of sequences our own renderer emits: \x1b[31m ... \x1b[0m.
    const s = "\x1b[31mred\x1b[0m";
    assert.strictEqual(displayWidth(s), 3);
    assert.strictEqual(displayWidth("\x1b[1m\x1b[4mab\x1b[0m"), 2);
  });

  it("ignores other CSI and OSC sequences", () => {
    // Non-SGR CSI (e.g. cursor up) and an OSC title terminated by BEL.
    assert.strictEqual(displayWidth("\x1b[2Aabc"), 3);
    assert.strictEqual(displayWidth("\x1b]0;title\x07ab"), 2);
    // OSC terminated by ST (ESC \) instead of BEL.
    assert.strictEqual(displayWidth("\x1b]0;t\x1b\\ab"), 2);
  });

  it("counts East-Asian wide characters as two columns", () => {
    assert.strictEqual(displayWidth("中"), 2);
    assert.strictEqual(displayWidth("日本語"), 6);
    assert.strictEqual(displayWidth("a中b"), 4); // 1 + 2 + 1
    // Hangul syllable and fullwidth digits.
    assert.strictEqual(displayWidth("한"), 2);
    assert.strictEqual(displayWidth("０"), 2); // fullwidth zero U+FF10
  });

  it("counts emoji as two columns", () => {
    assert.strictEqual(displayWidth("🚀"), 2);
    assert.strictEqual(displayWidth("ok 🚀!"), 6); // 2 + 1 + 2 + 1
  });

  it("counts combining marks as zero columns", () => {
    // e followed by combining acute accent -> one grapheme, one column.
    assert.strictEqual(displayWidth("e\u0301"), 1);
    assert.strictEqual(displayWidth("é"), 1); // precomposed, for comparison
    // Multiple combining marks still add nothing.
    assert.strictEqual(displayWidth("a\u0301\u0308"), 1);
  });

  it("ignores zero-width joiners and bidi controls", () => {
    assert.strictEqual(displayWidth("a\u200bb"), 2); // ZWSP between
    assert.strictEqual(displayWidth("a\u202Ab"), 2); // LRE bidi control
  });
});

describe("stripAnsi", () => {
  it("removes SGR, CSI and OSC sequences", () => {
    assert.strictEqual(stripAnsi("\x1b[31mhi\x1b[0m"), "hi");
    assert.strictEqual(stripAnsi("\x1b[2Ahi"), "hi");
    assert.strictEqual(stripAnsi("\x1b]0;t\x07hi"), "hi");
  });

  it("leaves plain text untouched", () => {
    assert.strictEqual(stripAnsi("plain text"), "plain text");
  });
});

describe("displaySlice", () => {
  it("returns a prefix within the given column budget", () => {
    assert.strictEqual(displaySlice("hello world", 5), "hello");
    assert.strictEqual(displaySlice("hello world", 4), "hell");
  });

  it("does not split a wide character in half", () => {
    // Asking for 1 column of a 2-column CJK char yields an empty prefix
    // rather than half of a surrogate pair.
    assert.strictEqual(displaySlice("中日", 1), "");
    assert.strictEqual(displaySlice("中日", 2), "中");
    assert.strictEqual(displaySlice("中日", 3), "中"); // can't fit next wide char
    assert.strictEqual(displaySlice("中日", 4), "中日");
  });

  it("preserves ANSI sequences inside the prefix", () => {
    // The color code takes no columns and is kept intact in the slice so the
    // returned prefix still renders correctly.
    const s = "\x1b[31mred\x1b[0m more";
    assert.strictEqual(displaySlice(s, 3), "\x1b[31mred\x1b[0m");
    assert.strictEqual(displaySlice(s, 4), "\x1b[31mred\x1b[0m ");
  });

  it("handles combining marks at the boundary", () => {
    // e + combining acute is one column; slicing to 1 keeps both code units.
    assert.strictEqual(displaySlice("e\u0301x", 1), "e\u0301");
  });
});
