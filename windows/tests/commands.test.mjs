// The panel's `/` menu (src/buddy/commands.ts): what Claude Code lists
// (src-tauri/src/code.rs `commands`) turns into the rows it offers, and the
// commands the panel answers itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerToCopy, describe, findSession, matchCommands, menuCommands, panelCommand, pendingHint, pickEffort, pickModel,
  pluginName, slashQuery, withCommand,
} from "../src/buddy/commands.ts";

const listed = [
  { name: "notes", description: "Write today's note. Use when the user asks for a note. (user)", argumentHint: "[day]", aliases: [], builtin: false },
  { name: "journal:standup", description: "(Journal) Draft a standup from yesterday's work", argumentHint: "", aliases: [] , builtin: false },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", aliases: [], builtin: true },
  { name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
  { name: "context", description: "Show current context usage", argumentHint: "", aliases: [], builtin: true },
  { name: "usage", description: "Show the total cost", argumentHint: "", aliases: ["cost", "stats"], builtin: true },
  { name: "color", description: "Set the prompt bar color", argumentHint: "", aliases: [], builtin: true },
  { name: "__remote-workflow", description: "internal", argumentHint: "", aliases: [], builtin: true },
];

test("the menu offers the panel's own commands and Claude Code's, less those of no use in the panel", () => {
  const menu = menuCommands(listed);
  const names = menu.map((c) => c.name);
  for (const own of ["btw", "plan", "usage", "resume", "copy", "memory", "login", "logout", "mcp", "plugin", "skills", "hooks", "status"]) {
    assert.equal(names.filter((n) => n === own).length, 1, own);
  }
  // Claude Code's, less its terminal's and its internal ones; its /usage is the panel's.
  assert.deepEqual(
    menu.filter((c) => listed.some((l) => l.name === c.name) && c.name !== "usage").map((c) => [c.name, c.group]),
    [["notes", "skill"], ["journal:standup", "plugin"], ["compact", "builtin"], ["clear", "builtin"], ["context", "builtin"]],
  );
  const about = (name) => menu.find((c) => c.name === name).description;
  assert.equal(about("btw"), "Ask a side question; the conversation itself stays as it is.");
  assert.equal(about("usage"), "Show your plan's limits, and this conversation's cost and time.");
  assert.equal(about("mcp"), "Opens Settings → Connectors.");
  assert.equal(about("status"), "Opens Settings → Claude Code.");
  assert.equal(menu.find((c) => c.name === "copy").hint, "[N]");
  assert.equal(menu.find((c) => c.name === "notes").hint, "[day]");
});

test("descriptions lose what the name already says", () => {
  assert.equal(describe(listed[0]), "Write today's note. Use when the user asks for a note.");
  assert.equal(describe(listed[1]), "Draft a standup from yesterday's work");
  assert.equal(describe({ ...listed[2], description: "Free up\n  context" }), "Free up context");
  assert.equal(pluginName(listed[1]), "Journal");
  assert.equal(pluginName({ ...listed[1], description: "Draft a standup" }), "journal");
});

test("the menu opens on the first word only, while it is being typed", () => {
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("/comp", 5), "comp");
  assert.equal(slashQuery("/compact", 3), "co");
  assert.equal(slashQuery("/compact now", 12), null);
  assert.equal(slashQuery("say /compact", 12), null);
  assert.equal(slashQuery("", 0), null);
});

test("matches come section by section, names starting with what is typed first", () => {
  const menu = menuCommands(listed);
  const names = (q) => matchCommands(menu, q).map((c) => c.name);
  // Names first, then aliases (/continue, /cost), then a piece of a name (/mcp).
  assert.deepEqual(names("c"), ["clear", "compact", "context", "copy", "resume", "usage", "mcp"]);
  assert.deepEqual(names("CON"), ["context", "resume"]);
  // A plugin's by its own part, a command by an alias, anything by a piece of its name.
  assert.deepEqual(names("stand"), ["journal:standup"]);
  assert.deepEqual(names("reset"), ["clear"]);
  assert.deepEqual(names("ote"), ["notes"]);
  assert.deepEqual(names("nothing"), []);
  assert.equal(names("").length, menu.length);
});

test("picking puts the command first, ready for its arguments", () => {
  assert.equal(withCommand("/comp", "compact"), "/compact ");
  assert.equal(withCommand("/comp keep the API part", "compact"), "/compact keep the API part");
  // From Settings, before what was being written.
  assert.equal(withCommand("about the mic", "notes"), "/notes about the mic");
});

test("a command typed alone with its space greys what it takes after it", () => {
  const menu = menuCommands(listed);
  assert.equal(pendingHint("/compact ", menu), "<optional custom summarization instructions>");
  assert.equal(pendingHint("/notes ", menu), "[day]");
  assert.equal(pendingHint("/new ", menu), "[name]", "by an alias");
  assert.equal(pendingHint("/compact now", menu), "");
  assert.equal(pendingHint("/compact", menu), "");
  assert.equal(pendingHint("/context ", menu), "");
});

test("the panel answers its own commands, and /clear, /model and /effort", () => {
  assert.deepEqual(panelCommand("/clear"), { name: "clear", arg: "" });
  assert.deepEqual(panelCommand("/reset now"), { name: "clear", arg: "now" });
  assert.deepEqual(panelCommand("/model opus"), { name: "model", arg: "opus" });
  assert.deepEqual(panelCommand("/Effort"), { name: "effort", arg: "" });
  assert.deepEqual(panelCommand("/cost"), { name: "usage", arg: "" });
  assert.deepEqual(panelCommand("/continue Mic fixes"), { name: "resume", arg: "Mic fixes" });
  assert.deepEqual(panelCommand("/plan add a\nlogin page"), { name: "plan", arg: "add a\nlogin page" });
  assert.deepEqual(panelCommand(" /btw why? "), { name: "btw", arg: "why?" });
  assert.deepEqual(panelCommand("/plugins"), { name: "plugin", arg: "", page: "plugins" });
  assert.deepEqual(panelCommand("/mcp"), { name: "mcp", arg: "", page: "connectors" });
  assert.deepEqual(panelCommand("/status"), { name: "status", arg: "", page: "claude" });
  // Claude Code's (/rename tells the panel through its stream), and what isn't a command.
  for (const text of ["/compact", "clear", "/clearly", "/rename Mic fixes", "/agents"]) assert.equal(panelCommand(text), null, text);
});

test("/model and /effort pick what they name, or say they don't know it", () => {
  const models = [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-haiku-4-5", name: "Haiku 4.5" }];
  assert.equal(pickModel("opus", models), "claude-opus-5-5");
  assert.equal(pickModel("Haiku 4.5", models), "claude-haiku-4-5");
  assert.equal(pickModel("claude-opus-5-5", models), "claude-opus-5-5");
  assert.equal(pickModel("default", models), null);
  assert.equal(pickModel("opusplan", models), undefined);
  assert.equal(pickEffort("HIGH", ["low", "high"]), "high");
  assert.equal(pickEffort("auto", ["low", "high"]), null);
  assert.equal(pickEffort("turbo", ["low", "high"]), undefined);
});

test("/resume finds a conversation by its id or its name, /copy an answer from the end", () => {
  const sessions = [
    { id: "5f76139f-6656-467e-8ef1-45a8bbe0ae8e", title: "Slash commands" },
    { id: "ad606ca9-d5b8-4524-b42c-1c76095acaa6", title: "Mic fixes" },
    { id: "0b1e2f3a-0000-4000-8000-000000000000", title: "Old mic idea" },
  ];
  assert.equal(findSession(sessions, "ad606ca9")?.title, "Mic fixes");
  assert.equal(findSession(sessions, "MIC")?.title, "Mic fixes", "the newest with the words");
  assert.equal(findSession(sessions, "nothing"), undefined);
  assert.equal(findSession(sessions, ""), undefined);
  const lines = [
    { role: "user", text: "a" },
    { role: "assistant", text: "first" },
    { role: "user", text: "b" },
    { role: "assistant", text: "second" },
    { role: "step", text: "Reads · x" },
  ];
  assert.equal(answerToCopy(lines, ""), "second");
  assert.equal(answerToCopy(lines, "2"), "first");
  assert.equal(answerToCopy(lines, "3"), null);
  assert.equal(answerToCopy(lines, "last"), "second");
  assert.equal(answerToCopy([], ""), null);
});
