// Buddybara on the desktop — the pure logic and his life cycle. No DOM, no
// Tauri: the panel wires it up in src/island/desktop.ts, the desktop window
// draws him in src/desktop/main.ts, and Rust owns the window (src-tauri/src/desktop.rs).
//
// Coordinates are y-down everywhere on a PC, so the Mac's DesktopSpace flip is
// not needed: a point on the desktop is used as the OS reports it.

import type { BotEmoteName, BotStateName } from "../core/layout";

/** What the panel tells the desktop window, whenever it changes. */
export interface DesktopSnapshot {
  state: BotStateName;
  soundEnabled: boolean;
  soundVolume: number;
  /** The Claude plan's usage, shown on the mikan; null hides it. */
  usage: number | null;
}

/** Events between the two windows. Rust adds `desktop-buddybara-dropped`. */
export const DESKTOP_EVENTS = {
  /** panel → desktop window */
  state: "desktop-buddybara-state",
  emote: "desktop-buddybara-emote",
  /** desktop window → panel */
  ready: "desktop-buddybara-ready",
  /** A click on him: opens or closes the panel (src/buddy). */
  click: "desktop-buddybara-click",
  /** His minimize button: he and the panel leave the screen. */
  minimize: "desktop-buddybara-minimize",
  /** Rust → panel: a drag ended at his new spot. */
  dropped: "desktop-buddybara-dropped",
  /** Rust → desktop window */
  cursor: "desktop-cursor",
  visible: "desktop-visible",
  flight: "desktop-flight",
  /** His window took a new side (Settings → Customization), logical pixels. */
  size: "desktop-size",
  /** Settings → desktop window: one step of "Play every state". */
  preview: "desktop-buddybara-preview",
  /** Rust → desktop window (Windows): the cursor's x while he is carried, logical pixels. */
  carried: "desktop-carried",
} as const;

// ── What he does when handled ─────────────────────────────────────────────────

/** Shaken while carried: this many turns back and forth… */
export const SHAKE_TURNS = 3;
/** …each after a swing of at least this many logical pixels… */
export const SHAKE_SWING = 28;
/** …all within this long, and he is dizzy. */
export const SHAKE_WINDOW_MS = 1500;

/** Watches where he is carried across the screen, for a shake. */
export class ShakeMeter {
  private started = false;
  /** The way he swings now (−1 left, 1 right, 0 not yet), and how far it went. */
  private dir = 0;
  private extreme = 0;
  private turns: number[] = [];

  /** One more position across (logical px) at `t` ms; true when it made him dizzy. */
  feed(t: number, x: number): boolean {
    if (!this.started) {
      this.started = true;
      this.extreme = x;
      return false;
    }
    const d = x - this.extreme;
    if (this.dir === 0) {
      if (Math.abs(d) >= SHAKE_SWING) {
        this.dir = Math.sign(d);
        this.extreme = x;
      }
      return false;
    }
    // Still going the same way: the swing goes on.
    if (Math.sign(d) === this.dir) {
      this.extreme = x;
      return false;
    }
    if (Math.abs(d) < SHAKE_SWING) return false;
    this.dir = -this.dir;
    this.extreme = x;
    this.turns = this.turns.filter((at) => t - at <= SHAKE_WINDOW_MS);
    this.turns.push(t);
    if (this.turns.length < SHAKE_TURNS) return false;
    this.turns = [];
    return true;
  }

  /** A new drag: nothing of the last one counts. */
  reset() {
    this.started = false;
    this.dir = 0;
    this.turns = [];
  }
}

/** Poked this many times… */
export const POKES = 4;
/** …within this long, he is annoyed. */
export const POKE_WINDOW_MS = 2000;

/** Counts the clicks on him, for too many too fast. */
export class PokeCounter {
  private at: number[] = [];

  /** A click on him at `t` ms; true when it was one too many. */
  poke(t: number): boolean {
    this.at = this.at.filter((x) => t - x <= POKE_WINDOW_MS);
    this.at.push(t);
    if (this.at.length < POKES) return false;
    this.at = [];
    return true;
  }
}

/** The pointer resting on him this long, idle… */
export const WINK_REST_MS = 2000;
/** …he winks, this often… */
export const WINK_CHANCE = 0.6;
/** …and not again for this long. */
export const WINK_COOLDOWN_MS = 15000;

/**
 * One step of Settings' "Play every state": shown on the desktop Buddybara
 * for `ms`, over whatever his sessions say, then he is back to that.
 */
export interface DesktopPreview {
  state: BotStateName;
  emote?: BotEmoteName;
  greet?: boolean;
  /** An idle fidget (BotEngine.fidget's kind). */
  fidget?: number;
  ms: number;
}

/** Every step of "Play every state", named as the engine names them. */
export const PREVIEW_STEPS: readonly (DesktopPreview & { name: string })[] = [
  { name: "idle", state: "idle", ms: 2500 },
  { name: "idle · hop", state: "idle", fidget: 0, ms: 1800 },
  { name: "idle · wiggle", state: "idle", fidget: 1, ms: 1800 },
  { name: "idle · stretch", state: "idle", fidget: 2, ms: 1800 },
  { name: "greet", state: "idle", greet: true, ms: 2600 },
  { name: "thinking", state: "thinking", ms: 3500 },
  { name: "working", state: "working", ms: 3500 },
  { name: "searching", state: "searching", ms: 3500 },
  { name: "question", state: "question", ms: 3000 },
  { name: "approval", state: "approval", ms: 3000 },
  { name: "ratelimit", state: "ratelimit", ms: 3000 },
  { name: "error", state: "error", ms: 2600 },
  { name: "finished", state: "finished", ms: 3000 },
  { name: "dizzy", state: "dizzy", ms: 2600 },
  { name: "sleeping", state: "sleeping", ms: 4500 },
  ...(["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"] as const).map((emote) => ({
    name: emote, state: "idle" as const, emote, ms: 2200,
  })),
];

// ── Constants (DesktopBuddybaraLogic) ────────────────────────────────────────────

/** Side of the desktop window at his usual size (100 %), logical pixels. */
export const PANEL_SIZE = 120;
/**
 * The sizes Settings → Customization offers, in percent of PANEL_SIZE: three
 * smaller, his own, three bigger (desktop.rs logic::SIZES).
 */
export const BUDDY_SIZES = [50, 65, 80, 100, 125, 160, 200] as const;
/** Seconds without agent activity before he may fall asleep. */
export const SLEEP_TIMEOUT = 120;
/** He only dozes off once the pointer is at least this far from him. */
export const SLEEP_MOUSE_DISTANCE = 150;
/** Clickable body radius, as a fraction of the window side. */
export const BODY_RADIUS_FRACTION = 0.24;
/** All of him as drawn, mikan and paws (desktop.rs FIGURE_RADIUS_FRACTION). */
export const FIGURE_RADIUS_FRACTION = 0.42;

/** A press that moves farther than this is a drag, not a click. */
export const DRAG_THRESHOLD = 3;

// ── Pure helpers ─────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/**
 * Whether Buddybara should be asleep: no agent activity for longer than
 * SLEEP_TIMEOUT (strictly), and the pointer not close to him.
 */
export function shouldSleep(sinceAgentActive: number, mouseDistanceToCenter: number): boolean {
  return sinceAgentActive > SLEEP_TIMEOUT && mouseDistanceToCenter >= SLEEP_MOUSE_DISTANCE;
}

/**
 * The nearest of BUDDY_SIZES to a size in percent, the smaller of two as near,
 * as desktop.rs logic::side_for reads it. Not a number: his usual size.
 */
export function buddySize(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return BUDDY_SIZES.reduce<number>((best, s) => (Math.abs(s - percent) < Math.abs(best - percent) ? s : best), BUDDY_SIZES[0]);
}

/**
 * His minimize button in a window of side `side`: its centre, top-right of
 * his head, and how much it is scaled — it grows less than he does
 * (desktop.rs logic::hide_button, which takes its clicks there).
 */
export function hideButton(side: number): { x: number; y: number; scale: number } {
  const k = side / PANEL_SIZE;
  return { x: 94 * k, y: 28 * k, scale: Math.min(1.3, Math.max(0.8, k)) };
}

/** Hit test of the round body inside the square window (window-local). */
export function isOverBody(local: Point, panelSize = PANEL_SIZE): boolean {
  const c = panelSize / 2;
  const r = panelSize * BODY_RADIUS_FRACTION;
  const dx = local.x - c;
  const dy = local.y - c;
  return dx * dx + dy * dy <= r * r;
}

/** Eye-tracking origin: the window centre, in the same space as the cursor. */
export function lookOrigin(panelMinX: number, panelMinY: number, panelSize = PANEL_SIZE): Point {
  return { x: panelMinX + panelSize / 2, y: panelMinY + panelSize / 2 };
}

/** BotCanvasView.lookX / lookY: x right +, y up +. */
export function gaze(bot: Point, mouse: Point): { lookX: number; lookY: number } {
  return {
    lookX: Math.tanh((mouse.x - bot.x) / 260),
    lookY: -Math.tanh((mouse.y - bot.y) / 200),
  };
}

/** Agent work keeps him awake; idle and sleeping don't. */
export function agentActive(state: BotStateName): boolean {
  return state !== "idle" && state !== "sleeping";
}

/**
 * Linux has no global cursor (Wayland), so his window only hears the pointer
 * while it is over his body. That counts as "near" for this long afterwards.
 */
export const POINTER_MEMORY_MS = 4000;

/**
 * Distance from the pointer to his centre, for shouldSleep. With a cursor
 * poll (Windows) it is measured; without one, the pointer is near while it was
 * over him a moment ago, and far otherwise.
 */
export function pointerDistance(
  cursorPoll: boolean,
  cursor: Point | null,
  sincePointerMs: number,
  panelSize = PANEL_SIZE,
): number {
  if (cursorPoll) {
    return cursor ? Math.hypot(cursor.x - panelSize / 2, cursor.y - panelSize / 2) : Infinity;
  }
  return sincePointerMs < POINTER_MEMORY_MS ? 0 : Infinity;
}

/**
 * Layer-shell drag: the surface is stretched over the display, so the pointer
 * reads in display coordinates — once the compositor has applied it. Until
 * then the pointer is still relative to the small surface at `origin`.
 */
export function layerDragTopLeft(origin: Point, client: Point, grab: Point, overlayApplied: boolean): Point {
  const base = overlayApplied ? { x: 0, y: 0 } : origin;
  return { x: base.x + client.x - grab.x, y: base.y + client.y - grab.y };
}

/** X11 drag: screen coordinates are global there; the window moves in physical pixels. */
export function windowDragTopLeft(origin: Point, screen: Point, screenAtPress: Point, dpr: number): Point {
  return {
    x: origin.x + (screen.x - screenAtPress.x) * dpr,
    y: origin.y + (screen.y - screenAtPress.y) * dpr,
  };
}

// ── Life cycle ────────────────────────────────────────────────────────────────

export type DesktopPhase =
  /** No window on screen. */
  | "home"
  /** Window flying out to his spot. */
  | "flyingOut"
  /** On the desktop: the normal state. */
  | "onDesktop";

/** Everything the life cycle does to the world, injected so it can be tested. */
export interface DesktopPorts {
  /**
   * Shows the window and flies it to his spot. False: no spot.
   * `anywhere`: a spot on a display that is gone gives way to the first-visit
   * corner instead of keeping him home (the user asked him out).
   */
  flyOut(anywhere: boolean): Promise<boolean>;
  /** An emote on the desktop Buddybara. */
  emote(emote: BotEmoteName, duration?: number): void;
}

export class DesktopBuddybaraController {
  phase: DesktopPhase = "home";
  /** He lives on the desktop (the `onDesktop` preference). */
  enabled = false;

  private lastState: BotStateName | null = null;
  private port: DesktopPorts;

  constructor(port: DesktopPorts) {
    this.port = port;
  }

  /** Launch: fly out to his spot if he lives there. */
  async launchFlyIfNeeded(anywhere = false): Promise<void> {
    if (!this.enabled || this.phase !== "home") return;
    this.phase = "flyingOut";
    const ok = await this.port.flyOut(anywhere);
    if (this.phase !== "flyingOut") return;
    if (!ok) {
      // His spot is on a display that is gone: he stays home.
      this.phase = "home";
      this.enabled = false;
      return;
    }
    this.phase = "onDesktop";
  }

  /** Call with the effective state; a task finishing gets a happy jump. */
  updateState(state: BotStateName) {
    const prev = this.lastState;
    this.lastState = state;
    if (prev == null || prev === state) return;
    if (state === "finished" && this.phase === "onDesktop") this.port.emote("happy", 1.2);
  }
}
