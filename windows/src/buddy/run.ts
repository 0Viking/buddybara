// The buddy panel's conversations (buddy.ts), kept free of the DOM: what a run
// says turns into lines, and times into "3 min ago". Tested on their own.

import type { CodeMessage, CodeProject, CodeRunEvent } from "../core/bridge";
import { stepLabel } from "../island/hooks";
import { language, t } from "../i18n/i18n";

/** `files`: a user line's attachments, by path. */
export type Line = { role: "user" | "assistant" | "step" | "error"; text: string; files?: string[] };

/** Typed while a run that can't take it was at work: the next turn, sent when that run ends. */
export interface Queued {
  text: string;
  files: string[];
}

/** A conversation on screen. `id` is null until a new one's run names it. */
export interface Chat {
  project: CodeProject;
  id: string | null;
  title: string;
  lines: Line[];
  loading: boolean;
  /** The run working on it (code.rs run id), while one is. */
  run: number | null;
  /** A run between turns, kept alive by its background tasks (a dev server):
   *  the next message goes into it, and a turn it starts by itself shows up. */
  alive?: number | null;
  queue: Queued[];
  /** How its run ended: with an error, or stopped by the user. */
  failed: boolean;
  stopped: boolean;
  /** A conversation with another model than Claude Code (chat.rs): no session, not saved. */
  other?: OtherModel;
}

/** Another model a conversation goes to: a provider of Settings → AI models and its model. */
export interface OtherModel {
  provider: string;
  model: string;
}

export function makeChat(project: CodeProject, id: string | null, title: string): Chat {
  return { project, id, title, lines: [], loading: false, run: null, queue: [], failed: false, stopped: false };
}

/** "3 min ago", or the date once it is more than a day old. */
export function ago(seconds: number, now = Date.now()): string {
  if (!seconds) return "";
  const s = now / 1000 - seconds;
  if (s < 60) return t("just now");
  if (s < 3600) return t("{n} min ago", { n: Math.floor(s / 60) });
  if (s < 86400) return t("{n} h ago", { n: Math.floor(s / 3600) });
  return new Date(seconds * 1000).toLocaleDateString(language(), { day: "numeric", month: "short" });
}

/** The last folder of a path, for a project the list doesn't have. */
export function folderOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Adds what a run said to its conversation (code.rs `events`). */
export function applyRunEvent(chat: Chat, e: CodeRunEvent) {
  const last = chat.lines[chat.lines.length - 1];
  switch (e.kind) {
    case "init":
      if (e.session) chat.id = e.session;
      break;
    case "text":
      if (!e.text) break;
      // The pieces of one answer read as one message, as in the transcript.
      if (last?.role === "assistant") last.text += `\n\n${e.text}`;
      else chat.lines.push({ role: "assistant", text: e.text });
      break;
    case "tool":
      chat.lines.push({ role: "step", text: stepLabel(e.tool ?? "Tool", e.input ?? {}) });
      break;
    case "result": {
      chat.failed = e.error === true;
      // The turn's last answer: messages sent while it was written may follow it.
      let at = chat.lines.length - 1;
      while (chat.lines[at]?.role === "user") at--;
      const answer = chat.lines[at]?.role === "assistant" ? chat.lines[at] : undefined;
      if (e.error) {
        const text = e.text || "Claude Code stopped.";
        // An API error comes as Claude's answer first, then as the result: one
        // red line, not the same words twice.
        if (answer?.text.endsWith(text)) {
          answer.text = answer.text.slice(0, -text.length).trimEnd();
          if (!answer.text) chat.lines.splice(at, 1);
        }
        chat.lines.push({ role: "error", text });
      }
      // The result repeats the last answer; anything else is news.
      else if (e.text && !answer?.text.endsWith(e.text)) {
        chat.lines.push({ role: "assistant", text: e.text });
      }
      if (e.session) chat.id = e.session;
      break;
    }
  }
}

/** Heads the list of files code.rs `with_attachments` puts after a prompt. */
const ATTACHED = "Attached files:";

/** A sent prompt split back into what was typed and the files it came with. */
export function splitAttachments(text: string): { text: string; files: string[] } {
  const at = text.lastIndexOf(ATTACHED);
  if (at < 0) return { text, files: [] };
  const typed = text.slice(0, at);
  const items = text.slice(at + ATTACHED.length).split("\n").filter((l) => l.trim());
  if ((typed && !typed.endsWith("\n\n")) || !items.length || !items.every((l) => l.startsWith("- "))) {
    return { text, files: [] };
  }
  return { text: typed.trimEnd(), files: items.map((l) => l.slice(2).trim()) };
}

export function userLine(text: string, files: string[]): Line {
  return files.length ? { role: "user", text, files } : { role: "user", text };
}

/** A line of a conversation read back from its file, drawn as a live run draws it. */
export function lineOf(m: CodeMessage): Line {
  if (m.role === "step") return { role: "step", text: stepLabel(m.tool ?? "Tool", m.input ?? {}) };
  if (m.role === "user") {
    const sent = splitAttachments(m.text);
    return userLine(sent.text, sent.files);
  }
  return { role: m.role, text: m.text };
}

/** Several queued turns as the one message they go as. */
export function mergeQueued(items: Queued[]): Queued {
  return { text: items.map((q) => q.text).filter(Boolean).join("\n\n"), files: items.flatMap((q) => q.files) };
}

/** The queued turns as one prompt, moved into the conversation (`lines`) as they go. */
export function takeQueue(chat: Chat): { prompt: string; attachments: string[]; lines: Line[] } | null {
  if (!chat.queue.length) return null;
  const queued = chat.queue;
  chat.queue = [];
  const lines = queued.map((q) => userLine(q.text, q.files));
  chat.lines.push(...lines);
  const next = mergeQueued(queued);
  return { prompt: next.text, attachments: next.files, lines };
}

/** The queued turns taken back unsent (their run failed or was stopped). */
export function dropQueue(chat: Chat): Queued | null {
  if (!chat.queue.length) return null;
  const queued = chat.queue;
  chat.queue = [];
  return mergeQueued(queued);
}

/** What one run takes (code.rs MAX_PROMPT, files.rs MAX_ATTACHMENTS and PASTE_MAX). */
export const MAX_PROMPT = 100_000;
export const MAX_ATTACHMENTS = 20;
export const PASTE_MAX_MB = 25;

/** The length code.rs counts for a message: characters of the prompt it makes (`with_attachments`). */
export function sentLength(text: string, files: string[]): number {
  if (!files.length) return [...text].length;
  const list = `${ATTACHED}\n${files.map((f) => `- ${f}`).join("\n")}`;
  return [...(text ? `${text}\n\n${list}` : list)].length;
}

/** Why code.rs would refuse this message, said before anything is cleared; null when it can go. */
export function tooBig(text: string, files: string[]): string | null {
  if (files.length > MAX_ATTACHMENTS) return t("At most {max} files at a time.", { max: MAX_ATTACHMENTS });
  if (sentLength(text, files) > MAX_PROMPT) return t("A message is at most {max} characters.", { max: MAX_PROMPT });
  return null;
}

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
};

/**
 * The name a pasted file goes under: its own when it is a real file name in
 * plain ASCII (a header carries it), else `pasted-<date>-<time>.<type>` — a
 * screenshot comes off the clipboard as "image.png", every time.
 */
export function pastedName(name: string, type: string, now = new Date()): string {
  const plain = name.replace(/[^\w .()-]/g, "").trim();
  if (/^[^.].*\.\w+$/.test(plain) && !/^image\.\w+$/i.test(plain)) return plain;
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = IMAGE_TYPES[type] ?? /\.(\w+)$/.exec(plain)?.[1] ?? "bin";
  return `pasted-${day}-${time}.${ext}`;
}
