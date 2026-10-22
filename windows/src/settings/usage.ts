// Settings → Claude Code → Usage: the plan's limits, as the panel's bars show
// them (buddy/usage.ts planRows), and a conversation's totals as Claude Code
// keeps them in its file (code.rs usage): what it cost, how long the API
// took, how long it has been going. Each shows when it has numbers: an API
// key has no plan limits, and a conversation may have no totals saved yet.

import { Bridge, type SessionUsage } from "../core/bridge";
import { parseClaudeUsageText, type PlanUsage } from "../core/plan";
import { duration, usd } from "../core/cost";
import { planRows } from "../buddy/usage";
import { h } from "../views/dom";
import { language, t } from "../i18n/i18n";

/** Whose totals it shows: the conversation the panel's /usage was typed in; nulls for the newest. */
export interface UsageTarget {
  project: string | null;
  session: string | null;
}

/** The plan's numbers are asked again once this old (the panel asks every few minutes too). */
const PLAN_FRESH_MS = 60_000;
let plan: { usage: PlanUsage | null; at: number } | null = null;

async function planUsage(): Promise<PlanUsage | null> {
  if (plan && Date.now() - plan.at < PLAN_FRESH_MS) return plan.usage;
  const usage = parseClaudeUsageText(await Bridge.claudePlanUsage());
  plan = { usage, at: Date.now() };
  return usage;
}

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** The last folder of a path: the project's name. */
const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** One total: what it is on the left, how much on the right. */
function stat(label: string, value: string, ltr = false): HTMLElement {
  return h("div", { class: "usage-stat" }, h("span", { text: label }), h("b", { text: value, dir: ltr ? "ltr" : undefined }));
}

/** A conversation's totals, under its name and its project's. */
function totalsView(u: SessionUsage): HTMLElement[] {
  const locale = language();
  const count = new Intl.NumberFormat(locale);
  const parts = [
    h("div", { class: "usage-head" }, h("span", { text: u.title, title: u.title }), h("small", { text: folderName(u.project), title: u.project })),
    stat(t("Total cost"), usd(u.costUsd, locale)),
    stat(t("Total duration (API)"), duration(u.apiMs, locale)),
    stat(t("Total duration (wall)"), duration(u.wallMs, locale)),
    stat(t("Code changes"), `+${count.format(u.linesAdded)} −${count.format(u.linesRemoved)}`, true),
    u.unknownCost ? h("div", { class: "hint", text: t("Some models have no known price: the cost leaves them out.") }) : null,
    h("div", { class: "hint", text: t("Claude Code saves these after each run; a conversation still open in VS Code or a terminal can be a little behind.") }),
  ];
  return parts.filter((p): p is HTMLElement => p != null);
}

/**
 * The card, and `planChanged` for the "Show on the mikan" switch: the plan's
 * numbers are only asked of the account while it is on (`planOn`).
 */
export function usageCard(target: UsageTarget, planOn: () => boolean): { el: HTMLElement; planChanged: () => void } {
  const plans = h("div", { class: "usage-part" });
  const totals = h("div", { class: "usage-part" });
  const el = h("div", { class: "card usage-card" },
    h("h2", {}, h("span", { text: t("Usage") })),
    h("div", { class: "stack" }, plans, totals),
  );

  let planDrawn = 0;
  const drawPlan = async () => {
    const run = ++planDrawn;
    plans.style.display = "";
    if (!planOn()) {
      plans.replaceChildren(h("div", { class: "hint", text: t("Turn on Plan usage below to see your plan's limits here.") }));
      return;
    }
    plans.replaceChildren(h("div", { class: "hint", text: t("Loading…") }));
    const u = await planUsage().catch(() => null);
    if (run !== planDrawn) return;
    // No numbers (an API key, a gateway): the totals alone.
    if (!u) plans.style.display = "none";
    plans.replaceChildren(...(u ? [h("div", { class: "usage-head" }, h("span", { text: t("Plan usage") })), ...planRows(u)] : []));
  };

  const drawTotals = async () => {
    totals.replaceChildren(h("div", { class: "hint", text: t("Loading…") }));
    try {
      const u = await Bridge.codeUsage(target.project, target.session);
      totals.replaceChildren(...(u ? totalsView(u) : [h("div", { class: "hint", text: t("No conversation has saved its usage yet.") })]));
    } catch (err) {
      totals.replaceChildren(h("div", { class: "notice err", text: errorText(err) }));
    }
  };

  void drawPlan();
  void drawTotals();
  return { el, planChanged: () => void drawPlan() };
}
