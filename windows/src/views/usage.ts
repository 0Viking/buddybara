// The Claude plan's numbers, kept across restarts. They show on the mikan
// (island/desktop.ts); core/plan.ts reads them.

import type { PlanUsage } from "../core/plan";
import { State } from "../core/state";

const STORE_KEY = "buddybara.claudePlanUsage";

/** New numbers (the account or the status line); kept so they survive a restart. */
export function setClaudePlanUsage(usage: PlanUsage): void {
  const prev = State.planUsage;
  const same = JSON.stringify([prev?.fiveHour, prev?.sevenDay]) === JSON.stringify([usage.fiveHour, usage.sevenDay]);
  State.planUsage = usage;
  if (same) return;
  try {
    window.localStorage?.setItem(STORE_KEY, JSON.stringify(usage));
  } catch {
    // Storage off or full: the numbers just will not outlive this run.
  }
  State.notify();
}

/** The last numbers seen, if any were kept. */
export function storedClaudePlanUsage(): string | null {
  try {
    return window.localStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
}
