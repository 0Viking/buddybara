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
} from "../core/bridge";
import { BUDDY_H, BUDDY_NECK, BUDDY_W, type AlertView } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type AskedQuestion } from "../core/state";
import { DesktopLink } from "../island/desktop";
import { N_, language, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { renderMarkdown } from "../views/markdown";
import {
  PASTE_MAX_MB, ago, applyRunEvent, dropQueue, folderOf, lineOf, makeChat, mergeQueued, pastedName, takeQueue,
  tooBig, userLine, type Chat, type Line, type OtherModel,
} from "./run";
import { POUR_MS, genieClear, genieFrame, genieHidden, genieWanted } from "./genie";
import { BuddyTerminal, type TermTarget } from "./terminal";
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

function lineView(line: Line): HTMLElement {
  if (line.role === "user") return sentView(line.text, line.files);
  if (line.role === "assistant") {
    const reply = h("div", { class: "reply" });
    renderMarkdown(reply, line.text);
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
  /** Why the last file (or message) couldn't be taken. */
  private attachError = "";
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
  private closeTimer: number | null = null;
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
  private termBtn = h("button", { class: "b-icon", title: tl("Terminal") }, svg(ICONS.terminal, 14, { stroke: 1.8 }));
  /** New conversation, or, in one, deleting it. */
  private newBtn = h("button", { class: "b-icon" });
  private confirm = h("div", { class: "b-confirm" });
  /** "Delete this conversation?" is asked. */
  private confirming = false;
  /** The terminal is on screen in place of the conversation. */
  private termShown = false;
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
  private servicesRow = h("button", { class: "b-project b-services" });
  private terminal = new BuddyTerminal(
    (target) => this.terminalEnded(target),
    () => this.hideTerminal(),
  );
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
    const sideFoot = h("div", { class: "b-side-foot" }, settingsBtn);
    const side = h("aside", { class: "b-side" }, this.servicesRow, sideHead, this.newRow, this.list, sideFoot);
    const bar = h("div", { class: "b-bar" }, this.back, this.title, this.termBtn, this.modeBtn, this.newBtn, closeBtn);
    const main = h("section", { class: "b-main" },
      bar, this.menu, this.confirm, this.body, this.terminal.el, this.card, this.files, this.composer, this.dropZone);
    this.el = h("div", { id: "buddy" }, side, main);
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
      else void this.showTerminal();
    });
    this.buildConfirm();
    // A click anywhere else is "no" to the question.
    document.addEventListener("pointerdown", (e) => {
      const at = e.target as Node;
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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => {
      this.fitInput();
      this.renderComposer();
    });
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
    // A screenshot (or a copied file) pasted anywhere in the panel is attached;
    // text is left to the field.
    document.addEventListener("paste", (e) => this.onPaste(e));
    // The window never takes the keyboard by itself (no-activate): a press in
    // the panel asks for it, and touching the panel keeps an alert open.
    this.el.addEventListener("pointerdown", () => {
      this.disarmClose();
      void Bridge.focusWindow(true);
    });
    this.el.addEventListener("pointerenter", () => this.disarmClose());
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.shown) return;
      // Escape in the terminal is Claude's (it interrupts, it closes its menus).
      if (this.terminal.el.contains(e.target as Node)) return;
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

  /** Opened by an alert, it folds away by itself unless touched (Settings' auto-close). */
  show(byAlert: boolean) {
    const was = this.shown;
    if (!was) {
      this.shown = true;
      this.el.inert = false;
      this.el.classList.add("open");
      void this.pour(true);
      void this.loadProjects();
      void this.refreshOtherKeys();
      Sound.play("open");
      // The conversation it opens on is looked at now.
      this.seen(this.chat?.id ?? null);
    }
    if (byAlert && !was) this.armClose();
    if (!byAlert) {
      this.disarmClose();
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
    this.setDragging(false);
    // Folded, the window may keep the keyboard: what is typed next must reach
    // nothing nobody sees — an Enter in the field, a Space on the Stop button.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.el.contains(focused)) focused.blur();
    this.el.inert = true;
    this.disarmClose();
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

  private armClose() {
    this.disarmClose();
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!State.pendingApproval) this.hide();
    }, State.settings.autoCloseInterval * 1000);
  }

  private disarmClose() {
    if (this.closeTimer != null) window.clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  private async loadProjects() {
    this.projects = await Bridge.codeProjects();
    this.renderProjects();
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
    if (!task?.sessionId || !task.sessionCwd) return;
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
      ?? { name: folderOf(task.sessionCwd), path: task.sessionCwd, sessions: 0, last: 0 };
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
    if (chat.run != null || chat.queue.length) this.live.set(chat.id, chat);
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
    const text = this.input.value.trim();
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
    // Claude Code has it open in the terminal: two of them would write one session.
    if (chat.id && this.terminal.runsFor({ project: chat.project.path, session: chat.id })) {
      this.attachError = t("This conversation is open in the terminal.");
      this.renderAttachments();
      return;
    }
    // What code.rs would refuse is said now, while nothing is cleared yet (a
    // queued turn goes merged with those before it).
    const goes = chat.run != null ? mergeQueued([...chat.queue, { text, files }]) : { text, files };
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
    if (e.kind === "exit") {
      this.runs.delete(e.run);
      chat.run = null;
      this.ended(chat);
    } else {
      applyRunEvent(chat, e);
      if (e.kind === "init") this.named(chat);
      if (e.kind === "result") Sound.play(e.error ? "error" : "finish");
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
    if (!kind || !p.session_id || !p.cwd || (p.buddybara_agent && p.buddybara_agent !== "claude-desktop")) return;
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
    this.renderServicesRow();
    this.renderNewProject();
    this.renderProjects();
    this.renderBar();
    this.renderMenu();
    this.confirm.classList.toggle("open", this.confirming && this.chat?.id != null);
    this.el.querySelector(".b-main")?.classList.toggle("terming", this.termShown);
    this.renderBody();
    this.renderCard();
    this.renderAttachments();
    this.renderComposer();
  }

  private renderNewProject() {
    this.newRow.classList.toggle("open", this.creating);
    this.newError.style.display = this.newError.textContent ? "" : "none";
  }

  /** Whether a run of ours works in this project, or in this session. */
  private working(project: string, session?: string): boolean {
    for (const c of this.runs.values()) {
      if (session ? c.id === session : c.project.path === project) return true;
    }
    return false;
  }

  private renderProjects() {
    const news = this.projectNotices();
    const rows = this.projects.map((p) => [p.name, p.path, p.sessions, this.working(p.path), news.get(samePath(p.path)) ?? null]);
    keyed(this.list, [this.project?.path, rows], () => {
      clear(this.list);
      for (const p of this.projects) {
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
        this.list.append(row);
      }
    });
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
    if (!target || this.chat?.run != null) return;
    this.termShown = true;
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
    this.termShown = false;
    this.render();
    if (this.shown) this.input.focus();
  }

  /** Elsewhere in the panel: the terminal view goes (Claude Code keeps running in it). */
  private leaveTerminal() {
    this.termShown = false;
    this.confirming = false;
  }

  /** Claude Code ended in the terminal: what it wrote there shows in the conversation, or the list. */
  private terminalEnded(target: TermTarget) {
    void this.loadProjects();
    const chat = this.chat;
    if (target.session && chat?.id === target.session && chat.run == null) {
      void this.reloadChat(chat);
    } else if (!target.session && !chat && this.project && samePath(this.project.path) === samePath(target.project)) {
      // The list again, the terminal left on screen: its last words stay readable.
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
    try {
      chat.lines = (await Bridge.codeMessages(chat.project.path, chat.id)).map(lineOf);
    } catch {
      return;
    }
    if (this.chat === chat) this.render();
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
    const kept = this.others.get(chat.project.path) ?? [];
    if (!kept.includes(chat)) this.others.set(chat.project.path, [chat, ...kept]);
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
    keyed(body, [this.notice, this.project?.path, sessions ?? null, this.renaming, others ?? null], () => this.buildList());
  }

  /** The picked project's sessions, or why there are none. */
  private buildList() {
    const body = this.body;
    clear(body);
    if (this.notice) body.append(h("div", { class: "b-error", text: this.notice }));
    if (!this.project) {
      body.append(h("div", { class: "b-hint", text: t("Pick a project") }));
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
    for (const line of chat.lines) log.append(lineView(line));
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
    this.files.classList.toggle("open", this.attachments.length > 0 || this.copying.length > 0 || this.attachError !== "");
    keyed(this.files, [this.attachments.map((f) => f.path), this.copying, this.attachError], () => {
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
  }

  /** The text field grows with what is typed, up to a few lines. */
  private fitInput() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }
}
