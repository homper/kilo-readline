// Pure helpers for per-session usage accounting, kept separate from the ACP
// wiring so they can be unit-tested without an agent.

export type SessionRole = "main" | "summarizer";

export type SessionUsage = {
  role: SessionRole;
  used: number; // tokens currently in context (last reported)
  size: number; // context window size (last reported)
  costAmount: number; // cumulative cost reported by the agent
  costCurrency: string;
};

export type UsageUpdate = {
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string } | null;
};

// Merge a usage_update into an entry, creating it if needed. Entries are never
// removed by this helper — callers keep them around so compacted-away sessions
// still show up in /status.
export function applyUsageUpdate(
  map: Map<string, SessionUsage>,
  sessionId: string,
  role: SessionRole,
  update: UsageUpdate,
): SessionUsage {
  const prev = map.get(sessionId) ?? {
    role,
    used: 0,
    size: 0,
    costAmount: 0,
    costCurrency: "",
  };
  prev.role = role;
  prev.used = Number(update.used) || 0;
  prev.size = Number(update.size) || 0;
  const amt = Number(update.cost?.amount ?? 0) || 0;
  prev.costAmount = amt;
  const cur = update.cost?.currency;
  prev.costCurrency = typeof cur === "string" && cur ? cur : prev.costCurrency;
  map.set(sessionId, prev);
  return prev;
}

export type SessionStatusRow = {
  id: string;
  role: SessionRole;
  used: number;
  size: number;
  costAmount: number;
  costCurrency: string;
  current: boolean;
};

// Produce ordered rows (by insertion order of the map) plus a totals summary.
// `currentId` marks the active main session.
export function summarizeSessions(
  map: Map<string, SessionUsage>,
  currentId: string | null,
): { rows: SessionStatusRow[]; totalCost: number; count: number } {
  const rows: SessionStatusRow[] = [];
  let totalCost = 0;
  for (const [id, u] of map) {
    rows.push({
      id,
      role: u.role,
      used: u.used,
      size: u.size,
      costAmount: u.costAmount,
      costCurrency: u.costCurrency,
      current: id === currentId && u.role === "main",
    });
    totalCost += u.costAmount || 0;
  }
  return { rows, totalCost, count: rows.length };
}
