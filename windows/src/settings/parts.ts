// Small pieces every settings page draws with.

import { h, svg } from "../views/dom";
import { BRANDS } from "./brands";

/** A page: its title, a line about it, then its cards. */
export function pageOf(title: string, intro: string | null, ...cards: HTMLElement[]): HTMLElement {
  return h("div", { class: "page" },
    h("div", { class: "head" }, h("div", {}, h("h1", { text: title }), intro ? h("p", { text: intro }) : null)),
    ...cards,
  );
}

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "var(--leaf)" : "var(--red)"}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A tile's background and mark: a near-black brand on a light tile, a light
 *  one under a dark mark, the rest under a white one. */
function tileColors(hex: string): [string, string] {
  const l = luminance(hex);
  if (l < 0.06) return ["#f6efe7", hex];
  return [hex, l > 0.4 ? "#1d1611" : "#ffffff"];
}

/**
 * A brand's mark (brands.ts) on a tile in its colour, or the name's initial on
 * a plain one, with the red / green dot on its corner unless `state` is
 * absent: "on", "off", "wait" (grey) or "busy" (amber, pulsing).
 */
export function markTile(id: string, name: string, state?: string): HTMLElement {
  const brand = BRANDS[id];
  const el = h("span", { class: brand ? "mark" : "mark plain" });
  if (brand) {
    const [bg, fg] = tileColors(brand.color);
    el.style.background = bg;
    el.style.color = fg;
    el.append(brand.path ? svg(brand.path, 21) : h("b", { text: brand.letter ?? "" }));
  } else {
    el.append(h("b", { text: (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase() }));
  }
  if (state) el.append(h("i", { class: `state ${state}` }));
  return el;
}
