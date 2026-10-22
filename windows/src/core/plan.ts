// The Claude plan's usage, with no DOM so it can be tested on its own. The
// numbers are what Claude Code's own /usage says (claude.rs plan_usage: Claude
// Code asks the account with its sign-in, which Buddybara never reads), or
// Claude Code's status line (`rate_limits`) when a terminal session runs the relay.
// Pro and Max only. They show on the mikan (island/desktop.ts).

export interface PlanWindow {
  /** 0–100, clamped. */
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt: number;
}

export interface PlanUsage {
  fiveHour?: PlanWindow;
  sevenDay?: PlanWindow;
  /** When the numbers arrived (epoch ms). */
  updatedAt: number;
}

const DAY_MS = 86_400_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// ── Claude ────────────────────────────────────────────────────────────────────

function parseClaudeWindow(raw: unknown, now: number): PlanWindow | undefined {
  const w = asObj(raw);
  const pct = w?.used_percentage;
  const epoch = w?.resets_at;
  if (!isNum(pct) || !isNum(epoch)) return undefined;
  // Anything outside 0–200 is not a percentage; 100–200 is a plan over its limit, shown full.
  if (pct < 0 || pct > 200) return undefined;
  // resets_at is epoch seconds. A date more than 400 days away is milliseconds in disguise.
  if (epoch <= 0 || epoch * 1000 > now + 400 * DAY_MS) return undefined;
  return { usedPct: Math.min(100, pct), resetsAt: epoch * 1000 };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * One line of Claude Code's /usage: "Current session: 15% used · resets Oct 23,
 * 12:50am (America/Sao_Paulo)". The reset is in this computer's own time zone
 * (Claude Code runs here); a line without a date resets today, or tomorrow
 * once that time has passed.
 */
function usageLine(text: string, label: string, now: number): PlanWindow | undefined {
  const m = new RegExp(
    `${label}[^:\\n]*:\\s*(\\d+(?:\\.\\d+)?)% used\\s*·\\s*resets\\s+(?:([a-z]{3})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)`,
    "i",
  ).exec(text);
  if (!m) return undefined;
  const pct = Number(m[1]);
  if (pct < 0 || pct > 200) return undefined;
  const today = new Date(now);
  const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) : today.getMonth();
  if (month < 0) return undefined;
  const hour = (Number(m[4]) % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(today.getFullYear(), month, m[3] ? Number(m[3]) : today.getDate(), hour, Number(m[5] ?? 0));
  // A reset is always ahead: without a date, a time already past is tomorrow's;
  // a date more than a day behind is next year's.
  if (!m[3] && at.getTime() <= now) at.setDate(at.getDate() + 1);
  else if (at.getTime() < now - DAY_MS) at.setFullYear(at.getFullYear() + 1);
  return { usedPct: Math.min(100, pct), resetsAt: at.getTime() };
}

/** What `claude -p /usage` prints (claude.rs plan_usage), or null when it has neither window (an API key, not signed in). */
export function parseClaudeUsageText(text: unknown, now = Date.now()): PlanUsage | null {
  if (typeof text !== "string") return null;
  const usage: PlanUsage = { updatedAt: now };
  const fiveHour = usageLine(text, "Current session", now);
  // "Current week (all models)" comes before any per-model week.
  const sevenDay = usageLine(text, "Current week", now);
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/** ClaudePlanGauge.parse: `rate_limits` of a status line call, or null when it holds neither window. */
export function parseClaudePlan(rateLimits: unknown, now = Date.now()): PlanUsage | null {
  const rl = asObj(rateLimits);
  const fiveHour = parseClaudeWindow(rl?.five_hour, now);
  const sevenDay = parseClaudeWindow(rl?.seven_day, now);
  if (!fiveHour && !sevenDay) return null;
  const usage: PlanUsage = { updatedAt: now };
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;
  return usage;
}

// ── Codex ─────────────────────────────────────────────────────────────────────

// ── Shared ────────────────────────────────────────────────────────────────────

/** What to show for a window: 0 once its reset time has passed. */
export const effectivePct = (w: PlanWindow, now = Date.now()): number => (w.resetsAt <= now ? 0 : w.usedPct);

/** The higher of the two effective percentages; null when there are no windows. */
export function dominantPct(u: PlanUsage | null | undefined, now = Date.now()): number | null {
  const pcts = [u?.fiveHour, u?.sevenDay].filter((w): w is PlanWindow => !!w).map((w) => effectivePct(w, now));
  return pcts.length ? Math.max(...pcts) : null;
}

/** Green below 50 %, orange up to 80 %, red above, grey without data. */
export function planColor(pct: number | null): string {
  if (pct == null) return "#6B7079";
  if (pct < 50) return "#22C55E";
  if (pct < 80) return "#F59E0B";
  return "#F4505E";
}

/** A stored Claude usage, if it still looks like one (the last numbers survive a restart). */
export function restorePlanUsage(raw: string | null): PlanUsage | null {
  if (!raw) return null;
  try {
    const v = asObj(JSON.parse(raw));
    if (!v || !isNum(v.updatedAt)) return null;
    const win = (w: unknown): PlanWindow | undefined => {
      const o = asObj(w);
      return o && isNum(o.usedPct) && isNum(o.resetsAt) && o.usedPct >= 0 && o.usedPct <= 100
        ? { usedPct: o.usedPct, resetsAt: o.resetsAt }
        : undefined;
    };
    const usage: PlanUsage = { updatedAt: v.updatedAt };
    const fh = win(v.fiveHour);
    const sd = win(v.sevenDay);
    if (fh) usage.fiveHour = fh;
    if (sd) usage.sevenDay = sd;
    return fh || sd ? usage : null;
  } catch {
    return null;
  }
}
