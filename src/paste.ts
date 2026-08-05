// Strip bracketed-paste sequences from a string, carrying paste state across
// chunks. Everything between CSI 200~ and CSI 201~ (inclusive) is dropped, so
// pasted content is ignored while typed keystrokes pass through. Handles a
// paste whose begin and end markers arrive in the same chunk (a naive impl
// would drop the end marker and leave paste mode stuck on) as well as markers
// split across chunks.
export function stripBracketedPaste(buf: string, st: { inPaste: boolean }): string {
  let out = "";
  let i = 0;
  while (i < buf.length) {
    if (!st.inPaste) {
      const start = buf.indexOf("\x1b[200~", i);
      if (start === -1) {
        out += buf.slice(i);
        break;
      }
      out += buf.slice(i, start);
      i = start + 6;
      st.inPaste = true;
    } else {
      const end = buf.indexOf("\x1b[201~", i);
      if (end === -1) break; // rest of this chunk is pasted content; drop it
      i = end + 6;
      st.inPaste = false;
    }
  }
  return out;
}
