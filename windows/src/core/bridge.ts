// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[buddybara] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

/** A folder under ~/projects (code.rs Project). `last`: Unix seconds, 0 = never. */
export interface CodeProject {
  name: string;
  path: string;
  sessions: number;
  last: number;
}

/** One of a project's Claude Code conversations (code.rs Session). */
export interface CodeSession {
  id: string;
  title: string;
  prompt: string;
  last: number;
}

/** A conversation's line (code.rs Message): a step carries its tool, worded on this side. */
export interface CodeMessage {
  role: "user" | "assistant" | "step";
  text: string;
  tool?: string;
  input?: Record<string, unknown>;
}

/** How a run works: a permission mode of the picker, an effort and a model (null = Claude Code's). */
export interface CodeRunOptions {
  mode: string;
  effort: string | null;
  model: string | null;
  /** Workflows on every task, together with `effort` (whatever its level). */
  ultracode: boolean;
}

/** One `code-run` event: what code.rs `events` makes of Claude Code's stream. */
export interface CodeRunEvent {
  run: number;
  kind: "init" | "text" | "tool" | "result" | "exit";
  session?: string | null;
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  error?: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Buddybara\buddybara.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Plan usage: the status line relay, installed apart from the hooks ──────
  /** Diff of the status line change. `install: false` previews taking the relay out. */
  statusLinePreview: (install: boolean) => callOrThrow<HookPreview>("status_line_preview", { install }),
  /** Same rules as hooksApply: an explicit click, and only for the diff that was shown. */
  statusLineApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("status_line_apply", { install, fingerprint }),
  /** The Claude plan's windows as the account reports them (claude.rs plan_usage), or null. */
  claudePlanUsage: () => call<unknown>("claude_plan_usage"),

  // ── Connectors: Claude Code's MCP servers (src-tauri/src/mcp.rs) ──────────
  /** The catalog alone, at once (every state "missing"). */
  mcpCatalog: async () => (await call<McpEntry[]>("mcp_catalog")) ?? [],
  /** The catalog with each service's state, then the other configured servers (`claude mcp list`). */
  mcpStatus: () => callOrThrow<McpEntry[]>("mcp_status"),
  /** Signs Claude Code in to a catalog service in the browser; resolves once it is done. `again`: Re-auth. */
  mcpConnect: (id: string, again: boolean) => callOrThrow<void>("mcp_connect", { id, again }),
  /** Ends the sign-in under way. */
  mcpCancel: () => call<void>("mcp_cancel"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Claude Code projects and sessions (src-tauri/src/code.rs) ─────────────
  /** The folders under the Projects root, most recent work first. */
  codeProjects: async () => (await call<CodeProject[]>("code_projects")) ?? [],
  /** Opens a native folder picker for the Projects root; returns the chosen path, or null if cancelled. */
  codePickProjectsFolder: () => callOrThrow<string | null>("code_pick_projects_folder"),
  /** Creates a folder under the Projects root and returns it (code.rs new_project). */
  codeNewProject: (name: string) => callOrThrow<CodeProject>("code_new_project", { name }),
  codeSessions: (project: string) => callOrThrow<CodeSession[]>("code_sessions", { project }),
  codeMessages: (project: string, session: string) =>
    callOrThrow<CodeMessage[]>("code_messages", { project, session }),
  /** Names a session as Claude Code's rename does; resolves to the name as kept. */
  codeRenameSession: (project: string, session: string, name: string) =>
    callOrThrow<string>("code_rename_session", { project, session, name }),
  /** Sends a session (its file and its folder) to the Recycle Bin. */
  codeDeleteSession: (project: string, session: string) =>
    callOrThrow<void>("code_delete_session", { project, session }),
  /** The buddy's terminal (terminal.rs): Claude Code in a real console; `terminal-output` / `terminal-exit` follow. */
  terminalOpen: (project: string, session: string | null, cols: number, rows: number) =>
    callOrThrow<number>("terminal_open", { project, session, cols, rows }),
  terminalWrite: (id: number, data: string) => call<void>("terminal_write", { id, data }),
  terminalResize: (id: number, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: number) => call<void>("terminal_close", { id }),
  /** Starts (session null) or continues a conversation; `code-run` events follow.
   *  `attachments`: inbox paths (ingestFile, pasteFile) the prompt comes with. */
  codeSend: (project: string, session: string | null, prompt: string, options: CodeRunOptions, attachments: string[] = []) =>
    callOrThrow<number>("code_send", { project, session, prompt, options, attachments }),
  codeStop: (run: number) => call<void>("code_stop", { run }),
  /** Writes a pasted file into the inbox. The bytes go as they are; `name` must be plain ASCII. */
  pasteFile: (name: string, bytes: Uint8Array) => {
    if (!IS_TAURI) return Promise.reject(new Error("not running inside Buddybara"));
    return invoke<DroppedFile>("paste_file", bytes, { headers: { "x-file-name": name } });
  },

  // ── Files and secrets ────── ──────────────────────────────────────────────────
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),

  // ── Buddybara on the desktop (src-tauri/src/desktop.rs) ───────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_buddybara_info"),
  /** A drag started on the desktop Buddybara; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_buddybara_drag_begin"),
  /** X11: top-left corner, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_buddybara_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_buddybara_drag_end", { x, y }),
  /** From the island to his spot. False: no spot on any connected display.
   *  `anywhere`: the first-visit corner then, rather than staying home. */
  desktopFlyOut: (anywhere = false) => call<boolean>("desktop_buddybara_fly_out", { anywhere }),
  /** Asleep, the cursor poll stops. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_buddybara_set_asleep", { asleep }),
  /** Buddy mode, his minimize button: off the screen until Buddybara is started again. */
  desktopPutAway: () => call<void>("desktop_buddybara_put_away"),
  /** Buddy mode: where the panel's funnel meets him, in the panel window's pixels (null: off screen). */
  desktopAnchor: () => call<[number, number] | null>("desktop_buddybara_anchor"),

};

/** How the desktop Buddybara's window works here (platform::DesktopMode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
  /** His window is on screen now (a page loading late still learns to draw). */
  shown: boolean;
}

/** An event for one window only (island ⇄ desktop Buddybara). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[buddybara] emit ${event} failed`, err);
  }
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Buddybara's status line relay (plan usage) is the status line in settings.json. */
  planRelayInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

/** One MCP server as Settings → Connectors shows it (mcp.rs Entry). */
export interface McpEntry {
  /** The catalog id, or the server's own name for the others. */
  id: string;
  name: string;
  state: "connected" | "needsAuth" | "pending" | "failed" | "disabled" | "missing";
  /** "work" | "design" | "dev" | "business", or "other" outside the catalog. */
  group: string;
  /** In the catalog: it has an Auth button. */
  catalog: boolean;
  /** Signed in on claude.ai rather than from here. */
  claudeAi: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Buddybara");
  return invoke<T>(cmd, args);
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Hands dropped File objects to Rust, which answers the island with their real
 * paths as a `file-drag` drop (webview_drop.rs). False without WebView2.
 */
export function postDroppedFiles(files: FileList): boolean {
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) return false;
  webview.postMessageWithAdditionalObjects("buddybara-file-drop", files);
  return true;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) handler({ type: "enter" });
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) handler({ type: "leave" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    webview.postMessageWithAdditionalObjects("buddybara-file-drop", files);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
