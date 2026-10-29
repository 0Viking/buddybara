// The look of the panel and Settings: a scheme (Settings → Customization) and
// whatever of it the user changed. A scheme is colours and a style: a font,
// corners and lines. Each is a CSS variable of style.css / settings.css :root,
// set on the page's root element; every other shade (dimmer text, hovers,
// lines) is mixed from them there, so a light scheme works as well as a dark
// one, and a dark sidebar beside a light page as well as either.

import { N_ } from "../i18n/i18n";

/** The colours a scheme sets, in the order Settings lists them. The id is the CSS variable's name. */
export const THEME_COLORS = [
  { id: "bg", label: N_("Background") },
  { id: "side", label: N_("Sidebar") },
  { id: "side-ink", label: N_("Sidebar text") },
  { id: "card", label: N_("Cards and menus") },
  { id: "ink", label: N_("Text") },
  { id: "dim", label: N_("Secondary text") },
  { id: "mikan", label: N_("Accent") },
  { id: "mikan-ink", label: N_("Text on accent") },
  { id: "composer", label: N_("Text box") },
  { id: "selected", label: N_("Selected project") },
  { id: "selected-ink", label: N_("Selected project text") },
  { id: "bubble", label: N_("Your messages") },
  { id: "bubble-ink", label: N_("Text in your messages") },
  { id: "code", label: N_("Code text") },
  { id: "code-bg", label: N_("Code background") },
  { id: "link", label: N_("Links") },
  { id: "tint", label: N_("Lines and hover") },
] as const;

export type ThemeColor = (typeof THEME_COLORS)[number]["id"];
type Palette = Record<ThemeColor, string>;

/** After each font: the scripts of the other interface languages (see style.css --font). */
const SCRIPTS = `"Segoe UI Emoji", "Nirmala UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans", `
  + `"Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Arabic", "Noto Sans CJK SC", "Noto Sans SC", `
  + `"Droid Sans Fallback", sans-serif`;

/** What a font falls back to, by kind, when the PC doesn't have it. */
const SANS = `"Segoe UI Variable Text", "Segoe UI", system-ui`;
const SERIF = `Georgia, Cambria, "Times New Roman"`;
const MONO = `Consolas, ui-monospace`;

/**
 * The fonts a scheme may set, sans first, then serifs, handwriting and
 * monospace: Nunito comes with Buddybara, the others with Windows 10 and 11
 * (Settings lists those a PC has). The ids are stored: never rename one.
 */
export const FONTS = [
  { id: "rounded", label: N_("Rounded"), family: "Nunito", stack: `"Nunito", system-ui, "Segoe UI Variable Text", "Segoe UI", ${SCRIPTS}` },
  { id: "clean", label: N_("Clean"), family: "Segoe UI", stack: `"Segoe UI Variable Text", "Segoe UI", system-ui, ${SCRIPTS}` },
  { id: "modern", label: N_("Modern"), family: "Calibri", stack: `Calibri, ${SANS}, ${SCRIPTS}` },
  { id: "gentle", label: N_("Gentle"), family: "Candara", stack: `Candara, Calibri, ${SANS}, ${SCRIPTS}` },
  { id: "casual", label: N_("Casual"), family: "Trebuchet MS", stack: `"Trebuchet MS", ${SANS}, ${SCRIPTS}` },
  { id: "wide", label: N_("Wide"), family: "Verdana", stack: `Verdana, ${SANS}, ${SCRIPTS}` },
  { id: "compact", label: N_("Compact"), family: "Tahoma", stack: `Tahoma, ${SANS}, ${SCRIPTS}` },
  { id: "geometric", label: N_("Geometric"), family: "Bahnschrift", stack: `Bahnschrift, ${SANS}, ${SCRIPTS}` },
  { id: "serif", label: N_("Serif"), family: "Georgia", stack: `${SERIF}, ${SCRIPTS}` },
  { id: "classic", label: N_("Classic"), family: "Constantia", stack: `Constantia, ${SERIF}, ${SCRIPTS}` },
  { id: "elegant", label: N_("Elegant"), family: "Palatino Linotype", stack: `"Palatino Linotype", Palatino, ${SERIF}, ${SCRIPTS}` },
  { id: "book", label: N_("Bookish"), family: "Sitka Text", stack: `"Sitka Text", Sitka, ${SERIF}, ${SCRIPTS}` },
  { id: "handwritten", label: N_("Handwritten"), family: "Segoe Print", stack: `"Segoe Print", "Ink Free", ${SANS}, ${SCRIPTS}` },
  { id: "marker", label: N_("Marker"), family: "Ink Free", stack: `"Ink Free", "Segoe Print", ${SANS}, ${SCRIPTS}` },
  { id: "comic", label: N_("Comic"), family: "Comic Sans MS", stack: `"Comic Sans MS", ${SANS}, ${SCRIPTS}` },
  { id: "mono", label: N_("Monospace"), family: "Cascadia Mono", stack: `"Cascadia Mono", "Cascadia Code", ${MONO}, ${SCRIPTS}` },
  { id: "typewriter", label: N_("Typewriter"), family: "Courier New", stack: `"Courier New", Courier, ${MONO}, ${SCRIPTS}` },
] as const;

/** How round every corner is, as a share of the radius the CSS draws (--round). */
export const CORNERS = [
  { id: "square", label: N_("Square"), value: 0.25 },
  { id: "soft", label: N_("Soft"), value: 0.6 },
  { id: "round", label: N_("Round"), value: 1 },
  { id: "pill", label: N_("Extra round"), value: 1.5 },
] as const;

/** How strong every line and hover is, as a share of the CSS's own (--lines). */
export const LINES = [
  { id: "faint", label: N_("Faint"), value: 0.5 },
  { id: "normal", label: N_("Normal"), value: 1 },
  { id: "strong", label: N_("Strong"), value: 2.4 },
] as const;

export type FontId = (typeof FONTS)[number]["id"];
export type CornerId = (typeof CORNERS)[number]["id"];
export type LineId = (typeof LINES)[number]["id"];

export interface Scheme {
  id: string;
  /** A name, like an editor theme's: not translated. */
  name: string;
  font: FontId;
  corners: CornerId;
  lines: LineId;
  colors: Palette;
}

/** The first is Buddybara's own: the capybara's browns and the mikan's orange.
 *  Each differs from the others in structure (light, dim, dark; the sidebar;
 *  bubbles; font, corners and lines), not only in hue. */
export const SCHEMES: Scheme[] = [
  // Buddybara: warm dark browns and the mikan orange.
  {
    id: "buddybara", name: "Buddybara", font: "rounded", corners: "round", lines: "normal",
    colors: {
      bg: "#15110e", side: "#1b1713", "side-ink": "#f7efe6", card: "#1e1915", ink: "#f7efe6", dim: "#b4a799",
      mikan: "#ff8a3d", "mikan-ink": "#2b1405", composer: "#231e1a", selected: "#362215", "selected-ink": "#ff8a3d", bubble: "#3a2416",
      "bubble-ink": "#efe6dc", code: "#e3d8cc", "code-bg": "#100c0a", link: "#ffb27a", tint: "#ffecd6",
    },
  },
  // Sunset: golden-hour orange-yellow, a night-blue sidebar, purple messages and a burnt-orange accent.
  {
    id: "sunset", name: "Sunset", font: "rounded", corners: "pill", lines: "faint",
    colors: {
      bg: "#ffe1a6", side: "#1d2350", "side-ink": "#ffe9c7", card: "#fff0d2", ink: "#2a170a", dim: "#74502d",
      mikan: "#b8420c", "mikan-ink": "#fff6ec", composer: "#fff6e4", selected: "#6b2d93", "selected-ink": "#fff3ff", bubble: "#6b2d93",
      "bubble-ink": "#fff3ff", code: "#1e2f78", "code-bg": "#fff3dc", link: "#2433a0", tint: "#5a300d",
    },
  },
  // Lavender: pale lilac with fresh green, soft and extra round.
  {
    id: "lavender", name: "Lavender", font: "rounded", corners: "pill", lines: "normal",
    colors: {
      bg: "#f2edff", side: "#eae1fe", "side-ink": "#190f2e", card: "#ffffff", ink: "#29203e", dim: "#655d82",
      mikan: "#057c5d", "mikan-ink": "#ffffff", composer: "#ffffff", selected: "#9ee3c0", "selected-ink": "#01462e", bubble: "#e2d5fc",
      "bubble-ink": "#29203e", code: "#643b9a", "code-bg": "#ebe4fa", link: "#046e53", tint: "#29203e",
    },
  },
  // Ocean: a mid-tone deep teal under a navy sidebar, with aqua and sky blue.
  {
    id: "ocean", name: "Ocean", font: "clean", corners: "round", lines: "faint",
    colors: {
      bg: "#1b5264", side: "#05273c", "side-ink": "#e0f2f6", card: "#255d6e", ink: "#f3fcfd", dim: "#afdadf",
      mikan: "#4bece8", "mikan-ink": "#01272d", composer: "#2b6071", selected: "#03464f", "selected-ink": "#70f8ed", bubble: "#78c7fd",
      "bubble-ink": "#002241", code: "#b2f8f0", "code-bg": "#0d3849", link: "#a6e1fe", tint: "#d8f5f6",
    },
  },
  // Paper: cream paper, serif type, square corners and red ink.
  {
    id: "paper", name: "Paper", font: "serif", corners: "square", lines: "strong",
    colors: {
      bg: "#faf6ee", side: "#f2ece0", "side-ink": "#1e170e", card: "#faf6ee", ink: "#1f1913", dim: "#6c6154",
      mikan: "#b3241f", "mikan-ink": "#fffaf2", composer: "#ffffff", selected: "#e5d7c0", "selected-ink": "#8d1b17", bubble: "#f1e6d6",
      "bubble-ink": "#1f1913", code: "#65321f", "code-bg": "#f3ecde", link: "#9b1f1b", tint: "#1f1913",
    },
  },
  // Phosphor: a green-on-black terminal: monospace, square, strong lines.
  {
    id: "phosphor", name: "Phosphor", font: "mono", corners: "square", lines: "strong",
    colors: {
      bg: "#030904", side: "#030904", "side-ink": "#94f1a2", card: "#050f07", ink: "#a6f4b1", dim: "#60ac6d",
      mikan: "#5dfa5b", "mikan-ink": "#021c09", composer: "#07150a", selected: "#082910", "selected-ink": "#66fc73", bubble: "#041e0b",
      "bubble-ink": "#bafbc2", code: "#4efb63", "code-bg": "#010302", link: "#62f6bf", tint: "#72f57c",
    },
  },
  // Neon: black with hot magenta messages and cyan links, round and quiet.
  {
    id: "neon", name: "Neon", font: "geometric", corners: "pill", lines: "faint",
    colors: {
      bg: "#050507", side: "#050507", "side-ink": "#e9e6ee", card: "#1e1b25", ink: "#f5f4f8", dim: "#a6a2b0",
      mikan: "#fe4bc0", "mikan-ink": "#29081a", composer: "#17141e", selected: "#fddeee", "selected-ink": "#160810", bubble: "#c80484",
      "bubble-ink": "#ffffff", code: "#80ecf1", "code-bg": "#17141e", link: "#47d2e8", tint: "#efedf4",
    },
  },
  // Storm: a slate-grey sky over a black sidebar, lit by lightning yellow.
  {
    id: "storm", name: "Storm", font: "geometric", corners: "soft", lines: "strong",
    colors: {
      bg: "#495460", side: "#05080c", "side-ink": "#e3e8ee", card: "#2e363f", ink: "#fafcfe", dim: "#c5cfd9",
      mikan: "#f6d732", "mikan-ink": "#201a09", composer: "#353e47", selected: "#1f252b", "selected-ink": "#fade4e", bubble: "#f6d732",
      "bubble-ink": "#201a09", code: "#d5ecf8", "code-bg": "#272f37", link: "#f7dd7d", tint: "#f0f6fc",
    },
  },
  // Velvet: deep wine and plum with gold, serif and quiet.
  {
    id: "velvet", name: "Velvet", font: "serif", corners: "soft", lines: "faint",
    colors: {
      bg: "#34142b", side: "#260a1e", "side-ink": "#f6e1ea", card: "#422037", ink: "#fae9f0", dim: "#c7a6b8",
      mikan: "#edb154", "mikan-ink": "#261704", composer: "#47263c", selected: "#48253d", "selected-ink": "#f2c36a", bubble: "#582c46",
      "bubble-ink": "#fae9f0", code: "#f4ca84", "code-bg": "#1e0918", link: "#e6bd77", tint: "#f9e0eb",
    },
  },
  // Kraft: kraft paper beside a dark-brown sidebar, ink-blue messages, square.
  {
    id: "kraft", name: "Kraft", font: "geometric", corners: "square", lines: "normal",
    colors: {
      bg: "#dfc6a8", side: "#30231b", "side-ink": "#f2e6d6", card: "#f4ead9", ink: "#2b1f15", dim: "#574331",
      mikan: "#1c3a8b", "mikan-ink": "#ffffff", composer: "#f4ead9", selected: "#dfc6a8", "selected-ink": "#2b1f15", bubble: "#214092",
      "bubble-ink": "#ffffff", code: "#642309", "code-bg": "#f2e6d3", link: "#214092", tint: "#2b1f15",
    },
  },
  // Moss: forest greens with a lime accent, soft and calm.
  {
    id: "moss", name: "Moss", font: "rounded", corners: "soft", lines: "faint",
    colors: {
      bg: "#132d1b", side: "#2b422e", "side-ink": "#eaf1e4", card: "#0e1d13", ink: "#e9eddf", dim: "#a8b6a0",
      mikan: "#c8e93d", "mikan-ink": "#182704", composer: "#0e1d13", selected: "#3e5838", "selected-ink": "#d2f66b", bubble: "#2b412c",
      "bubble-ink": "#ecf1e2", code: "#d7e6ab", "code-bg": "#101911", link: "#cbd870", tint: "#e6efda",
    },
  },
  // Rose: crisp white and blush pink, rose-red messages, a wine selected row.
  {
    id: "rose", name: "Rose", font: "clean", corners: "pill", lines: "strong",
    colors: {
      bg: "#ffffff", side: "#fdebef", "side-ink": "#2d0f1a", card: "#fdeff3", ink: "#311921", dim: "#825d68",
      mikan: "#ba1f5a", "mikan-ink": "#ffffff", composer: "#f9ecf0", selected: "#4d1928", "selected-ink": "#ffffff", bubble: "#ba1f5a",
      "bubble-ink": "#ffffff", code: "#922452", "code-bg": "#fbeef1", link: "#af2055", tint: "#311921",
    },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function schemeOf(id: string): Scheme {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0];
}

/** What a scheme looks like with the user's changes over it: only real values count. */
export function themeLook(scheme: string, custom: Record<string, string> | undefined) {
  const s = schemeOf(scheme);
  const colors = { ...SCHEMES[0].colors, ...s.colors };
  for (const { id } of THEME_COLORS) {
    const mine = custom?.[id];
    if (mine && HEX.test(mine)) colors[id] = mine.toLowerCase();
  }
  const pick = <T extends { id: string }>(list: readonly T[], mine: string | undefined, theirs: string): T =>
    list.find((x) => x.id === mine) ?? list.find((x) => x.id === theirs) ?? list[0];
  return {
    colors,
    font: pick(FONTS, custom?.font, s.font),
    corners: pick(CORNERS, custom?.corners, s.corners),
    lines: pick(LINES, custom?.lines, s.lines),
  };
}

/** A "#rrggbb" colour's relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Fired on the window once the look changes, for what draws itself (the terminal). */
export const THEME_EVENT = "buddybara-theme";

/**
 * Paints the page in the scheme. A light background also turns Windows'
 * native controls (dropdowns, scrollbars) light.
 */
export function applyTheme(scheme: string, custom: Record<string, string> | undefined) {
  const look = themeLook(scheme, custom);
  const root = document.documentElement;
  for (const { id } of THEME_COLORS) root.style.setProperty(`--${id}`, look.colors[id]);
  root.style.setProperty("--font", look.font.stack);
  root.style.setProperty("--round", String(look.corners.value));
  root.style.setProperty("--lines", String(look.lines.value));
  root.style.colorScheme = luminance(look.colors.bg) > 0.4 ? "light" : "dark";
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** A colour of the theme as the page has it now ("#rrggbb"), for a canvas or xterm.js. */
export function themeColor(id: ThemeColor): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${id}`).trim() || SCHEMES[0].colors[id];
}

/**
 * Settings → Customization's text size, in percent of the usual: three
 * smaller, the usual, three bigger. Not part of a scheme: a scheme picked
 * later keeps it.
 */
export const TEXT_SIZES = [70, 80, 90, 100, 115, 130, 150] as const;

/** The nearest of TEXT_SIZES, the smaller of two as near. Not a number: the usual size. */
export function textSize(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return TEXT_SIZES.reduce<number>((best, s) => (Math.abs(s - percent) < Math.abs(best - percent) ? s : best), TEXT_SIZES[0]);
}

/**
 * Sizes the page's text: every font size in the style sheets is multiplied
 * by --text. What draws its own text (the terminal) hears THEME_EVENT.
 */
export function applyTextSize(percent: number) {
  const k = String(textSize(percent) / 100);
  const root = document.documentElement;
  if (root.style.getPropertyValue("--text") === k) return;
  root.style.setProperty("--text", k);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** The page's text size now, as a factor (1 = the usual), for xterm.js. */
export function textScale(): number {
  return Number(getComputedStyle(document.documentElement).getPropertyValue("--text")) || 1;
}
