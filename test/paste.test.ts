import { describe, it } from "node:test";
import assert from "node:assert";
import { stripBracketedPaste } from "../src/paste.js";

describe("stripBracketedPaste", () => {
  it("passes through plain typed input unchanged", () => {
    const st = { inPaste: false };
    assert.strictEqual(stripBracketedPaste("12\r", st), "12\r");
    assert.strictEqual(st.inPaste, false);
  });

  it("drops a paste fully contained in one chunk", () => {
    const st = { inPaste: false };
    // A whole paste (begin + content + end) arrives in a single chunk. The old
    // implementation only saw the begin marker and left paste mode stuck on.
    const out = stripBracketedPaste("\x1b[200~1\r\x1b[201~", st);
    assert.strictEqual(out, "");
    assert.strictEqual(st.inPaste, false, "must exit paste mode when end marker is in the same chunk");
  });

  it("keeps typed text around a single-chunk paste", () => {
    const st = { inPaste: false };
    const out = stripBracketedPaste("ab\x1b[200~PASTED\x1b[201~cd\r", st);
    assert.strictEqual(out, "abcd\r");
    assert.strictEqual(st.inPaste, false);
  });

  it("handles begin and end markers split across chunks", () => {
    const st = { inPaste: false };
    assert.strictEqual(stripBracketedPaste("\x1b[200~1\n2", st), "");
    assert.strictEqual(st.inPaste, true);
    assert.strictEqual(stripBracketedPaste("3\n4\x1b[201~", st), "");
    assert.strictEqual(st.inPaste, false);
    // Typed input after the paste resumes normally.
    assert.strictEqual(stripBracketedPaste("9\r", st), "9\r");
    assert.strictEqual(st.inPaste, false);
  });

  it("drops content while inside a paste that has not ended yet", () => {
    const st = { inPaste: false };
    assert.strictEqual(stripBracketedPaste("\x1b[200~", st), "");
    assert.strictEqual(st.inPaste, true);
    assert.strictEqual(stripBracketedPaste("ignored content here", st), "");
    assert.strictEqual(st.inPaste, true);
    assert.strictEqual(stripBracketedPaste("\x1b[201~", st), "");
    assert.strictEqual(st.inPaste, false);
  });

  it("leaves a stray end marker in place when not in a paste", () => {
    // A stray end marker (no preceding begin) is not a paste sequence, so the
    // pure function leaves it in the output. readSingleLine separately drops
    // any chunk that still contains an escape sequence, so this can't leak.
    const st = { inPaste: false };
    const out = stripBracketedPaste("hi\x1b[201~there\r", st);
    assert.strictEqual(out, "hi\x1b[201~there\r");
    assert.strictEqual(st.inPaste, false);
  });
});
