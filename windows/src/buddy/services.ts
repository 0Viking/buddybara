// The panel's Services: a card for each service switched on in Settings →
// Integrations, fed by integrations.rs's `integration` events (Stripe, GitHub,
// Vercel, n8n, Resend, Notion, Cal.com). The cards are Coucou's, drawn the
// panel's way. News (a deploy, a payment, CI going red) plays a sound, dots the
// Services row and makes Buddybara react.

import { Bridge, onEvent, type IntegrationUpdate } from "../core/bridge";
import {
  CI_COLORS, GH_STRINGS, GRID_WEEKS, activityHeader, actionsUrl, ciWord, contributionColor, formatCount,
  gitHubAlert, lastDays, lastWeeks, mainCISummary, myPRsValue, profileUrl, readActivity, readPulse, readStats,
  safeGitHubUrl, shortRepo, weekColumn, worstCI,
  type ContributionDay, type GitHubActivity, type GitHubEvent, type GitHubPR, type GitHubRepoCI, type GitHubSection,
} from "../core/github";
import { SERVICES, type ServiceDef } from "../core/services";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { dot, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { BRANDS } from "../settings/brands";
import { luminance } from "../settings/parts";
import { language, t } from "../i18n/i18n";
import { ago } from "./run";

const GREEN = "#22C55E";
const RED = "#F4505E";

interface Info {
  data: Record<string, unknown>;
  error: string | null;
  /** Data came in at least once. */
  loaded: boolean;
  /** The last news: n8n's runs only ever come this way. */
  event: IntegrationUpdate["event"];
}

const infos = new Map<string, Info>();
/** Which of the enabled services' keys are in the Credential Manager. */
const keys = new Map<string, boolean>();
/** Something happened since the tab was last on screen: "bad" when any of it went wrong. */
let news: "good" | "bad" | null = null;
/** Bumped on every change: the panel redraws the tab only when it moves. */
let version = 0;
/** GitHub: the list open under its card. Vercel: the newest deploy's details. */
let ghOpen: GitHubSection | null = null;
let vercelOpen = false;
let changed: () => void = () => {};

function bump() {
  version++;
  changed();
}

/** The services switched on in Settings, in the catalog's order. */
export function enabledServices(): ServiceDef[] {
  return SERVICES.filter((s) => State.settings.activeIntegrations.includes(s.id));
}

export const servicesVersion = () => version;
export const servicesNews = () => news;

/** The tab is on screen: its dot goes, and GitHub refetches what is stale. */
export function servicesSeen() {
  if (news) {
    news = null;
    bump();
  }
  if (enabledServices().some((s) => s.id === "integration_github")) void Bridge.githubRefresh("pulse");
}

/** Asks which keys are there, for the cards that should say "add a key". */
export async function refreshServiceKeys() {
  for (const s of enabledServices()) {
    for (const f of s.fields) keys.set(f.key, (await Bridge.secretPresent(f.key)) ?? true);
  }
  bump();
}

/** Listens to the pollers. `react`: Buddybara's answer to news (true: good news). */
export function startServices(onChange: () => void, react: (good: boolean) => void) {
  changed = onChange;
  void onEvent<IntegrationUpdate>("integration", (u) => {
    const before = infos.get(u.id);
    infos.set(u.id, {
      data: u.error ? (before?.data ?? {}) : u.data,
      error: u.error,
      loaded: u.error ? (before?.loaded ?? false) : true,
      event: u.event ?? before?.event ?? null,
    });
    if (u.event && State.settings.activeIntegrations.includes(u.id)) {
      news = u.event.success && news !== "bad" ? "good" : "bad";
      Sound.play(u.event.success ? "finish" : "error");
      react(u.event.success);
    }
    bump();
  });
  void onEvent<GitHubEvent[]>("github-alerts", (events) => {
    const alert = gitHubAlert(events);
    if (!alert) return;
    news = alert.badge === "finished" && news !== "bad" ? "good" : "bad";
    Sound.play(alert.sound);
    react(alert.badge === "finished");
    bump();
  });
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const get = (id: string) => infos.get(id)?.data ?? {};

function arr(d: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = d[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** "3 min ago" for a time in milliseconds, seconds or ISO text. */
function since(value: unknown): string {
  const ms = typeof value === "number" ? (value > 1e12 ? value : value * 1000) : Date.parse(String(value));
  return Number.isFinite(ms) ? ago(ms / 1000) : "";
}

/** The service's mark, in its colour (a near-black one in the panel's ink). */
function glyph(brand: string): Element {
  const b = BRANDS[brand];
  const color = !b ? "#9398a1" : luminance(b.color) < 0.06 ? "#f5f6f8" : b.color;
  if (b?.path) {
    const el = svg(b.path, 14, { fill: color });
    el.classList.add("s-glyph");
    return el;
  }
  return h("i", { class: "s-letter", style: `background:${color}`, text: b?.letter ?? "?" });
}

function openSafe(url: unknown) {
  if (typeof url === "string" && /^https?:\/\//.test(url)) void Bridge.openUrl(url);
}

/** A list row: its dot, its name, then whatever goes on the right. */
function row(color: string, name: string, ...right: (string | Node)[]): HTMLElement {
  return h("div", { class: "s-row" }, dot(color, 6), h("span", { class: "s-name", text: name }),
    ...right.map((r) => (typeof r === "string" ? h("span", { class: "s-ago", text: r }) : r)));
}

function note(text: string, cls = ""): HTMLElement {
  return h("div", { class: `s-note ${cls}`, text });
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function stripe(): Node[] {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = arr(d, "payments").map((p) =>
    row(p.status === "succeeded" ? GREEN : RED, String(p.description ?? t("Payment")),
      h("span", { class: p.status === "succeeded" ? "s-amount" : "s-amount off", text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}` }), since(p.createdAt)));
  return [h("div", { class: "s-big" }, h("span", { text: balance }), h("i", { text: currency })), ...rows];
}

function vercel(): Node[] {
  const deployments = arr(get("integration_vercel"), "deployments").slice(0, 3);
  if (!deployments.length) return [note(t("Nothing here"))];
  return deployments.flatMap((d, i) => {
    const color = d.state === "READY" ? GREEN : RED;
    const r = row(color, String(d.projectName ?? ""), since(d.createdAt));
    if (i > 0) return [r];
    r.classList.add("s-click");
    r.addEventListener("click", () => {
      vercelOpen = !vercelOpen;
      bump();
    });
    if (!vercelOpen) return [r];
    const status = d.state === "READY" ? t("Ready") : d.state === "CANCELED" ? t("Canceled") : t("Error");
    const more = h("div", { class: "s-more" },
      h("span", { class: "s-badge", style: `color:${color};background:${color}24`, text: status }),
      d.commitMessage ? h("div", { class: "s-text", text: String(d.commitMessage) }) : null,
      d.branch ? h("div", { class: "s-dim", text: String(d.branch) }) : null,
      d.url ? h("button", { class: "s-link", text: String(d.url), onclick: () => openSafe(`https://${d.url}`) }) : null,
    );
    return [r, more];
  });
}

function resend(): Node[] {
  const d = get("integration_resend");
  const out: Node[] = [];
  if (d.total != null) out.push(h("div", { class: "s-big" }, h("span", { text: String(d.total) }), h("i", { text: t("Emails") })));
  arr(d, "emails").slice(0, 3).forEach((e, i) => {
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    out.push(row(e.lastEvent === "delivered" ? GREEN : RED, to.split("@")[0], since(e.createdAt)));
    if (i === 0 && e.subject) out.push(h("div", { class: "s-sub", text: String(e.subject) }));
  });
  return out.length ? out : [note(t("Nothing here"))];
}

function notion(): Node[] {
  const pages = arr(get("integration_notion"), "pages").slice(0, 3);
  if (!pages.length) return [note(t("Nothing here"))];
  return pages.map((p) => {
    const r = h("button", { class: "s-row s-click", onclick: () => openSafe(p.url) },
      p.emoji ? h("span", { class: "s-emoji", text: String(p.emoji) }) : svg(ICONS.doc, 11),
      h("span", { class: "s-name", text: String(p.title ?? t("Untitled")) }),
      h("span", { class: "s-ago", text: since(p.lastEditedAt) }));
    return r;
  });
}

function calcom(): Node[] {
  const bookings = arr(get("integration_calcom"), "bookings")
    .slice()
    .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)))
    .slice(0, 3);
  if (!bookings.length) return [note(t("No calls scheduled"))];
  return bookings.map((b) => {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(language(), { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    return h("div", { class: "s-row" }, dot("#C9956A", 6),
      h("span", { class: "s-time", text: `${day} ${time}` }),
      h("span", { class: "s-name", text: String(b.title ?? t("Meeting")) }));
  });
}

function n8n(): Node[] {
  const event = infos.get("integration_n8n")?.event;
  if (!event) return [note(t("No new runs yet: the next one shows here."))];
  const color = event.success ? GREEN : RED;
  return [
    h("div", { class: "s-row" }, dot(color, 6), h("span", { class: "s-name", text: event.label }),
      h("span", { class: "s-badge", style: `color:${color};background:${color}24`, text: event.success ? t("Success") : t("Failed") })),
    event.detail
      ? h("pre", { class: "s-pre", text: event.detail })
      : note(event.success ? t("Completed successfully.") : t("No error details available.")),
  ];
}

// GitHub: three rows (my PRs, to review, default branch CI) and the year's
// activity, each opening its list under it.

function ghToggle(section: GitHubSection) {
  ghOpen = ghOpen === section ? null : section;
  if (ghOpen) void Bridge.githubRefresh(ghOpen === "activity" ? "activity" : "pulse");
  bump();
}

function ghStat(section: GitHubSection, icon: Element, color: string, label: string, value: string): HTMLElement {
  return h("button", { class: ghOpen === section ? "s-stat s-click on" : "s-stat s-click", onclick: () => ghToggle(section) },
    h("i", { class: "s-stat-icon", style: `color:${color}` }, icon),
    h("span", { class: "s-name", text: label }),
    h("span", { class: "s-value", text: value }));
}

function ciDot(ci: GitHubPR["ci"]): HTMLElement {
  const el = dot(CI_COLORS[ci], 6);
  if (ci === "unknown") el.style.opacity = "0";
  return el;
}

function prRow(pr: GitHubPR, showCI: boolean): HTMLElement {
  return h("button", { class: "s-row s-click", onclick: () => openSafe(safeGitHubUrl(pr.url)) },
    showCI ? ciDot(pr.ci) : h("i", { class: "s-gap" }),
    h("span", { class: "s-ref", text: `${shortRepo(pr.repo)}#${pr.number}` }),
    h("span", { class: "s-name", text: pr.title }),
    pr.isDraft ? h("span", { class: "s-ago", text: GH_STRINGS.draft }) : null);
}

function repoRow(repo: GitHubRepoCI): HTMLElement {
  const word = ciWord(repo.ci);
  return h("button", { class: "s-row s-click", onclick: () => openSafe(safeGitHubUrl(actionsUrl(repo.url))) },
    ciDot(repo.ci),
    h("span", { class: "s-ref", text: shortRepo(repo.repo) }),
    h("span", { class: "s-name", text: repo.branch }),
    word ? h("span", { class: "s-ago", style: `color:${CI_COLORS[repo.ci]}`, text: word }) : null);
}

function ghList(rows: HTMLElement[]): HTMLElement {
  return h("div", { class: "s-list" }, ...(rows.length ? rows : [note(GH_STRINGS.nothingHere)]));
}

function ghGrid(activity: GitHubActivity, login: string): HTMLElement {
  const label = h("button", { class: "s-dim s-link", text: activityHeader(activity, null, null), onclick: () => openSafe(profileUrl(login)) });
  const show = (day: ContributionDay | null) => {
    label.textContent = activityHeader(activity, null, day);
  };
  const grid = h("div", { class: "s-grid" });
  for (const week of lastWeeks(activity, GRID_WEEKS)) {
    const column = h("div", { class: "s-week" });
    for (const day of weekColumn(week)) {
      const cell = h("i", { class: day ? "s-cell" : "s-cell empty", style: day ? `background:${contributionColor(day.level)}` : "" });
      if (day) {
        cell.addEventListener("mouseenter", () => show(day));
        cell.addEventListener("mouseleave", () => show(null));
      }
      column.append(cell);
    }
    grid.append(column);
  }
  return h("div", { class: "s-list" }, grid, label);
}

function github(): Node[] {
  const d = get("integration_github");
  const pulse = readPulse(d);
  const stats = readStats(d);
  const activity = readActivity(d);
  const out: Node[] = [];
  if (stats) {
    const mini = h("span", { class: "s-mini" });
    if (activity) for (const day of lastDays(activity, 7)) mini.append(h("i", { style: `background:${contributionColor(day.level)}` }));
    out.push(h("div", { class: "s-big" },
      h("span", { text: `★ ${formatCount(stats.totalStars)}` }),
      h("i", { text: GH_STRINGS.repos(stats.totalRepos) }), mini));
  }
  if (!pulse) return out.length ? out : [note(GH_STRINGS.loading)];
  const reviews = pulse.toReview.length;
  const main = mainCISummary(pulse.mainCI);
  out.push(ghStat("myPRs", svg(ICONS.pull, 11, { stroke: 2.2 }), CI_COLORS[worstCI(pulse.myPRs.map((p) => p.ci))],
    GH_STRINGS.myPRs, myPRsValue(pulse.myPRs)));
  if (ghOpen === "myPRs") out.push(ghList(pulse.myPRs.map((p) => prRow(p, true))));
  out.push(ghStat("toReview", svg(ICONS.eye, 11, { stroke: 2.2 }), reviews > 0 ? "#8AB4F8" : "#6B7079",
    GH_STRINGS.toReview, String(reviews)));
  if (ghOpen === "toReview") out.push(ghList(pulse.toReview.map((p) => prRow(p, false))));
  out.push(ghStat("mainCI", svg(main.failing ? ICONS.octagonX : ICONS.seal, 11, { evenOdd: true }), main.color,
    GH_STRINGS.mainCI, main.value));
  if (ghOpen === "mainCI") out.push(ghList(pulse.mainCI.map(repoRow)));
  if (activity) {
    out.push(ghStat("activity", svg(ICONS.star, 11), "#39D353", GH_STRINGS.activity, GH_STRINGS.contributions(activity.total)));
    if (ghOpen === "activity") out.push(ghGrid(activity, pulse.login));
  }
  return out;
}

const BODIES: Record<string, () => Node[]> = {
  integration_stripe: stripe,
  integration_github: github,
  integration_vercel: vercel,
  integration_n8n: n8n,
  integration_resend: resend,
  integration_notion: notion,
  integration_calcom: calcom,
};

function card(def: ServiceDef): HTMLElement {
  const info = infos.get(def.id);
  const open = h("button", { class: "s-icon", title: t("Open {name}", { name: def.name }) }, svg(ICONS.arrowUpRight, 11, { stroke: 2 }));
  open.addEventListener("click", () => (def.open ? openSafe(def.open) : void Bridge.openN8n()));
  const refresh = h("button", { class: "s-icon", title: t("Refresh") }, svg(ICONS.arrowClockwise, 11, { stroke: 2 }));
  refresh.addEventListener("click", () => void Bridge.refreshIntegration(def.id));
  const el = h("div", { class: "s-card" },
    h("div", { class: "s-head" }, glyph(def.brand), h("b", { text: def.name }), h("span", { class: "s-kind", text: t(def.kind) }), refresh, open));
  if (def.fields.some((f) => keys.get(f.key) === false)) {
    el.append(h("div", { class: "s-note" },
      h("span", { text: t("Add its key in Settings → Integrations.") }),
      h("button", { class: "s-link", text: t("Settings…"), onclick: () => void Bridge.openSettingsWindow() })));
  } else if (info?.error) {
    el.append(note(info.error, "err"));
  } else if (!info?.loaded && def.id !== "integration_n8n") {
    el.append(note(t("Loading…")));
  } else {
    el.append(...BODIES[def.id]());
  }
  return el;
}

/** The tab's contents: a card per enabled service. */
export function servicesView(): HTMLElement[] {
  const enabled = enabledServices();
  if (!enabled.length) return [h("div", { class: "b-hint", text: t("Switch services on in Settings → Integrations.") })];
  return [h("div", { class: "s-cards" }, ...enabled.map(card))];
}
