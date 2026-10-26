// The usage above the panel's Settings button, whichever kind the user has:
// with a plan (a subscription), its limits as claude.ai shows them (the 5-hour
// session and the week, each a bar and when it resets); without one (an API
// key, a gateway), a conversation's totals, what it cost and how long it took.
// The plan's numbers are State.planUsage, from Claude Code's own /usage
// (island/hooks.ts), which only has them on a plan; the totals are Claude
// Code's own (code.rs usage). Settings → Claude Code → Usage draws the same
// bars (planRows).

import type { SessionUsage } from "../core/bridge";
import { duration, usd } from "../core/cost";
import type { PlanUsage, PlanWindow } from "../core/plan";
import { State } from "../core/state";
import { h } from "../views/dom";
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

/**
 * Draws the usage into `el`: the plan's bars when Claude Code has a plan (its
 * limits are what count there, and the dollar figure is only an estimate),
 * else `totals`. Hidden with neither.
 */
export function renderUsage(el: HTMLElement, totals: SessionUsage | null, now = Date.now()) {
  const bars = State.planUsage ? planRows(State.planUsage, now) : [];
  const shown = bars.length ? bars : totals ? [totalsRow(totals)] : [];
  el.replaceChildren(...(shown.length ? [h("div", { class: "b-usage-side" }, ...shown)] : []));
  el.style.display = shown.length ? "" : "none";
}
