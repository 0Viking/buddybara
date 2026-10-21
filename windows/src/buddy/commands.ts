// The `/` menu of the panel's field (buddy.ts), kept free of the DOM: what it
// offers, what matches what is typed, and the commands the panel answers
// itself. Tested on their own.
//
// The list is Claude Code's own (code.rs `commands`): built-in commands, the
// user's and the project's skills, and plugins'. Nothing here names a skill
// or a plugin: whatever is installed shows.

import type { SlashCommand } from "../core/bridge";
import type { Line } from "./run";
import { N_, t } from "../i18n/i18n";

/** "plugin": a plugin's (`plugin:name`). The panel's own go with the built-in ones. */
export type CommandGroup = "builtin" | "skill" | "plugin";

export interface MenuCommand {
  name: string;
  /** One line: what it does. */
  description: string;
  /** What it takes after its name (`<instructions>`, `[days]`), or "". */
  hint: string;
  aliases: string[];
  group: CommandGroup;
}

/** The menu's sections, in this order. */
export const GROUPS: CommandGroup[] = ["builtin", "skill", "plugin"];

/**
 * The commands the panel answers itself (buddy.ts runCommand), in the menu
 * with Claude Code's. Those Claude Code has too, or only has in its terminal,
 * become what the panel already does: Settings pages, the usage bars, the
 * list of conversations. `page`: the Settings page it opens (settings/main.ts
 * PageId).
 */
interface Own {
  name: string;
  about?: string;
  hint?: string;
  aliases?: string[];
  page?: string;
}

const OWN: Own[] = [
  { name: "btw", about: N_("Ask a side question; the conversation itself stays as it is.") },
  { name: "plan", about: N_("Switch to Plan mode; anything after it goes as your request."), hint: "[request]" },
  { name: "usage", about: N_("Show your plan's limits, and this conversation's cost and time."), aliases: ["cost", "stats"] },
  { name: "resume", about: N_("Back to this project's conversations, or open the one named after it."), hint: "[name]", aliases: ["continue"] },
  { name: "copy", about: N_("Copy Claude's last answer, or the Nth from the end."), hint: "[N]" },
  { name: "memory", about: N_("Open the CLAUDE.md files in your editor.") },
  { name: "login", about: N_("Sign in to your Claude account, in your browser.") },
  { name: "logout", about: N_("Sign out of your Claude account.") },
  { name: "mcp", page: "connectors" },
  { name: "plugin", aliases: ["plugins"], page: "plugins" },
  { name: "skills", page: "skills" },
  { name: "hooks", page: "claude" },
  { name: "status", page: "claude" },
];

/** The Settings pages the commands open, by name. */
const PAGE_NAMES: Record<string, string> = {
  connectors: N_("Connectors"),
  plugins: N_("Plugins"),
  skills: N_("Skills"),
};

function pageName(page: string): string {
  return page === "claude" ? "Claude Code" : t(PAGE_NAMES[page]);
}

/**
 * Every name the panel answers, aliases included, to the command it is. Also
 * Claude Code's /clear (headless, it would carry on in another session under
 * the panel's feet), /model and /effort (the panel picks those for each run).
 */
const ACTIONS: Record<string, string> = { clear: "clear", new: "clear", reset: "clear", model: "model", effort: "effort" };
for (const o of OWN) for (const name of [o.name, ...(o.aliases ?? [])]) ACTIONS[name] = o.name;

/**
 * Claude Code's commands that do nothing useful from the panel: its
 * terminal's own (colours, the focus view, a heap dump), those it refuses
 * headless (fast mode, the removed agents wizard), the reloads every run does
 * anyway, and its servers' handoffs.
 */
const HIDDEN = new Set([
  "color", "focus", "heapdump", "fast", "agents", "reload-plugins", "reload-skills", "workflow-launch-exec",
]);

/** A description on one line, without what the name already says. */
export function describe(c: SlashCommand): string {
  let text = c.description.replace(/\s+/g, " ").trim();
  // A plugin's starts with the plugin's name in brackets: the name has it.
  if (c.name.includes(":")) text = text.replace(/^\([^)]*\)\s*/, "");
  // A command file's ends with where it is from.
  return text.replace(/\s*\((user|project)\)$/, "");
}

/** A plugin's name as its own commands give it (`(Atlassian MCP) …`), else its part of the name. */
export function pluginName(c: SlashCommand): string {
  return /^\(([^)]+)\)/.exec(c.description.trim())?.[1] ?? c.name.split(":")[0];
}

/**
 * The menu's commands: the panel's own (in the interface's language), then
 * Claude Code's, less those of no use here, those the panel answers, and its
 * internal ones.
 */
export function menuCommands(list: SlashCommand[]): MenuCommand[] {
  const out: MenuCommand[] = OWN.map((o) => ({
    name: o.name,
    description: o.page ? t("Opens Settings → {page}.", { page: pageName(o.page) }) : t(o.about ?? ""),
    hint: o.hint ?? "",
    aliases: o.aliases ?? [],
    group: "builtin",
  }));
  for (const c of list) {
    if (OWN.some((o) => o.name === c.name || o.aliases?.includes(c.name))) continue;
    if (c.name.startsWith("_") || HIDDEN.has(c.name)) continue;
    out.push({
      name: c.name,
      description: describe(c),
      hint: c.argumentHint,
      aliases: c.aliases,
      group: c.builtin ? "builtin" : c.name.includes(":") ? "plugin" : "skill",
    });
  }
  return out;
}

/**
 * What follows the slash while the field's first word is a command being
 * typed (`/comp`, the caret in it), or null: the menu is for the start of a
 * message only, and goes once a space follows the command.
 */
export function slashQuery(text: string, caret: number): string | null {
  const typed = /^\/(\S*)$/.exec(text.slice(0, caret));
  return typed ? typed[1] : null;
}

/** How well `c` matches `query`, best 0; -1 when it doesn't. */
function score(c: MenuCommand, query: string): number {
  if (!query) return 0;
  const name = c.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  // A plugin's by its own part (`/standup` finds `/notes:standup`), or an alias.
  const own = name.slice(name.indexOf(":") + 1);
  if (own.startsWith(query) || c.aliases.some((a) => a.toLowerCase().startsWith(query))) return 1;
  return name.includes(query) ? 2 : -1;
}

/** The commands `query` matches, section by section, the best matches first in each. */
export function matchCommands(all: MenuCommand[], query: string): MenuCommand[] {
  const q = query.toLowerCase();
  return all
    .map((c) => ({ c, score: score(c, q) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => GROUPS.indexOf(a.c.group) - GROUPS.indexOf(b.c.group) || a.score - b.score || a.c.name.localeCompare(b.c.name))
    .map((m) => m.c);
}

/** The field's text with its first word made the command picked, and a space to type after. */
export function withCommand(text: string, name: string): string {
  return `/${name} ${text.replace(/^\/\S*\s*/, "")}`;
}

/**
 * The argument hint to grey after a command typed alone with its space
 * (`/compact `), until something follows it; "" for none.
 */
export function pendingHint(text: string, all: MenuCommand[]): string {
  const typed = /^\/(\S+) $/.exec(text)?.[1].toLowerCase();
  if (!typed) return "";
  return all.find((c) => c.name.toLowerCase() === typed || c.aliases.some((a) => a.toLowerCase() === typed))?.hint ?? "";
}

/** A command the panel answers itself: its name (aliases resolved), what follows it, the Settings page it opens. */
export interface PanelCommand {
  name: string;
  arg: string;
  page?: string;
}

/** The command the panel answers itself in `text`, or null: it goes to Claude Code. */
export function panelCommand(text: string): PanelCommand | null {
  const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = typed ? ACTIONS[typed[1].toLowerCase()] : undefined;
  if (!typed || !name) return null;
  const page = OWN.find((o) => o.name === name)?.page;
  return page ? { name, arg: (typed[2] ?? "").trim(), page } : { name, arg: (typed[2] ?? "").trim() };
}

/** The model `/model <name>` asks for: its id, null for Claude Code's default, undefined when none matches. */
export function pickModel(arg: string, models: { id: string; name: string }[]): string | null | undefined {
  const q = arg.trim().toLowerCase();
  if (q === "default") return null;
  return models.find((m) => {
    const name = m.name.toLowerCase();
    return m.id === q || name === q || name.split(" ")[0] === q;
  })?.id;
}

/** The effort `/effort <level>` asks for: one of `levels`, null for Claude Code's own, undefined when none matches. */
export function pickEffort(arg: string, levels: string[]): string | null | undefined {
  const q = arg.trim().toLowerCase();
  if (q === "auto" || q === "default") return null;
  return levels.includes(q) ? q : undefined;
}

/** The session `/resume <name>` means: by its id (or its start), else the newest whose title has the words. */
export function findSession<S extends { id: string; title: string }>(sessions: S[], query: string): S | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const byId = /^[0-9a-f-]{6,}$/.test(q) ? sessions.find((s) => s.id.toLowerCase().startsWith(q)) : undefined;
  return byId ?? sessions.find((s) => s.title.toLowerCase().includes(q));
}

/** Claude's answer `/copy [N]` means: the Nth from the end (the last without N), or null when there are fewer. */
export function answerToCopy(lines: Line[], arg: string): string | null {
  let left = /^\d+$/.test(arg.trim()) ? Math.max(1, Number(arg)) : 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === "assistant" && --left === 0) return lines[i].text;
  }
  return null;
}
