// The panel pours out of Buddybara the way a window comes out of the macOS Dock
// (the "genie" effect), and back into him when it closes. A web page can't
// bend the panel's pixels, so its shape does the bending: a funnel from his
// body that widens while the panel slides out through it, then straightens
// into the panel itself. Everything is in the panel window's logical pixels:
// the panel sits between two BUDDY_NECK margins (island.rs place_panel).

import { BUDDY_H, BUDDY_NECK, BUDDY_W } from "../core/layout";

export interface Tip {
  x: number;
  y: number;
}

/** Points along each edge of the funnel. */
const STEPS = 28;
/** Half the height of the stream where it leaves him. */
const NECK_HALF = 4;
/** Open: out of him, then straight. Close: the same, backwards and quicker. */
export const POUR_MS = { open: 420, close: 320 };

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};

/**
 * The panel at `p`: 0 is all of it still inside him, 1 the panel as it is.
 * `wrap` spans the whole window and takes the funnel's shape; `panel` slides.
 */
export function genieFrame(wrap: HTMLElement, panel: HTMLElement, tip: Tip, p: number) {
  const left = BUDDY_NECK;
  const right = BUDDY_NECK + BUDDY_W;
  // Away from him, towards the panel's far side.
  const dir = tip.x > (left + right) / 2 ? -1 : 1;
  const near = Math.abs((dir < 0 ? right : left) - tip.x);
  const far = Math.abs((dir < 0 ? left : right) - tip.x);
  const tipY = Math.min(BUDDY_H - NECK_HALF, Math.max(NECK_HALF, tip.y));
  // First it slides out through the funnel, then the funnel straightens and
  // lets go of him; the two overlap a little.
  const slide = ease(clamp01(p / 0.62));
  const settle = ease(clamp01((p - 0.38) / 0.62));
  const reach = slide * far;
  const start = settle * near;
  const flare = Math.max(1, (1 - settle) * far * 0.9);
  const mid = BUDDY_H / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const d = start + ((reach - start) * i) / STEPS;
    // 0 at the neck, 1 where the funnel is as tall as the panel.
    const w = smooth((d - start) / flare + settle);
    const c = tipY + (mid - tipY) * w;
    const half = NECK_HALF + (mid - NECK_HALF) * w;
    const x = (tip.x + dir * d).toFixed(1);
    top.push(`${x}px ${(c - half).toFixed(1)}px`);
    bottom.push(`${x}px ${(c + half).toFixed(1)}px`);
  }
  wrap.style.clipPath = `polygon(${[...top, ...bottom.reverse()].join(", ")})`;
  // Its far edge is as far out of him as the funnel reaches.
  panel.style.transform = `translateX(${(-dir * (far - reach)).toFixed(1)}px)`;
}

/** Nothing of the panel shows yet: before an opening knows where he is. */
export function genieHidden(wrap: HTMLElement) {
  wrap.style.clipPath = "polygon(0px 0px, 0px 0px, 0px 0px)";
}

export function genieClear(wrap: HTMLElement, panel: HTMLElement) {
  wrap.style.clipPath = "";
  panel.style.transform = "";
}

/** Windows' "Show animations" off (reduced motion): no genie, only the fade. */
export function genieWanted(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
