// Settings → Skills and Plugins: the most used of Anthropic's Directory (what
// claude.ai/customize shows), fifteen per department (directory.rs), each with
// Install / Uninstall for Claude Code, and Get more for the rest on claude.ai.
// Both start with what is installed and Add (addons.ts).

import { Bridge, type DirCategory, type DirEntry, type DirKind } from "../core/bridge";
import { clear, h, svg } from "../views/dom";
import { N_, t } from "../i18n/i18n";
import { installedChanged, installedPlugins, installedSkills, toolArea } from "./addons";
import { markTile, searchBox } from "./parts";

/** The Directory's departments (its `work_department`), as claude.ai names them. */
const DEPARTMENT: Record<string, string> = {
  engineering: N_("Engineering"),
  product: N_("Product"),
  design: N_("Design"),
  data: N_("Data"),
  marketing: N_("Marketing"),
  sales: N_("Sales"),
  "customer-support": N_("Customer support"),
  finance: N_("Finance"),
  legal: N_("Legal"),
  hr: N_("HR"),
  operations: N_("Operations"),
  "it-security": N_("IT & security"),
};

const PAGE: Record<DirKind, { title: string; intro: string; more: string; search: string }> = {
  skills: {
    title: N_("Skills"),
    search: N_("Search skills…"),
    intro: N_("Know-how Claude Code picks up when a task needs it: the most used skills of Anthropic's Directory, by department. An installed skill starts with your next Claude Code session."),
    more: "https://claude.ai/customize/skills",
  },
  plugins: {
    title: N_("Plugins"),
    search: N_("Search plugins…"),
    intro: N_("Commands, agents, hooks and connections that extend Claude Code: the most used plugins of Anthropic's Directory, by department. Plugins can run code on this computer, so install the ones you trust. They start with your next Claude Code session."),
    more: "https://claude.ai/customize/plugins",
  },
};

const OUT_ICON = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";

/** What the pages learnt, kept while the window is only hidden. */
const categories = new Map<DirKind, DirCategory[]>();
const sections = new Map<string, DirEntry[]>();
/** The entry being installed or removed, and why the last attempt on one failed. */
const busy = new Set<string>();
const errors = new Map<string, string>();
/** What each page's search field holds, and what the Directory answered for it. */
const queries = new Map<DirKind, string>();
const results = new Map<string, DirEntry[]>();

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

function getMore(url: string, label: string): HTMLElement {
  return h("button", { class: "icon", onclick: () => void Bridge.openUrl(url) }, svg(OUT_ICON, 13, { stroke: 2.2 }), label);
}

/** What an entry brings, as small tags. */
function parts(e: DirEntry): HTMLElement {
  const tags = h("div", { class: "dir-parts" });
  const add = (n: number, label: string) => {
    if (n) tags.append(h("span", { text: `${t(label)} ${n}` }));
  };
  add(e.skills, N_("Skills"));
  add(e.commands, N_("Commands"));
  add(e.agents, N_("Agents"));
  add(e.hooks, N_("Hooks"));
  add(e.servers, N_("Servers"));
  return tags;
}

function card(e: DirEntry, redraw: () => void): HTMLElement {
  const working = busy.has(e.id);
  const button = h("button", {
    class: e.installed ? "danger" : "primary",
    text: working ? (e.installed ? t("Removing…") : t("Installing…")) : e.installed ? t("Uninstall") : t("Install"),
  });
  button.disabled = working || !e.installable;
  if (!e.installable) button.title = t("Claude Code doesn't know this one yet: open /plugin in Claude Code once, then try again.");
  button.addEventListener("click", async () => {
    busy.add(e.id);
    errors.delete(e.id);
    redraw();
    try {
      await (e.installed ? Bridge.pluginUninstall(e.id) : Bridge.pluginInstall(e.id));
      e.installed = !e.installed;
      installedChanged();
    } catch (err) {
      errors.set(e.id, errorText(err));
    }
    busy.delete(e.id);
    redraw();
  });
  const tier = e.tier === "anthropic" ? "Anthropic" : e.tier === "partner" ? t("Verified") : t("Community");
  const error = errors.get(e.id);
  return h("div", { class: e.installed ? "dir-card ok" : "dir-card" },
    h("div", { class: "dir-top" },
      markTile(e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), e.name, e.installed ? "on" : undefined),
      h("div", { class: "dir-title" },
        h("div", { class: "conn-name", text: e.name, title: e.name }),
        h("div", { class: "conn-sub" },
          e.publisher ? h("span", { text: e.publisher }) : null,
          h("span", { class: `dir-tier ${e.tier}`, text: tier }),
        ),
      ),
    ),
    h("div", { class: "dir-summary", text: e.summary, title: e.summary }),
    error ? h("div", { class: "dir-error", text: error, title: error }) : null,
    h("div", { class: "dir-foot wrap" }, parts(e), button),
  );
}

function section(kind: DirKind, category: DirCategory): HTMLElement {
  const grid = h("div", { class: "grid" }, h("div", { class: "hint", text: t("Loading…") }));
  const key = `${kind}/${category.id}`;
  const draw = () => {
    const list = sections.get(key);
    if (!list) return;
    clear(grid);
    if (!list.length) grid.append(h("div", { class: "hint", text: t("Nothing here") }));
    for (const e of list) grid.append(card(e, draw));
  };
  if (sections.has(key)) draw();
  else {
    Bridge.directorySection(kind, category.id)
      .then((list) => {
        sections.set(key, list);
        draw();
      })
      .catch((err) => {
        clear(grid);
        grid.append(h("div", { class: "notice err", text: errorText(err) }));
      });
  }
  return h("section", { class: "group" },
    h("div", { class: "group-head" },
      h("h3", { text: `${t(DEPARTMENT[category.id] ?? category.id)} · ${category.count}` }),
      getMore(PAGE[kind].more, t("Get more")),
    ),
    grid,
  );
}

/** The whole Directory's answer to `query`, best match first. */
function searchResults(kind: DirKind, query: string, into: HTMLElement) {
  const key = `${kind}\n${query}`;
  const head = h("h3", { text: t("Searching…") });
  const grid = h("div", { class: "grid" });
  into.append(h("section", { class: "group" }, h("div", { class: "group-head" }, head, getMore(PAGE[kind].more, t("Get more"))), grid));
  const draw = () => {
    const list = results.get(key) ?? [];
    head.textContent = `${t("Results")} · ${list.length}`;
    clear(grid);
    if (!list.length) grid.append(h("div", { class: "hint", text: t("No results") }));
    for (const e of list) grid.append(card(e, draw));
  };
  if (results.has(key)) return draw();
  Bridge.directorySearch(kind, query)
    .then((list) => {
      results.set(key, list);
      if (queries.get(kind) === query) draw();
    })
    .catch((err) => {
      clear(grid);
      grid.append(h("div", { class: "notice err", text: errorText(err) }));
    });
}

export function directoryPage(kind: DirKind): HTMLElement {
  const def = PAGE[kind];
  const mine = h("div", { class: "page-sections" });
  const list = h("div", { class: "page-sections" });
  const fill = (cats: DirCategory[]) => {
    if (queries.get(kind)) return;
    clear(list);
    for (const c of cats) list.append(section(kind, c));
  };
  // The departments, or the results of what the search field holds.
  const show = (query: string) => {
    queries.set(kind, query);
    mine.replaceChildren(toolArea(), kind === "skills" ? installedSkills(query) : installedPlugins(query));
    clear(list);
    if (query) return searchResults(kind, query, list);
    const known = categories.get(kind);
    if (known) return fill(known);
    list.append(h("div", { class: "hint", text: t("Loading…") }));
    Bridge.directoryCategories(kind)
      .then((cats) => {
        categories.set(kind, cats);
        fill(cats);
      })
      .catch((err) => {
        clear(list);
        list.append(h("div", { class: "notice err", text: errorText(err) }));
      });
  };
  const body = h("div", { class: "page" },
    h("div", { class: "head" },
      h("div", {}, h("h1", { text: t(def.title) }), h("p", { text: t(def.intro) })),
      getMore(def.more, t("Get more on claude.ai")),
    ),
    searchBox(t(def.search), queries.get(kind) ?? "", show),
    mine,
    list,
  );
  show(queries.get(kind) ?? "");
  return body;
}
