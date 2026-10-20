// Markdown in the chat's answers, as on the Mac (ChatMarkdown.swift and
// ChatMarkdownView.swift): headings, paragraphs, fenced code with a copy button,
// bullet and numbered lists, quotes and rules, with bold, italic, `code` and
// links inside the text.
//
// Everything is built as DOM nodes with textContent, never as HTML, so nothing
// a model writes can inject markup. A web link (http(s), as [text](url) or
// written out) opens in the browser through Rust, which checks the scheme
// again. A link to a file or folder ([text](path#L12), file:///…, C:\…, a
// path in `code`) is opened by Rust too: a folder in File Explorer, a file in
// VS Code — shown, never run.

import { Bridge } from "../core/bridge";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t } from "../i18n/i18n";

const STRINGS = {
  copy: N_("Copy"),
  copied: N_("Copied"),
  missing: N_("That file was not found."),
};

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; code: string }
  /** `prefix` is "•" or "1."; `indent` the nesting level, from 0. */
  | { kind: "item"; prefix: string; text: string; indent: number }
  | { kind: "quote"; text: string }
  | { kind: "rule" };

const isRule = (s: string) => s === "---" || s === "***" || s === "___";
const isBullet = (s: string) => /^[-*+] /.test(s);
const ordered = (s: string) => /^(\d+)\.\s+/.exec(s);
const isQuote = (s: string) => s.startsWith("> ") || s === ">";

/** Same rules as the Mac's parser, line by line. */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      blocks.push({ kind: "code", lang, code: code.join("\n") });
      i++;
      continue;
    }

    // A heading needs a space after the #s; "#hashtag" stays a paragraph.
    const hashes = /^#+/.exec(line)?.[0].length ?? 0;
    if (hashes && (line.length === hashes || line[hashes] === " ")) {
      const text = line.slice(hashes).trim();
      if (text) blocks.push({ kind: "heading", level: Math.min(hashes, 6), text });
      i++;
      continue;
    }

    const stripped = line.trim();
    if (isRule(stripped)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (isQuote(stripped)) {
      blocks.push({ kind: "quote", text: stripped.startsWith("> ") ? stripped.slice(2) : "" });
      i++;
      continue;
    }

    const indent = Math.floor((line.length - line.trimStart().length) / 2);
    if (isBullet(stripped)) {
      blocks.push({ kind: "item", prefix: "•", text: stripped.slice(2), indent });
      i++;
      continue;
    }
    const number = ordered(stripped);
    if (number) {
      blocks.push({ kind: "item", prefix: `${number[1]}.`, text: stripped.slice(number[0].length), indent });
      i++;
      continue;
    }
    if (!stripped) {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para = [line];
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      const s = next.trim();
      if (!s || next.startsWith("#") || next.startsWith("```") || isQuote(s) || isBullet(s) || isRule(s) || ordered(s)) break;
      para.push(next);
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

// ── Inline ────────────────────────────────────────────────────────────────────

/** A file or folder a link points at; a relative path is from the conversation's project. */
export interface FileTarget {
  path: string;
  line: number | null;
}

export type Inline =
  | { kind: "text"; text: string }
  /** `url` / `file`: `code` that is a web address or a path, clickable too. */
  | { kind: "code"; text: string; url?: string | null; file?: FileTarget | null }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  /** Neither `url` nor `file`: not something to open — the text stays, the link goes. */
  | { kind: "link"; url: string | null; file?: FileTarget | null; children: Inline[] };

/**
 * `code`, **bold**, __bold__, *italic*, _italic_ and [text](url), whichever
 * comes first. No lookbehind: older WebKitGTK builds reject it, and one bad
 * regex literal would take the whole island down with it.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

const isWordChar = (c: string | undefined) => c != null && /\w/.test(c);

/** The address if it is an http(s) one; anything else (javascript:, file:, data:…) is not a link. */
export function safeWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** `#L12`, `#L12-L20`, `:12`, `:12:5` at the end of a path. */
const LINE_SUFFIX = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/;
const ABSOLUTE = /^[A-Za-z]:[\\/]|^\\\\/;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * The file or folder a link target names: an absolute Windows path, a
 * file:/// URL, or a relative path (with a folder or an extension in it),
 * with its line if it says one. Null for anything else (another scheme, an
 * anchor, a word).
 */
export function fileTarget(raw: string): FileTarget | null {
  let s = raw.trim();
  if (!s || s.startsWith("#")) return null;
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  }
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !ABSOLUTE.test(s)) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* as it is */
  }
  let line: number | null = null;
  const m = LINE_SUFFIX.exec(s);
  if (m && (m[2] || m[3])) {
    s = m[1];
    line = Number(m[2] ?? m[3]);
  }
  // No Windows path holds these (past the drive's colon).
  if (!s || /[<>"|?*]/.test(s.slice(2))) return null;
  const relative = /^\.{1,2}[\\/]/.test(s) || /[\\/]/.test(s) || EXTENSION.test(s);
  return ABSOLUTE.test(s) || relative ? { path: s, line } : null;
}

/**
 * `code` that names a file to open: an absolute path (spaces and all), or a
 * relative one with a folder and an extension (`src/main.ts:12`). Not a bare
 * name, nor a command (`npm run build`).
 */
function codeTarget(text: string): FileTarget | null {
  const s = text.trim();
  const absolute = ABSOLUTE.test(s);
  if (!absolute && (/\s/.test(s) || !/[\\/]/.test(s))) return null;
  const target = fileTarget(s);
  if (!target || (!absolute && !EXTENSION.test(target.path))) return null;
  return target;
}

/**
 * Written-out addresses in plain text: web ones, and absolute Windows paths
 * that end in a file name (where one with a space would be cut short, it
 * isn't a file name and stays text).
 */
const BARE = /\bhttps?:\/\/[^\s<>"'`]+|\b[A-Za-z]:\\[^\s<>"'`|?*]+/g;

/** The written-out address without the punctuation of the sentence around it. */
function trimAddress(raw: string): string {
  let s = raw.replace(/[.,;:!?'"]+$/, "");
  // A closing bracket belongs to the address only if it opened one.
  while (/[)\]}]$/.test(s)) {
    const close = s[s.length - 1];
    const open = close === ")" ? "(" : close === "]" ? "[" : "{";
    if (s.split(open).length >= s.split(close).length) break;
    s = s.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
  }
  return s;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const addText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  /** Plain text, with what is written out as an address made a link. */
  const pushText = (t: string) => {
    const bare = new RegExp(BARE.source, "g");
    let from = 0;
    let b: RegExpExecArray | null;
    while ((b = bare.exec(t))) {
      const address = trimAddress(b[0]);
      const web = /^https?:/i.test(address) ? safeWebUrl(address) : null;
      const file = web ? null : EXTENSION.test(address) ? fileTarget(address) : null;
      if (!web && !file) continue;
      addText(t.slice(from, b.index));
      const children: Inline[] = [{ kind: "text", text: address }];
      out.push(web ? { kind: "link", url: web, children } : { kind: "link", url: null, file, children });
      from = b.index + address.length;
      bare.lastIndex = from;
    }
    addText(t.slice(from));
  };
  const re = new RegExp(INLINE.source, "g");
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // snake_case_words are not italics: an opening _ must not follow a letter.
    if (m[5] != null && isWordChar(text[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) {
      const url = safeWebUrl(m[1]);
      const file = url ? null : codeTarget(m[1]);
      out.push(url ? { kind: "code", text: m[1], url } : file ? { kind: "code", text: m[1], file } : { kind: "code", text: m[1] });
    } else if (m[6] != null) {
      const url = safeWebUrl(m[7]);
      const file = url ? null : fileTarget(m[7]);
      const children = parseInline(m[6]);
      out.push(file ? { kind: "link", url, file, children } : { kind: "link", url, children });
    }
    else if (m[2] != null || m[3] != null) out.push({ kind: "strong", children: parseInline(m[2] ?? m[3]) });
    else out.push({ kind: "em", children: parseInline(m[4] ?? m[5]) });
  }
  pushText(text.slice(at));
  return out;
}

/** The conversation's project, while an answer of it is drawn: where relative paths start. */
let drawingBase: string | null = null;

/** A click on `el` opens `url` in the browser, or `file` through Rust. */
function opens(el: HTMLElement, url: string | null | undefined, file: FileTarget | null | undefined) {
  const base = drawingBase;
  el.title = url ?? file?.path ?? "";
  el.addEventListener("click", (e) => {
    e.preventDefault();
    if (url) {
      void Bridge.openUrl(url);
    } else if (file) {
      Bridge.openPath(file.path, file.line, base).catch(() => {
        el.classList.add("md-missing");
        el.title = t(STRINGS.missing);
      });
    }
  });
}

function appendInline(into: HTMLElement, nodes: Inline[]) {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        into.append(document.createTextNode(node.text));
        break;
      case "code": {
        const code = h("code", { class: node.url || node.file ? "md-code md-open" : "md-code", text: node.text });
        if (node.url || node.file) opens(code, node.url, node.file);
        into.append(code);
        break;
      }
      case "strong":
      case "em": {
        const el = h(node.kind === "strong" ? "strong" : "em");
        appendInline(el, node.children);
        into.append(el);
        break;
      }
      case "link": {
        if (!node.url && !node.file) {
          appendInline(into, node.children);
          break;
        }
        const a = h("a", { class: "md-link", href: node.url ?? "#" });
        opens(a, node.url, node.file);
        appendInline(a, node.children);
        into.append(a);
        break;
      }
    }
  }
}

function inline(text: string, into: HTMLElement) {
  appendInline(into, parseInline(text));
}

// ── Blocks ────────────────────────────────────────────────────────────────────

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard API (or no permission): the old way, through a hidden field.
    const area = h("textarea", { style: "position:fixed;opacity:0" }) as HTMLTextAreaElement;
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Puts the code on the clipboard; the check mark shows for a moment. */
function copyButton(text: string): HTMLElement {
  const btn = h("button", { class: "md-copy", title: t(STRINGS.copy), "aria-label": t(STRINGS.copy) }, svg(ICONS.copy, 11));
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await writeClipboard(text);
    btn.replaceChildren(svg(ICONS.check, 11, { stroke: 2.2 }));
    btn.classList.add("done");
    btn.title = t(STRINGS.copied);
    window.setTimeout(() => {
      btn.replaceChildren(svg(ICONS.copy, 11));
      btn.classList.remove("done");
      btn.title = t(STRINGS.copy);
    }, 1500);
  });
  return btn;
}

function render(block: Block): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const el = h("div", { class: block.level <= 2 ? "md-h md-h1" : "md-h" });
      inline(block.text, el);
      return el;
    }
    case "paragraph": {
      const el = h("div", { class: "md-p" });
      inline(block.text, el);
      return el;
    }
    case "code":
      return h("div", { class: "md-pre" }, h("pre", { text: block.code }), copyButton(block.code));
    case "item": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      const item = h("div", { class: "md-item" }, h("span", { class: "md-bullet", text: block.prefix }), text);
      if (block.indent) item.style.paddingLeft = `${block.indent * 12}px`;
      return item;
    }
    case "quote": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      return h("div", { class: "md-quote" }, h("i"), text);
    }
    case "rule":
      return h("hr", { class: "md-rule" });
  }
}

/** Replaces what `into` shows with the Markdown rendered. */
/** `base`: the conversation's project folder, where a relative path in the answer starts. */
export function renderMarkdown(into: HTMLElement, markdown: string, base: string | null = null) {
  drawingBase = base;
  try {
    into.replaceChildren(...parseMarkdown(markdown).map(render));
  } finally {
    drawingBase = null;
  }
}
