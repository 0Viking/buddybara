// Settings → Connectors: the MCP servers Claude Code can sign in to (mcp.rs),
// three to a row, each with its mark, a red / green dot and Auth / Re-auth.
// Auth runs Claude Code's own sign-in, which opens the service's page in the
// browser; a claude.ai connector opens claude.ai's connector settings instead.
// What the page learnt is kept while the window is only hidden.

import { Bridge, type DirConnector, type McpEntry } from "../core/bridge";
import { N_, t } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { markTile, searchBox } from "./parts";

const GROUPS: [group: string, label: string][] = [
  ["work", N_("Work")],
  ["design", N_("Design & content")],
  ["dev", N_("Developers")],
  ["business", N_("Business")],
  ["everyday", N_("Everyday")],
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
const OUT_ICON = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";
/** Every connector of claude.ai's directory: thousands more than these. */
const MORE = "https://claude.ai/customize/connectors";

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
    markTile(entry.id, entry.name, state),
    h("div", { class: "conn-text" },
      h("div", { class: "conn-name", text: entry.name, title: entry.name }),
      h("div", { class: err ? "conn-sub err" : "conn-sub", text: sub, title: sub }),
    ),
  );
  if (entry.catalog) el.append(button(entry, busy));
  return el;
}

// ── Page ──────────────────────────────────────────────────────────────────────

/** What the search field holds, and claude.ai's connectors it matched that the list lacks. */
let query = "";
let found: DirConnector[] = [];
let searchFailure = "";
let searchRun = 0;

const moreButton = () =>
  h("button", { class: "icon", onclick: () => void Bridge.openUrl(MORE) }, svg(OUT_ICON, 13, { stroke: 2.2 }), t("Get more on claude.ai"));

const matches = (e: McpEntry) => !query || e.name.toLowerCase().includes(query.toLowerCase());

/** A connector of claude.ai the list lacks: its page there switches it on. */
function foundCard(f: DirConnector): HTMLElement {
  return h("div", { class: "conn" },
    markTile(f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), f.name),
    h("div", { class: "conn-text" },
      h("div", { class: "conn-name", text: f.name, title: f.name }),
      h("div", { class: "conn-sub", text: f.summary, title: f.summary }),
    ),
    h("button", { text: t("Open"), onclick: () => void Bridge.openUrl(f.page) }),
  );
}

function fill(content: HTMLElement) {
  if (failure) content.append(h("div", { class: "notice err", text: failure }));
  let any = false;
  for (const [group, label] of GROUPS) {
    const list = entries.filter((e) => e.group === group && matches(e));
    if (!list.length) continue;
    any = true;
    content.append(h("section", { class: "group" },
      h("h3", { text: t(label) }),
      h("div", { class: "grid" }, ...list.map(card)),
    ));
  }
  if (query && found.length) {
    content.append(h("section", { class: "group" },
      h("h3", { text: t("More on claude.ai") }),
      h("div", { class: "grid" }, ...found.map(foundCard)),
    ));
  } else if (query && searchFailure) {
    content.append(h("div", { class: "notice err", text: searchFailure }));
  } else if (query && !any) {
    content.append(h("div", { class: "hint", text: t("No results") }));
  }
  content.append(h("div", { class: "row" },
    h("div", {
      class: "hint",
      text: t("Services via claude.ai are signed in on claude.ai: Auth opens the service's page there, and Claude Code picks it up from the same account."),
    }),
    moreButton(),
  ));
}

/** The list follows the field at once; claude.ai's directory answers a moment later. */
function search(q: string) {
  query = q;
  found = [];
  searchFailure = "";
  redraw();
  if (!q) return;
  const run = ++searchRun;
  Bridge.connectorSearch(q)
    .then((list) => {
      if (run !== searchRun) return;
      found = list;
      redraw();
    })
    .catch((err) => {
      if (run !== searchRun) return;
      searchFailure = message(err);
      redraw();
    });
}

export function connectorsPage(): HTMLElement {
  const refreshButton = h("button", { class: "icon", onclick: () => void refresh() });
  const content = h("div", { class: "page-sections" });
  const body = h("div", { class: "page" },
    h("div", { class: "head" },
      h("div", {},
        h("h1", { text: t("Connectors") }),
        h("p", { text: t("Connect Claude Code to the apps you use. Auth opens the service's sign-in page in your browser, and Claude Code keeps the sign-in for every project.") }),
      ),
      h("div", { class: "head-actions" }, refreshButton, moreButton()),
    ),
    searchBox(t("Search connectors…"), query, search),
    content,
  );
  // Only the list redraws: the field keeps the focus while states come in.
  shown = {
    body,
    draw: () => {
      clear(refreshButton);
      refreshButton.append(svg(REFRESH_ICON, 14, { stroke: 2.4 }), reading ? t("Checking…") : t("Refresh"));
      refreshButton.disabled = reading != null;
      clear(content);
      fill(content);
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
