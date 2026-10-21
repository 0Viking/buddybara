// The buddy's terminal (src-tauri/src/terminal.rs): interactive Claude Code in
// a real console, drawn here by xterm.js — for what a `claude -p` run can't
// do: /mcp sign-ins, /login, anything that asks. Opened on a conversation, it
// resumes that session; on a project's list, it starts a new one there. A
// message sent from the panel in that conversation quits it between turns
// (quit, buddy.ts takeFromTerminal), and opening it again resumes it.

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Bridge, onEvent } from "../core/bridge";
import { THEME_EVENT, textScale, themeColor } from "../core/theme";
import { t } from "../i18n/i18n";
import { h } from "../views/dom";

/** Its text at the usual size; Settings → Customization's text size scales it. */
const TERMINAL_FONT_PX = 12;

/** quit(): between its Ctrl+Cs, and how long Claude Code gets to end before it is closed. */
const QUIT_GAP_MS = 150;
const QUIT_WAIT_MS = 2500;

const sleep = (ms: number) => new Promise<void>((done) => window.setTimeout(done, ms));

/** Where it runs: a project folder, and the session it resumes (null: a new one). */
export interface TermTarget {
  project: string;
  session: string | null;
}

export class BuddyTerminal {
  /** Its place in the panel; xterm.js draws inside. */
  readonly el = h("div", { class: "b-term" });
  /** What it was last opened on. */
  target: TermTarget | null = null;

  private xterm: Terminal | null = null;
  private fit = new FitAddon();
  private id: number | null = null;
  private ended = true;
  /** Its screen as it came before terminal_open answered with its id, by id. */
  private early = new Map<number, string[]>();
  private earlyEnd = new Set<number>();
  /** quit() waiting for Claude Code to end. */
  private waiting: (() => void)[] = [];

  /** `ended`: Claude Code exited (read the session again). `leave`: back to the conversation. */
  constructor(
    private onEnded: (target: TermTarget) => void,
    private onLeave: () => void,
  ) {
    // The panel never changes size, but the view does come and go.
    new ResizeObserver(() => this.refit()).observe(this.el);
  }

  async init() {
    await onEvent<{ id: number; data: string }>("terminal-output", (e) => {
      if (e.id === this.id) this.xterm?.write(e.data);
      else if (this.id == null) this.keep(e.id, e.data);
    });
    await onEvent<{ id: number; code: number }>("terminal-exit", (e) => {
      if (e.id === this.id) this.end();
      else if (this.id == null) this.earlyEnd.add(e.id);
    });
  }

  /** Claude Code runs in it now, for `target`. */
  runsFor(target: TermTarget): boolean {
    return !this.ended && this.target != null && same(this.target, target);
  }

  /** Running at all, for whatever. */
  get running(): boolean {
    return !this.ended;
  }

  /** Shown (so it can be measured): Claude Code for `target`, unless it already runs for it. */
  async open(target: TermTarget) {
    const term = this.ensure();
    this.refit();
    term.focus();
    if (this.runsFor(target)) return;
    if (this.id != null && !this.ended) void Bridge.terminalClose(this.id);
    term.reset();
    this.target = target;
    this.id = null;
    this.ended = false;
    this.early.clear();
    this.earlyEnd.clear();
    try {
      const id = await Bridge.terminalOpen(target.project, target.session, term.cols, term.rows);
      this.id = id;
      for (const data of this.early.get(id) ?? []) term.write(data);
      this.early.clear();
      if (this.earlyEnd.has(id)) this.end();
    } catch (err) {
      this.ended = true;
      term.write(`\r\n${String(err instanceof Error ? err.message : err)}\r\n`);
    }
  }

  focus() {
    this.xterm?.focus();
  }

  /** Ends it, as closing a terminal window would. */
  close() {
    if (this.id != null && !this.ended) void Bridge.terminalClose(this.id);
  }

  /**
   * Claude Code quits as the user would quit it: Ctrl+C, three times (the
   * first clears a draft or shuts a menu, then twice is Claude Code's own
   * exit). Ctrl+C only ever cancels: it never answers yes to anything. Still
   * running after that, it is closed like a window. Resolves once it ended.
   */
  async quit() {
    const id = this.id;
    if (id == null || this.ended) return;
    const gone = new Promise<void>((done) => this.waiting.push(done));
    for (let i = 0; i < 3 && !this.ended; i++) {
      void Bridge.terminalWrite(id, "\x03");
      await sleep(QUIT_GAP_MS);
    }
    if (await Promise.race([gone.then(() => true), sleep(QUIT_WAIT_MS).then(() => false)])) return;
    void Bridge.terminalClose(id);
    await Promise.race([gone, sleep(QUIT_WAIT_MS)]);
  }

  private keep(id: number, data: string) {
    const kept = this.early.get(id) ?? [];
    kept.push(data);
    this.early.set(id, kept);
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.xterm?.write(`\r\n\x1b[2m${t("Claude Code ended. Press any key to go back.")}\x1b[0m\r\n`);
    for (const done of this.waiting.splice(0)) done();
    if (this.target) this.onEnded(this.target);
  }

  private refit() {
    if (!this.xterm || this.el.clientWidth < 40 || this.el.clientHeight < 40) return;
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  private ensure(): Terminal {
    if (this.xterm) return this.xterm;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
      fontSize: TERMINAL_FONT_PX * textScale(),
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      // ConPTY redraws lines itself: xterm.js mustn't reflow them twice.
      windowsPty: { backend: "conpty" },
      theme: terminalTheme(),
    });
    // Another scheme or text size in Settings: the terminal takes it at once.
    window.addEventListener(THEME_EVENT, () => {
      term.options.theme = terminalTheme();
      const px = TERMINAL_FONT_PX * textScale();
      if (term.options.fontSize !== px) {
        term.options.fontSize = px;
        this.refit();
      }
    });
    term.loadAddon(this.fit);
    // A sign-in prints its link: a click opens it in the browser.
    term.loadAddon(new WebLinksAddon((_e, uri) => void Bridge.openUrl(uri)));
    term.open(this.el);
    term.onData((data) => {
      if (this.ended) this.onLeave();
      else if (this.id != null) void Bridge.terminalWrite(this.id, data);
    });
    term.onResize(({ cols, rows }) => {
      if (this.id != null && !this.ended) void Bridge.terminalResize(this.id, cols, rows);
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey) return true;
      const key = e.key.toLowerCase();
      // Ctrl+C with text selected copies it; without, it is Claude's Ctrl+C.
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Ctrl+V: the browser pastes, and xterm.js takes the paste.
      return key !== "v";
    });
    this.xterm = term;
    return term;
  }
}

/** The panel's colours for xterm.js, which draws them itself. */
function terminalTheme() {
  const accent = themeColor("mikan");
  return {
    background: themeColor("bg"),
    foreground: themeColor("code"),
    cursor: accent,
    selectionBackground: `${accent}59`,
  };
}

function same(a: TermTarget, b: TermTarget): boolean {
  return a.session === b.session && a.project.toLowerCase() === b.project.toLowerCase();
}
