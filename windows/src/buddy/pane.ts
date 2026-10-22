// A plugin's pane, drawn in the drawer (buddy.ts paneView): Claude Code sends
// what the plugin's mod draws as a tree of plain elements (code.rs `ui`,
// `ui_render`), and this turns it into the panel's own: boxes, text, buttons,
// fields, pickers, links, code and Markdown. A click, typing or a pick goes
// back through `actions`, with the element's `press` (which plugin, which
// handler); the plugin answers by drawing again. Nothing in the tree is ever
// HTML: text is text, and a link opens only http(s).

import { clear, h } from "../views/dom";
import { renderMarkdown } from "../views/markdown";
import { t } from "../i18n/i18n";

/** One element of a pane's tree, as Claude Code sends it. */
export interface PaneNode {
  type: string;
  props?: Record<string, unknown>;
  children?: PaneChild[];
  /** For what can be pressed, typed in or picked: the plugin and its handler. */
  press?: { plugin: string; handle: number };
}

export type PaneChild = PaneNode | string | number | boolean | null;

/** What the person does in a pane, for the run that holds it. */
export interface PaneActions {
  press(node: PaneNode, href?: string): void;
  input(node: PaneNode, kind: "change" | "submit", value: string): void;
  select(node: PaneNode, value: string): void;
  openUrl(url: string): void;
}

/** Typing is sent this long after the last key (Enter sends at once). */
const TYPING_MS = 250;

/** A size of the terminal's cells (gap, padding, margin) in the panel: a row is about 6 px. */
function cells(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.max(0, v) * 6}px` : null;
}

/** A width or height: a percentage as given, a count of cells as characters. */
function extent(v: unknown): string | null {
  if (typeof v === "string" && /^\d+(\.\d+)?%$/.test(v)) return v;
  return typeof v === "number" && Number.isFinite(v) ? `${Math.max(0, v)}ch` : null;
}

/** The terminal's colour names, in the panel's theme; a #hex as it is. */
const COLORS: Record<string, string> = {
  black: "var(--ink)", white: "var(--ink)", gray: "var(--dim)", grey: "var(--dim)",
  red: "var(--red-text)", green: "var(--green)", yellow: "var(--amber)", blue: "var(--cyan)",
  magenta: "var(--pink)", cyan: "var(--cyan)",
};

export function paneColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  return COLORS[v.replace(/Bright$/, "").toLowerCase()] ?? null;
}

const ALIGN: Record<string, string> = { "flex-start": "flex-start", "flex-end": "flex-end", center: "center", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, string> = { ...ALIGN, "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" };

/** A Box's layout as CSS: a terminal's flexbox (a row unless it says column). */
export function boxStyle(p: Record<string, unknown>): Record<string, string> {
  const s: Record<string, string> = {
    flexDirection: p.flexDirection === "column" || p.flexDirection === "column-reverse" ? String(p.flexDirection) : p.flexDirection === "row-reverse" ? "row-reverse" : "row",
  };
  const set = (key: string, value: string | null | undefined) => {
    if (value) s[key] = value;
  };
  set("gap", cells(p.gap));
  set("columnGap", cells(p.columnGap));
  set("rowGap", cells(p.rowGap));
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const axis = side === "Top" || side === "Bottom" ? "Y" : "X";
    set(`padding${side}`, cells(p[`padding${side}`] ?? p[`padding${axis}`] ?? p.padding));
    set(`margin${side}`, cells(p[`margin${side}`] ?? p[`margin${axis}`] ?? p.margin));
  }
  set("width", extent(p.width));
  set("height", extent(p.height));
  set("minWidth", extent(p.minWidth));
  set("maxWidth", extent(p.maxWidth));
  if (typeof p.flexGrow === "number") s.flexGrow = String(p.flexGrow);
  if (typeof p.flexShrink === "number") s.flexShrink = String(p.flexShrink);
  if (p.flexWrap === "wrap" || p.flexWrap === "wrap-reverse") s.flexWrap = p.flexWrap;
  set("alignItems", ALIGN[String(p.alignItems)]);
  set("alignSelf", ALIGN[String(p.alignSelf)]);
  set("justifyContent", JUSTIFY[String(p.justifyContent)]);
  if (p.borderStyle) {
    s.border = `1px solid ${paneColor(p.borderColor) ?? "color-mix(in srgb, var(--tint) calc(12% * var(--lines)), transparent)"}`;
    s.borderRadius = "calc(8px * var(--round))";
  }
  if (p.overflow === "hidden") s.overflow = "hidden";
  return s;
}

function apply(el: HTMLElement, style: Record<string, string>) {
  for (const [k, v] of Object.entries(style)) (el.style as unknown as Record<string, string>)[k] = v;
}

/** The text of an element's children, for what shows one string (a button's label, a code block). */
export function textOf(children: PaneChild[] | undefined): string {
  return (children ?? []).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : c && typeof c === "object" ? textOf(c.children) : "")).join("");
}

/** A link's target, when it is one the panel opens: http(s) only. */
export function safeUrl(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v) ? v : null;
}

function textStyle(el: HTMLElement, p: Record<string, unknown>) {
  if (p.bold || p.weight === "bold" || p.weight === "semibold") el.style.fontWeight = p.weight === "semibold" ? "600" : "700";
  if (p.italic) el.style.fontStyle = "italic";
  const lines = [p.underline && "underline", p.strikethrough && "line-through"].filter(Boolean).join(" ");
  if (lines) el.style.textDecoration = lines;
  if (p.dimColor) el.classList.add("dim");
  const color = paneColor(p.color);
  if (color) el.style.color = color;
  const back = paneColor(p.backgroundColor);
  if (back) el.style.background = `color-mix(in srgb, ${back} 25%, transparent)`;
  if (typeof p.wrap === "string" && p.wrap.startsWith("truncate")) el.classList.add("truncate");
}

/** Draws `node` (and what is in it) with the panel's own elements. `base`: the folder relative links in Markdown start from. */
export function renderPane(node: PaneChild, actions: PaneActions, base: string): Node | null {
  if (node == null || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") return document.createTextNode(String(node));
  const p = node.props ?? {};
  const kids = () => (node.children ?? []).map((c) => renderPane(c, actions, base)).filter((n): n is Node => n != null);
  const key = typeof p.key === "string" ? p.key : "";
  switch (node.type) {
    case "Box":
    case "div": {
      const el = h("div", { class: "pn-box" });
      apply(el, boxStyle(p));
      el.append(...kids());
      return el;
    }
    case "Text":
    case "span":
    case "b": {
      const el = h("span", { class: "pn-text" });
      textStyle(el, node.type === "b" ? { ...p, bold: true } : p);
      el.append(...kids());
      return el;
    }
    case "Button": {
      const label = typeof p.label === "string" ? p.label : textOf(node.children);
      const el = h("button", { class: p.dimColor ? "pn-button dim" : "pn-button", text: label, "data-key": key }) as HTMLButtonElement;
      el.disabled = p.disabled === true || !node.press;
      el.addEventListener("click", () => actions.press(node));
      return el;
    }
    case "Input": {
      const el = h("input", {
        class: "pn-input", type: p.mask ? "password" : "text", spellcheck: "false", autocomplete: "off", "data-key": key,
        placeholder: typeof p.placeholder === "string" ? p.placeholder : "",
      }) as HTMLInputElement;
      el.value = typeof p.value === "string" ? p.value : "";
      el.disabled = !node.press;
      let timer = 0;
      el.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => actions.input(node, "change", el.value), TYPING_MS);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        window.clearTimeout(timer);
        actions.input(node, "submit", el.value);
      });
      return el;
    }
    case "Select": {
      const el = h("select", { class: "pn-select", "data-key": key }) as HTMLSelectElement;
      const options = Array.isArray(p.options) ? (p.options as { value?: unknown; label?: unknown }[]) : [];
      for (const o of options) {
        if (typeof o?.value !== "string") continue;
        el.append(h("option", { value: o.value, text: typeof o.label === "string" ? o.label : o.value }));
      }
      if (typeof p.value === "string") el.value = p.value;
      el.disabled = !node.press;
      el.addEventListener("change", () => actions.select(node, el.value));
      return el;
    }
    case "Link": {
      const href = typeof p.href === "string" ? p.href : typeof p.url === "string" ? p.url : "";
      const label = typeof p.label === "string" ? p.label : textOf(node.children) || href;
      const el = h("button", { class: "pn-link", text: label, title: href });
      el.addEventListener("click", () => {
        if (node.press) actions.press(node, href || undefined);
        else if (safeUrl(href)) actions.openUrl(href);
      });
      return el;
    }
    case "Code": {
      const text = typeof p.code === "string" ? p.code : typeof p.text === "string" ? p.text : textOf(node.children);
      return h("pre", { class: "pn-code" }, h("code", { text }));
    }
    case "Markdown": {
      const el = h("div", { class: "reply pn-markdown" });
      renderMarkdown(el, typeof p.text === "string" ? p.text : textOf(node.children), base);
      return el;
    }
    case "Image":
    case "Raster": {
      // Only a picture carried in the tree itself: nothing is fetched for a pane.
      const src = typeof p.src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(p.src) ? p.src : null;
      return src ? h("img", { class: "pn-image", src, alt: typeof p.alt === "string" ? p.alt : "" }) : null;
    }
    case "Client":
      return h("div", { class: "pn-unsupported", text: t("This part of the plugin only shows in Claude Code Desktop.") });
    default: {
      // An element the panel doesn't know: what is in it, if anything.
      const inside = kids();
      if (!inside.length) return null;
      const el = h("div", { class: "pn-box" });
      apply(el, boxStyle({ flexDirection: "column" }));
      el.append(...inside);
      return el;
    }
  }
}

/**
 * Draws `tree` into `into` in place of what was there. The field being typed
 * in keeps the keyboard, its caret and what was typed since its last send.
 */
export function drawPane(into: HTMLElement, tree: PaneChild, actions: PaneActions, base: string) {
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement && into.contains(active) && active.dataset.key
    ? { key: active.dataset.key, value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;
  clear(into);
  const drawn = renderPane(tree, actions, base);
  if (drawn) into.append(drawn);
  if (!typing) return;
  const field = [...into.querySelectorAll<HTMLInputElement>(".pn-input")].find((i) => i.dataset.key === typing.key);
  if (!field) return;
  field.value = typing.value;
  field.focus();
  field.setSelectionRange(typing.start, typing.end);
}
