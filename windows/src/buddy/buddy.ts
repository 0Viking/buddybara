// Buddy mode: Buddybara lives on the desktop wherever he is dropped, and a click on
// him opens this panel beside him (island.rs place_panel): the folders under
// ~/projects on the left, a project's Claude Code sessions and a conversation
// on the right, continued from here with `claude -p --resume` (code.rs).
//
// It stands in for the island. The hook handlers (island/hooks.ts) ask it to
// bring up their cards: a permission request or a question is answered from
// here with the island's own commands, and a session that finishes opens here,
// ready for a reply.
//
// Every conversation keeps its own run: several can work at once, one left and
// opened again shows as it is, still live, and what is typed while Claude is
// at it waits as the next turn. Files dropped on the panel or pasted into it
// go with the next message, copied into the inbox first (files.rs).

import {
  Bridge, onDragDrop, onEvent,
  type ChatDelta, type CodeProject, type CodeRunEvent, type CodeSession, type DragDropPayload, type DroppedFile,
  type SessionUsage, type SlashCommand,
} from "../core/bridge";
import { BUDDY_H, BUDDY_NECK, BUDDY_W, type AlertView } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type AskedQuestion } from "../core/state";
import { DesktopLink } from "../island/desktop";
import { N_, language, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { renderMarkdown, writeClipboard } from "../views/markdown";
import {
  PASTE_MAX_MB, ago, applyRunEvent, dropQueue, folderOf, lineOf, makeChat, mergeQueued, pastedName, takeQueue,
  tokensShort, tooBig, userLine, type Chat, type Line, type OtherModel,
} from "./run";
import {
  answerToCopy, findSession, matchCommands, menuCommands, panelCommand, pendingHint, pickEffort, pickModel, slashQuery,
  withCommand, type CommandGroup, type MenuCommand, type PanelCommand,
} from "./commands";
import { POUR_MS, genieClear, genieFrame, genieHidden, genieWanted } from "./genie";
import { THEME_EVENT } from "../core/theme";
import { BuddyTerminal, type TermTarget } from "./terminal";
import { Setup } from "./setup";
import { renderUsage } from "./usage";
import { Drawer, aiProvider, paneId } from "./drawer";
import { drawPane, type PaneActions, type PaneChild, type PaneNode } from "./pane";
import { refreshClaudePlan } from "../island/hooks";
import { PROVIDERS, providerDef, readyProviders } from "../core/providers";
import {
  enabledServices, refreshServiceKeys, servicesNews, servicesSeen, servicesVersion, servicesView, startServices,
} from "./services";
import "./buddy.css";

/** The permission modes of the picker (never a bypass: code.rs refuses one). */
const MODES = [
  { id: "default", name: N_("Manual"), about: N_("Claude asks before each edit.") },
  { id: "acceptEdits", name: N_("Edit automatically"), about: N_("Claude edits files without asking.") },
  { id: "plan", name: N_("Plan"), about: N_("Claude explores the code and presents a plan before editing.") },
  { id: "auto", name: N_("Auto"), about: N_("Claude approves safe actions and pauses for anything risky.") },
];

const EFFORTS = [
  { id: "low", name: N_("Low") },
  { id: "medium", name: N_("Medium") },
  { id: "high", name: N_("High") },
  { id: "xhigh", name: N_("Extra high") },
  { id: "max", name: N_("Max") },
];

/** The models of the picker, as VS Code lists them (code.rs passes the id as
 * `--model`). Ultracode needs a model that can do extra high effort: Haiku can't. */
const MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5", about: N_("Best for everyday, complex tasks"), ultracode: true },
  { id: "claude-fable-5-1", name: "Fable 5.1", about: N_("Most capable for your hardest and longest-running tasks"), ultracode: true },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", about: N_("Efficient for routine tasks"), ultracode: true },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", about: N_("Fastest for quick answers"), ultracode: false },
];

/** Longest name a session may be given (code.rs MAX_SESSION_NAME). */
const MAX_SESSION_NAME = 100;

const STOP_ICON = "M7 7h10v10H7z";

/** `chat.run` while code_send has yet to answer with the run's id (they start at 1). */
const STARTING = 0;

/** Stop takes no click for this long after the send button turned into it. */
const STOP_GRACE_MS = 600;

/** The project of a drawer's chat with another model started before any was picked: its links lead nowhere. */
const NO_PROJECT: CodeProject = { name: "", path: "", sessions: 0, last: 0, elsewhere: false };

/** A project's `/` menu is asked of Claude Code again once it is this old (a skill installed since). */
const COMMANDS_FRESH_MS = 10 * 60_000;

/** Measures the field's text, for where a command's argument hint goes (renderGhost). */
const measurer = document.createElement("canvas");

/** The `/` menu's sections (commands.ts GROUPS). */
const GROUP_NAMES: Record<CommandGroup, string> = {
  builtin: N_("Commands"),
  skill: N_("Skills"),
  plugin: N_("Plugins"),
};

/** News of a session nobody has looked at yet: it finished, failed, or waits for an answer. */
type Notice = { cwd: string; kind: "done" | "error" | "input"; at: number };

/** The few fields of a hook event (island/hooks.ts HookPayload) the dots need. */
interface HookNotice {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  buddybara_agent?: string;
}

/** The hook events that are news, and what kind (hooks.ts has the rest of the payload). */
const NOTICE_KINDS: Record<string, Notice["kind"]> = {
  Stop: "done",
  StopFailure: "error",
  PermissionRequest: "input",
  Notification: "input",
};

/** A project shows its most pressing news. */
const NOTICE_RANK: Record<Notice["kind"], number> = { done: 0, error: 1, input: 2 };

/** Kept for this many sessions at most, the newest. */
const MAX_NOTICES = 300;

/** A folder as one spelling: VS Code writes `c:\…`, a terminal `C:\…`, some add a slash. */
function samePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function loadNotices(): Map<string, Notice> {
  try {
    return new Map(Object.entries(JSON.parse(stored("unread") ?? "{}") as Record<string, Notice>));
  } catch {
    return new Map();
  }
}

/** The picks of the panel are a convenience of this computer: local storage. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(`buddybara.buddy.${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(`buddybara.buddy.${key}`);
    else localStorage.setItem(`buddybara.buddy.${key}`, value);
  } catch {
    /* nothing lost but the pick */
  }
}

/** An error as the panel says it: its message, without the "Error:" in front. */
/** The window has grown from its folded pixel to the panel's size (or long enough has passed). */
function sized(): Promise<void> {
  const until = performance.now() + 250;
  return new Promise((done) => {
    const check = () => {
      if (window.innerWidth >= BUDDY_W || performance.now() > until) done();
      else window.setTimeout(check, 16);
    };
    check();
  });
}

function errorText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

/** Waits for a start-up step; one that fails is written to Buddybara's log, and the rest goes on. */
async function logged(what: string, step: Promise<unknown>) {
  try {
    await step;
  } catch (err) {
    void Bridge.log(`buddy: ${what} failed: ${errorText(err)}`);
  }
}

/** An other model's provider, by name ("OpenAI-compatible" in the interface language). */
function otherName(provider: string): string {
  return t(providerDef(provider)?.name ?? provider);
}

/**
 * Builds `el` again only when what it shows changed. Every run event redraws
 * the panel, and an element rebuilt between a press and its release takes the
 * click with it.
 */
function keyed(el: HTMLElement, key: unknown[], build: () => void) {
  const k = JSON.stringify([language(), ...key]);
  if (el.dataset.key === k) return;
  el.dataset.key = k;
  build();
}

/** A file, by its name, the full path on hover. */
function fileChip(name: string, path: string, ...extra: HTMLElement[]): HTMLElement {
  return h("span", { class: "b-file", title: path }, svg(ICONS.doc, 11), h("span", { class: "b-file-name", text: name }), ...extra);
}

/** What the user sent: the text in a bubble, the files it came with under it. */
function sentView(text: string, files: string[] | undefined, queued = false): HTMLElement {
  return h(
    "div",
    { class: queued ? "chat-row user b-queued" : "chat-row user" },
    h("div", { class: "b-sent" },
      text ? h("div", { class: "bubble", text }) : null,
      files?.length ? h("div", { class: "b-files" }, ...files.map((p) => fileChip(folderOf(p), p))) : null,
      queued ? h("div", { class: "b-queued-label", text: t("Queued") }) : null),
  );
}

/** `base`: the conversation's project, where the relative paths its answers link start. */
function lineView(line: Line, base: string): HTMLElement {
  if (line.role === "user") return sentView(line.text, line.files);
  // Claude Code summarizing the conversation: a line across, what it did on it.
  if (line.role === "compacting" || line.role === "compacted") {
    const text = line.role === "compacting"
      ? t("Compacting…")
      : line.tokens ? t("Compacted {n} tokens", { n: tokensShort(line.tokens) }) : t("Conversation compacted");
    return h("div", { class: line.role === "compacting" ? "b-compact busy" : "b-compact" }, h("span", { text }));
  }
  if (line.role === "assistant") {
    const reply = h("div", { class: "reply" });
    renderMarkdown(reply, line.text, base);
    return h("div", { class: "chat-row" }, reply);
  }
  return h("div", { class: line.role === "step" ? "b-step" : "b-error", text: line.text });
}

export class Buddy {
  readonly desktop: DesktopLink;
  private shown = false;
  private projects: CodeProject[] = [];
  private project: CodeProject | null = null;
  private sessions: CodeSession[] | null = null;
  private chat: Chat | null = null;
  /** Runs in flight, by code.rs run id, each for its own conversation. */
  private runs = new Map<number, Chat>();
  /** Conversations with a run or a queue, by session id: opened again, the same one shows, live. */
  private live = new Map<string, Chat>();
  /** What a run said before code_send even answered with its id. */
  private early = new Map<number, CodeRunEvent[]>();
  /** Files for the next message, already copied into the inbox. */
  private attachments: DroppedFile[] = [];
  /** Files still being copied in: a message sent meanwhile waits for them. */
  private adding: Promise<void> = Promise.resolve();
  /** Their names, shown as chips on their way. */
  private copying: string[] = [];
  /** Copies that failed so far: one failing while a message waits stops it. */
  private failures = 0;
  /** When the send button last turned into Stop. */
  private stopSince = 0;
  /** A conversation is being taken over from the terminal (takeFromTerminal): Enter again waits. */
  private handing = false;
  /** Why the last file (or message, or command) couldn't be taken. */
  private attachError = "";
  /** A word under the field for a moment, and its timer (flashNote). */
  private note = "";
  private noteTimer = 0;
  /** The conversation follows its end, unless the user scrolled up to read. */
  private pinned = true;
  /** Unread news by session: a dot on it and on its project until it is opened. */
  private notices = loadNotices();
  private dragging = false;
  private mode = stored("mode") ?? "default";
  private effort: string | null = stored("effort");
  /** null: Claude Code's own model. */
  private model: string | null = MODELS.find((m) => m.id === stored("model"))?.id ?? null;
  private ultracode = stored("ultracode") === "1";
  private menuOpen = false;
  /** Put away by his minimize button, until Buddybara is started again. */
  private minimized = false;
  /** Why the sessions of the picked project couldn't be read. */
  private notice = "";
  /** Picks of a multiple-choice question, by question. */
  private picks = new Map<string, Set<string>>();
  private picksFor = "";
  /** The "new project" field is open in the sidebar. */
  private creating = false;
  /** The session whose name is being edited in the list, and the name so far. */
  private renaming: string | null = null;
  private renameDraft = "";
  /** The field selects its text when it first shows, not on every redraw. */
  private renameFresh = false;
  /** The conversation the body last drew: another one starts at its end. */
  private drawn: Chat | null = null;
  /** How far the panel is out of Buddybara (genie.ts: 0 inside him, 1 open), and the pour under way. */
  private pourAt = 0;
  private pourRun = 0;

  private el: HTMLElement;
  /** The whole window: the shape the panel pours out of Buddybara in. */
  private genie: HTMLElement;
  private list = h("div", { class: "b-projects" });
  /** Built once: a redraw of the list never takes the field from under the typing. */
  private newName = h("input", {
    class: "b-new-input", type: "text", spellcheck: "false", placeholder: tl("Project name"),
  }) as HTMLInputElement;
  private newError = h("div", { class: "b-new-error" });
  private newRow = h("div", { class: "b-new" }, this.newName, this.newError);
  private back = h("button", { class: "b-icon", title: tl("Back") }, svg(ICONS.chevronLeft, 13, { stroke: 2.2 }));
  private title = h("div", { class: "b-title" });
  private modeBtn = h("button", { class: "b-chip" });
  private menu = h("div", { class: "b-menu" });
  /** A project's right-click menu, at the pointer (openProjectMenu). */
  private projectMenu = h("div", { class: "b-menu b-context" });
  /** The `/` menu over the field (renderSlash): the rows it shows, the one picked by the arrows. */
  private slash = h("div", { class: "b-slash" });
  private slashRows: MenuCommand[] = [];
  private slashAt = 0;
  /** What was typed after the slash when the rows were last listed: another query starts at the top. */
  private slashFor: string | null = null;
  /** The field's text when Escape put the menu away: it stays away until the text changes. */
  private slashDismissed: string | null = null;
  /** Each project's commands as Claude Code last listed them (null until it has), and when. */
  private commands = new Map<string, { list: SlashCommand[] | null; at: number; asking: boolean }>();
  /** The argument hint of the command typed, greyed after it in the field (renderGhost). */
  private ghost = h("span", { class: "b-ghost", "aria-hidden": "true" });
  private termBtn = h("button", { class: "b-icon", title: tl("Terminal") }, svg(ICONS.terminal, 14, { stroke: 1.8 }));
  /** New conversation, or, in one, deleting it. */
  private newBtn = h("button", { class: "b-icon" });
  private confirm = h("div", { class: "b-confirm" });
  /** "Delete this conversation?" is asked. */
  private confirming = false;
  /** The terminal is on screen in place of the conversation. */
  /** The Services tab is on screen in place of a project. */
  private services = false;
  /** The provider (Settings → AI models) new conversations go to, or null for Claude Code. */
  private other: string | null = stored("other");
  /** Which other providers have their key, for the menu; asked when the panel opens. */
  private otherKeys: Record<string, boolean> = {};
  /** Conversations with other models, by run, while one answers; and the line it streams into. */
  private otherRuns = new Map<number, Chat>();
  private nextOtherRun = 1_000_000_000;
  private partial = new WeakMap<Chat, Line>();
  /** Each project's conversations with other models, kept while Buddybara runs (they aren't saved). */
  private others = new Map<string, Chat[]>();
  /** Plugins' panes drawn in the drawer, by `run:pane` (paneView): their element, and whether they need drawing. */
  private paneViews = new Map<string, { pane: HTMLElement; body: HTMLElement; stale: boolean; drawing: boolean; again: boolean }>();
  /** The drawer's chats with other models, one per provider, kept while Buddybara runs (aiView). */
  private aiChats = new Map<string, Chat>();
  /** Their tabs, built once each: put back, a text box would lose the keyboard. */
  private aiPanes = new Map<string, { pane: HTMLElement; log: HTMLElement; input: HTMLTextAreaElement; model: HTMLButtonElement; fresh: HTMLButtonElement }>();
  private servicesRow = h("button", { class: "b-project b-services" });
  private terminal = new BuddyTerminal(
    (target) => this.terminalEnded(target),
    () => this.hideTerminal(),
  );
  /** The first-run screen, over the panel while something Buddybara needs is missing. */
  private setup = new Setup(
    () => this.chooseFolder(),
    (page) => {
      this.hide();
      void Bridge.openSettingsWindow(page);
    },
  );
  /** The usage above Settings (usage.ts): a click opens Settings → Claude Code → Usage. */
  private usage = h("div", { class: "b-usage", role: "button", title: tl("Usage") });
  /** The totals it shows (refreshTotals), whose they are, and the last asking. */
  private totals: SessionUsage | null = null;
  private totalsKey: string | null = null;
  private totalsAsked = 0;
  /** The drawer under the conversation: the terminal and side questions (drawer.ts). */
  private drawer: Drawer;
  private btw: Chat | null = null;
  /** btw sessions: copies never saved, so their hooks bring no dot and open nothing. */
  private ephemeral = new Set<string>();
  private btwLog = h("div", { class: "b-log b-drawer-log" });
  private btwInput = h("textarea", { class: "b-input", rows: "1", spellcheck: "false" }) as HTMLTextAreaElement;
  private btwPane = h("div", { class: "b-drawer-pane" }, this.btwLog,
    h("div", { class: "b-composer" }, this.btwInput,
      h("button", { class: "b-send", onclick: () => void this.sendBtw() }, svg(ICONS.arrowUp, 11, { stroke: 2.4 }))));
  private body = h("div", { class: "b-body" });
  private card = h("div", { class: "b-card" });
  private files = h("div", { class: "b-attach" });
  private input = h("textarea", { class: "b-input", rows: "1", spellcheck: "false" }) as HTMLTextAreaElement;
  private sendBtn = h("button", { class: "b-send", title: tl("Send") });
  private composer = h("div", { class: "b-composer" }, this.input, this.sendBtn);
  private dropZone = h("div", { class: "b-drop" }, h("div", { class: "b-drop-text", text: tl("Drop your files here") }));

  constructor(root: HTMLElement) {
    const closeBtn = h("button", { class: "b-icon", title: tl("Close") }, svg(ICONS.xmark, 11, { stroke: 2.4 }));
    const pickFolderBtn = h("button", { class: "b-add", title: tl("Choose projects folder") }, svg(ICONS.folder, 13));
    const addProjectBtn = h("button", { class: "b-add", title: tl("New project") }, svg(ICONS.plus, 13, { stroke: 2 }));
    const headActions = h("div", { class: "b-head-actions" }, pickFolderBtn, addProjectBtn);
    const sideHead = h("div", { class: "b-side-head" }, h("span", { text: tl("Projects") }), headActions);
    const settingsBtn = h("button", { class: "b-icon", title: tl("Settings") }, svg(ICONS.gear, 14));
    const credit = h("span", { class: "b-credit", text: tl("Created By {name}", { name: "Yuri Kotoman" }) });
    const sideFoot = h("div", { class: "b-side-foot" }, settingsBtn, credit);
    const side = h("aside", { class: "b-side" }, this.servicesRow, sideHead, this.newRow, this.list, this.usage, sideFoot);
    const bar = h("div", { class: "b-bar" }, this.back, this.title, this.termBtn, this.modeBtn, this.newBtn, closeBtn);
    const main = h("section", { class: "b-main" },
      bar, this.menu, this.confirm, this.body, this.card, this.files, this.composer, this.dropZone);
    // The drawer: the terminal and side questions (btw), under the conversation.
    this.drawer = new Drawer(main, {
      terminal: this.terminal.el,
      picked: (tab) => {
        const pane = paneId(tab);
        if (tab === "terminal") void this.showTerminal();
        else if (pane != null) this.panePicked(pane);
        else {
          this.refreshFromTerminal();
          this.render();
          const provider = aiProvider(tab);
          (provider ? this.aiPane(provider).input : this.btwInput).focus();
        }
      },
      closed: () => {
        this.refreshFromTerminal();
        this.render();
        if (this.shown) this.input.focus();
      },
      slid: () => this.refreshFromTerminal(),
      btwView: () => this.btwView(),
      aiReady: () => readyProviders(State.settings, this.otherKeys).map((r) => r.def.id),
      aiView: (provider) => this.aiView(provider),
      panes: () => (this.chat?.paneRun != null ? this.chat.panes ?? [] : []),
      paneView: (id) => this.paneView(id),
      closePane: (id) => this.closePane(id),
    });
    this.composer.after(this.drawer.bar, this.drawer.space);
    main.append(this.drawer.el);
    this.btwInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.sendBtw();
      }
    });
    this.el = h("div", { id: "buddy" }, side, main, this.setup.el, this.projectMenu);
    this.projectMenu.addEventListener("contextmenu", (e) => e.preventDefault());
    this.list.addEventListener("scroll", () => this.closeProjectMenu());
    this.genie = h("div", { id: "genie" }, this.el);
    root.append(this.genie);

    this.back.addEventListener("click", () => {
      // In the terminal, back is to the conversation.
      if (this.termShown) this.hideTerminal();
      else this.leaveChat();
    });
    this.newBtn.addEventListener("click", () => {
      if (!this.chat?.id) {
        this.newChat();
        return;
      }
      this.confirming = !this.confirming;
      this.menuOpen = false;
      this.render();
    });
    this.termBtn.addEventListener("click", () => {
      if (this.termShown) this.hideTerminal();
      else this.drawer.show("terminal");
    });
    this.buildConfirm();
    // A click anywhere else is "no" to the question.
    document.addEventListener("pointerdown", (e) => {
      const at = e.target as Node;
      if (!this.projectMenu.contains(at)) this.closeProjectMenu();
      if (this.confirming && !this.confirm.contains(at) && !this.newBtn.contains(at)) {
        this.confirming = false;
        this.render();
      }
    });
    this.servicesRow.addEventListener("click", () => this.openServices());
    pickFolderBtn.addEventListener("click", () => void this.chooseFolder());
    addProjectBtn.addEventListener("click", () => this.startNewProject());
    settingsBtn.addEventListener("click", () => {
      // Buddybara's Settings is a window of its own: the panel folds out of its way.
      this.hide();
      void Bridge.openSettingsWindow();
    });
    closeBtn.addEventListener("click", () => this.hide());
    this.modeBtn.addEventListener("click", () => {
      this.menuOpen = !this.menuOpen;
      this.confirming = false;
      this.render();
    });
    this.newName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.createProject();
      } else if (e.key === "Escape") {
        // Only the field closes, not the panel (the document's Escape).
        e.preventDefault();
        e.stopPropagation();
        this.cancelNewProject();
      }
    });
    this.newName.addEventListener("input", () => {
      this.newError.textContent = "";
      this.renderNewProject();
    });
    // Clicking away with nothing typed closes the field, once that click is
    // done: closed on the press, it would pull the list from under the pointer
    // and the click would land on another row, or on none.
    this.newName.addEventListener("blur", () => {
      if (this.newName.value.trim()) return;
      document.addEventListener("click", () => {
        if (document.activeElement !== this.newName && !this.newName.value.trim()) this.cancelNewProject();
      }, { once: true });
    });
    this.sendBtn.addEventListener("click", () => {
      if (!this.stopShown()) {
        void this.send();
      } else if (performance.now() - this.stopSince > STOP_GRACE_MS) {
        // A click this soon after it turned into Stop is the second half of a
        // double click (or a click after Enter): it never meant to stop.
        this.stop();
      }
    });
    this.input.addEventListener("keydown", (e) => {
      if (this.slashKey(e)) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => {
      this.fitInput();
      this.renderComposer();
    });
    // The menu follows the caret, and goes when the field is left.
    for (const type of ["click", "keyup", "focus", "blur"]) this.input.addEventListener(type, () => this.renderSlash());
    this.composer.append(this.slash, this.ghost);
    // A press on the menu leaves the keyboard in the field.
    this.slash.addEventListener("pointerdown", (e) => e.preventDefault());
    this.body.addEventListener("scroll", () => {
      // Folded to one pixel, its sizes say nothing about the reader.
      if (!this.shown || this.body.clientHeight < 40) return;
      this.pinned = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    });
    // Unfolded again: at the end if that is where it was, the field at its height.
    window.addEventListener("resize", () => {
      if (!this.shown) return;
      this.fitInput();
      if (this.chat && this.pinned) this.body.scrollTop = this.body.scrollHeight;
    });
    // The field's height again whenever what it is measured with changes: its
    // width (the panel unfolding after a start), its font (another scheme, a
    // font that finished loading).
    let fieldWidth = 0;
    new ResizeObserver(() => {
      if (this.input.clientWidth === fieldWidth) return;
      fieldWidth = this.input.clientWidth;
      // Next frame: resizing the field it watches inside its own callback,
      // the observer would report a loop.
      requestAnimationFrame(() => this.fitInput());
    }).observe(this.input);
    window.addEventListener(THEME_EVENT, () => this.fitInput());
    void document.fonts.ready.then(() => this.fitInput());
    // A screenshot (or a copied file) pasted anywhere in the panel is attached;
    // text is left to the field.
    document.addEventListener("paste", (e) => this.onPaste(e));
    // The window never takes the keyboard by itself (no-activate): a press in
    // the panel asks for it.
    this.el.addEventListener("pointerdown", () => void Bridge.focusWindow(true));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.shown) return;
      // Escape in the terminal is Claude's (it interrupts, it closes its menus).
      if (this.terminal.el.contains(e.target as Node)) return;
      if (this.closeProjectMenu()) return;
      if (this.menuOpen) this.menuOpen = false;
      else if (this.confirming) this.confirming = false;
      else this.hide();
      this.render();
    });

    this.desktop = new DesktopLink({
      clicked: () => this.toggle(),
      minimize: () => this.minimize(),
    });
    State.subscribe(() => this.renderCard());
    renderUsage(this.usage, null);
    State.subscribe(() => renderUsage(this.usage, this.totals));
    this.usage.addEventListener("click", () => this.showUsage());
    // A service switched on or off in Settings: its row and its card follow.
    State.subscribe(() => {
      this.renderServicesRow();
      if (this.services) this.renderBody();
    });
    // Folded, nothing in it can hold the keyboard or be pressed by a key.
    this.el.inert = true;
  }

  async init() {
    // One step at a time, each on its own: whatever fails, Buddybara still comes
    // out and the panel still opens.
    await logged("run events", onEvent<CodeRunEvent>("code-run", (e) => this.onRun(e)));
    // A skill or plugin installed or removed in Settings: the `/` menu is asked for again.
    await logged("commands", onEvent<null>("commands-changed", () => this.commands.clear()));
    await logged("file drops", onDragDrop((e) => this.onDrag(e)));
    await logged("notifications", onEvent<HookNotice>("hook", (p) => this.onHook(p)));
    await logged("terminal", this.terminal.init());
    startServices(() => this.render(), (good) => this.desktop.emote(good ? "happy" : "surprised"));
    await logged("other models", onEvent<ChatDelta>("chat-delta", (d) => this.onDelta(d)));
    void this.refreshOtherKeys();
    // The whole window is the panel: it takes the mouse wherever it is shown.
    void Bridge.setIslandRect(BUDDY_NECK, 0, BUDDY_W, BUDDY_H);
    void Bridge.setCollapsed(true);
    await logged("desktop Buddybara", this.desktop.init());
    this.desktop.launch();
    this.render();
  }

  /** Buddybara was started again (its shortcut): Buddybara comes out, or waves if he is. */
  summon() {
    this.minimized = false;
    void this.desktop.summon();
  }

  /** The tray's Open: Buddybara back out if he was put away, else the panel. */
  open() {
    if (this.minimized) this.summon();
    else this.show(false);
  }

  /** His minimize button: he and the panel leave the screen; Buddybara runs on. */
  private minimize() {
    this.minimized = true;
    this.hide(true);
    void Bridge.desktopPutAway();
  }

  // ── The hook handlers' host (island/hooks.ts HookHost) ───────────────────────

  alert(view: AlertView) {
    // Put away: nothing comes up by itself until Buddybara is started again.
    if (this.minimized) return;
    if (view === "approval" || view === "question") {
      this.show(true);
      this.renderCard();
    } else if (view === "finished" || view === "error") {
      this.openFinished();
    }
  }

  // ── Open and close ──────────────────────────────────────────────────────────

  toggle() {
    if (this.shown) this.hide();
    else this.show(false);
  }

  /** Opened by an alert, it leaves the keyboard where it was. */
  show(byAlert: boolean) {
    const was = this.shown;
    if (!was) {
      this.shown = true;
      this.el.inert = false;
      this.el.classList.add("open");
      void this.pour(true);
      void this.loadProjects();
      void this.refreshOtherKeys();
      void this.setup.check();
      // Other conversations may have run meanwhile (VS Code, a terminal).
      this.totalsKey = null;
      refreshClaudePlan();
      Sound.play("open");
      // The conversation it opens on is looked at now.
      this.seen(this.chat?.id ?? null);
    }
    if (!byAlert) {
      void Bridge.focusWindow(true);
      window.setTimeout(() => {
        if (!this.shown) return;
        if (this.termShown) this.terminal.focus();
        else this.input.focus();
      }, 60);
    }
    this.render();
  }

  /** `now`: folded at once, without pouring back into him (he is leaving too). */
  hide(now = false) {
    if (!this.shown) return;
    this.shown = false;
    this.menuOpen = false;
    this.closeProjectMenu();
    this.setDragging(false);
    // Folded, the window may keep the keyboard: what is typed next must reach
    // nothing nobody sees — an Enter in the field, a Space on the Stop button.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.el.contains(focused)) focused.blur();
    this.el.inert = true;
    this.el.classList.remove("open");
    void Bridge.focusWindow(false);
    if (now) {
      this.pourRun++;
      this.poured(false);
    } else {
      void this.pour(false);
    }
    Sound.play("close");
  }

  /**
   * Out of Buddybara (open) or back into him: the genie, from wherever the last
   * pour left off, so a click halfway turns it around. Without him on screen,
   * or with animations off in Windows, the plain fade.
   */
  private async pour(open: boolean) {
    const run = ++this.pourRun;
    const genie = genieWanted();
    if (open) {
      // Nothing shows until the window is beside him and the page has its size.
      if (genie) {
        this.genie.classList.add("pouring");
        if (this.pourAt === 0) genieHidden(this.genie);
      }
      await Bridge.setCollapsed(false);
      if (genie) await sized();
    }
    const at = genie ? await Bridge.desktopAnchor() : null;
    if (run !== this.pourRun) return;
    if (!at) {
      this.poured(open);
      return;
    }
    const tip = { x: at[0], y: at[1] };
    const from = this.pourAt;
    const to = open ? 1 : 0;
    const ms = (open ? POUR_MS.open : POUR_MS.close) * Math.abs(to - from);
    this.genie.classList.add("pouring");
    const start = performance.now();
    await new Promise<void>((done) => {
      const frame = (now: number) => {
        if (run !== this.pourRun) return done();
        const t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
        this.pourAt = from + (to - from) * t;
        genieFrame(this.genie, this.el, tip, this.pourAt);
        if (t < 1) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
    if (run === this.pourRun) this.poured(open);
  }

  /** A pour is over: the panel as it is, or folded away to its one pixel. */
  private poured(open: boolean) {
    this.pourAt = open ? 1 : 0;
    this.genie.classList.remove("pouring");
    genieClear(this.genie, this.el);
    if (!open) void Bridge.setCollapsed(true);
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  private async loadProjects() {
    this.projects = await Bridge.codeProjects();
    this.renderProjects();
  }

  /** Settings changed which folders are listed: the list again, and away from one no longer in it. */
  async refreshProjects() {
    await this.loadProjects();
    const p = this.project;
    if (p && !this.projects.some((x) => samePath(x.path) === samePath(p.path)) && this.chat?.run == null) {
      this.project = null;
      this.chat = null;
      this.sessions = null;
      this.render();
    }
  }

  /** The folder button by "Projects": pick the folder whose subfolders the list shows. */
  private async chooseFolder() {
    let path: string | null;
    try {
      path = await Bridge.codePickProjectsFolder();
    } catch (err) {
      this.notice = errorText(err);
      this.render();
      return;
    }
    if (!path) return; // cancelled
    // A new root: the open project may not be under it. Back to the list.
    this.cancelNewProject();
    this.project = null;
    this.chat = null;
    this.sessions = null;
    this.notice = "";
    Sound.play("pop");
    await this.loadProjects();
    this.render();
  }

  /** The + beside "Projects": the name field opens above the list. */
  private startNewProject() {
    this.creating = true;
    this.renderNewProject();
    this.newName.focus();
  }

  private cancelNewProject() {
    if (!this.creating) return;
    this.creating = false;
    this.newName.value = "";
    this.newError.textContent = "";
    this.renderNewProject();
  }

  /** Enter in the field: the folder is made (code.rs new_project), then opened, ready for a first message. */
  private async createProject() {
    if (!this.newName.value.trim()) {
      this.cancelNewProject();
      return;
    }
    try {
      const project = await Bridge.codeNewProject(this.newName.value);
      this.cancelNewProject();
      Sound.play("pop");
      await this.loadProjects();
      await this.pickProject(project);
      if (this.shown) this.input.focus();
    } catch (err) {
      this.newError.textContent = errorText(err);
      this.renderNewProject();
      this.newName.focus();
    }
  }

  private async pickProject(p: CodeProject) {
    this.leaveTerminal();
    this.services = false;
    // A project picked while the name field is open with nothing in it: the field goes.
    if (document.activeElement !== this.newName && !this.newName.value.trim()) this.cancelNewProject();
    if (this.project?.path !== p.path) this.chat = null;
    this.project = p;
    this.sessions = null;
    this.notice = "";
    this.render();
    const asked = Date.now();
    try {
      this.sessions = await Bridge.codeSessions(p.path);
      this.prune(p, this.sessions, asked);
    } catch (err) {
      this.sessions = [];
      this.notice = errorText(err);
    }
    if (this.project === p) this.render();
  }

  // ── Conversations ───────────────────────────────────────────────────────────

  private async openSession(project: CodeProject, id: string, title: string) {
    this.leaveTerminal();
    this.services = false;
    this.project = project;
    // Opened: its dot goes, and its project's with the last one.
    this.seen(id);
    // At work (or holding a queue): the very conversation on screen before, still live.
    const live = this.live.get(id);
    if (live) {
      this.chat = live;
      this.restoreQueue(live);
      this.render();
      return;
    }
    const chat = makeChat(project, id, title);
    chat.loading = true;
    this.chat = chat;
    this.render();
    try {
      chat.lines = (await Bridge.codeMessages(project.path, id)).map(lineOf);
    } catch (err) {
      chat.lines = [{ role: "error", text: errorText(err) }];
    }
    chat.loading = false;
    if (this.chat === chat) this.render();
  }

  /** Claude finished (or failed): that session opens here, ready for a reply. */
  private openFinished() {
    const task = State.focusTask;
    if (!task?.sessionId || !task.sessionCwd || this.ephemeral.has(task.sessionId)) return;
    // Already on screen: a run of ours draws itself; another session's is read again.
    if (this.chat?.id === task.sessionId) {
      if (this.chat.run == null) void this.openSession(this.chat.project, task.sessionId, this.chat.title);
      this.show(true);
      return;
    }
    // A message being written (in a conversation, or a first one on the list):
    // the panel comes up, but stays where it is, so it can't land in this one.
    if (this.drafting()) {
      this.show(true);
      return;
    }
    const cwd = task.sessionCwd.toLowerCase().replace(/[\\/]+$/, "");
    const project = this.projects.find((p) => p.path.toLowerCase() === cwd)
      ?? { name: folderOf(task.sessionCwd), path: task.sessionCwd, sessions: 0, last: 0, elsewhere: true };
    this.show(true);
    void this.openSession(project, task.sessionId, project.name);
  }

  /** The Services row: the services' cards in place of a project. */
  private openServices() {
    this.leaveTerminal();
    this.cancelNewProject();
    this.services = true;
    this.project = null;
    this.chat = null;
    this.sessions = null;
    this.notice = "";
    servicesSeen();
    void refreshServiceKeys();
    this.render();
  }

  private newChat() {
    if (!this.project) return;
    this.leaveTerminal();
    this.chat = makeChat(this.project, null, t("New conversation"));
    this.render();
    this.input.focus();
  }

  private leaveChat() {
    this.chat = null;
    if (this.project) void this.pickProject(this.project);
    else this.render();
  }

  /** A conversation stays findable by its session while it runs or holds a queue. */
  private track(chat: Chat) {
    if (!chat.id) return;
    if (chat.run != null || chat.alive != null || chat.queue.length) this.live.set(chat.id, chat);
    else if (this.live.get(chat.id) === chat) this.live.delete(chat.id);
  }

  /** Turns queued for a run that failed or was stopped come back to the composer, unsent. */
  private restoreQueue(chat: Chat) {
    if (chat.run != null) return;
    const back = dropQueue(chat);
    this.track(chat);
    if (!back) return;
    this.input.value = [back.text, this.input.value.trim()].filter(Boolean).join("\n\n");
    this.attachments.push(...back.files.map((path) => ({ name: folderOf(path), path, size: 0 })));
    this.fitInput();
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  private async send() {
    // It goes where it was written, whatever happens during the wait below.
    const project = this.project;
    const writtenIn = this.chat;
    const failures = this.failures;
    // A file still being copied in goes with this message, as it was meant to.
    await this.adding;
    // One that could not be copied meanwhile: its reason stays up, nothing
    // goes; Enter again sends without it.
    if (this.failures !== failures) return;
    let text = this.input.value.trim();
    // The panel's own commands (commands.ts panelCommand): /plan with a request
    // switches to Plan mode, and the request goes like any message.
    const own = panelCommand(text);
    if (own?.name === "plan" && own.arg) {
      this.mode = "plan";
      store("mode", "plan");
      text = own.arg;
    } else if (own?.name === "btw") {
      // A side question in the drawer; the conversation itself is untouched.
      if (await this.askBtw(own.arg)) this.clearInput();
      return;
    } else if (own) {
      this.clearInput();
      await this.runCommand(own);
      return;
    }
    const files = this.attachments.map((f) => f.path);
    if ((!text && !files.length) || !project) return;
    const chat = writtenIn ?? makeChat(project, null, t("New conversation"));
    // A new conversation goes to the other model picked in the menu, if one is.
    if (!chat.id && !chat.other && !chat.lines.length) {
      const other = this.otherReady();
      if (other) chat.other = other;
    }
    if (chat.other && files.length) {
      this.attachError = t("Only Claude Code can read attached files.");
      this.renderAttachments();
      return;
    }
    // Claude Code has it open in the terminal: two of them would write one
    // session. Between turns there, it quits and the conversation goes on here.
    if (chat.id && this.terminal.runsFor({ project: chat.project.path, session: chat.id }) && !(await this.takeFromTerminal(chat))) {
      return;
    }
    // A Claude Code run at work reads it at its next step; anything else at
    // work (starting, being stopped, another model) gets it as the next turn.
    const live = chat.other || chat.stopped || chat.run === STARTING ? null : chat.run ?? chat.alive ?? null;
    // What code.rs would refuse is said now, while nothing is cleared yet (a
    // queued turn goes merged with those before it).
    const goes = chat.run != null && live == null ? mergeQueued([...chat.queue, { text, files }]) : { text, files };
    const refused = tooBig(goes.text, goes.files);
    if (refused) {
      this.attachError = refused;
      this.renderAttachments();
      return;
    }
    this.chat = chat;
    this.input.value = "";
    this.attachments = [];
    this.attachError = "";
    this.fitInput();
    Sound.play("send");
    if (live != null) return this.say(chat, live, text, files);
    if (chat.run != null) {
      // Claude is still at it: this is the next turn, sent the moment the run ends.
      chat.queue.push({ text, files });
      this.track(chat);
      this.render();
      return;
    }
    const line = userLine(text, files);
    chat.lines.push(line);
    await this.start(chat, text, files, [line]);
  }

  /** One `claude -p` run for the conversation (code.rs send); `sent`: the lines it carries. */
  private async start(chat: Chat, prompt: string, attachments: string[], sent: Line[]) {
    if (chat.other) return this.startOther(chat);
    chat.failed = false;
    chat.stopped = false;
    chat.run = STARTING;
    this.render();
    try {
      const run = await Bridge.codeSend(chat.project.path, chat.id, prompt, { mode: this.mode, effort: this.effort, model: this.model, ultracode: this.ultracodeOn() }, attachments);
      chat.run = run;
      this.runs.set(run, chat);
      this.track(chat);
      if (chat.stopped) void Bridge.codeStop(run);
      const missed = this.early.get(run) ?? [];
      this.early.delete(run);
      for (const e of missed) this.onRun(e);
    } catch (err) {
      chat.run = null;
      // It never went: its lines leave the conversation, and what they said
      // comes back to be sent again — ahead of anything queued since.
      chat.lines = chat.lines.filter((l) => !sent.includes(l));
      chat.lines.push({ role: "error", text: errorText(err) });
      chat.queue.unshift({ text: prompt, files: attachments });
      if (this.chat === chat) this.restoreQueue(chat);
      this.track(chat);
    }
    this.render();
  }

  /** Into the run at work, read at its next step (code.rs say). */
  private async say(chat: Chat, run: number, text: string, files: string[]) {
    const line = userLine(text, files);
    chat.lines.push(line);
    this.render();
    if (await Bridge.codeSay(run, text, files).catch(() => false)) {
      // Between turns: this message starts the next one.
      if (chat.run == null) {
        chat.run = run;
        chat.alive = null;
        this.track(chat);
        this.render();
      }
      return;
    }
    // Its turn was already over (or its files need a run of their own): the next turn, as before.
    chat.lines = chat.lines.filter((l) => l !== line);
    chat.queue.push({ text, files });
    this.track(chat);
    // The run may have ended meanwhile, with nothing queued then.
    if (chat.run == null) this.ended(chat);
    this.render();
  }

  /** The terminal is on screen: its tab in front, the drawer up. */
  private get termShown(): boolean {
    return this.drawer.open && this.drawer.active === "terminal";
  }

  // ── Side questions (/btw) ───────────────────────────────────────────────────

  /** The side questions of the conversation on screen (or of the project, before it has one). */
  private btwChat(): Chat | null {
    const project = this.chat?.project ?? this.project;
    if (!project) return null;
    // Its title says what it is about: another conversation gets its own.
    const about = this.chat?.id ?? project.path;
    if (this.btw?.title !== about) this.btw = { ...makeChat(project, null, about), side: true };
    return this.btw;
  }

  /**
   * /btw: answered from a copy of the conversation that is never saved
   * (code.rs Options.btw), in Plan mode so it only reads. False when it can't
   * go yet (no project, or the last one is still being answered): the text stays.
   */
  private async askBtw(question: string): Promise<boolean> {
    const btw = this.btwChat();
    if (!btw) return false;
    this.drawer.show("btw");
    question = question.trim();
    if (!question) return true;
    if (btw.run != null) return false;
    btw.lines.push(userLine(question, []));
    btw.run = STARTING;
    this.drawer.render();
    try {
      const run = await Bridge.codeSend(btw.project.path, this.chat?.id ?? null, question,
        { mode: "plan", effort: this.effort, model: this.model, ultracode: false, btw: true });
      btw.run = run;
      this.runs.set(run, btw);
      const missed = this.early.get(run) ?? [];
      this.early.delete(run);
      for (const e of missed) this.onRun(e);
    } catch (err) {
      btw.run = null;
      btw.lines.push({ role: "error", text: errorText(err) });
    }
    this.drawer.render();
    return true;
  }

  private async sendBtw() {
    if (await this.askBtw(this.btwInput.value)) this.btwInput.value = "";
  }

  /** A side question's run: its answer shows in the btw tab, and nothing else follows from it. */
  private onBtw(chat: Chat, e: CodeRunEvent) {
    if (e.kind === "exit") {
      this.runs.delete(e.run);
      chat.run = null;
    } else {
      if (e.kind === "init" && e.session) this.ephemeral.add(e.session);
      applyRunEvent(chat, e);
      if (e.kind === "result") Sound.play(e.error ? "error" : "finish");
    }
    this.drawer.render();
  }

  private btwView(): HTMLElement {
    const btw = this.btwChat();
    clear(this.btwLog);
    if (!btw?.lines.length) {
      this.btwLog.append(h("div", { class: "b-hint", text: t("Ask Claude something on the side: it answers from a copy of this conversation, which stays as it is.") }));
    }
    for (const line of btw?.lines ?? []) this.btwLog.append(lineView(line, btw!.project.path));
    if (btw?.run != null) this.btwLog.append(h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i"))));
    this.btwInput.placeholder = t("Ask on the side…");
    requestAnimationFrame(() => (this.btwLog.scrollTop = this.btwLog.scrollHeight));
    return this.btwPane;
  }

  /** The send button stops Claude only while it works and nothing new is on its way. */
  private stopShown(): boolean {
    return this.chat?.run != null && !this.drafting();
  }

  /** Something is being written: text, attached files, or files still being copied in. */
  private drafting(): boolean {
    return this.input.value.trim() !== "" || this.attachments.length > 0 || this.copying.length > 0;
  }

  private stop() {
    const chat = this.chat;
    if (chat?.run == null) return;
    chat.stopped = true;
    if (chat.other) {
      // Another model can't be stopped mid-answer: what it streamed stays, the rest is let go.
      this.otherRuns.delete(chat.run);
      this.partial.delete(chat);
      chat.run = null;
      this.restoreQueue(chat);
      this.render();
      return;
    }
    if (chat.run !== STARTING) void Bridge.codeStop(chat.run);
  }

  private onRun(e: CodeRunEvent) {
    const chat = this.runs.get(e.run);
    if (!chat) {
      // Ahead of code_send's answer: kept for the run it names (a few runs, at most).
      const kept = this.early.get(e.run) ?? [];
      if (kept.length < 500) kept.push(e);
      this.early.set(e.run, kept);
      if (this.early.size > 8) this.early.delete(this.early.keys().next().value!);
      return;
    }
    if (chat.side) return this.onBtw(chat, e);
    // A plugin's pane changed what it draws, or says something: only that.
    if (e.kind === "ui_invalidate") return this.panesStale(chat, e.instances ?? null);
    if (e.kind === "ui_toast") {
      if (this.chat === chat && e.text) this.flashNote(e.text);
      return;
    }
    // Claude Code's commands changed mid-session: the `/` menu asks again.
    if (e.kind === "commands_changed") {
      this.commands.delete(chat.project.path);
      return;
    }
    if (e.kind === "exit") {
      this.runs.delete(e.run);
      // Its panes go with it.
      applyRunEvent(chat, e);
      this.forgetPanes(e.run);
      if (chat.alive === e.run) chat.alive = null;
      if (chat.run === e.run) {
        chat.run = null;
        this.ended(chat);
      } else this.track(chat);
    } else {
      // Alive between turns, it starts one by itself (a background task
      // ended). Panes opening or closing aren't a turn.
      if (chat.run == null && chat.alive === e.run && e.kind !== "result" && e.kind !== "panes") {
        chat.run = e.run;
        chat.alive = null;
      }
      const title = chat.title;
      applyRunEvent(chat, e);
      if (chat.title !== title) this.titled(chat);
      if (e.kind === "init") {
        this.named(chat);
        this.commandsSeen(chat.project.path, e.commands ?? []);
      }
      if (e.kind === "panes") this.panesChanged(chat, e.run, e.focus ?? null);
      if (e.kind === "result") Sound.play(e.error ? "error" : "finish");
      // The turn is over, but background tasks or a plugin's pane keep the run
      // alive: the conversation is free again, and its next message goes into
      // this run.
      const keeps = (e.background ?? 0) > 0 || (typeof e.panes === "number" && e.panes > 0);
      if (e.kind === "result" && keeps && chat.run === e.run) {
        chat.run = null;
        chat.alive = e.run;
        const queued = dropQueue(chat);
        if (queued) void this.say(chat, e.run, queued.text, queued.files);
        else this.ended(chat);
      }
    }
    if (this.chat === chat || e.kind === "exit") this.render();
  }

  /** A new conversation got its session: findable now, and shown in place of its file if that is open. */
  private named(chat: Chat) {
    this.track(chat);
    if (chat.id && this.chat !== chat && this.chat?.id === chat.id) this.chat = chat;
    if (this.project?.path === chat.project.path) this.refreshSessions();
  }

  /** A run ended: what was queued goes next, or back to the composer if it failed or was stopped. */
  private ended(chat: Chat) {
    // Claude Code saved the run's totals: the usage box asks again.
    this.totalsKey = null;
    const next = chat.failed || chat.stopped ? null : takeQueue(chat);
    if (next) void this.start(chat, next.prompt, next.attachments, next.lines);
    else if (this.chat === chat) this.restoreQueue(chat);
    this.track(chat);
    // Done (or failed) out of sight: news. Not a stop the user asked for, nor
    // a turn that goes straight on with what was queued. (With the hook relay
    // installed, its Stop says the same.)
    if (chat.id && !next && !chat.stopped) this.notify(chat.id, chat.project.path, chat.failed ? "error" : "done");
    // A new conversation has a title now, every session a new time, every project a new count.
    this.refreshSessions();
    void this.loadProjects();
  }

  /** The picked project's sessions read again, redrawn if their list is on screen. */
  private refreshSessions() {
    const project = this.project;
    if (!project) return;
    const asked = Date.now();
    void Bridge.codeSessions(project.path)
      .then((s) => {
        if (this.project !== project) return;
        this.sessions = s;
        this.prune(project, s, asked);
        if (!this.chat) this.render();
      })
      .catch(() => {});
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  /** A hook event of a Claude Code session that is news: a dot on it and its project. */
  private onHook(p: HookNotice) {
    const kind = NOTICE_KINDS[p.hook_event_name ?? ""];
    // Other agents' sessions are not in these lists: their dot could never go.
    if (!kind || !p.session_id || !p.cwd || this.ephemeral.has(p.session_id) || (p.buddybara_agent && p.buddybara_agent !== "claude-desktop")) return;
    this.notify(p.session_id, p.cwd, kind);
  }

  /** News for a session, unless it is on screen right now (then it was seen). */
  private notify(session: string, cwd: string, kind: Notice["kind"]) {
    if (this.shown && this.chat?.id === session) return;
    this.notices.set(session, { cwd, kind, at: Date.now() });
    this.saveNotices();
    this.render();
  }

  /** Looked at: its dot goes, and its project's if it was the last there. */
  private seen(session: string | null) {
    if (!session || !this.notices.delete(session)) return;
    this.saveNotices();
  }

  /**
   * The dots of a project's sessions that its list no longer has (gone, or too
   * old to be listed) go too: nothing could ever open them. Only those older
   * than the list asked for, which may simply not have been in it yet.
   */
  private prune(project: CodeProject, sessions: CodeSession[], asked: number) {
    const listed = new Set(sessions.map((s) => s.id));
    const folder = samePath(project.path);
    let changed = false;
    for (const [id, n] of this.notices) {
      if (n.at < asked && samePath(n.cwd) === folder && !listed.has(id)) {
        this.notices.delete(id);
        changed = true;
      }
    }
    if (changed) this.saveNotices();
  }

  private saveNotices() {
    const newest = [...this.notices].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_NOTICES);
    this.notices = new Map(newest);
    store("unread", JSON.stringify(Object.fromEntries(newest)));
  }

  /** Each project's most pressing news, by folder. */
  private projectNotices(): Map<string, Notice["kind"]> {
    const out = new Map<string, Notice["kind"]>();
    for (const n of this.notices.values()) {
      const folder = samePath(n.cwd);
      const had = out.get(folder);
      if (!had || NOTICE_RANK[n.kind] > NOTICE_RANK[had]) out.set(folder, n.kind);
    }
    return out;
  }

  // ── Attachments ─────────────────────────────────────────────────────────────

  private onDrag(e: DragDropPayload) {
    if (e.type !== "drop") {
      this.setDragging(this.shown && e.type !== "leave");
      return;
    }
    this.setDragging(false);
    if (!e.paths?.length) return;
    // Closed, it can only have been dropped on Buddybara: the panel opens to take it.
    if (!this.shown) this.show(false);
    this.attach(e.paths);
  }

  private setDragging(on: boolean) {
    if (this.dragging === on) return;
    this.dragging = on;
    this.dropZone.classList.toggle("on", on);
  }

  /** Dropped files: copied into the inbox (files.rs ingest), then shown above the composer. */
  private attach(paths: string[]) {
    this.queueCopies(paths, folderOf, (path) => Bridge.ingestFile(path));
  }

  /** Copies shown on their way at once, and made one after the other. */
  private queueCopies<T>(items: T[], name: (item: T) => string, copy: (item: T) => Promise<DroppedFile>) {
    this.copying.push(...items.map(name));
    this.renderAttachments();
    this.renderComposer();
    this.adding = this.adding.then(() => this.add(items, name, copy));
  }

  /** Each item made a file of the inbox, one after the other, and added as it lands. */
  private async add<T>(items: T[], name: (item: T) => string, copy: (item: T) => Promise<DroppedFile>) {
    this.attachError = "";
    let added = 0;
    for (const item of items) {
      try {
        // Pushed once it is there: into the list of the next message, not one a send has just emptied.
        const file = await copy(item);
        this.attachments.push(file);
        added++;
      } catch (err) {
        this.attachError = errorText(err);
        this.failures++;
      }
      const at = this.copying.indexOf(name(item));
      if (at >= 0) this.copying.splice(at, 1);
      this.renderAttachments();
    }
    if (added) Sound.play("pop");
    this.renderComposer();
    // The keyboard back to the message, only if it is on screen and nothing else took it.
    if (this.shown && (document.activeElement === document.body || document.activeElement === this.input)) this.input.focus();
  }

  private onPaste(e: ClipboardEvent) {
    // Pasted into the terminal: it is the terminal's (xterm.js takes it).
    if (this.terminal.el.contains(e.target as Node)) return;
    const data = e.clipboardData;
    const files = Array.from(data?.files ?? []);
    // Office copies a picture of the text along with it: the text wins. A
    // picture alone (a screenshot) is attached.
    if (!files.length || data?.getData("text/plain").trim() || !this.shown) return;
    e.preventDefault();
    this.queueCopies(files, (file) => file.name || "pasted", (file) => this.pasted(file));
  }

  /**
   * A pasted file, a screenshot mostly: its bytes written into the inbox
   * (files.rs save_pasted). Too big is refused before a byte is read — the
   * whole file would cross the bridge on the UI thread first.
   */
  private async pasted(file: File): Promise<DroppedFile> {
    if (file.size > PASTE_MAX_MB * 1024 * 1024) throw new Error(t("A pasted file is at most {mb} MB.", { mb: PASTE_MAX_MB }));
    return Bridge.pasteFile(pastedName(file.name, file.type), new Uint8Array(await file.arrayBuffer()));
  }

  // ── Questions and permissions ───────────────────────────────────────────────

  private decide(d: "allow" | "deny") {
    const req = State.pendingApproval;
    if (!req) return;
    Sound.play(d === "deny" ? "blip" : "approve");
    void Bridge.approvalDecision(req.requestId, d);
    State.endApproval();
    State.notify();
  }

  private answer(answers: Record<string, string | string[]>) {
    const req = State.pendingApproval;
    if (!req) return;
    Sound.play("approve");
    void Bridge.approvalAnswer(req.requestId, answers);
    State.endApproval();
    State.notify();
  }

  private pick(questions: AskedQuestion[], q: AskedQuestion, label: string) {
    // One question with one answer: the click is the answer.
    if (questions.length === 1 && !q.multiSelect) {
      this.answer({ [q.question]: label });
      return;
    }
    const set = this.picks.get(q.question) ?? new Set<string>();
    if (q.multiSelect) {
      if (set.has(label)) set.delete(label);
      else set.add(label);
    } else {
      set.clear();
      set.add(label);
    }
    this.picks.set(q.question, set);
    this.renderCard();
  }

  private sendPicks(questions: AskedQuestion[]) {
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const set = [...(this.picks.get(q.question) ?? [])];
      if (!set.length) return;
      answers[q.question] = q.multiSelect ? set : set[0];
    }
    this.answer(answers);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  private render() {
    // News that comes in while the tab is on screen is seen at once.
    if (this.services && this.shown && servicesNews()) servicesSeen();
    this.refreshTotals();
    this.renderServicesRow();
    this.renderNewProject();
    this.renderProjects();
    this.renderBar();
    this.renderMenu();
    this.confirm.classList.toggle("open", this.confirming && this.chat?.id != null);
    this.drawer.bar.style.display = this.project || this.chat ? "" : "none";
    this.drawer.render();
    this.renderBody();
    this.renderCard();
    this.renderAttachments();
    this.renderComposer();
  }

  /**
   * The usage box's totals (code.rs usage): the conversation on screen's,
   * else the picked project's newest, else the newest of all. Asked again
   * when that changes, when the panel opens, and when a run ends.
   */
  private refreshTotals() {
    if (!this.shown) return;
    const project = this.chat?.project.path ?? this.project?.path ?? null;
    const session = this.chat?.other ? null : this.chat?.id ?? null;
    const key = `${project}\n${session}`;
    if (key === this.totalsKey) return;
    this.totalsKey = key;
    const asked = ++this.totalsAsked;
    const done = (u: SessionUsage | null) => {
      if (asked !== this.totalsAsked) return;
      this.totals = u;
      renderUsage(this.usage, u);
    };
    Bridge.codeUsage(project, session).then(done, () => done(null));
  }

  private renderNewProject() {
    this.newRow.classList.toggle("open", this.creating);
    this.newError.style.display = this.newError.textContent ? "" : "none";
  }

  /** Whether a run of ours works in this project, or in this session. */
  private working(project: string, session?: string): boolean {
    for (const c of this.runs.values()) {
      if (c.run != null && (session ? c.id === session : c.project.path === project)) return true;
    }
    return false;
  }

  private renderProjects() {
    const news = this.projectNotices();
    const rows = this.projects.map((p) => [p.name, p.path, p.sessions, p.elsewhere, this.working(p.path), news.get(samePath(p.path)) ?? null]);
    keyed(this.list, [this.project?.path, rows], () => {
      clear(this.list);
      // The projects folder's first; then the folders Claude Code has sessions
      // for elsewhere (VS Code's, a terminal's), under a heading of their own.
      const first = this.projects.findIndex((p) => p.elsewhere);
      this.projects.forEach((p, i) => {
        if (i === first) this.list.append(h("div", { class: "b-side-sub", text: t("Other folders with sessions") }));
        const kind = news.get(samePath(p.path));
        const row = h(
          "button",
          { class: p.path === this.project?.path ? "b-project on" : "b-project", title: p.path },
          h("span", { class: "b-project-name", text: p.name }),
          this.working(p.path) ? h("span", { class: "b-live" }) : null,
          p.sessions ? h("span", { class: "b-count", text: String(p.sessions) }) : null,
          kind ? h("span", { class: `b-news ${kind}` }) : null,
        );
        row.addEventListener("click", () => void this.pickProject(p));
        row.addEventListener("contextmenu", (e) => this.openProjectMenu(e, p));
        this.list.append(row);
      });
    });
  }

  /** Right-click on a project, in place of WebView2's own menu (Back, Refresh, Print…). */
  private openProjectMenu(e: MouseEvent, project: CodeProject) {
    e.preventDefault();
    const explorer = h("button", { class: "b-context-item" }, svg(ICONS.folder, 13), h("span", { text: t("Open in File Explorer") }));
    explorer.addEventListener("click", () => {
      this.closeProjectMenu();
      // A folder only Claude Code's sessions remember may be gone since.
      void Bridge.openPath(project.path, null, null).catch(() => {});
    });
    this.projectMenu.replaceChildren(explorer);
    this.projectMenu.classList.add("open");
    // At the pointer, kept inside the panel.
    const box = this.el.getBoundingClientRect();
    const x = Math.min(e.clientX - box.left, box.width - this.projectMenu.offsetWidth - 6);
    const y = Math.min(e.clientY - box.top, box.height - this.projectMenu.offsetHeight - 6);
    this.projectMenu.style.left = `${Math.max(6, x)}px`;
    this.projectMenu.style.top = `${Math.max(6, y)}px`;
  }

  /** True if it was open. */
  private closeProjectMenu(): boolean {
    if (!this.projectMenu.classList.contains("open")) return false;
    this.projectMenu.classList.remove("open");
    return true;
  }

  /** The Services row, there once a service is on, with a dot for news. */
  private renderServicesRow() {
    const shown = enabledServices().length > 0;
    keyed(this.servicesRow, [shown, this.services, servicesNews()], () => {
      clear(this.servicesRow);
      this.servicesRow.style.display = shown ? "" : "none";
      this.servicesRow.classList.toggle("on", this.services);
      this.servicesRow.append(
        svg(ICONS.grid, 12, { stroke: 1.8 }),
        h("span", { class: "b-project-name", text: t("Services") }),
        servicesNews() ? h("span", { class: servicesNews() === "bad" ? "b-news error" : "b-news" }) : "",
      );
    });
  }

  private renderBar() {
    this.back.style.visibility = this.chat ? "visible" : "hidden";
    this.title.textContent = this.services ? t("Services") : this.chat?.title ?? this.project?.name ?? "";
    this.modeBtn.style.display = this.services ? "none" : "";
    // A conversation with another model says which; so does a new one that would go to it.
    const other = this.chat?.other ?? (this.chat?.id ? null : this.otherReady());
    this.modeBtn.disabled = this.chat?.other != null;
    keyed(this.modeBtn, [this.mode, this.model, this.ultracodeOn(), other], () => {
      clear(this.modeBtn);
      if (other) {
        this.modeBtn.append(h("span", { text: `${otherName(other.provider)} · ${other.model}` }), svg(ICONS.chevronUpDown, 9, { stroke: 2 }));
        return;
      }
      const mode = MODES.find((m) => m.id === this.mode) ?? MODES[0];
      const model = MODELS.find((m) => m.id === this.model);
      const label = [t(mode.name), model?.name, this.ultracodeOn() ? "Ultracode" : null].filter(Boolean).join(" · ");
      this.modeBtn.append(h("span", { text: label }), svg(ICONS.chevronUpDown, 9, { stroke: 2 }));
    });
    this.modeBtn.classList.toggle("open", this.menuOpen);
    // Its own conversation's terminal can't open while a run of ours writes it.
    const chat = this.chat;
    const busy = chat?.run != null;
    this.termBtn.style.display = this.project || chat ? "" : "none";
    this.termBtn.classList.toggle("on", this.termShown);
    this.termBtn.disabled = busy && !this.termShown;
    const deleting = chat?.id != null;
    this.newBtn.style.display = this.services ? "none" : "";
    keyed(this.newBtn, [deleting], () => {
      clear(this.newBtn);
      this.newBtn.append(deleting ? svg(ICONS.trash, 14, { stroke: 1.8 }) : svg(ICONS.plus, 13));
      this.newBtn.title = deleting ? t("Delete conversation") : t("New conversation");
    });
    const inTerminal = chat?.id != null && this.terminal.runsFor({ project: chat.project.path, session: chat.id });
    this.newBtn.disabled = deleting && (busy || inTerminal);
    this.newBtn.classList.toggle("open", this.confirming);
  }

  /** "Delete this conversation?", under its button. */
  private buildConfirm() {
    const no = h("button", { class: "b-confirm-no", text: tl("Cancel") });
    const yes = h("button", { class: "b-confirm-yes", text: tl("Delete") });
    no.addEventListener("click", () => {
      this.confirming = false;
      this.render();
    });
    yes.addEventListener("click", () => void this.deleteChat());
    this.confirm.append(
      h("div", { class: "b-confirm-title", text: tl("Delete this conversation?") }),
      h("div", { class: "b-confirm-about", text: tl("It goes to the Recycle Bin.") }),
      h("div", { class: "b-confirm-actions" }, no, yes),
    );
  }

  /** The conversation on screen, its file and its folder, to the Recycle Bin. */
  private async deleteChat() {
    const chat = this.chat;
    this.confirming = false;
    if (!chat?.id || chat.run != null) {
      this.render();
      return;
    }
    const id = chat.id;
    try {
      await Bridge.codeDeleteSession(chat.project.path, id);
    } catch (err) {
      this.notice = errorText(err);
      this.render();
      return;
    }
    Sound.play("close");
    this.live.delete(id);
    this.seen(id);
    if (this.terminal.target?.session === id) this.terminal.close();
    if (this.sessions) this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.chat === chat) this.chat = null;
    void this.loadProjects();
    if (this.project) void this.pickProject(this.project);
    else this.render();
  }

  // ── Terminal ────────────────────────────────────────────────────────────────

  /** Where a terminal opened now would run: the conversation on screen, else a new one in the project. */
  private termTarget(): TermTarget | null {
    if (this.chat) return { project: this.chat.project.path, session: this.chat.id };
    return this.project ? { project: this.project.path, session: null } : null;
  }

  private async showTerminal() {
    const target = this.termTarget();
    if (!target || this.chat?.run != null) {
      this.drawer.close("terminal");
      return;
    }
    this.menuOpen = false;
    this.confirming = false;
    void Bridge.focusWindow(true);
    this.render();
    // Laid out first: xterm.js measures its place to know its columns.
    await new Promise((done) => requestAnimationFrame(done));
    await this.terminal.open(target);
  }

  private hideTerminal() {
    if (!this.termShown) return;
    this.drawer.hide();
    this.render();
    if (this.shown) this.input.focus();
  }

  /** Elsewhere in the panel: the terminal view goes (Claude Code keeps running in it). */
  private leaveTerminal() {
    if (this.termShown) this.drawer.hide();
    this.confirming = false;
  }

  /**
   * Claude Code ended in the terminal (/exit, or a message from the panel took
   * the conversation over): the drawer slides down if the terminal was in
   * front, its tab kept for next time, and what Claude Code wrote there shows
   * in the conversation, or the list.
   */
  private terminalEnded(target: TermTarget) {
    if (this.termShown) {
      this.drawer.hide();
      if (this.shown) this.input.focus();
    }
    void this.loadProjects();
    const chat = this.chat;
    if (target.session && chat?.id === target.session && chat.run == null) {
      void this.reloadChat(chat);
    } else if (!target.session && !chat && this.project && samePath(this.project.path) === samePath(target.project)) {
      // A new session the terminal started: the project's list shows it.
      const project = this.project;
      void Bridge.codeSessions(project.path).then((list) => {
        if (this.project !== project || this.chat) return;
        this.sessions = list;
        this.render();
      }, () => {});
    }
    this.render();
  }

  /** The turns of a conversation read again from its file, staying on it. */
  private async reloadChat(chat: Chat) {
    if (!chat.id) return;
    let lines: Line[];
    try {
      lines = (await Bridge.codeMessages(chat.project.path, chat.id)).map(lineOf);
    } catch {
      return;
    }
    // A run of ours started meanwhile: its lines are the newer ones.
    if (chat.run != null) return;
    chat.lines = lines;
    if (this.chat === chat) this.render();
  }

  /**
   * A message for a conversation Claude Code has open in the terminal: if it
   * is between turns there, it quits (terminal.ts quit) and what it wrote is
   * read, so the message goes on from here; the Terminal tab resumes it again
   * later. Mid-turn (at work, or waiting on a permission or a question), the
   * message waits in the field. True: the conversation is the panel's now.
   */
  private async takeFromTerminal(chat: Chat): Promise<boolean> {
    if (this.handing) return false;
    const target = { project: chat.project.path, session: chat.id };
    const refuse = (why: string) => {
      this.attachError = why;
      this.renderAttachments();
      return false;
    };
    this.handing = true;
    try {
      if (await Bridge.codeTurnOpen(chat.project.path, chat.id!).catch(() => true)) {
        return refuse(t("Claude is still at work in the terminal: let it finish there (or stop it with Esc), then send again."));
      }
      await this.terminal.quit();
      if (this.terminal.runsFor(target)) return refuse(t("Couldn't close Claude Code in the terminal."));
      await this.reloadChat(chat);
      return true;
    } finally {
      this.handing = false;
    }
  }

  /** Back from the terminal (its tab put away or left): what Claude Code wrote there shows in the conversation. */
  private refreshFromTerminal() {
    const chat = this.chat;
    if (!chat?.id || chat.run != null || this.termShown) return;
    if (this.terminal.runsFor({ project: chat.project.path, session: chat.id })) void this.reloadChat(chat);
  }

  private renderMenu() {
    this.menu.classList.toggle("open", this.menuOpen);
    if (!this.menuOpen) return;
    keyed(this.menu, [this.mode, this.effort, this.model, this.ultracode], () => this.buildMenu());
  }

  /** Ultracode is asked for, and the model can do it. */
  private ultracodeOn() {
    return this.ultracode && MODELS.find((m) => m.id === this.model)?.ultracode !== false;
  }

  /** One pick of the menu, with its line of explanation; picking closes it. */
  private option(name: string, about: string, on: boolean, pick: () => void) {
    const row = h(
      "button",
      { class: on ? "b-mode on" : "b-mode" },
      h("div", { class: "b-mode-name", text: name }),
      h("div", { class: "b-mode-about", text: about }),
      on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
    );
    row.addEventListener("click", () => {
      pick();
      this.menuOpen = false;
      Sound.play("blip");
      this.render();
    });
    return row;
  }

  private buildMenu() {
    clear(this.menu);
    this.menu.append(h("div", { class: "b-menu-head", text: t("Mode") }));
    for (const m of MODES) {
      this.menu.append(this.option(t(m.name), t(m.about), m.id === this.mode, () => {
        this.mode = m.id;
        store("mode", m.id);
      }));
    }
    this.menu.append(h("div", { class: "b-menu-head sep", text: t("Model") }));
    const claude = this.other == null;
    this.menu.append(this.option(t("Default (recommended)"), t("Use the default model"), claude && this.model == null, () => {
      this.model = null;
      store("model", null);
      this.pickOther(null);
    }));
    for (const m of MODELS) {
      this.menu.append(this.option(m.name, t(m.about), claude && m.id === this.model, () => {
        this.model = m.id;
        store("model", m.id);
        this.pickOther(null);
      }));
    }
    // Another model, for new conversations: no tools, so the mode and effort here don't apply to it.
    const ready = readyProviders(State.settings, this.otherKeys);
    if (ready.length) {
      this.menu.append(h("div", { class: "b-menu-head sep", text: t("Other models") }));
      for (const { def, model } of ready) {
        this.menu.append(this.option(t(def.name), model, this.other === def.id, () => this.pickOther(def.id)));
      }
    }
    // Ultracode goes with any effort (CLI 2.1.299 and later), Max included.
    const ultracode = this.ultracodeOn();
    const level = EFFORTS.find((e) => e.id === this.effort);
    const dots = h("div", { class: "b-dots" });
    EFFORTS.forEach((e, i) => {
      const on = level != null && i <= EFFORTS.indexOf(level);
      const dot = h("button", { class: on ? "b-dot on" : "b-dot", title: t(e.name) });
      // The same level again goes back to Claude Code's own default.
      dot.addEventListener("click", () => {
        this.effort = this.effort === e.id ? null : e.id;
        store("effort", this.effort);
        Sound.play("blip");
        this.render();
      });
      dots.append(dot);
    });
    this.menu.append(
      h("div", { class: "b-effort" },
        h("span", { text: `${t("Effort")} (${level ? t(level.name) : t("Default")})` }),
        dots),
    );
    const able = MODELS.find((m) => m.id === this.model)?.ultracode !== false;
    const toggle = h(
      "button",
      { class: able ? "b-mode b-ultra" : "b-mode b-ultra off", disabled: !able },
      h("div", { class: "b-mode-name", text: "Ultracode" }),
      h("div", { class: "b-mode-about", text: able ? t("Workflows on every task, at any effort") : t("Not available for this model") }),
      h("span", { class: ultracode ? "switch on" : "switch" }),
    );
    toggle.addEventListener("click", () => {
      this.ultracode = !this.ultracode;
      store("ultracode", this.ultracode ? "1" : null);
      Sound.play("blip");
      this.render();
    });
    this.menu.append(toggle);
  }

  // ── Other models ────────────────────────────────────────────────────────────

  /** Picked in the menu: new conversations go to `provider`, or to Claude Code again (null). */
  private pickOther(provider: string | null) {
    this.other = provider;
    store("other", provider);
  }

  private async refreshOtherKeys() {
    for (const p of PROVIDERS) if (p.key) this.otherKeys[p.key] = (await Bridge.secretPresent(p.key)) ?? false;
  }

  /** The other model a new conversation goes to now, if it is still set up in Settings. */
  private otherReady(): OtherModel | null {
    const ready = readyProviders(State.settings, this.otherKeys).find((r) => r.def.id === this.other);
    return ready ? { provider: ready.def.id, model: ready.model } : null;
  }

  /** One answer from the conversation's other model, then whatever was typed meanwhile. */
  private async startOther(chat: Chat) {
    const other = chat.other!;
    if (!chat.id && chat.title === t("New conversation")) {
      const first = chat.lines.find((l) => l.role === "user")?.text.split("\n")[0] ?? "";
      if (first) chat.title = first.length > 60 ? `${first.slice(0, 57)}…` : first;
    }
    chat.failed = false;
    chat.stopped = false;
    const run = ++this.nextOtherRun;
    chat.run = run;
    this.otherRuns.set(run, chat);
    // On its project's list, unless it is a drawer's tab.
    const kept = this.others.get(chat.project.path) ?? [];
    if (!chat.side && !kept.includes(chat)) this.others.set(chat.project.path, [chat, ...kept]);
    this.render();
    const turns = chat.lines
      .filter((l) => l.role === "user" || l.role === "assistant")
      .map((l) => ({ role: l.role, content: l.text }));
    let answer: string | null = null;
    let failure = "";
    try {
      answer = await Bridge.chatSend(other.provider, other.model, turns, run);
    } catch (err) {
      failure = errorText(err);
    }
    // Stopped meanwhile: stop() already let this run go.
    if (!this.otherRuns.delete(run)) return;
    const streamed = this.partial.get(chat);
    this.partial.delete(chat);
    if (answer != null) {
      if (streamed) streamed.text = answer;
      else chat.lines.push({ role: "assistant", text: answer });
    } else {
      if (streamed) chat.lines = chat.lines.filter((l) => l !== streamed);
      chat.lines.push({ role: "error", text: failure });
      chat.failed = true;
    }
    chat.run = null;
    Sound.play(chat.failed ? "error" : "finish");
    if (!chat.failed && takeQueue(chat)) {
      void this.startOther(chat);
      return;
    }
    if (this.chat === chat) this.restoreQueue(chat);
    this.render();
  }

  /** A model server's answer as it streams. */
  private onDelta(d: ChatDelta) {
    const chat = this.otherRuns.get(d.run);
    if (!chat || !d.text) return;
    let line = this.partial.get(chat);
    if (!line) {
      line = { role: "assistant", text: "" };
      chat.lines.push(line);
      this.partial.set(chat, line);
    }
    line.text = d.text;
    if (this.chat === chat) this.render();
    else if (chat.side) this.drawer.render();
  }

  // ── Plugins' panes in the drawer ────────────────────────────────────────────

  /** A pane's view: built once per run and pane, drawn again when the plugin says it changed. */
  private paneView(id: string): HTMLElement {
    const chat = this.chat;
    const run = chat?.paneRun;
    if (!chat || run == null) return h("div", { class: "b-drawer-pane" });
    const v = this.paneParts(run, id);
    if (v.stale) void this.drawPaneOf(chat, id);
    return v.pane;
  }

  private paneParts(run: number, id: string) {
    const key = `${run}:${id}`;
    let v = this.paneViews.get(key);
    if (!v) {
      const body = h("div", { class: "b-pane-body" });
      const pane = h("div", { class: "b-drawer-pane b-pane" }, body);
      // A press in it gives the pane the keyboard (its Pane site then holds it).
      pane.addEventListener("focusin", () => void Bridge.codeUi(run, { subtype: "ui_pane_focus", id }).catch(() => {}));
      v = { pane, body, stale: true, drawing: false, again: false };
      this.paneViews.set(key, v);
    }
    return v;
  }

  /** What the person does in a pane, sent to the run that holds it; the pane is drawn again after. */
  private paneActions(chat: Chat, run: number, id: string): PaneActions {
    const site = { component: "Pane", instance_id: id };
    const key = (n: PaneNode) => (typeof n.props?.key === "string" ? { key: n.props.key } : {});
    const send = (request: Record<string, unknown>) => {
      Bridge.codeUi(run, request)
        .catch((err) => void Bridge.log(`buddy: pane ${id}: ${errorText(err)}`))
        .finally(() => void this.drawPaneOf(chat, id));
    };
    return {
      press: (n, href) => {
        if (n.press) send({ subtype: "ui_press", plugin: n.press.plugin, handle: n.press.handle, ...key(n), ...(href ? { href } : {}) });
      },
      input: (n, kind, value) => {
        if (n.press) send({ subtype: "ui_input", plugin: n.press.plugin, handle: n.press.handle, kind, value, ...key(n), ...site });
      },
      select: (n, value) => {
        if (n.press) send({ subtype: "ui_select", plugin: n.press.plugin, handle: n.press.handle, value, ...key(n), ...site });
      },
      openUrl: (url) => void Bridge.openUrl(url),
    };
  }

  /** Asks the pane's run for what it draws now, and draws it (one at a time; asked again meanwhile, once more after). */
  private async drawPaneOf(chat: Chat, id: string) {
    const run = chat.paneRun;
    if (run == null || !chat.panes?.some((p) => p.id === id)) return;
    const v = this.paneParts(run, id);
    v.stale = false;
    if (v.drawing) {
      v.again = true;
      return;
    }
    v.drawing = true;
    try {
      const size = v.body.getBoundingClientRect();
      const answer = await Bridge.codeUi<{ tree?: PaneChild }>(run, {
        subtype: "ui_render", component: "Pane", instance_id: id,
        props: {
          title: chat.panes.find((p) => p.id === id)?.title ?? id,
          isFocused: this.drawer.open && this.drawer.active === `pane:${id}`,
          // In the terminal's cells: what the plugin lays its text out for.
          bodyColumns: Math.max(24, Math.floor((size.width || 380) / 7.5)),
          placement: "dock",
          scroll: { offset: 0, bodyRows: Math.max(8, Math.floor((size.height || 320) / 18)) },
        },
      });
      drawPane(v.body, answer.tree ?? null, this.paneActions(chat, run, id), chat.project.path);
    } catch (err) {
      if (!v.body.firstChild) v.body.append(h("div", { class: "b-hint", text: errorText(err) }));
    } finally {
      v.drawing = false;
      if (v.again) {
        v.again = false;
        void this.drawPaneOf(chat, id);
      }
    }
  }

  /** The panes open in `run` changed: closed ones' views go, tabs follow, one a plugin asks to show comes up. */
  private panesChanged(chat: Chat, run: number, focus: string | null) {
    const open = new Set((chat.panes ?? []).map((p) => `${run}:${p.id}`));
    for (const key of [...this.paneViews.keys()]) {
      if (key.startsWith(`${run}:`) && !open.has(key)) this.paneViews.delete(key);
    }
    if (focus && this.chat === chat && open.has(`${run}:${focus}`)) this.drawer.show(`pane:${focus}`);
    else this.drawer.render();
  }

  /** What these panes draw changed (null: every pane's): the one on screen is drawn now, the others when shown. */
  private panesStale(chat: Chat, ids: string[] | null) {
    const run = chat.paneRun;
    if (run == null) return;
    for (const p of chat.panes ?? []) {
      if (ids && !ids.includes(p.id)) continue;
      const v = this.paneViews.get(`${run}:${p.id}`);
      if (!v) continue;
      v.stale = true;
      if (this.chat === chat && this.drawer.open && this.drawer.active === `pane:${p.id}`) void this.drawPaneOf(chat, p.id);
    }
  }

  /** A pane's tab picked: Claude Code hears it is shown, and it is drawn. */
  private panePicked(id: string) {
    const chat = this.chat;
    const run = chat?.paneRun;
    if (!chat || run == null) return;
    void Bridge.codeUi(run, { subtype: "ui_pane_show", id }).catch(() => {});
    this.render();
    void this.drawPaneOf(chat, id);
  }

  /** A pane tab's ×: the plugin is asked to close it; the roster that follows takes its tab away. */
  private closePane(id: string) {
    const run = this.chat?.paneRun;
    if (run == null) return;
    void Bridge.codeUi(run, { subtype: "ui_close", id }).catch((err) => void Bridge.log(`buddy: pane ${id}: ${errorText(err)}`));
  }

  /** A run ended: its panes' views go. */
  private forgetPanes(run: number) {
    for (const key of [...this.paneViews.keys()]) if (key.startsWith(`${run}:`)) this.paneViews.delete(key);
  }

  // ── Other models in the drawer ──────────────────────────────────────────────

  /** An other model's tab: which model, a new conversation, the chat, its text box. */
  private aiPane(provider: string) {
    const known = this.aiPanes.get(provider);
    if (known) return known;
    const log = h("div", { class: "b-log b-drawer-log" });
    const input = h("textarea", { class: "b-input", rows: "1", spellcheck: "false" }) as HTMLTextAreaElement;
    // The model Settings → AI models picked for it: changed there.
    const model = h("button", { class: "b-ai-model", title: tl("Settings") }) as HTMLButtonElement;
    model.addEventListener("click", () => {
      this.hide();
      void Bridge.openSettingsWindow("models");
    });
    const fresh = h("button", { class: "b-ai-new", title: tl("New conversation") }, svg(ICONS.plus, 12, { stroke: 2 })) as HTMLButtonElement;
    fresh.addEventListener("click", () => {
      if (this.aiChats.get(provider)?.run != null) return;
      this.aiChats.delete(provider);
      this.drawer.render();
      input.focus();
    });
    const send = h("button", { class: "b-send", title: tl("Send") }, svg(ICONS.arrowUp, 11, { stroke: 2.4 }));
    send.addEventListener("click", () => this.sendAi(provider));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendAi(provider);
      }
    });
    const pane = h("div", { class: "b-drawer-pane" },
      h("div", { class: "b-ai-head" }, model, h("span", { class: "b-drawer-gap" }), fresh),
      log,
      h("div", { class: "b-composer" }, input, send));
    const parts = { pane, log, input, model, fresh };
    this.aiPanes.set(provider, parts);
    return parts;
  }

  /** An other model's tab as it stands: its conversation, or what it is for, or that it isn't set up. */
  private aiView(provider: string): HTMLElement {
    const p = this.aiPane(provider);
    const ready = readyProviders(State.settings, this.otherKeys).find((r) => r.def.id === provider);
    const chat = this.aiChats.get(provider);
    const name = otherName(provider);
    p.model.textContent = ready?.model ?? chat?.other?.model ?? "";
    p.model.style.display = p.model.textContent ? "" : "none";
    p.fresh.disabled = !chat?.lines.length || chat.run != null;
    clear(p.log);
    if (!ready) {
      p.log.append(h("div", { class: "b-hint", text: t("{name} isn't set up yet: see Settings → AI models.", { name }) }));
    } else if (!chat?.lines.length) {
      p.log.append(h("div", { class: "b-hint", text: t("Chat with {name}: it only answers what you write here, with no tools and nothing from your projects.", { name }) }));
    }
    for (const line of chat?.lines ?? []) p.log.append(lineView(line, chat!.project.path));
    if (chat?.run != null) p.log.append(h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i"))));
    p.input.placeholder = t("Ask {name}…", { name });
    p.input.disabled = !ready;
    requestAnimationFrame(() => (p.log.scrollTop = p.log.scrollHeight));
    return p.pane;
  }

  /** What was typed in an other model's tab: the next turn of its chat (startOther), once the last is answered. */
  private sendAi(provider: string) {
    const p = this.aiPane(provider);
    const text = p.input.value.trim();
    const ready = readyProviders(State.settings, this.otherKeys).find((r) => r.def.id === provider);
    let chat = this.aiChats.get(provider);
    if (!text || !ready || chat?.run != null) return;
    if (!chat) {
      chat = { ...makeChat(this.project ?? NO_PROJECT, null, otherName(provider)), side: true };
      this.aiChats.set(provider, chat);
    }
    // The model Settings has for it now, even mid-conversation.
    chat.other = { provider, model: ready.model };
    chat.lines.push(userLine(text, []));
    p.input.value = "";
    Sound.play("send");
    void this.startOther(chat);
  }

  /** A conversation with another model, on its project's list. */
  private otherRow(c: Chat): HTMLElement {
    const first = c.lines.find((l) => l.role === "user")?.text ?? "";
    const row = h("button", { class: "b-session" },
      h("div", { class: "b-session-top" },
        c.run != null ? h("span", { class: "b-live" }) : null,
        h("span", { class: "b-session-title", text: c.title }),
        h("span", { class: "b-session-time b-other", text: `${otherName(c.other!.provider)} · ${c.other!.model}` })),
      first ? h("div", { class: "b-session-sub", text: first }) : null);
    row.addEventListener("click", () => {
      this.leaveTerminal();
      this.chat = c;
      this.render();
    });
    return row;
  }

  private renderBody() {
    const body = this.body;
    if (this.services) {
      this.drawn = null;
      const ids = enabledServices().map((s) => s.id);
      keyed(body, ["services", servicesVersion(), ids], () => {
        clear(body);
        body.append(...servicesView());
      });
      return;
    }
    if (this.chat) {
      // Another conversation starts at its end; this one stays where the
      // reader is (the scroll listener keeps `pinned`).
      if (this.drawn !== this.chat) this.pinned = true;
      const top = body.scrollTop;
      body.dataset.key = "";
      clear(body);
      this.drawn = this.chat;
      this.renderChat(this.chat);
      body.scrollTop = this.pinned ? body.scrollHeight : top;
      return;
    }
    this.drawn = null;
    // ago() in the key: "just now" turns into "2 h ago" between two openings.
    const sessions = this.sessions?.map((s) => [
      s.id, s.title, s.prompt, ago(s.last), this.working(this.project?.path ?? "", s.id), this.notices.get(s.id)?.kind ?? null,
    ]);
    const others = this.others.get(this.project?.path ?? "")?.map((c) => [c.title, c.run != null, c.lines.length]);
    keyed(body, [this.notice, this.project?.path, sessions ?? null, this.renaming, others ?? null, this.waitingCommand()], () => this.buildList());
  }

  /** The picked project's sessions, or why there are none. */
  private buildList() {
    const body = this.body;
    clear(body);
    if (this.notice) body.append(h("div", { class: "b-error", text: this.notice }));
    if (!this.project) {
      // A command from Settings waits in the field for a project to run in.
      const command = this.waitingCommand();
      body.append(h("div", { class: "b-hint", text: command ? t("Pick a project to run {command} in.", { command }) : t("Pick a project") }));
    } else if (this.sessions == null) {
      body.append(h("div", { class: "b-hint", text: t("Loading…") }));
    } else if (!this.sessions.length && !this.others.get(this.project.path)?.length) {
      body.append(h("div", { class: "b-hint", text: t("No sessions yet") }));
    } else {
      const project = this.project;
      for (const c of this.others.get(project.path) ?? []) body.append(this.otherRow(c));
      for (const s of this.sessions) {
        if (this.renaming === s.id) {
          body.append(this.renameRow(project, s));
          continue;
        }
        const news = this.notices.get(s.id);
        // Not a button inside the row's button: a span that keeps its click.
        const rename = h("span", { class: "b-rename", role: "button", title: t("Rename") }, svg(ICONS.pencil, 11, { stroke: 2 }));
        rename.addEventListener("click", (e) => {
          e.stopPropagation();
          this.renaming = s.id;
          this.renameDraft = s.title;
          this.renameFresh = true;
          this.render();
        });
        const row = h(
          "button",
          { class: "b-session" },
          h("div", { class: "b-session-top" },
            this.working(project.path, s.id) ? h("span", { class: "b-live" }) : null,
            h("span", { class: "b-session-title", text: s.title }),
            rename,
            h("span", { class: "b-session-time", text: ago(s.last) }),
            news ? h("span", { class: `b-news ${news.kind}` }) : null),
          s.prompt ? h("div", { class: "b-session-sub", text: s.prompt }) : null,
        );
        row.addEventListener("click", () => void this.openSession(project, s.id, s.title));
        body.append(row);
      }
    }
  }

  /** A session's row while it is renamed: its name in a field. Enter, ✓ or leaving it saves; Escape or ✕ doesn't. */
  private renameRow(project: CodeProject, s: CodeSession) {
    const input = h("input", { class: "b-rename-input", maxlength: MAX_SESSION_NAME, "aria-label": t("Rename") });
    input.value = this.renameDraft;
    const count = h("span", { class: "b-rename-count" });
    const counted = () => {
      count.textContent = `${input.value.length}/${MAX_SESSION_NAME}`;
      count.classList.toggle("full", input.value.length >= MAX_SESSION_NAME);
    };
    counted();
    const cancel = () => {
      this.renaming = null;
      this.render();
    };
    input.addEventListener("input", () => {
      this.renameDraft = input.value;
      counted();
    });
    input.addEventListener("keydown", (e) => {
      // Escape here is the field's, not the panel's (which would close).
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void this.finishRename(project, s);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    const no = h("button", { class: "b-rename-btn", title: t("Cancel") }, svg(ICONS.xmark, 9, { stroke: 2.4 }));
    const yes = h("button", { class: "b-rename-btn ok", title: t("Save") }, svg(ICONS.check, 12, { stroke: 2.6 }));
    for (const button of [no, yes]) {
      // Pressed, they leave the field focused: its blur would save before ✕ could cancel.
      button.addEventListener("mousedown", (e) => e.preventDefault());
    }
    no.addEventListener("click", cancel);
    yes.addEventListener("click", () => void this.finishRename(project, s));
    // A redraw takes the field away without the user leaving it: not a save.
    input.addEventListener("blur", () => {
      if (input.isConnected) void this.finishRename(project, s);
    });
    window.setTimeout(() => {
      if (!input.isConnected) return;
      input.focus();
      if (this.renameFresh) input.select();
      this.renameFresh = false;
    }, 0);
    return h("div", { class: "b-session editing" }, input, count, no, yes);
  }

  private async finishRename(project: CodeProject, s: CodeSession) {
    if (this.renaming !== s.id) return;
    this.renaming = null;
    const name = this.renameDraft.trim();
    const old = s.title;
    if (!name || name === old) {
      this.render();
      return;
    }
    // Shown at once; the file has the last word.
    this.retitle(s, name);
    try {
      this.retitle(s, await Bridge.codeRenameSession(project.path, s.id, name));
    } catch (err) {
      this.retitle(s, old);
      this.notice = errorText(err);
      this.render();
    }
  }

  /** A session's new name, wherever it shows: the list, and its conversation if open. */
  private retitle(s: CodeSession, title: string) {
    s.title = title;
    for (const chat of [this.chat, this.live.get(s.id)]) {
      if (chat?.id === s.id) chat.title = title;
    }
    this.render();
  }

  private renderChat(chat: Chat) {
    const log = h("div", { class: "b-log" });
    if (chat.loading) log.append(h("div", { class: "b-hint", text: t("Loading…") }));
    for (const line of chat.lines) log.append(lineView(line, chat.project.path));
    if (chat.run != null) {
      log.append(h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i"))));
    }
    for (const q of chat.queue) log.append(sentView(q.text, q.files, true));
    this.body.append(log);
  }

  private renderCard() {
    const req = State.pendingApproval;
    this.card.classList.toggle("open", req != null);
    if (req && this.picksFor !== req.requestId) {
      this.picksFor = req.requestId;
      this.picks.clear();
    }
    const who = req ? State.tasks.find((x) => x.id === req.pillId)?.name ?? "Claude Code" : "";
    const picks = [...this.picks].map(([q, set]) => [q, [...set]]);
    // Rebuilt only when it changes: Allow pressed while another run streams must still land.
    keyed(this.card, [req?.requestId ?? null, req?.command, req?.tool, req?.questions ?? null, who, picks], () => this.buildCard());
  }

  private buildCard() {
    clear(this.card);
    const req = State.pendingApproval;
    if (!req) return;
    const who = State.tasks.find((x) => x.id === req.pillId)?.name ?? "Claude Code";
    const questions = req.questions;
    if (questions) {
      for (const q of questions) {
        const set = this.picks.get(q.question);
        const options = h("div", { class: "b-options" });
        for (const o of q.options) {
          const b = h("button", { class: set?.has(o.label) ? "b-option on" : "b-option", text: o.label, title: o.description });
          b.addEventListener("click", () => this.pick(questions, q, o.label));
          options.append(b);
        }
        this.card.append(h("div", { class: "b-card-text", text: q.question }), options);
      }
      if (questions.length > 1 || questions.some((q) => q.multiSelect)) {
        const send = h("button", { class: "b-btn primary", text: t("Send") });
        send.addEventListener("click", () => this.sendPicks(questions));
        this.card.append(h("div", { class: "b-card-actions" }, send));
      }
      return;
    }
    const deny = h("button", { class: "b-btn", text: t("Deny") });
    const allow = h("button", { class: "b-btn primary", text: t("Allow") });
    deny.addEventListener("click", () => this.decide("deny"));
    allow.addEventListener("click", () => this.decide("allow"));
    this.card.append(
      h("div", { class: "b-card-head" }, h("span", { class: "b-card-who", text: who }), h("span", { text: t("needs permission") })),
      h("div", { class: "b-card-cmd", text: req.command || req.tool }),
      h("div", { class: "b-card-actions" }, deny, allow),
    );
  }

  private renderAttachments() {
    // Shown with or without a project: files dropped on Buddybara before one is
    // picked are there, waiting, and so is the reason one was refused.
    this.files.classList.toggle("open", this.attachments.length > 0 || this.copying.length > 0 || this.attachError !== "" || this.note !== "");
    keyed(this.files, [this.attachments.map((f) => f.path), this.copying, this.attachError, this.note], () => {
      clear(this.files);
      for (const f of this.attachments) {
        const remove = h("button", { class: "b-file-x", title: t("Remove") }, svg(ICONS.xmark, 8, { stroke: 2.6 }));
        remove.addEventListener("click", () => {
          this.attachments = this.attachments.filter((a) => a !== f);
          this.renderAttachments();
          this.renderComposer();
        });
        this.files.append(fileChip(f.name, f.path, remove));
      }
      // Still being copied in: there already, dimmed, so Enter doesn't look ignored.
      for (const name of this.copying) {
        const chip = fileChip(name, name);
        chip.classList.add("copying");
        this.files.append(chip);
      }
      if (this.attachError) this.files.append(h("span", { class: "b-attach-error", text: this.attachError }));
      if (this.note) this.files.append(h("span", { class: "b-attach-note", text: this.note }));
    });
  }

  private renderComposer() {
    this.composer.style.display = this.project ? "" : "none";
    this.input.placeholder = this.chat?.id || this.chat?.lines.length ? t("Continue…") : t("Ask me anything…");
    const stop = this.stopShown();
    // Its icon redrawn only when it changes: Stop pressed while Claude streams must land.
    keyed(this.sendBtn, [stop], () => {
      if (stop) this.stopSince = performance.now();
      clear(this.sendBtn);
      this.sendBtn.append(svg(stop ? STOP_ICON : ICONS.arrowUp, 11, stop ? {} : { stroke: 2.4 }));
    });
    this.sendBtn.title = stop ? t("Stop Claude") : t("Send");
    this.sendBtn.classList.toggle("stop", stop);
    this.renderSlash();
  }

  // ── The panel's own commands ────────────────────────────────────────────────

  private clearInput() {
    this.input.value = "";
    this.fitInput();
    this.renderComposer();
  }

  /**
   * A command the panel answers itself (commands.ts panelCommand): what
   * Claude Code does with it in its terminal, done with what the panel has.
   */
  private async runCommand(c: PanelCommand) {
    this.attachError = "";
    const project = this.chat?.project ?? this.project;
    if (c.page) {
      // Settings is a window of its own: the panel folds out of its way.
      this.hide();
      void Bridge.openSettingsWindow(c.page);
      return;
    }
    switch (c.name) {
      case "clear":
        this.newChat();
        break;
      case "model": {
        // A model named: picked at once; none, or one the menu doesn't have: the menu.
        const id = c.arg ? pickModel(c.arg, MODELS) : undefined;
        if (id === undefined) this.openMenu();
        else {
          this.model = id;
          store("model", id);
          this.pickOther(null);
          Sound.play("blip");
        }
        break;
      }
      case "effort": {
        const level = c.arg ? pickEffort(c.arg, EFFORTS.map((e) => e.id)) : undefined;
        if (level === undefined) this.openMenu();
        else {
          this.effort = level;
          store("effort", level);
          Sound.play("blip");
        }
        break;
      }
      case "plan":
        this.mode = "plan";
        store("mode", "plan");
        Sound.play("blip");
        break;
      case "usage":
        this.showUsage();
        break;
      case "resume":
        if (project) await this.resume(project, c.arg);
        break;
      case "copy":
        await this.copyAnswer(c.arg);
        break;
      case "memory":
        if (project) await Bridge.codeMemory(project.path).catch((err) => (this.attachError = errorText(err)));
        break;
      case "login":
      case "logout":
        // Claude Code's own, in a window of its own (setup.rs); the browser for a sign-in.
        await Bridge.setupStart(c.name).catch((err) => (this.attachError = errorText(err)));
        break;
    }
    this.render();
  }

  private openMenu() {
    this.menuOpen = true;
    this.confirming = false;
  }

  /**
   * /usage: Settings → Claude Code, whose Usage shows the plan's limits and
   * this conversation's totals (the project's newest, from its list).
   */
  private showUsage() {
    const project = this.chat?.project.path ?? this.project?.path ?? null;
    const session = this.chat?.other ? null : this.chat?.id ?? null;
    this.hide();
    void Bridge.openSettingsUsage(project, session);
  }

  /** /resume: back to the project's conversations, or straight into the one named. */
  private async resume(project: CodeProject, name: string) {
    if (name) {
      const sessions = this.project === project && this.sessions
        ? this.sessions
        : await Bridge.codeSessions(project.path).catch((): CodeSession[] => []);
      const found = findSession(sessions, name);
      if (found) return this.openSession(project, found.id, found.title);
    }
    this.project = project;
    this.leaveChat();
  }

  /** /copy [N]: Claude's last answer (or the Nth from the end) on the clipboard, as Markdown. */
  private async copyAnswer(arg: string) {
    const text = this.chat ? answerToCopy(this.chat.lines, arg) : null;
    if (text == null) {
      this.attachError = t("No answer to copy yet.");
      return;
    }
    await writeClipboard(text);
    this.flashNote(t("Copied"));
  }

  /** A word under the field for a moment ("Copied"). */
  private flashNote(text: string) {
    this.note = text;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note = "";
      this.renderAttachments();
    }, 2000);
    this.renderAttachments();
  }

  /** Renamed by Claude Code (/rename): the list says it too. */
  private titled(chat: Chat) {
    const s = this.sessions?.find((x) => x.id === chat.id);
    if (s) s.title = chat.title;
    if (this.project?.path === chat.project.path) this.refreshSessions();
  }

  /**
   * Settings → Skills → Use: the panel opens with the command typed before
   * whatever was being written, ready for what follows it. Not sent.
   */
  useCommand(text: string) {
    const name = /^\/(\S+)/.exec(text.trim())?.[1];
    if (!name) return;
    if (this.minimized) this.summon();
    this.leaveTerminal();
    this.services = false;
    // Another model can't run Claude Code's commands: back to the project's list.
    if (this.chat?.other) this.chat = null;
    this.input.value = withCommand(this.input.value.trim(), name);
    this.show(false);
    this.fitInput();
    // After show's own focus: the caret right after the command.
    window.setTimeout(() => {
      if (!this.shown) return;
      this.input.focus();
      const at = name.length + 2;
      this.input.setSelectionRange(at, at);
      this.renderComposer();
    }, 90);
  }

  /** The command waiting in the field while no project is picked (useCommand), or "". */
  private waitingCommand(): string {
    return this.project ? "" : /^\/\S+/.exec(this.input.value.trim())?.[0] ?? "";
  }

  // ── The / menu ──────────────────────────────────────────────────────────────

  /**
   * The menu over the field while its first word is a command being typed:
   * Claude Code's commands, skills and plugins' for this project (and /btw),
   * those that match first. Not for a conversation with another model.
   */
  private renderSlash() {
    this.renderGhost();
    const project = this.project?.path;
    const value = this.input.value;
    if (value !== this.slashDismissed) this.slashDismissed = null;
    const other = this.chat?.other ?? (this.chat?.id ? null : this.otherReady());
    const query = project && !other && this.slashDismissed == null && document.activeElement === this.input
      ? slashQuery(value, this.input.selectionStart ?? 0)
      : null;
    if (query == null || !project) return this.closeSlash();
    this.askCommands(project);
    const list = this.commands.get(project)?.list ?? null;
    const rows = matchCommands(menuCommands(list ?? []), query);
    if (!rows.length && list) return this.closeSlash();
    if (query !== this.slashFor) {
      this.slashFor = query;
      this.slashAt = 0;
    }
    this.slashAt = Math.max(0, Math.min(this.slashAt, rows.length - 1));
    this.slashRows = rows;
    keyed(this.slash, [rows.map((r) => r.name), this.slashAt, list == null], () => {
      clear(this.slash);
      let group: CommandGroup | null = null;
      rows.forEach((c, i) => {
        if (c.group !== group) {
          group = c.group;
          this.slash.append(h("div", { class: "b-slash-head", text: t(GROUP_NAMES[group]) }));
        }
        const row = h(
          "button",
          { class: i === this.slashAt ? "b-slash-item on" : "b-slash-item", title: c.description },
          h("span", { class: "b-slash-name", text: `/${c.name}` }),
          h("span", { class: "b-slash-hint", text: c.hint }),
          c.description ? h("span", { class: "b-slash-about", text: c.description }) : null,
        );
        row.addEventListener("click", () => this.pickSlash(c));
        this.slash.append(row);
      });
      // The first time in a project, Claude Code takes a second or two to list them.
      if (list == null) this.slash.append(h("div", { class: "b-slash-wait", text: t("Loading…") }));
    });
    this.slash.classList.add("open");
    // The picked row in sight, scrolling the menu only (scrollIntoView would move the panel too).
    const on = this.slash.querySelector<HTMLElement>(".b-slash-item.on");
    if (on) {
      const view = this.slash;
      if (on.offsetTop < view.scrollTop) view.scrollTop = on.offsetTop - 30;
      else if (on.offsetTop + on.offsetHeight > view.scrollTop + view.clientHeight) {
        view.scrollTop = on.offsetTop + on.offsetHeight - view.clientHeight + 4;
      }
    }
  }

  private closeSlash() {
    this.slash.classList.remove("open");
    this.slashRows = [];
    this.slashFor = null;
  }

  /**
   * A command typed alone with its space (`/compact `): what it takes after
   * it, greyed where that would go, until something is typed there. Not in a
   * right-to-left field, where the command's place moves with the text.
   */
  private renderGhost() {
    const project = this.project?.path;
    const other = this.chat?.other ?? (this.chat?.id ? null : this.otherReady());
    const list = project ? this.commands.get(project)?.list ?? [] : [];
    const hint = project && !other && document.activeElement === this.input
      ? pendingHint(this.input.value, menuCommands(list))
      : "";
    const hide = () => this.ghost.classList.remove("open");
    if (!hint) return hide();
    const style = getComputedStyle(this.input);
    if (style.direction === "rtl") return hide();
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ctx = measurer.getContext("2d");
    if (!ctx) return hide();
    ctx.font = font;
    const input = this.input;
    const left = input.offsetLeft + input.clientLeft + parseFloat(style.paddingLeft) + ctx.measureText(input.value).width;
    const right = input.offsetLeft + input.clientLeft + input.clientWidth - parseFloat(style.paddingRight);
    // No room left on the line: no hint.
    if (right - left < 24) return hide();
    this.ghost.textContent = hint;
    Object.assign(this.ghost.style, {
      font,
      lineHeight: style.lineHeight,
      left: `${left}px`,
      top: `${input.offsetTop + input.clientTop + parseFloat(style.paddingTop)}px`,
      maxWidth: `${right - left}px`,
    });
    this.ghost.classList.add("open");
  }

  /** The menu's keys: arrows to move, Tab or Enter to pick, Escape to put it away. True when it took the key. */
  private slashKey(e: KeyboardEvent): boolean {
    if (!this.slash.classList.contains("open") || e.isComposing) return false;
    const rows = this.slashRows;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length) {
      e.preventDefault();
      this.slashAt = (this.slashAt + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      this.renderSlash();
      return true;
    }
    if (e.key === "Escape") {
      // The panel stays open: only the menu goes.
      e.preventDefault();
      e.stopPropagation();
      this.slashDismissed = this.input.value;
      this.closeSlash();
      return true;
    }
    const picked = rows[this.slashAt];
    if (!picked || !(e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) return false;
    // Typed out in full already: Enter sends it as it is.
    if (e.key === "Enter" && this.input.value.trim().toLowerCase() === `/${picked.name.toLowerCase()}`) return false;
    e.preventDefault();
    this.pickSlash(picked);
    return true;
  }

  /** The command into the field, the caret after it for its arguments. */
  private pickSlash(c: MenuCommand) {
    this.input.value = withCommand(this.input.value, c.name);
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.fitInput();
    this.renderComposer();
  }

  /**
   * A run started with these commands: one the menu doesn't know (a plugin
   * installed since, registered as the session started) makes it ask again.
   */
  private commandsSeen(project: string, names: string[]) {
    const known = this.commands.get(project);
    if (!known?.list || known.asking) return;
    const have = new Set(known.list.map((c) => c.name));
    if (names.some((n) => !n.startsWith("_") && !have.has(n))) this.commands.delete(project);
  }

  /** A project's commands, asked of Claude Code when the menu first opens there, and again once stale. */
  private askCommands(project: string) {
    const known = this.commands.get(project);
    if (known && (known.asking || Date.now() - known.at < COMMANDS_FRESH_MS)) return;
    const entry = { list: known?.list ?? null, at: known?.at ?? 0, asking: true };
    this.commands.set(project, entry);
    Bridge.codeCommands(project)
      .then(
        (list) => {
          entry.list = list;
        },
        (err) => {
          // Only /btw then; asked again once this is stale.
          entry.list ??= [];
          void Bridge.log(`buddy: commands failed: ${errorText(err)}`);
        },
      )
      .finally(() => {
        entry.at = Date.now();
        entry.asking = false;
        this.renderSlash();
      });
  }

  /** The text field grows with what is typed, up to a few lines. */
  private fitInput() {
    const input = this.input;
    // Folded to its one pixel, the field has no width to be measured by.
    if (input.clientWidth < 40) return;
    input.style.height = "auto";
    const full = input.scrollHeight;
    input.style.height = `${Math.min(120, full)}px`;
    // A scrollbar only once it is as tall as it gets.
    input.style.overflowY = full > 120 ? "auto" : "hidden";
  }
}
