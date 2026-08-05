// Display-width helpers: count terminal columns a string occupies, accounting
// for ANSI/OSC escape sequences, zero-width combining marks, and East-Asian
// wide/fullwidth characters. Used by the table layout, the word wrapper, and
// the raw-mode line editor so CJK/emoji content aligns and wraps correctly
// instead of being measured by UTF-16 code-unit length.

// Matches SGR color sequences (the kind our own renderer emits) and other CSI
// sequences, plus OSC sequences terminated by BEL or ST. Anything matching is
// stripped before width is measured.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Sticky variant used by displaySlice to test whether the string starts with a
// (zero-width) escape sequence. Unlike String.match with /g, RegExp.exec on a
// sticky regex reliably reports a match anchored at lastIndex.
const ANSI_PREFIX_RE =
  /(?:\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/y;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// Unicode "Default_Ignorable*" and combining/format marks that occupy no
// column on screen. We strip them before measuring so e.g. `e\u0301` (two
// code units) measures as 1, like the precomposed `é`.
//
// Ranges (by code point):
//  - U+0300..U+036F  Combining Diacritical Marks
//  - U+0483..U+0489  Combining Cyrillic
//  - U+0591..U+05BD  Hebrew points (most)
//  - U+05BF          Hebrew point
//  - U+05C1..U+05C2  Hebrew shin dots
//  - U+05C4..U+05C5  Hebrew marks
//  - U+05C7          Hebrew point
//  - U+0600..U+0605  Arabic marks
//  - U+0610..U+061A  Arabic marks
//  - U+061C          ALM
//  - U+064B..U+065F  Arabic marks
//  - U+0670          Arabic superscript
//  - U+06D6..U+06DC  Arabic marks
//  - U+06DF..U+06E4  Arabic marks
//  - U+06E7..U+06E8  Arabic marks
//  - U+06EA..U+06ED  Arabic marks
//  - U+070F          Syriac
//  - U+0711          Syriac
//  - U+0730..U+074A  Syriac marks
//  - U+200B..U+200F  ZWSP/ZWNJ/ZWJ/LRM/RLM
//  - U+202A..U+202E  bidi controls
//  - U+2060..U+2064  word joiner etc.
//  - U+2066..U+2069  bidi isolates
//  - U+206A..U+206F  deprecated format
//  - U+FEFF          BOM/ZWNBSP
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0600 && cp <= 0x0605) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    cp === 0x061c ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    cp === 0x070f ||
    cp === 0x0711 ||
    (cp >= 0x0730 && cp <= 0x074a) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0x206a && cp <= 0x206f) ||
    cp === 0xfeff
  );
}

// East-Asian wide / fullwidth: these occupy two terminal columns. Based on
// the Unicode East Asian Width property (W and F). Ambiguous (A) characters
// are treated as narrow here (1 column) to match the common monospace default
// outside an explicitly CJK locale.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2329 && cp <= 0x232a) || // corner brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth currency
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks (pictographs, emoticons, transport, supplemental, ext A)
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B-F
    (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Ext G+
  );
}

// Terminal column width of `str` after stripping escape sequences and
// ignoring zero-width combining/format marks. Wide (CJK/emoji) chars count 2.
export function displayWidth(str: string): number {
  let w = 0;
  for (const ch of stripAnsi(str)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0) continue;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

// Number of display columns the first `cols` columns of `str` occupy, i.e.
// the largest prefix whose display width is <= `cols`. Returns the index into
// the *unstripped* string (so ANSI codes between visible chars are preserved
// when slicing). Used to truncate a line to a display width without splitting
// a wide char in half.
export function displaySlice(str: string, cols: number): string {
  let w = 0;
  let i = 0;
  while (i < str.length) {
    // Skip a complete ANSI/OSC sequence as a unit; it takes no columns.
    ANSI_PREFIX_RE.lastIndex = 0;
    const m = ANSI_PREFIX_RE.exec(str.slice(i));
    if (m) {
      i += m[0].length;
      continue;
    }
    const ch = str[i];
    const cp = ch.codePointAt(0)!;
    const isSurrogate = cp >= 0x10000;
    const cw = isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (w + cw > cols) break;
    w += cw;
    i += isSurrogate ? 2 : 1;
  }
  return str.slice(0, i);
}
