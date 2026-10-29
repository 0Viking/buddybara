// Settings → Customization: the look of the panel and Settings (a scheme, then
// any of its colours, its font, corners, lines and text size), and the desktop
// Buddybara's size and picture. Each works on its own. The look and the text
// change live, both windows at once; his size is desktop.rs's to apply; the
// picture is kept by skin.rs and every window that draws him reloads it.

import { Bridge, emitToWindow } from "../core/bridge";
import type { Settings } from "../core/state";
import {
  CORNERS, FONTS, LINES, SCHEMES, TEXT_SIZES, THEME_COLORS, applyTextSize, applyTheme, schemeOf,
  textSize, themeLook, type Scheme,
} from "../core/theme";
import { BUDDY_SIZES, DESKTOP_EVENTS, PREVIEW_STEPS, buddySize } from "../buddybara/desktop-logic";
import { BotEngine } from "../buddybara/engine";
import { asSkin, skinPng } from "../buddybara/skin";
import { N_, language, t } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { pageOf } from "./parts";

const RESET_ICON = "M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5";

/** Which fonts this PC has, measured once each. */
const fontsSeen = new Map<string, boolean>();

/**
 * Whether Windows has `family`: text drawn in it measures otherwise than in
 * the generic font it would fall back to, for at least one of three. Nunito
 * comes with Buddybara (`rounded`): always there.
 */
function fontInstalled(id: string, family: string): boolean {
  if (id === "rounded") return true;
  const known = fontsSeen.get(family);
  if (known !== undefined) return known;
  const ctx = document.createElement("canvas").getContext("2d");
  let found = true;
  if (ctx) {
    const sample = "mmmmmmmmmmlli1WQ@#&gy";
    const width = (font: string) => {
      ctx.font = font;
      return ctx.measureText(sample).width;
    };
    found = ["monospace", "serif", "sans-serif"].some((base) => width(`72px "${family}", ${base}`) !== width(`72px ${base}`));
  }
  fontsSeen.set(family, found);
  return found;
}

/** Redraws the skin card on the page now, if it is on screen. */
let refreshSkins: (() => void) | null = null;
// Back from the skins folder (pictures added there): the tiles show them.
window.addEventListener("focus", () => refreshSkins?.());

/** The desktop Buddybara's window (desktop.rs LABEL). */
const DESKTOP_WINDOW = "buddybara";
/**
 * Each step is held this much longer on his side than it lasts here: the
 * next one arrives before he goes back to his real state in between.
 */
const PREVIEW_OVERLAP_MS = 500;

/** "Play every state": the step on now (−1: none), and what shows it on the page now. */
let tourStep = -1;
let tourTimer = 0;
let tourLabel: HTMLElement | null = null;
let tourButton: HTMLButtonElement | null = null;

function showTour() {
  const step = PREVIEW_STEPS[tourStep];
  if (tourLabel) tourLabel.textContent = step ? `${tourStep + 1}/${PREVIEW_STEPS.length} · ${step.name}` : "";
  if (tourButton) tourButton.disabled = tourStep >= 0;
}

/** Plays the steps from `i` on the desktop Buddybara, one after the other. */
function playTour(i = 0) {
  window.clearTimeout(tourTimer);
  const step = PREVIEW_STEPS[i];
  tourStep = step ? i : -1;
  showTour();
  if (!step) return;
  const { name: _name, ...shown } = step;
  void emitToWindow(DESKTOP_WINDOW, DESKTOP_EVENTS.preview, { ...shown, ms: step.ms + PREVIEW_OVERLAP_MS });
  tourTimer = window.setTimeout(() => playTour(i + 1), step.ms);
}

function percent(n: number): string {
  return new Intl.NumberFormat(language(), { style: "percent" }).format(n / 100);
}

function resetButton(): HTMLButtonElement {
  return h("button", { class: "icon", title: t("Reset"), "aria-label": t("Reset") }, svg(RESET_ICON, 14, { stroke: 2 })) as HTMLButtonElement;
}

/**
 * A slider over a few sizes in percent. `now` is one of `steps`; `pick` is
 * told only of a size that changed; `show` follows it with the size now.
 */
function sizeSlider(
  title: string, steps: readonly number[], now: () => number, pick: (percent: number) => void,
  show: (percent: number) => void,
): HTMLInputElement {
  const slider = h("input", {
    type: "range", min: "0", max: String(steps.length - 1), step: "1", "aria-label": title,
  }) as HTMLInputElement;
  const sync = () => {
    const at = Math.max(0, steps.indexOf(now()));
    slider.value = String(at);
    slider.setAttribute("aria-valuetext", percent(steps[at]));
    show(steps[at]);
  };
  slider.addEventListener("input", () => {
    const n = steps[Number(slider.value)];
    if (n !== now()) pick(n);
    sync();
  });
  sync();
  return slider;
}

/** Moves a size slider to its stop `i`, as a drag there would. */
function slideTo(slider: HTMLInputElement, i: number) {
  slider.value = String(i);
  slider.dispatchEvent(new Event("input"));
}

/**
 * The Style card's text size: a row like the others, its reset back to the
 * usual size, the slider and the size now.
 */
function textSizeRow(now: () => number, pick: (percent: number) => void): HTMLElement {
  const value = h("strong", { class: "size-now" });
  const reset = resetButton();
  const slider = sizeSlider(t("Text size"), TEXT_SIZES, now, pick, (n) => {
    value.textContent = percent(n);
    reset.style.visibility = n === 100 ? "hidden" : "visible";
  });
  reset.addEventListener("click", () => slideTo(slider, TEXT_SIZES.indexOf(100)));
  return h("div", { class: "color-row size-row" }, h("span", { text: t("Text size") }), reset, slider, value);
}

/**
 * Fills `card` with a slider over a few sizes in percent: the size now beside
 * the title, each size named under its stop (a click on a name goes there).
 */
function sizeCard(
  card: HTMLElement, title: string, hint: string, steps: readonly number[],
  now: () => number, pick: (percent: number) => void,
) {
  const value = h("strong", { class: "size-now" });
  const names = steps.map((n, i) => h("button", {
    type: "button",
    text: percent(n),
    style: `inset-inline-start:${(100 * i) / (steps.length - 1)}%`,
    onclick: () => slideTo(slider, i),
  }));
  const slider = sizeSlider(title, steps, now, pick, (n) => {
    value.textContent = percent(n);
    names.forEach((name, i) => name.classList.toggle("on", steps[i] === n));
  });
  card.append(
    h("h2", {}, h("span", { text: title }), h("span", { class: "grow" }), value),
    h("p", { class: "card-hint", text: hint }),
    h("div", { class: "size-slider" }, slider, h("div", { class: "size-names" }, ...names)),
  );
}

/** Buddybara as he is drawn wearing no picture, `px` across: his tile, and the preview. */
function capybara(px: number): HTMLCanvasElement {
  const canvas = h("canvas", { "aria-hidden": "true" }) as HTMLCanvasElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(px * dpr);
  canvas.style.width = canvas.style.height = `${px}px`;
  const engine = new BotEngine();
  engine.setState("idle", true);
  engine.update(0);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // As the corner one is: 0.8 of the width across, room left for his ears.
    const side = px * 0.1;
    ctx.setTransform(dpr, 0, 0, dpr, side * dpr, 0);
    engine.draw(ctx, px - 2 * side, px);
  }
  return canvas;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
}

export function customizePage(settings: Settings, save: () => Promise<void>): HTMLElement {
  const schemes = h("div", { class: "card" });
  const style = h("div", { class: "card" });
  const colors = h("div", { class: "card" });
  const size = h("div", { class: "card" });
  const skin = h("div", { class: "card" });

  const custom = () => settings.themeCustom ?? {};
  const paint = () => applyTheme(settings.theme, custom());

  let saving = 0;
  /** While a colour is dragged, it is written once the dragging stops. */
  const saveSoon = () => {
    window.clearTimeout(saving);
    saving = window.setTimeout(() => void save(), 300);
  };

  /** Set (or, with null, back to the scheme's) one thing of the look. */
  const setCustom = (key: string, value: string | null) => {
    const next = { ...custom() };
    if (value == null) delete next[key];
    else next[key] = value;
    settings.themeCustom = next;
    paint();
  };

  const undoButton = (key: string, after: () => void) => {
    const undo = resetButton();
    undo.style.visibility = custom()[key] ? "visible" : "hidden";
    undo.addEventListener("click", () => {
      setCustom(key, null);
      void save();
      after();
    });
    return undo;
  };

  const redrawLook = () => {
    drawSchemes();
    drawStyle();
    drawColors();
  };

  function drawSchemes() {
    clear(schemes);
    const tile = (s: Scheme) => {
      const c = s.colors;
      const on = s.id === schemeOf(settings.theme).id;
      const k = CORNERS.find((x) => x.id === s.corners)?.value ?? 1;
      const font = FONTS.find((x) => x.id === s.font)?.stack ?? "";
      return h("button", {
        class: on ? "scheme on" : "scheme",
        "aria-pressed": on,
        onclick: () => {
          // A new scheme starts clean: what was changed in the last one goes.
          settings.theme = s.id;
          settings.themeCustom = {};
          paint();
          void save();
          redrawLook();
        },
      },
        h("span", { class: "scheme-art", style: `background:${c.bg};border-color:${c.tint}33;border-radius:${9 * k}px` },
          h("i", { class: "art-side", style: `background:${c.side}` },
            h("i", { class: "art-pick", style: `background:${c.selected};border-radius:${3 * k}px` })),
          h("i", { class: "art-bubble", style: `background:${c.bubble};border-radius:${5 * k}px` }),
          h("i", { class: "art-line", style: `background:${c.ink}` }),
          h("i", { class: "art-line short", style: `background:${c.dim}` }),
          h("i", { class: "art-box", style: `background:${c.composer};border-radius:${6 * k}px` }),
          h("i", { class: "art-dot", style: `background:${c.mikan}` }),
        ),
        h("span", { class: "scheme-name", style: `font-family:${font}`, text: s.name }),
      );
    };
    schemes.append(
      h("h2", {}, h("span", { text: t("Color scheme") })),
      h("div", { class: "schemes" }, ...SCHEMES.map(tile)),
    );
  }

  function drawStyle() {
    clear(style);
    const look = themeLook(settings.theme, custom());
    const row = <T extends { id: string; label: string }>(
      key: string, title: string, list: readonly T[], current: T, describe: (x: T) => string, look?: (x: T) => string,
    ) => {
      const select = h("select", { "aria-label": t(title) }) as HTMLSelectElement;
      for (const x of list) select.append(h("option", { value: x.id, text: describe(x), style: look ? look(x) : undefined }));
      select.value = current.id;
      select.addEventListener("change", () => {
        setCustom(key, select.value);
        void save();
        drawSchemes();
        drawStyle();
      });
      return h("label", { class: "color-row" }, h("span", { text: t(title) }), undoButton(key, drawStyle), select);
    };
    style.append(
      h("h2", {}, h("span", { text: t("Style") })),
      h("div", { class: "colors" },
        // The fonts this PC has (and the one picked, whatever), each shown in itself.
        row("font", N_("Font"), FONTS.filter((f) => f === look.font || fontInstalled(f.id, f.family)), look.font,
          (f) => `${t(f.label)} · ${f.family}`, (f) => `font-family:${f.stack}`),
        row("corners", N_("Corners"), CORNERS, look.corners, (c) => t(c.label)),
        row("lines", N_("Lines"), LINES, look.lines, (l) => t(l.label)),
        // Not part of the scheme: another one picked keeps it.
        textSizeRow(() => textSize(settings.textSize), (n) => {
          settings.textSize = n;
          applyTextSize(n);
          void save();
        }),
      ),
    );
  }

  function drawColors() {
    clear(colors);
    const current = themeLook(settings.theme, custom()).colors;
    const reset = h("button", {
      text: t("Reset to the scheme"),
      onclick: () => {
        settings.themeCustom = {};
        paint();
        void save();
        redrawLook();
      },
    }) as HTMLButtonElement;
    reset.disabled = Object.keys(custom()).length === 0;
    const rows = THEME_COLORS.map(({ id, label }) => {
      const input = h("input", { type: "color", value: current[id], "aria-label": t(label) }) as HTMLInputElement;
      const hex = h("code", { text: current[id] });
      const undo = undoButton(id, drawColors);
      input.addEventListener("input", () => {
        setCustom(id, input.value);
        hex.textContent = input.value;
        undo.style.visibility = "visible";
        reset.disabled = false;
        saveSoon();
      });
      return h("label", { class: "color-row" }, h("span", { text: t(label) }), hex, undo, input);
    });
    colors.append(
      h("h2", {}, h("span", { text: t("Colors") }), h("span", { class: "grow" }), reset),
      h("p", { class: "card-hint", text: t("Change any color of the scheme: the panel and Settings follow at once.") }),
      h("div", { class: "colors" }, ...rows),
    );
  }

  /** The pictures of the last drawing, let go by the next. */
  const urls: string[] = [];
  const pictureUrl = (bytes: ArrayBuffer) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    urls.push(url);
    return url;
  };
  let drawing = 0;

  /**
   * What he wears now, the button to choose a picture of one's own, and the
   * pictures to pick from: Buddybara himself first, then the skins folder's.
   */
  async function drawSkin(error = "") {
    const turn = ++drawing;
    const [bytes, library] = await Promise.all([Bridge.skinGet(), Bridge.skinLibrary()]);
    const pictures = (await Promise.all((library?.names ?? []).map(async (name) => ({
      name, bytes: await Bridge.skinLibraryGet(name),
    })))).filter((p): p is { name: string; bytes: ArrayBuffer } => p.bytes != null && p.bytes.byteLength > 0);
    // A newer drawing started meanwhile: it is the one that shows.
    if (turn !== drawing) return;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    const worn = bytes && bytes.byteLength > 0 ? bytes : null;

    const wear = (change: () => Promise<unknown>) =>
      void change().then(() => drawSkin(), () => drawSkin(t("That picture couldn't be used.")));
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/bmp", hidden: true }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (chosen) wear(async () => Bridge.skinSave(await skinPng(chosen)));
    });
    const choose = h("button", { class: "primary", text: t("Choose image…"), onclick: () => file.click() });

    const tile = (name: string, art: HTMLElement, on: boolean, pick: () => void) =>
      h("button", { class: on ? "skin-tile on" : "skin-tile", "aria-pressed": on, title: name, onclick: pick },
        h("span", { class: "skin-tile-art" }, art),
        h("span", { class: "skin-tile-name", text: name }));
    const tiles = [
      tile("Buddybara", capybara(64), !worn, () => wear(() => Bridge.skinRemove())),
      ...pictures.map((p) => tile(
        p.name, h("img", { src: pictureUrl(p.bytes), alt: "" }), worn != null && sameBytes(worn, p.bytes),
        () => wear(async () => Bridge.skinSave(await asSkin(p.bytes))),
      )),
    ];

    clear(skin);
    skin.append(
      h("h2", {}, h("span", { text: t("Buddy skin") })),
      h("div", { class: "skin-row" },
        h("div", { class: "skin-preview" }, worn ? h("img", { src: pictureUrl(worn), alt: "" }) : capybara(84)),
        h("div", { class: "skin-text" },
          h("p", { text: t("Your picture takes the capybara's place on the desktop, at about its height. The plan usage and the work badge still show on it.") }),
          error ? h("p", { class: "err", text: error }) : null,
          h("div", { class: "row" }, choose, file),
        ),
      ),
      h("div", { class: "skin-tiles" }, ...tiles),
      h("div", { class: "skin-folder" },
        h("span", { text: t("Pictures in the skins folder show here.") }),
        h("button", { text: t("Open the folder"), onclick: () => void Bridge.skinLibraryOpen().catch(() => {}) })),
      h("div", { class: "skin-folder" },
        tourButton = h("button", { text: t("Play every state"), onclick: () => playTour() }) as HTMLButtonElement,
        tourLabel = h("code", { class: "tour-step" }),
        h("span", { class: "grow" }),
        h("span", { text: t("On the desktop Buddybara: each state, his greeting, his fidgets and his faces.") })),
    );
    showTour();
  }
  refreshSkins = () => {
    if (skin.isConnected) void drawSkin();
  };

  // desktop.rs resizes him when the settings are saved.
  sizeCard(size, t("Buddy size"), t("How big Buddybara is on the desktop."), BUDDY_SIZES,
    () => buddySize(settings.buddySize),
    (n) => {
      settings.buddySize = n;
      void save();
    });

  redrawLook();
  void drawSkin();
  return pageOf(t("Customization"),
    t("The look of the panel and Settings, and a picture of your own for Buddybara. Each works on its own."),
    schemes, style, colors, size, skin);
}
