// The usage above the panel's Settings button, whichever the user has: the
// plan's, as claude.ai shows it (the 5-hour session and the week, each a bar
// and when it resets), and a conversation's totals, what it cost and how long
// it took (an API key or a gateway has those only). The plan's numbers are
// State.planUsage, kept fresh by island/hooks.ts while plan usage is on; the
// totals are Claude Code's own (code.rs usage). Settings → Claude Code →
// Usage draws the same bars (planRows).

import type { SessionUsage } from "../core/bridge";
import { duration, usd } from "../core/cost";
import type { PlanUsage, PlanWindow } from "../core/plan";
import { State } from "../core/state";
import { clear, h } from "../views/dom";
import { language, t } from "../i18n/i18n";

function row(label: string, w: PlanWindow, weekly: boolean, now: number): HTMLElement {
  // Reset since the numbers came: nothing used yet.
  const over = w.resetsAt <= now;
  const pct = over ? 0 : Math.round(w.usedPct);
  const at = new Date(w.resetsAt);
  const time = at.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
  const when = weekly
    ? t("Resets {day} at {time}", { day: at.toLocaleDateString(language(), { weekday: "short" }), time })
    : t("Resets at {time}", { time });
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return h("div", { class: "b-use" },
    h("div", { class: "b-use-head" }, h("span", { text: label }), h("span", { text: t("{pct}% used", { pct }) })),
    h("div", { class: pct >= 90 ? "b-use-bar high" : "b-use-bar" }, fill),
    over ? null : h("div", { class: "b-use-when", text: when }),
  );
}

/** A bar for each window the numbers have: the 5-hour session, the week. */
export function planRows(u: PlanUsage, now = Date.now()): HTMLElement[] {
  const rows: HTMLElement[] = [];
  if (u.fiveHour) rows.push(row(t("This session"), u.fiveHour, false, now));
  if (u.sevenDay) rows.push(row(t("This week"), u.sevenDay, true, now));
  return rows;
}

/** A conversation's totals: its name and what it cost, then how long the API took and how long in all. */
function totalsRow(u: SessionUsage): HTMLElement {
  const locale = language();
  return h("div", { class: "b-use" },
    h("div", { class: "b-use-head" }, h("span", { class: "b-use-name", text: u.title, title: u.title }), h("span", { text: usd(u.costUsd, locale) })),
    h("div", { class: "b-use-when", text: t("API {api} · total {wall}", { api: duration(u.apiMs, locale), wall: duration(u.wallMs, locale) }) }),
  );
}

/** How long each side shows when the box has both, the cost first. */
export const TURN_MS = 7000;

/**
 * The box's two sides, the cost and the plan's bars, one over the other: the
 * box keeps the taller one's height, so the list above it never jumps. With
 * both, they take turns (a fade, buddy.css); the pointer over the box holds
 * the one it shows.
 */
interface Sides {
  cost: HTMLElement;
  plan: HTMLElement;
  showing: "cost" | "plan";
  timer: number;
  held: boolean;
}

const sides = new WeakMap<HTMLElement, Sides>();

function sidesOf(el: HTMLElement): Sides {
  const known = sides.get(el);
  if (known) return known;
  clear(el);
  const s: Sides = { cost: h("div", { class: "b-usage-side" }), plan: h("div", { class: "b-usage-side" }), showing: "cost", timer: 0, held: false };
  el.append(s.cost, s.plan);
  el.addEventListener("mouseenter", () => (s.held = true));
  el.addEventListener("mouseleave", () => (s.held = false));
  sides.set(el, s);
  return s;
}

function turn(s: Sides, both: boolean) {
  s.cost.classList.toggle("off", both && s.showing !== "cost");
  s.plan.classList.toggle("off", both && s.showing !== "plan");
}

/**
 * Draws the usage into `el`: the plan's bars while plan usage is on and the
 * account has them, `totals` when there are some, taking turns with both.
 * Hidden with neither. Redrawn in place: a turn under way goes on.
 */
export function renderUsage(el: HTMLElement, totals: SessionUsage | null, now = Date.now()) {
  const u = State.settings.showPlanInNotch ? State.planUsage : null;
  const s = sidesOf(el);
  const bars = u ? planRows(u, now) : [];
  s.plan.replaceChildren(...bars);
  s.cost.replaceChildren(...(totals ? [totalsRow(totals)] : []));
  s.plan.style.display = bars.length ? "" : "none";
  s.cost.style.display = totals ? "" : "none";
  el.style.display = bars.length || totals ? "" : "none";
  const both = bars.length > 0 && totals != null;
  if (both && !s.timer) {
    s.showing = "cost";
    s.timer = window.setInterval(() => {
      if (s.held) return;
      s.showing = s.showing === "cost" ? "plan" : "cost";
      turn(s, true);
    }, TURN_MS);
  } else if (!both && s.timer) {
    window.clearInterval(s.timer);
    s.timer = 0;
  }
  turn(s, both);
}
