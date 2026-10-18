// Settings → Connectors: the MCP servers Claude Code can sign in to (mcp.rs),
// three to a row, each with its mark, a red / green dot and Auth / Re-auth.
// Auth runs Claude Code's own sign-in, which opens the service's page in the
// browser; a claude.ai connector opens claude.ai's connector settings instead.
// What the page learnt is kept while the window is only hidden.

import { Bridge, type McpEntry } from "../core/bridge";
import { N_, t } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { BRANDS } from "./brands";

const GROUPS: [group: string, label: string][] = [
  ["work", N_("Work")],
  ["design", N_("Design & content")],
  ["dev", N_("Developers")],
  ["business", N_("Business")],
  ["other", N_("Other servers")],
];

const STATE_TEXT: Record<McpEntry["state"], string> = {
  connected: N_("Connected"),
  needsAuth: N_("Needs sign-in"),
  pending: N_("Waiting for approval"),
  failed: N_("Can't connect"),
  disabled: N_("Turned off"),
  missing: N_("Not connected"),
};

const REFRESH_ICON = "M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7";

let entries: McpEntry[] = [];
/** The states have been read at least once (until then the dots are grey). */
let known = false;
let reading: Promise<void> | null = null;
let lastRead = 0;
/** Why the states couldn't be read (Claude Code missing…). */
let failure = "";
/** The catalog id being signed in to. One at a time: Claude Code takes the
 *  browser's answer on one local address. */
let signingIn: string | null = null;
let cancelled = false;
/** Why a card's last Auth failed, until its next one. */
const errors = new Map<string, string>();
/** The page on screen, redrawn in place as states come in. */
let shown: { body: HTMLElement; draw: () => void } | null = null;

const message = (err: unknown) => String(err).replace(/^Error:\s*/, "");

function redraw() {
  if (shown?.body.isConnected) shown.draw();
}

/** Reads the states again: `claude mcp list` checks every server, a few seconds. */
function refresh(): Promise<void> {
  if (reading) return reading;
  reading = (async () => {
    try {
      entries = await Bridge.mcpStatus();
      known = true;
      failure = "";
    } catch (err) {
      failure = message(err);
    } finally {
      lastRead = Date.now();
      reading = null;
      redraw();
    }
  })();
  redraw();
  return reading;
}

// Back from the browser (a sign-in, claude.ai's connectors): read them again.
window.addEventListener("focus", () => {
  if (shown?.body.isConnected && Date.now() - lastRead > 10_000) void refresh();
});

async function connect(entry: McpEntry) {
  errors.delete(entry.id);
  if (entry.claudeAi) {
    await Bridge.mcpConnect(entry.id, false).catch((err) => errors.set(entry.id, message(err)));
    redraw();
    return;
  }
  signingIn = entry.id;
  cancelled = false;
  redraw();
  try {
    await Bridge.mcpConnect(entry.id, known && entry.state === "connected");
    entry.state = "connected";
  } catch (err) {
    if (!cancelled) errors.set(entry.id, message(err));
  } finally {
    signingIn = null;
    redraw();
    // After any read already under way, which may predate the sign-in.
    void Promise.resolve(reading).then(refresh);
  }
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A tile's background and mark: a near-black brand on a light tile, a light
 *  one under a dark mark, the rest under a white one. */
function tileColors(hex: string): [string, string] {
  const l = luminance(hex);
  if (l < 0.06) return ["#f6efe7", hex];
  return [hex, l > 0.4 ? "#1d1611" : "#ffffff"];
}

function mark(entry: McpEntry, state: string): HTMLElement {
  const brand = BRANDS[entry.id];
  const el = h("span", { class: brand ? "mark" : "mark plain" });
  if (brand) {
    const [bg, fg] = tileColors(brand.color);
    el.style.background = bg;
    el.style.color = fg;
    el.append(brand.path ? svg(brand.path, 21) : h("b", { text: brand.letter ?? "" }));
  } else {
    el.append(h("b", { text: (entry.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase() }));
  }
  el.append(h("i", { class: `state ${state}` }));
  return el;
}

function button(entry: McpEntry, busy: boolean): HTMLElement {
  if (busy) {
    return h("button", {
      text: t("Cancel"),
      onclick: () => {
        cancelled = true;
        void Bridge.mcpCancel();
      },
    });
  }
  const again = known && entry.state === "connected";
  const el = h("button", {
    class: again ? "" : "primary",
    text: again ? t("Re-auth") : t("Auth"),
    onclick: () => void connect(entry),
  });
  if (signingIn && !entry.claudeAi) {
    el.disabled = true;
    el.title = t("Finish the other sign-in first.");
  }
  return el;
}

function card(entry: McpEntry): HTMLElement {
  const busy = signingIn === entry.id;
  const state = busy ? "busy" : !known ? "wait" : entry.state === "connected" ? "on" : "off";
  const err = errors.get(entry.id);
  // A claude.ai card says where its Auth goes; its dot says the rest.
  const sub = busy
    ? t("In your browser…")
    : err ?? (!known ? t("Checking…") : entry.claudeAi ? t("Via claude.ai") : t(STATE_TEXT[entry.state]));
  const el = h("div", { class: `conn${state === "on" ? " ok" : ""}${busy ? " busy" : ""}` },
    mark(entry, state),
    h("div", { class: "conn-text" },
      h("div", { class: "conn-name", text: entry.name, title: entry.name }),
      h("div", { class: err ? "conn-sub err" : "conn-sub", text: sub, title: sub }),
    ),
  );
  if (entry.catalog) el.append(button(entry, busy));
  return el;
}

// ── Page ──────────────────────────────────────────────────────────────────────

function fill(body: HTMLElement) {
  const refreshButton = h("button", { class: "icon", onclick: () => void refresh() },
    svg(REFRESH_ICON, 14, { stroke: 2.4 }),
    reading ? t("Checking…") : t("Refresh"),
  );
  refreshButton.disabled = reading != null;
  body.append(h("div", { class: "head" },
    h("div", {},
      h("h1", { text: t("Connectors") }),
      h("p", { text: t("Connect Claude Code to the apps you use. Auth opens the service's sign-in page in your browser, and Claude Code keeps the sign-in for every project.") }),
    ),
    refreshButton,
  ));
  if (failure) body.append(h("div", { class: "notice err", text: failure }));
  for (const [group, label] of GROUPS) {
    const list = entries.filter((e) => e.group === group);
    if (!list.length) continue;
    body.append(h("section", { class: "group" },
      h("h3", { text: t(label) }),
      h("div", { class: "grid" }, ...list.map(card)),
    ));
  }
  body.append(h("div", {
    class: "hint",
    text: t("Services via claude.ai are signed in on claude.ai: Auth opens your connectors there, and Claude Code picks them up from the same account."),
  }));
}

export function connectorsPage(): HTMLElement {
  const body = h("div", { class: "page" });
  shown = {
    body,
    draw: () => {
      clear(body);
      fill(body);
    },
  };
  if (!entries.length) {
    void Bridge.mcpCatalog().then((catalog) => {
      if (entries.length) return;
      entries = catalog;
      redraw();
    });
  }
  if (Date.now() - lastRead > 10_000) void refresh();
  shown.draw();
  return body;
}
