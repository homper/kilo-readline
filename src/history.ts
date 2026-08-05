// Pure helpers for the on-disk prompt history file, kept separate from the ACP
// wiring so they can be unit-tested without a filesystem or an agent.
//
// History file format: a sequence of NUL-separated blocks, each prefixed with
// \x01 (single-line entry) or \x02 (multiline entry). Trailing entries without a
// marker (legacy files) are tolerated and classified by whether they contain a
// newline.

export type HistoryEntry = { text: string; isMultiline: boolean };

// Once the history file grows past this many bytes it is trimmed down to the
// most recent entries so it does not grow without bound.
export const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
export const HISTORY_KEEP_ON_TRIM = 10;

export function serializeHistoryEntry(text: string): string {
  const marker = text.includes("\n") ? "\x02" : "\x01";
  return `${marker}${text}\x00`;
}

export function serializeHistory(entries: HistoryEntry[]): string {
  return entries.map((e) => serializeHistoryEntry(e.text)).join("");
}

// Parse a history file's raw content into entries. Mirrors the loader in
// index.ts so the trim logic can be exercised against a string without touching
// the filesystem.
export function parseHistory(content: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const block of content.split("\x00")) {
    if (!block.trim()) continue;
    let text: string;
    let isMultiline: boolean;
    if (block[0] === "\x01") {
      isMultiline = false;
      text = block.slice(1);
    } else if (block[0] === "\x02") {
      isMultiline = true;
      text = block.slice(1);
    } else {
      text = block;
      isMultiline = text.includes("\n");
    }
    out.push({ text, isMultiline });
  }
  return out;
}

// Decide whether the history needs trimming given its current byte length, and
// if so return the entries to keep (the last HISTORY_KEEP_ON_TRIM). Returns
// null when no trim is needed, so callers can skip the rewrite.
export function trimHistoryEntries(
  entries: HistoryEntry[],
  byteLength: number,
): HistoryEntry[] | null {
  if (byteLength <= HISTORY_MAX_BYTES) return null;
  if (entries.length <= HISTORY_KEEP_ON_TRIM) return null;
  return entries.slice(-HISTORY_KEEP_ON_TRIM);
}
