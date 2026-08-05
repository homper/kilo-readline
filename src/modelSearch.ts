// Pure helpers for /model's search view, kept separate from the ACP wiring in
// index.ts so they can be unit-tested without an agent or a filesystem.
//
// Two completion modes for the search box:
//  - full-path mode: the token under the cursor already looks like (the start
//    of) a provider-qualified model id (it contains "/"). Tab then cycles full
//    model values, exactly as before this feature.
//  - word mode: the token is a bare fragment (no "/"). Tab then cycles the
//    individual words that occur across all model ids/names (split on
//    "/", "-", "_", ".", and whitespace), e.g. "son" -> "sonnet".
//
// The Enter-time resolution ("exact full model name + only surrounding spaces
// => select it immediately") lives in index.ts's search loop and is
// independent of these Tab helpers; these only drive the Tab overlay.

export type ModelOption = { value: string; name: string };

// Split a model id/name into its constituent "words". Delimiters mirror the
// boundary rewards in fuzzyScore: "/", "-", "_", ".", plus whitespace. Empty
// fragments are dropped. Used to build the Tab word-completion candidate set.
export function extractModelWords(models: ModelOption[]): string[] {
  const set = new Set<string>();
  for (const m of models) {
    for (const src of [m.value, m.name]) {
      for (const w of src.toLowerCase().split(/[/\-_.\s]+/)) {
        if (w) set.add(w);
      }
    }
  }
  return Array.from(set);
}

// A token "looks like a full model path" when it already contains a provider
// separator ("/"). In that case Tab should complete/cycle full model ids, not
// words. (We deliberately use only "/" rather than fuzzy prefix matching so
// that typing a bare fragment like "claude" still goes through word mode —
// the user gets to complete the word, then continue typing to disambiguate.)
export function isFullPathToken(token: string): boolean {
  return token.includes("/");
}

// Fuzzy subsequence matcher: returns true when every char of `query` appears
// in `target` in order (case-insensitive). Score rewards compact, early,
// boundary matches so the most relevant candidate ranks first. Mirrors the
// private fuzzyScore in index.ts but is exported here for testing.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  let ti = 0;
  let prevMatched = false;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = false;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = true;
        const boundary = ti === 0 || /[/\-_. ]/.test(t[ti - 1]);
        score += boundary ? 10 : prevMatched ? 5 : 1;
        prevMatched = true;
        ti++;
        break;
      }
      prevMatched = false;
      ti++;
    }
    if (!found) return null;
  }
  return score - Math.max(0, t.length - q.length) * 0.1;
}

// Word-mode Tab completion candidates for a token: words that start with the
// token first (sorted by length then alpha), then fuzzy-subsequence matches
// for the token among the remaining words. Returns the matched words (not
// full model ids) for the Tab cycling overlay.
export function matchModelWords(token: string, words: string[]): string[] {
  const q = token.trim().toLowerCase();
  if (!q) return [];
  const prefix: string[] = [];
  const fuzzy: { w: string; s: number }[] = [];
  for (const w of words) {
    if (w.startsWith(q)) prefix.push(w);
    else {
      const s = fuzzyScore(q, w);
      if (s !== null) fuzzy.push({ w, s });
    }
  }
  prefix.sort((a, b) => a.length - b.length || a.localeCompare(b));
  fuzzy.sort((a, b) => b.s - a.s || a.w.localeCompare(b.w));
  return [...prefix, ...fuzzy.map((x) => x.w)];
}

// Full-path-mode Tab completion candidates: model values whose id starts with
// the token (case-insensitive). Sorted by length then alpha so the shortest
// (tightest) match leads.
export function matchModelPaths(token: string, models: ModelOption[]): string[] {
  const q = token.trim().toLowerCase();
  if (!q) return [];
  const hits = models.filter((m) => m.value.toLowerCase().startsWith(q));
  hits.sort((a, b) => a.value.length - b.value.length || a.value.localeCompare(b.value));
  return hits.map((m) => m.value);
}

// Filter full models for Enter-time resolution / multi-word query support.
// Splits the query on whitespace and requires EVERY word to fuzzy-match (AND
// semantics) so "claude sonnet" matches `anthropic/claude-sonnet-5`. Each
// model is scored by the sum of per-word scores against its value and name;
// the best per word is used. Returns matches best-first. An empty query
// returns the kilo/* models (mirrors the original blank-search behaviour).
export function matchModels(query: string, models: ModelOption[]): ModelOption[] {
  const qRaw = query.trim().toLowerCase();
  if (qRaw === "") return models.filter((o) => o.value.startsWith("kilo/"));
  // Provider-prefixed queries: plain prefix match on the value (single word).
  if (qRaw.startsWith("kilo/") || qRaw.startsWith("anthropic/")) {
    return models
      .filter((o) => o.value.toLowerCase().startsWith(qRaw))
      .sort((a, b) => a.value.localeCompare(b.value));
  }
  const words = qRaw.split(/\s+/).filter(Boolean);
  const scored: { o: ModelOption; s: number }[] = [];
  for (const o of models) {
    let total = 0;
    let ok = true;
    for (const w of words) {
      const sv = fuzzyScore(w, o.value);
      const sn = fuzzyScore(w, o.name);
      const best = sv === null ? sn : sn === null ? sv : Math.max(sv, sn);
      if (best === null) {
        ok = false;
        break;
      }
      total += best;
    }
    if (ok) scored.push({ o, s: total });
  }
  scored.sort((a, b) => b.s - a.s || a.o.value.localeCompare(b.o.value));
  return scored.map((x) => x.o);
}

// True when `text` is exactly one full model id (case-insensitive) possibly
// surrounded by whitespace — the Enter-time "just use this model" shortcut.
export function exactModelMatch(text: string, models: ModelOption[]): ModelOption | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return models.find((o) => o.value.toLowerCase() === t) ?? null;
}

// --- Thinking / reasoning (effort) level display -------------------------------

// Canonical openrouter reasoning-effort names. A variant whose id (lowercased)
// is in this set is already an openrouter level name and is shown as-is.
export const OPENROUTER_EFFORT_NAMES = new Set(["none", "low", "medium", "high"]);

// Model-specific variant ids that are NOT openrouter names, mapped to the
// openrouter canonical name they correspond to. Display then shows
// "<agent name> (<openrouter name>)" so the user sees the alias. The only
// non-canonical variant the bundled glm-5.2 plugin emits is "max" (see
// ../kilocode-src packages/core/src/plugin/variant.ts). Extend as needed.
export const EFFORT_ALIAS_TO_OPENROUTER: Record<string, string> = {
  max: "high",
};

// Format the display name for a single effort/variant level. `variantId` is the
// raw variant id (e.g. "high", "max", "default"); `agentName` is the option's
// human-readable `name` from the agent (e.g. "High", "Max"). If the variant id
// is itself an openrouter name, the agent name is shown unchanged. If it is a
// known alias, the openrouter canonical name is appended in parens. Unknown
// non-canonical ids (e.g. a literal "default" variant) show just the agent name.
export function effortDisplayName(variantId: string, agentName: string): string {
  const id = variantId.toLowerCase();
  if (OPENROUTER_EFFORT_NAMES.has(id)) return agentName;
  const mapped = EFFORT_ALIAS_TO_OPENROUTER[id];
  return mapped ? `${agentName} (${mapped})` : agentName;
}

// Format the thinking level shown in /status. Resolves `current` to its option
// name via the agent's effort options (so the user sees e.g. "High" rather than
// "high"), then applies the openrouter-alias rule. Returns "(none)" when the
// model has no effort options (caller guards on that) or when the current level
// can't be resolved (shouldn't normally happen — the agent always reports a
// currentValue when there are options).
export function formatEffortDisplay(
  current: string | null,
  options: { value: string; name: string }[],
): string {
  if (options.length === 0) return "(none)";
  if (current == null || current === "") return "(none)";
  const hit = options.find((o) => o.value === current);
  const name = hit ? hit.name : current;
  return effortDisplayName(current, name);
}
