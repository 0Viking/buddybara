// Settings → Claude Code → Usage: the plan's limits, as the panel's bars show
// them (buddy/usage.ts planRows), and a conversation's totals as Claude Code
// keeps them in its file (code.rs usage): how long the API took, how long it
// has been going, and, without a plan, what it cost. Each shows when it has
// numbers: an API key has no plan limits, and on a plan the dollar figure is
// only Claude Code's estimate, not a bill.

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

/** A conversation's totals, under its name and its project's; what it cost only without a plan. */
function totalsView(u: SessionUsage, withCost: boolean): HTMLElement[] {
  const locale = language();
  const count = new Intl.NumberFormat(locale);
  const parts = [
    h("div", { class: "usage-head" }, h("span", { text: u.title, title: u.title }), h("small", { text: folderName(u.project), title: u.project })),
    withCost ? stat(t("Total cost"), usd(u.costUsd, locale)) : null,
    stat(t("Total duration (API)"), duration(u.apiMs, locale)),
    stat(t("Total duration (wall)"), duration(u.wallMs, locale)),
    stat(t("Code changes"), `+${count.format(u.linesAdded)} −${count.format(u.linesRemoved)}`, true),
    withCost && u.unknownCost ? h("div", { class: "hint", text: t("Some models have no known price: the cost leaves them out.") }) : null,
    h("div", { class: "hint", text: t("Claude Code saves these after each run; a conversation still open in VS Code or a terminal can be a little behind.") }),
  ];
  return parts.filter((p): p is HTMLElement => p != null);
}

/**
 * The card, and `planChanged` to draw it again. The plan's numbers are asked
 * of Claude Code whatever the "Show on the mikan" switch says: it only has
 * them on a plan, and then they replace the conversation's dollar figure.
 */
export function usageCard(target: UsageTarget): { el: HTMLElement; planChanged: () => void } {
  const plans = h("div", { class: "usage-part" });
  const totals = h("div", { class: "usage-part" });
  const el = h("div", { class: "card usage-card" },
    h("h2", {}, h("span", { text: t("Usage") })),
    h("div", { class: "stack" }, plans, totals),
  );

  let drawn = 0;
  const draw = async () => {
    const run = ++drawn;
    plans.style.display = "";
    plans.replaceChildren(h("div", { class: "hint", text: t("Loading…") }));
    totals.replaceChildren(h("div", { class: "hint", text: t("Loading…") }));
    const [u, sum] = await Promise.all([
      planUsage().catch(() => null),
      Bridge.codeUsage(target.project, target.session).then((value) => ({ value }), (err: unknown) => ({ err })),
    ]);
    if (run !== drawn) return;
    // No plan (an API key, a gateway): the totals alone, with what they cost.
    plans.style.display = u ? "" : "none";
    plans.replaceChildren(...(u ? [h("div", { class: "usage-head" }, h("span", { text: t("Plan usage") })), ...planRows(u)] : []));
    if ("err" in sum) totals.replaceChildren(h("div", { class: "notice err", text: errorText(sum.err) }));
    else totals.replaceChildren(...(sum.value ? totalsView(sum.value, !u) : [h("div", { class: "hint", text: t("No conversation has saved its usage yet.") })]));
  };

  void draw();
  return { el, planChanged: () => void draw() };
}
