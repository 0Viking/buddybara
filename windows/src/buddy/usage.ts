// The plan's usage above the panel's Settings button, as claude.ai shows it:
// the 5-hour session and the week, each a bar and when it resets. The numbers
// are State.planUsage, kept fresh by island/hooks.ts while plan usage is on.

import type { PlanWindow } from "../core/plan";
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

/** Draws the usage into `el`, hidden while there are no numbers or plan usage is off. */
export function renderUsage(el: HTMLElement, now = Date.now()) {
  const u = State.settings.showPlanInNotch ? State.planUsage : null;
  clear(el);
  el.style.display = u?.fiveHour || u?.sevenDay ? "" : "none";
  if (u?.fiveHour) el.append(row(t("This session"), u.fiveHour, false, now));
  if (u?.sevenDay) el.append(row(t("This week"), u.sevenDay, true, now));
}
