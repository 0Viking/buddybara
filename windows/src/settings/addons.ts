// Settings → Skills and Plugins, beyond the Directory (directory.ts): what is
// installed, first on each page, and adding more by hand (src-tauri/src/
// addons.rs) — a skill, a command, a plugin or a marketplace, from a file, a
// folder or a link, looked inside before anything is installed — or a new
// skill written here. Use opens the panel with a command typed.
//
// What the pages learnt, and a half-done Add or New skill, are kept while the
// window is only hidden.

import {
  Bridge,
  type AddonPreview, type AddonRun, type InstalledPlugin, type MarketPlugin, type MySkill, type NewSkill, type SlashCommand,
} from "../core/bridge";
import { skillName } from "../core/skills";
import { describe, fromPlugin, pluginName } from "../buddy/commands";
import { clear, h } from "../views/dom";
import { N_, t } from "../i18n/i18n";
import { markTile, toggle } from "./parts";

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

/** Appends what there is (a line left out is null). */
function append(el: HTMLElement, ...nodes: (HTMLElement | null)[]) {
  el.append(...nodes.filter((n): n is HTMLElement => n != null));
}

/** Asked of Claude Code again once this old: something installed elsewhere since. */
const FRESH_MS = 60_000;

/** Opens the panel with `/name` typed. */
function useButton(command: string): HTMLElement {
  const use = h("button", { class: "primary", text: t("Use"), title: t("Opens the panel with {command} typed, ready to send.", { command }) });
  use.addEventListener("click", () => void Bridge.panelUse(command).catch(() => {}));
  return use;
}

// ── What is installed ─────────────────────────────────────────────────────────

/**
 * Skills and commands as Claude Code lists them from the home folder (code.rs
 * commands: the user's own and plugins', no project's, no built-in ones), and
 * which of them are the user's own files.
 */
let skills: SlashCommand[] | null = null;
let mine: MySkill[] = [];
let skillsAt = 0;
let skillsError = "";
let askingSkills: Promise<void> | null = null;

let plugins: InstalledPlugin[] | null = null;
let pluginsAt = 0;
let pluginsError = "";
let askingPlugins: Promise<void> | null = null;
/** Plugins being turned on or off, updated or removed, and why the last try failed. */
const pluginBusy = new Set<string>();
const pluginErrors = new Map<string, string>();

/** The sections on screen, redrawn when what is installed changes. */
let redrawSkills: (() => void) | null = null;
let redrawPlugins: (() => void) | null = null;

/** Something was installed or removed: both lists are asked again. */
export function installedChanged() {
  skillsAt = 0;
  pluginsAt = 0;
  if (redrawSkills) void askSkills().then(() => redrawSkills?.());
  if (redrawPlugins) void askPlugins().then(() => redrawPlugins?.());
}

function askSkills(): Promise<void> {
  askingSkills ??= Promise.all([Bridge.codeCommands(null), Bridge.skillsMine().catch((): MySkill[] => [])])
    .then(([list, own]) => {
      skills = list.filter((c) => !c.builtin && !c.name.startsWith("_"));
      mine = own;
      skillsError = "";
    })
    .catch((err) => {
      skillsError = errorText(err);
      skills ??= [];
    })
    .finally(() => {
      skillsAt = Date.now();
      askingSkills = null;
    });
  return askingSkills;
}

function askPlugins(): Promise<void> {
  askingPlugins ??= Bridge.pluginsInstalled()
    .then((list) => {
      plugins = list;
      pluginsError = "";
    })
    .catch((err) => {
      pluginsError = errorText(err);
      plugins ??= [];
    })
    .finally(() => {
      pluginsAt = Date.now();
      askingPlugins = null;
    });
  return askingPlugins;
}

/** One installed command: what it does, Use, and for the user's own Edit and Remove. */
function skillCard(c: SlashCommand, own: MySkill | undefined): HTMLElement {
  const plugin = fromPlugin(c);
  const command = `/${c.name}`;
  const summary = describe(c);
  const actions: HTMLElement[] = [];
  if (own) {
    const edit = h("button", { text: t("Edit"), title: own.path });
    edit.addEventListener("click", () => void Bridge.openPath(own.path, null, null).catch(() => {}));
    const remove = h("button", { class: "danger", text: t("Remove"), title: t("It goes to the Recycle Bin.") });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await Bridge.skillRemove(own.name, own.kind);
        installedChanged();
      } catch (err) {
        remove.disabled = false;
        remove.title = errorText(err);
      }
    });
    actions.push(edit, remove);
  }
  return h("div", { class: "dir-card" },
    h("div", { class: "dir-top" },
      markTile(plugin ? c.plugin ?? c.name.split(":")[0] : c.name, plugin ? pluginName(c) : c.name),
      h("div", { class: "dir-title" },
        h("div", { class: "conn-name", text: command, title: command }),
        plugin || own ? h("div", { class: "conn-sub" }, h("span", { text: plugin ? pluginName(c) : own?.kind === "command" ? t("Your command") : t("Yours") })) : null,
      ),
    ),
    h("div", { class: "dir-summary", text: summary, title: summary }),
    h("div", { class: "dir-foot" },
      h("div", { class: "dir-parts" }, c.argumentHint ? h("span", { class: "dir-hint", text: c.argumentHint }) : null),
      ...actions,
      useButton(command),
    ),
  );
}

function sectionHead(title: HTMLElement, ...buttons: HTMLElement[]): HTMLElement {
  return h("div", { class: "group-head" }, title, h("div", { class: "group-actions" }, ...buttons));
}

function addButton(): HTMLElement {
  const b = h("button", { class: "primary", text: t("Add skill or plugin…") });
  b.addEventListener("click", () => openTool("add"));
  return b;
}

/** Settings → Skills: what is installed, the user's own first, then plugins'; while searching, those that match. */
export function installedSkills(query: string): HTMLElement {
  const head = h("h3", { text: t("Installed") });
  const create = h("button", { text: t("New skill") });
  create.addEventListener("click", () => openTool("new"));
  const grid = h("div", { class: "grid" });
  const el = h("section", { class: "group" }, sectionHead(head, create, addButton()), grid);
  const draw = () => {
    clear(grid);
    if (!skills) {
      grid.append(h("div", { class: "hint", text: t("Loading…") }));
      return;
    }
    if (skillsError && !skills.length) {
      grid.append(h("div", { class: "notice err", text: skillsError }));
      return;
    }
    const q = query.toLowerCase();
    const own = (c: SlashCommand) => mine.find((m) => m.name === c.name);
    const list = skills
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .sort((a, b) => Number(fromPlugin(a)) - Number(fromPlugin(b)) || a.name.localeCompare(b.name));
    head.textContent = `${t("Installed")} · ${list.length}`;
    if (!list.length) grid.append(h("div", { class: "hint", text: q ? t("No results") : t("Nothing here") }));
    for (const c of list) grid.append(skillCard(c, own(c)));
  };
  redrawSkills = () => {
    if (el.isConnected) draw();
  };
  draw();
  if (!skills || Date.now() - skillsAt > FRESH_MS) void askSkills().then(redrawSkills);
  return el;
}

/** Where an installed plugin came from, as its card says it. */
const SOURCE: Record<InstalledPlugin["source"], string> = {
  directory: N_("Directory"),
  official: N_("Official"),
  managed: N_("Managed by your organization"),
  yours: N_("Added by you"),
  other: "",
};

function pluginCard(p: InstalledPlugin, redraw: () => void): HTMLElement {
  // A plugin can be installed twice, for the user and for a project: one card each.
  const key = `${p.id}|${p.project}`;
  const busy = pluginBusy.has(key);
  const managed = p.source === "managed";
  const act = async (action: "enable" | "disable" | "update" | "uninstall") => {
    pluginBusy.add(key);
    pluginErrors.delete(key);
    redraw();
    try {
      await Bridge.pluginAction(p, action);
      pluginBusy.delete(key);
      installedChanged();
    } catch (err) {
      pluginBusy.delete(key);
      pluginErrors.set(key, errorText(err));
      redraw();
    }
  };
  const tags = h("div", { class: "dir-parts" });
  const tag = (n: number, label: string) => {
    if (n) tags.append(h("span", { text: `${t(label)} ${n}` }));
  };
  tag(p.commands.length, N_("Commands"));
  tag(p.servers, N_("Servers"));
  tag(p.hooks, N_("Hooks"));
  const controls: HTMLElement[] = [];
  if (managed) {
    controls.push(h("span", { class: "hint", text: t("Can't be changed here") }));
  } else {
    const sw = toggle(p.enabled, (on) => void act(on ? "enable" : "disable"));
    sw.title = p.enabled ? t("On: Claude Code uses it") : t("Off: Claude Code leaves it out");
    const update = h("button", { text: busy ? t("Working…") : t("Update") });
    update.addEventListener("click", () => void act("update"));
    const remove = h("button", { class: "danger", text: t("Uninstall") });
    remove.addEventListener("click", () => void act("uninstall"));
    for (const b of [sw, update, remove] as HTMLButtonElement[]) b.disabled = busy;
    controls.push(sw, update, remove);
  }
  const source = SOURCE[p.source] ? t(SOURCE[p.source]) : p.marketplace;
  const project = p.project.split(/[\\/]/).filter(Boolean).pop();
  const where = project ? t("Only in {project}", { project }) : "";
  const error = pluginErrors.get(key);
  return h("div", { class: p.enabled ? "dir-card ok" : "dir-card off" },
    h("div", { class: "dir-top" },
      markTile(p.name, p.name, p.enabled ? "on" : undefined),
      h("div", { class: "dir-title" },
        h("div", { class: "conn-name", text: p.name, title: p.id }),
        h("div", { class: "conn-sub", title: p.project || undefined },
          h("span", { text: [source, p.version, where].filter(Boolean).join(" · ") })),
      ),
    ),
    h("div", { class: "dir-summary", text: p.description, title: p.description }),
    error ? h("div", { class: "dir-error", text: error, title: error }) : null,
    h("div", { class: "dir-foot wrap" }, tags, h("div", { class: "dir-controls" }, ...controls)),
  );
}

/** Settings → Plugins: what Claude Code has installed, each to turn off, update or uninstall. */
export function installedPlugins(query: string): HTMLElement {
  const head = h("h3", { text: t("Installed") });
  const grid = h("div", { class: "grid" });
  const el = h("section", { class: "group" }, sectionHead(head, addButton()), grid);
  const draw = () => {
    clear(grid);
    if (!plugins) {
      grid.append(h("div", { class: "hint", text: t("Loading…") }));
      return;
    }
    if (pluginsError && !plugins.length) {
      grid.append(h("div", { class: "notice err", text: pluginsError }));
      return;
    }
    const q = query.toLowerCase();
    const list = plugins.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    head.textContent = `${t("Installed")} · ${list.length}`;
    if (!list.length) grid.append(h("div", { class: "hint", text: q ? t("No results") : t("Nothing here") }));
    for (const p of list) grid.append(pluginCard(p, draw));
  };
  redrawPlugins = () => {
    if (el.isConnected) draw();
  };
  draw();
  if (!plugins || Date.now() - pluginsAt > FRESH_MS) void askPlugins().then(redrawPlugins);
  return el;
}

// ── Add, and New skill ────────────────────────────────────────────────────────

type Step =
  | { at: "choose" }
  | { at: "busy"; text: string }
  | { at: "preview"; preview: AddonPreview }
  /** `commands`: what it brought; `edit`: a new skill's SKILL.md. */
  | { at: "done"; commands: string[]; edit?: string }
  | { at: "error"; text: string };

let tool: "closed" | "add" | "new" = "closed";
let step: Step = { at: "choose" };
/** The tick that lets what is looked at run programs. */
let trust = false;
/** A marketplace's plugins: being installed, ticked, why one failed, what one brought. */
const marketBusy = new Set<string>();
const marketTrust = new Set<string>();
const marketErrors = new Map<string, string>();
const marketDone = new Map<string, string[]>();
let draft: NewSkill = { name: "", description: "", hint: "", instructions: "", auto: true };
let draftError = "";
let creating = false;
/** A file is dragged over the window. */
let dragging = false;
/** The area on screen. */
let area: HTMLElement | null = null;

function redrawTool() {
  if (area?.isConnected) drawTool(area);
}

function openTool(which: "add" | "new") {
  tool = which;
  if (step.at !== "busy") setStep({ at: "choose" });
  draftError = "";
  redrawTool();
  area?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function closeTool() {
  tool = "closed";
  setStep({ at: "choose" });
  redrawTool();
}

function setStep(next: Step) {
  step = next;
  trust = false;
  marketBusy.clear();
  marketTrust.clear();
  marketErrors.clear();
  marketDone.clear();
}

/** Where Add and New skill show, above what is installed (both pages share it). */
export function toolArea(): HTMLElement {
  area = h("div", { class: "addon-area" });
  drawTool(area);
  return area;
}

/** A file is dragged over Settings, or not any more: Add opens to take it. */
export function addonsDragging(on: boolean) {
  dragging = on;
  if (on && tool !== "add" && step.at !== "busy") openTool("add");
  else redrawTool();
}

/** Something dropped on Settings: looked inside at once. */
export function addonsDropped(path: string) {
  dragging = false;
  tool = "add";
  void inspect(() => Bridge.addonInspect(path));
}

async function inspect(look: () => Promise<AddonPreview>, busyText = t("Looking inside…")) {
  setStep({ at: "busy", text: busyText });
  redrawTool();
  try {
    setStep({ at: "preview", preview: await look() });
  } catch (err) {
    setStep({ at: "error", text: errorText(err) });
  }
  redrawTool();
}

async function pick(folder: boolean) {
  const path = await Bridge.addonPick(folder).catch((err) => {
    setStep({ at: "error", text: errorText(err) });
    redrawTool();
    return null;
  });
  if (path) await inspect(() => Bridge.addonInspect(path));
}

function closeButton(): HTMLElement {
  const x = h("button", { class: "addon-x", text: "×", title: t("Close") });
  x.addEventListener("click", closeTool);
  return x;
}

function drawTool(el: HTMLElement) {
  clear(el);
  el.style.display = tool === "closed" ? "none" : "";
  if (tool === "closed") return;
  const card = h("div", { class: "card addon-card" });
  el.append(card);
  if (tool === "new") return drawNew(card);
  card.append(h("h2", {}, h("span", { class: "grow", text: t("Add a skill or plugin") }), closeButton()));
  const body = h("div", { class: "stack" });
  card.append(body);
  switch (step.at) {
    case "choose":
      return chooseView(body);
    case "busy":
      body.append(h("div", { class: "hint addon-busy", text: step.text }));
      return;
    case "preview":
      return previewView(body, step.preview);
    case "done":
      return doneView(body, step.commands, step.edit);
    case "error": {
      const back = h("button", { text: t("Back") });
      back.addEventListener("click", () => {
        setStep({ at: "choose" });
        redrawTool();
      });
      body.append(h("div", { class: "notice err addon-pre", text: step.text }), h("div", { class: "row" }, back));
    }
  }
}

function chooseView(body: HTMLElement) {
  const file = h("button", { text: t("Choose a file…") });
  file.addEventListener("click", () => void pick(false));
  const folder = h("button", { text: t("Choose a folder…") });
  folder.addEventListener("click", () => void pick(true));
  const link = h("input", {
    type: "text", spellcheck: "false", autocomplete: "off",
    placeholder: t("Marketplace link: https://… or owner/repo"), "aria-label": t("Marketplace link"),
  }) as HTMLInputElement;
  const add = h("button", { text: t("Add marketplace") });
  const go = () => {
    const value = link.value.trim();
    if (value) void inspect(() => Bridge.addonAddMarketplace(value), t("Adding the marketplace…"));
  };
  add.addEventListener("click", go);
  link.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  body.append(
    h("div", { class: dragging ? "addon-drop on" : "addon-drop" },
      h("b", { text: t("Drop a file or a folder here") }),
      h("span", { text: t("A skill (a .zip, a .skill, or a folder with SKILL.md), a command (.md), a plugin or a marketplace.") }),
      h("div", { class: "row" }, file, folder),
    ),
    h("div", { class: "row addon-link" }, link, add),
    h("div", { class: "hint", text: t("A skill only holds instructions. A plugin can also run programs: Buddybara shows which before you install it.") }),
  );
}

const KIND: Record<AddonPreview["kind"], string> = {
  skill: N_("Skill"),
  skills: N_("Skills"),
  command: N_("Command"),
  plugin: N_("Plugin"),
  marketplace: N_("Marketplace"),
};

/** `/a`, `/b`, as chips. */
function commandChips(commands: string[]): HTMLElement | null {
  if (!commands.length) return null;
  return h("div", { class: "addon-row" },
    h("span", { class: "addon-label", text: t("Adds") }),
    h("div", { class: "addon-chips" }, ...commands.slice(0, 24).map((c) => h("code", { text: `/${c}` }))),
  );
}

function runLine(r: AddonRun): HTMLElement {
  const label = r.kind === "hook" ? t("Hook {event}", { event: r.name })
    : r.kind === "server" ? t("Server {name}", { name: r.name })
    : r.kind === "remote" ? t("Connects to {name}", { name: r.name })
    : t("Language server {name}", { name: r.name });
  return h("li", {}, h("span", { text: `${label}: ` }), h("code", { text: r.detail, dir: "ltr" }));
}

/** What it runs, and the tick that allows it. `unknown`: it can't be looked inside first. */
function runsView(runs: AddonRun[], unknown: boolean, ticked: boolean, onTick: (on: boolean) => void): HTMLElement[] {
  if (!runs.length && !unknown) return [];
  const box = h("input", { type: "checkbox" }) as HTMLInputElement;
  box.checked = ticked;
  box.addEventListener("change", () => onTick(box.checked));
  const notice = h("div", { class: "notice warn" },
    h("div", { text: unknown
      ? t("Buddybara can't look inside this one before it is installed: it comes from its own repository, and may run programs on this computer.")
      : t("It runs programs on this computer, by itself:") }),
    runs.length ? h("ul", { class: "addon-runs" }, ...runs.map(runLine)) : null,
  );
  return [notice, h("label", { class: "addon-tick" }, box, h("span", { text: t("I trust it: let it run these.") }))];
}

function previewView(body: HTMLElement, p: AddonPreview) {
  append(body,
    h("div", { class: "addon-title" },
      h("span", { class: "addon-kind", text: p.kind === "skills" ? t("{n} skills", { n: p.commands.length || p.name.split(", ").length }) : t(KIND[p.kind]) }),
      h("b", { text: p.name, title: p.name })),
    p.description ? h("div", { class: "addon-about", text: p.description }) : null,
  );
  if (p.kind === "marketplace") return marketView(body, p);
  const chips = commandChips(p.commands);
  if (chips) body.append(chips);
  else if (p.kind !== "plugin") body.append(h("div", { class: "hint", text: t("It doesn't add a command: Claude uses it by itself when it fits.") }));
  if (p.replaces) body.append(h("div", { class: "notice warn", text: t("You already have one with this name: installing replaces it, and the old one goes to the Recycle Bin.") }));
  if (p.problem) body.append(h("div", { class: "notice err addon-pre" }, h("div", { text: t("Claude Code's check found a problem, so it can't be installed:") }), h("div", { text: p.problem })));
  body.append(...runsView(p.runs, false, trust, (on) => {
    trust = on;
    redrawTool();
  }));
  const install = h("button", { class: "primary", text: p.replaces ? t("Replace") : t("Install") });
  install.disabled = p.problem != null || (p.runs.length > 0 && !trust);
  install.addEventListener("click", async () => {
    // Read before the next step clears it.
    const trusted = trust;
    setStep({ at: "busy", text: t("Installing…") });
    redrawTool();
    try {
      const commands = await Bridge.addonInstall(p.id, trusted);
      setStep({ at: "done", commands });
      installedChanged();
    } catch (err) {
      setStep({ at: "error", text: errorText(err) });
    }
    redrawTool();
  });
  const cancel = h("button", { text: t("Cancel") });
  cancel.addEventListener("click", () => {
    setStep({ at: "choose" });
    redrawTool();
  });
  body.append(h("div", { class: "row" }, install, cancel));
}

/** A marketplace's plugins, each with its own Install. */
function marketView(body: HTMLElement, p: AddonPreview) {
  if (p.problem) body.append(h("div", { class: "notice err addon-pre" }, h("div", { text: t("Claude Code's check found a problem, so it can't be installed:") }), h("div", { text: p.problem })));
  if (!p.plugins.length) body.append(h("div", { class: "hint", text: t("It offers no plugins.") }));
  for (const m of p.plugins) body.append(marketPluginRow(p, m));
  const done = h("button", { text: t("Done") });
  done.addEventListener("click", closeTool);
  body.append(h("div", { class: "row" }, done));
}

function marketPluginRow(p: AddonPreview, m: MarketPlugin): HTMLElement {
  const brought = marketDone.get(m.name);
  const installed = m.installed || brought != null;
  const row = h("div", { class: "addon-plugin" },
    h("div", { class: "addon-title" }, h("b", { text: m.name }), installed ? h("span", { class: "addon-kind ok", text: t("Installed") }) : null),
    m.description ? h("div", { class: "addon-about", text: m.description }) : null,
  );
  const chips = commandChips(brought ?? m.commands);
  if (chips) row.append(chips);
  if (brought) row.append(h("div", { class: "addon-chips" }, ...brought.slice(0, 6).map((c) => useButton(`/${c}`))));
  if (installed) return row;
  const ticked = marketTrust.has(m.name);
  row.append(...runsView(m.runs, m.unknown, ticked, (on) => {
    if (on) marketTrust.add(m.name);
    else marketTrust.delete(m.name);
    redrawTool();
  }));
  const error = marketErrors.get(m.name);
  if (error) row.append(h("div", { class: "notice err addon-pre", text: error }));
  const busy = marketBusy.has(m.name);
  const install = h("button", { class: "primary", text: busy ? t("Installing…") : t("Install") });
  install.disabled = busy || p.problem != null || ((m.runs.length > 0 || m.unknown) && !ticked);
  install.addEventListener("click", async () => {
    marketBusy.add(m.name);
    marketErrors.delete(m.name);
    redrawTool();
    try {
      marketDone.set(m.name, await Bridge.addonInstallFrom(p.id, m.name, ticked));
      installedChanged();
    } catch (err) {
      marketErrors.set(m.name, errorText(err));
    }
    marketBusy.delete(m.name);
    redrawTool();
  });
  row.append(h("div", { class: "row" }, install));
  return row;
}

function doneView(body: HTMLElement, commands: string[], edit?: string) {
  body.append(h("div", { class: "notice ok", text: t("Installed.") }));
  if (commands.length) {
    body.append(h("div", { class: "hint", text: t("Type it in the panel, or press Use:") }));
    for (const c of commands.slice(0, 12)) {
      body.append(h("div", { class: "addon-row" }, h("code", { text: `/${c}` }), useButton(`/${c}`)));
    }
  }
  body.append(h("div", { class: "hint", text: t("The panel's next message has it. A conversation open in VS Code or a terminal gets it when it starts again.") }));
  const again = h("button", { text: t("Add another") });
  again.addEventListener("click", () => {
    tool = "add";
    setStep({ at: "choose" });
    redrawTool();
  });
  const close = h("button", { text: t("Close") });
  close.addEventListener("click", closeTool);
  const buttons = h("div", { class: "row" }, again, close);
  if (edit) {
    const open = h("button", { text: t("Edit"), title: edit });
    open.addEventListener("click", () => void Bridge.openPath(edit, null, null).catch(() => {}));
    buttons.prepend(open);
  }
  body.append(buttons);
}

/** One field of New skill: its label, the input, a line under it. */
function field(label: string, input: HTMLElement, hint?: HTMLElement | null): HTMLElement {
  return h("label", { class: "addon-field" }, h("span", { class: "addon-label", text: label }), input, hint ?? null);
}

function drawNew(card: HTMLElement) {
  card.append(h("h2", {}, h("span", { class: "grow", text: t("New skill") }), closeButton()));
  const body = h("div", { class: "stack" });
  card.append(body);
  if (step.at === "done") return doneView(body, step.commands, step.edit);
  const text = (key: "name" | "description" | "hint", placeholder: string) => {
    const input = h("input", { type: "text", spellcheck: key === "description" ? "true" : "false", autocomplete: "off", placeholder }) as HTMLInputElement;
    input.value = draft[key];
    input.addEventListener("input", () => {
      draft = { ...draft, [key]: input.value };
      if (key === "name") showName();
    });
    return input;
  };
  const named = h("div", { class: "hint" });
  const showName = () => {
    const name = skillName(draft.name);
    named.textContent = name ? t("Type /{name} in the panel to use it.", { name }) : t("Letters, digits and dashes.");
  };
  showName();
  const instructions = h("textarea", { rows: "9", spellcheck: "true", placeholder: t("What Claude should do, step by step, as you'd explain it to a colleague.") }) as HTMLTextAreaElement;
  instructions.value = draft.instructions;
  instructions.addEventListener("input", () => (draft = { ...draft, instructions: instructions.value }));
  const auto = h("input", { type: "checkbox" }) as HTMLInputElement;
  auto.checked = draft.auto;
  auto.addEventListener("change", () => (draft = { ...draft, auto: auto.checked }));
  const create = h("button", { class: "primary", text: creating ? t("Creating…") : t("Create") });
  create.disabled = creating;
  create.addEventListener("click", async () => {
    creating = true;
    draftError = "";
    redrawTool();
    try {
      const name = await Bridge.skillCreate(draft);
      const own = await Bridge.skillsMine().catch((): MySkill[] => []);
      draft = { name: "", description: "", hint: "", instructions: "", auto: true };
      setStep({ at: "done", commands: [name], edit: own.find((m) => m.name === name)?.path });
      installedChanged();
    } catch (err) {
      draftError = errorText(err);
    }
    creating = false;
    redrawTool();
  });
  const cancel = h("button", { text: t("Cancel") });
  cancel.addEventListener("click", closeTool);
  append(body,
    h("div", { class: "hint", text: t("A skill is instructions Claude follows: once created, it is a /command in the panel and in Claude Code.") }),
    field(t("Name"), text("name", "daily-standup"), named),
    field(t("What it does"), text("description", t("Drafts my standup from yesterday's work")),
      h("div", { class: "hint", text: t("Shown in the / menu. Claude also reads it to know when the skill fits.") })),
    field(t("What you type after it (optional)"), text("hint", "[team]")),
    field(t("Instructions"), instructions),
    h("label", { class: "addon-tick" }, auto, h("span", { text: t("Claude may also use it by itself when it fits") })),
    draftError ? h("div", { class: "notice err", text: draftError }) : null,
    h("div", { class: "row" }, create, cancel),
  );
}
