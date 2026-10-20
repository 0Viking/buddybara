// Buddybara, the capybara with a mikan on its head, drawn in Canvas 2D.
//
// The engine half (states, tweens, emotes, particles, badges) is what the rest of
// the app talks to. The character is its own: a boxy capybara head whose ears
// twitch, perk up and droop, a snout that sniffs and chews, beady eyes that
// follow the pointer and glance around when it rests, two small paws (one
// waves hello) and a mikan that wobbles on its head and gets tossed when work
// is done. Colours and proportions match the app icon (scripts/gen-icons.mjs).

import { Ease, lerp, type EaseFn } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup";

export type BadgeKind = "dots" | "bang" | "question" | "dot";

export interface Badge {
  kind: BadgeKind;
  color: RGB;
}

export type RGB = readonly [number, number, number]; // components 0…1

export type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn];

interface Tween {
  prop: PropKey;
  keys: TweenKey[];
  index: number;
  from: number;
  startMs: number;
  onComplete?: () => void;
}

type PropKey =
  | "yaw" | "pitch" | "roll" | "tilt" | "open" | "sx" | "sy"
  | "oy" | "ox" | "tint" | "hands" | "blush" | "es" | "badgeS"
  | "earL" | "earR" | "mikanY" | "mikanSpin";

interface BotStateCfg {
  color: RGB;
  tint: number;
  eye: EyeShape;
  badge: Badge | null;
  bounces: boolean;
  scans: boolean;
  breathes: boolean;
  zz: boolean;
  sweat: boolean;
  look: readonly [number, number] | null;
  tilt: number;
}

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z";
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number; size: number;
}

// ── The capybara (palette and proportions of scripts/gen-icons.mjs) ──────────
// Lengths are in units of R, the body radius, from the centre of the head.

const HEAD_RX = 1.12;
const HEAD_RY = 0.9;
const HEAD_N = 3.2;
/** The figure sits this far below the canvas centre: the mikan takes the room above. */
const DROP = 0.22;
/** Ears pivot at their base, inside the head; `rise` lifts the ear above it. */
const EAR = { x: 0.88, y: -0.7, rise: 0.16, rx: 0.22, ry: 0.19 };
const EYE = { x: 0.5, y: -0.32, w: 0.22, h: 0.27 };
const SNOUT = { y: 0.34, rx: 0.7, ry: 0.43, n: 3 };
const MIKAN = { y: -1.12, r: 0.48 };
const PAW = { x: 0.42, y: 0.86, rx: 0.17, ry: 0.11 };
/** A picture in the capybara's place (`skin`) fits in this box, in R: about his
 *  height from the top of the mikan to the paws, and a little wider than him. */
const SKIN = { h: 2.55, w: 2.9 };
/** Pores on the mikan's peel, in units of its radius. */
const PORES: readonly (readonly [number, number])[] = [
  [0.3, -0.1], [-0.1, 0.35], [0.42, 0.38], [-0.45, 0.15], [0.1, -0.55], [0.55, -0.25],
];

const rgb255 = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255];
const FUR_TOP = rgb255(176, 127, 85);
const FUR_BOTTOM = rgb255(148, 101, 63);
const EAR_FUR = rgb255(123, 75, 42);
const EAR_IN = rgb255(90, 52, 28);
const MUZZLE = rgb255(134, 89, 56);
const PAW_FUR = rgb255(110, 70, 42);
const RIM = "rgb(43,26,16)";
const NOSE = "rgb(58,36,24)";
const BLUSH = "242,140,130";
const MIKAN_LIGHT = "rgb(255,186,74)";
const MIKAN_DARK = "rgb(238,118,18)";
const LEAF = "rgb(76,175,80)";
const LEAF_VEIN = "rgb(46,125,50)";
const STEM = "rgb(93,64,55)";
const INK = "rgb(30,20,16)";

/** Ear pose by state: perked up (−) or drooping (+), in radians. */
const EAR_POSE: Partial<Record<BotStateName, number>> = {
  approval: -0.28, question: -0.2, sleeping: 0.6, ratelimit: 0.45, error: 0.35,
};
/** States calm enough for the eyes to wander when the pointer rests. */
const GLANCES = new Set<BotStateName>(["idle", "working", "finished"]);
/** States in which a picture bobs along, as if hopping while it works. */
const BOBS = new Set<BotStateName>(["working", "searching"]);

const C = {
  idle: [0.902, 0.914, 0.933] as RGB,
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  searching: [0.388, 0.396, 0.949] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
  sleeping: [0.58, 0.635, 0.722] as RGB,
  dizzy: [0.957, 0.447, 0.714] as RGB,
};

const base = {
  bounces: false, scans: false, breathes: false, zz: false, sweat: false,
  look: null, tilt: 0,
};

export const BOT_STATES: Record<BotStateName, BotStateCfg> = {
  idle: { ...base, color: C.idle, tint: 0, eye: "pill", badge: null },
  working: { ...base, color: C.working, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.working } },
  thinking: { ...base, color: C.thinking, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.thinking }, look: [0.55, 0.55] },
  searching: { ...base, color: C.searching, tint: 0.72, eye: "pill", badge: { kind: "dots", color: C.searching }, scans: true },
  approval: { ...base, color: C.approval, tint: 0.78, eye: "wide", badge: { kind: "bang", color: C.approval }, bounces: true },
  question: { ...base, color: C.question, tint: 0.75, eye: "pill", badge: { kind: "question", color: C.question }, tilt: 0.17 },
  error: { ...base, color: C.error, tint: 0.78, eye: "flat", badge: { kind: "dot", color: C.error } },
  finished: { ...base, color: C.finished, tint: 0.35, eye: "happy", badge: { kind: "dot", color: C.finished } },
  ratelimit: { ...base, color: C.ratelimit, tint: 0.72, eye: "tired", badge: { kind: "dot", color: C.ratelimit }, sweat: true },
  sleeping: { ...base, color: C.sleeping, tint: 0.32, eye: "closed", badge: null, breathes: true, zz: true },
  dizzy: { ...base, color: C.dizzy, tint: 0.7, eye: "spiral", badge: null },
};

const EMOTE_EYE: Record<BotEmoteName, EyeShape> = {
  love: "heart", surprised: "dot", proud: "star", wink: "wink",
  yawn: "tired", happy: "happy", annoyed: "line",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const now = () => performance.now() / 1000;

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix3 = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

/** |x/rx|ⁿ + |y/ry|ⁿ = 1 around (ox, oy): the capybara's square-ish face and snout. */
function superellipse(rx: number, ry: number, n: number, ox = 0, oy = 0, steps = 64): Path2D {
  const p = new Path2D();
  const e = 2 / n;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const px = ox + rx * Math.sign(c) * Math.pow(Math.abs(c), e);
    const py = oy + ry * Math.sign(s) * Math.pow(Math.abs(s), e);
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  p.closePath();
  return p;
}

function roundRectPath(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}

const FONT = `system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

type Face = ReturnType<BotEngine["face"]>;

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  // Animated state (BotEngine `s`)
  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1;
  sx = 1; sy = 1; oy = 0; ox = 0;
  tint = 0; hands = 0; blush = 0; es = 1; badgeS = 0;

  // Spring lag of the mikan behind the head's moves, −1…1.
  physDx = 0;
  physDy = 0;
  private physVx = 0;
  private physVy = 0;
  private prevYaw = 0;
  private prevOy = 0;
  private prevRoll = 0;

  // Targets
  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1;

  /** Extra canvas height above the body so hearts can fly out without clipping. */
  particleOverhang = 0;

  // Mouth spring (fraction of R)
  slotH = 0; slotHTarget = 0; slotHVel = 0;

  col: RGB = C.idle;
  colT: RGB = C.idle;

  state: BotStateName = "idle";
  cfg: BotStateCfg = BOT_STATES.idle;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;

  badge: Badge | null = null;
  private badgeKey = "none";
  private badgeToken = 0;

  private tweens = new Map<PropKey, Tween>();
  private locks = new Set<PropKey>();
  private particles: Particle[] = [];

  lookX = 0;
  lookY = 0;

  lastTime = now();
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;
  waveUntil = 0;
  waveStart = 0;
  private greetToken = 0;
  private lastAmbient = 0;

  // Capybara life: ears, sniffing, chewing, glances and the mikan.
  /** Ear flicks (tweened), radians. */
  earL = 0;
  earR = 0;
  /** Ear pose, following the state: drooping (+) or perked (−). */
  earPose = 0;
  /** The mikan's hop above its seat, in R, and its spin while it flies. */
  mikanY = 0;
  mikanSpin = 0;
  /** The Claude plan's usage, shown on the mikan (null hides it), and its gauge colour. */
  usagePct: number | null = null;
  usageColor = "#22C55E";
  /** A picture of the user's own in the capybara's place (Settings → Customization): it
   *  moves as he does, under the usage gauge and the badge. Null draws the capybara. */
  skin: ImageBitmap | null = null;
  /** A picture has no ears or nose to keep it alive: now and then, it fidgets. */
  private nextFidget = now() + 6 + Math.random() * 6;
  private nextEarFlick = now() + 2 + Math.random() * 3;
  private sniffStart = 0;
  private sniffUntil = 0;
  private nextSniff = now() + 4 + Math.random() * 4;
  private chewUntil = 0;
  private nextChew = now() + 6 + Math.random() * 6;
  private glanceX = 0;
  private glanceY = 0;
  private glanceTgX = 0;
  private glanceTgY = 0;
  private nextGlance = 0;
  private lastLookMove = now();
  private lastLookX = 0;
  private lastLookY = 0;

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    const prev = this.state;
    this.state = next;
    this.cfg = BOT_STATES[next];
    this.colT = this.cfg.color;
    if (!this.locks.has("tint")) this.tint = this.cfg.tint;
    if (!this.locks.has("tilt")) this.tgTilt = this.cfg.tilt;
    this.setBadge(this.cfg.badge);

    switch (next) {
      case "finished":
        this.tossMikan();
        setTimeout(() => this.emit("spark", 5), 500);
        break;
      case "error":
        this.anim("ox", [
          [0.08, 50, Ease.out], [-0.08, 70, Ease.inOut],
          [0.05, 70, Ease.inOut], [0, 90, Ease.out],
        ]);
        break;
      case "approval":
        this.anim("oy", [[-0.2, 150, Ease.out], [0, 300, Ease.back]]);
        break;
      case "dizzy":
        this.doRoll(1300, 2);
        break;
      case "question":
        this.blink();
        break;
      case "ratelimit":
        this.emit("sweat", 1);
        break;
      default:
        if (prev !== "idle" || next !== "idle") this.blink();
    }
  }

  setBadge(b: Badge | null) {
    const key = b ? `${b.kind}-${b.color.join(",")}` : "none";
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    const tok = ++this.badgeToken;
    this.anim("badgeS", [[0, 90, Ease.inOut]]);
    setTimeout(() => {
      if (tok !== this.badgeToken) return;
      this.badge = b;
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    }, 100);
  }

  blink() {
    if (this.locks.has("open")) return;
    this.anim("open", [[0.06, 70, Ease.inOut], [1, 130, Ease.out]]);
  }

  /** A landing's squash; `k` scales it (a whole picture squashes by half: all of him is the body). */
  squash(k = 1) {
    this.physVy += 0.6 * k;
    this.anim("sy", [[1 - 0.22 * k, 70, Ease.out], [1 + 0.1 * k, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim("sx", [[1 + 0.16 * k, 70, Ease.out], [1 - 0.05 * k, 130, Ease.out], [1, 170, Ease.inOut]]);
  }

  /** Work done: a hop, and the mikan flies up, turns once and lands back. */
  tossMikan() {
    this.anim("oy", [[-0.16, 160, Ease.out], [0, 320, Ease.back]]);
    this.anim("mikanY", [[-0.4, 300, Ease.out], [0, 320, Ease.easeIn]], () => this.squash(this.skin ? 0.5 : 1));
    this.anim("mikanSpin", [[Math.PI * 2, 620, Ease.inOut]], () => { this.mikanSpin = 0; });
  }

  private flickEar(side: "earL" | "earR") {
    if (this.locks.has(side)) return;
    this.anim(side, [[0.5, 60, Ease.out], [-0.12, 90, Ease.inOut], [0.22, 80, Ease.inOut], [0, 150, Ease.out]]);
  }

  doRoll(durationMs: number, turns: number) {
    this.roll = 0;
    this.anim("roll", [[Math.PI * 2 * turns, durationMs, Ease.inOut]], () => { this.roll = 0; });
  }

  /** Hello: a little hop, happy eyes and a wave of the right paw. */
  greet() {
    const t = now();
    const tok = ++this.greetToken;
    this.waveStart = t + 0.45;
    this.waveUntil = t + 1.55;
    this.physVx += 0.2;

    this.eyeOverride = "happy";
    this.eyeOverrideUntil = t + 2.0;
    this.anim("oy", [[-0.06, 220, Ease.out], [0.0, 220, Ease.back]]);

    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.anim("hands", [[1, 280, Ease.out]]);
      this.anim("sy", [[0.95, 100, Ease.out], [1.0, 260, Ease.back]]);
      this.anim("sx", [[1.04, 100, Ease.out], [1.0, 260, Ease.back]]);
      Sound.play("greet");
    }, 250);

    setTimeout(() => { if (this.greetToken === tok) this.blink(); }, 550);
    setTimeout(() => { if (this.greetToken === tok) this.blink(); }, 1500);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.waveUntil = 0;
      this.anim("hands", [[0, 200, Ease.inOut]]);
    }, 1550);
    setTimeout(() => {
      if (this.greetToken !== tok) return;
      this.eyeOverride = "happy";
      this.eyeOverrideUntil = now() + 0.3;
    }, 1750);
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    const t = now();
    this.eyeOverride = EMOTE_EYE[emote];
    this.eyeOverrideUntil = t + duration;

    switch (emote) {
      case "love":
        this.anim("blush", [
          [1, 300, Ease.out], [1, (duration - 0.6) * 1000, Ease.lin], [0, 300, Ease.inOut],
        ]);
        this.emit("heart", 4);
        this.anim("oy", [[-0.1, 160, Ease.out], [0, 300, Ease.back]]);
        break;
      case "surprised":
        this.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
        this.anim("es", [[1.25, 120, Ease.out], [1, 500, Ease.inOut]]);
        break;
      case "proud":
        this.emit("star", 5);
        this.anim("tilt", [
          [-0.14, 220, Ease.out], [-0.14, (duration - 0.5) * 1000, Ease.lin], [0, 280, Ease.inOut],
        ]);
        this.anim("blush", [
          [0.7, 250, Ease.out], [0.7, (duration - 0.5) * 1000, Ease.lin], [0, 300, Ease.inOut],
        ]);
        break;
      case "wink":
        this.anim("tilt", [
          [0.12, 160, Ease.out], [0.12, (duration - 0.4) * 1000, Ease.lin], [0, 240, Ease.inOut],
        ]);
        break;
      case "yawn":
        this.anim("sy", [[1.12, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        this.anim("sx", [[0.94, 500, Ease.inOut], [1, 500, Ease.inOut]]);
        this.slotHTarget = 0.32;
        setTimeout(() => {
          this.slotHTarget = 0;
          this.eyeOverride = "closed";
          this.emit("z", 2);
        }, 700);
        break;
      case "happy":
        this.anim("blush", [[0.6, 200, Ease.out], [0, 600, Ease.inOut]]);
        break;
      case "annoyed":
        this.eyeOverride = "line";
        this.eyeOverrideUntil = t + 0.8;
        setTimeout(() => Sound.play("annoyed"), 60);
        break;
    }
  }

  emit(type: Particle["type"], count: number) {
    for (let i = 0; i < count; i++) {
      const isZ = type === "z";
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
      });
    }
  }

  // ── Tweens ──────────────────────────────────────────────────────────────────

  anim(prop: PropKey, keys: TweenKey[], onComplete?: () => void) {
    this.tweens.set(prop, {
      prop, keys, index: 0, from: this[prop], startMs: performance.now(), onComplete,
    });
    this.locks.add(prop);
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number) {
    const n = now();
    const nowMs = performance.now();

    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.index];
      const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]));
      this[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.index += 1;
        tw.startMs = nowMs;
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          this.locks.delete(tw.prop);
          tw.onComplete?.();
        }
      }
    }

    const t = n - this.t0;
    let ty = this.lookX * 0.62;
    let tp = this.lookY * 0.5;

    if (this.cfg.look) {
      ty = ty * 0.35 + this.cfg.look[0] * 0.55;
      tp = tp * 0.3 + this.cfg.look[1] * 0.5;
    }
    if (this.cfg.scans) {
      ty = Math.sin(t * 2.6) * 0.6;
      tp = -0.06;
    }
    if (this.state === "sleeping") { ty = 0; tp = -0.14; }
    if (this.state === "dizzy") { ty = Math.sin(t * 9) * 0.25; }

    this.tgYaw = ty;
    this.tgPitch = tp;
    this.tgTilt = this.cfg.tilt;

    if (n > this.waveStart && n < this.waveUntil) {
      const wt = n - this.waveStart;
      this.tgTilt = -0.06 + Math.sin(2 * Math.PI * 1.2 * wt) * 0.07;
    }
    // A picture thinks swaying from side to side.
    if (this.skin && this.state === "thinking") this.tgTilt += Math.sin(t * 1.3) * 0.05;

    let bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    const bobbing = this.skin != null && BOBS.has(this.state);
    if (bobbing) bounce = -Math.abs(Math.sin(t * 4.2)) * 0.06;
    const kGen = 1 - Math.pow(0.0008, dt);
    if (!this.locks.has("oy")) this.oy += (bounce - this.oy) * kGen;

    if (this.cfg.breathes) {
      this.tgSy = 1 + Math.sin(t * 1.8) * 0.035;
      this.tgSx = 1 - Math.sin(t * 1.8) * 0.02;
    } else if (bobbing) {
      // Each bob lands with a little squash.
      const contact = (1 - Math.abs(Math.sin(t * 4.2))) ** 6;
      this.tgSy = 1 - 0.05 * contact;
      this.tgSx = 1 + 0.03 * contact;
    } else {
      this.tgSy = 1;
      this.tgSx = 1;
    }

    const kLook = 1 - Math.pow(0.0025, dt);
    if (!this.locks.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.locks.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.locks.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.locks.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.locks.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.locks.has("es")) this.es += (this.tgEs - this.es) * kGen;

    this.col = mix3(this.col, this.colT, 1 - Math.pow(0.002, dt));

    if (n > this.nextBlink) {
      if (this.state !== "sleeping" && this.state !== "dizzy") {
        this.blink();
        if (Math.random() < 0.22) setTimeout(() => this.blink(), 230);
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2;
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) this.eyeOverride = null;

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (this.cfg.zz) this.emit("z", 1);
      if (this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }

    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);

    // Mouth slot spring — ω₀ = 2π/0.25, ζ = 0.6
    const omega = (2 * Math.PI) / 0.25;
    const zeta = 0.6;
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * zeta * omega * this.slotHVel;
    this.slotHVel += acc * dt;
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt);

    // Soft-part spring: lags behind head turns, hops and rolls (stiffness 60, damping 9).
    if (dt > 0) {
      const yawVel = (this.yaw - this.prevYaw) / dt;
      const oyVel = (this.oy - this.prevOy) / dt;
      // A finished roll snaps from 2π·turns back to 0: that jump is not motion.
      const dRoll = this.roll - this.prevRoll;
      const rollVel = Math.abs(dRoll) > Math.PI ? 0 : dRoll / dt;
      const centrifugal = rollVel * 0.18;
      const tDx = Math.max(-1, Math.min(1, -yawVel * 0.35 - this.tilt * 2 + centrifugal));
      const tDy = Math.max(-1, Math.min(1, oyVel * 0.5));
      this.physVx += (60 * (tDx - this.physDx) - 9 * this.physVx) * dt;
      this.physVy += (60 * (tDy - this.physDy) - 9 * this.physVy) * dt;
      this.physDx += this.physVx * dt;
      this.physDy += this.physVy * dt;
    }
    this.prevYaw = this.yaw;
    this.prevOy = this.oy;
    this.prevRoll = this.roll;

    this.updateLife(n, t, dt, kGen);
    this.lastTime = n;
  }

  /**
   * A picture's idle fidget: a little hop, a wiggle or a stretch — `kind` 0,
   * 1 or 2 (Settings' preview of them), or one at random.
   */
  fidget(kind?: number) {
    const pick = kind == null ? Math.random() : [0, 0.5, 0.9][kind] ?? 0;
    if (pick < 0.4) {
      this.anim("oy", [[-0.08, 150, Ease.out], [0, 260, Ease.back]], () => this.squash(0.45));
    } else if (pick < 0.75) {
      this.anim("tilt", [[0.07, 140, Ease.inOut], [-0.06, 180, Ease.inOut], [0, 160, Ease.out]]);
    } else {
      this.anim("sy", [[1.06, 380, Ease.inOut], [1, 420, Ease.inOut]]);
      this.anim("sx", [[0.96, 380, Ease.inOut], [1, 420, Ease.inOut]]);
    }
  }

  /** Ears, sniffing, chewing and glances: what keeps a resting capybara alive. */
  private updateLife(n: number, t: number, dt: number, kGen: number) {
    if (this.skin && n > this.nextFidget) {
      if (this.state === "idle") this.fidget();
      this.nextFidget = n + 6 + Math.random() * 8;
    }
    const earTarget = this.state === "dizzy" ? Math.sin(t * 7) * 0.45 : EAR_POSE[this.state] ?? 0;
    this.earPose += (earTarget - this.earPose) * kGen;

    if (n > this.nextEarFlick) {
      if (this.state !== "sleeping") {
        const side = Math.random() < 0.5 ? "earL" : "earR";
        this.flickEar(side);
        // Now and then the other one answers.
        if (Math.random() < 0.3) setTimeout(() => this.flickEar(side === "earL" ? "earR" : "earL"), 260);
      }
      this.nextEarFlick = n + 2.5 + Math.random() * 5;
    }
    if (n > this.nextSniff) {
      if (this.state === "idle" || this.state === "working" || this.state === "thinking") {
        this.sniffStart = n;
        this.sniffUntil = n + 0.75;
      }
      this.nextSniff = n + 5 + Math.random() * 7;
    }
    if (n > this.nextChew) {
      if (this.state === "idle") this.chewUntil = n + 1.4 + Math.random();
      this.nextChew = n + 7 + Math.random() * 8;
    }

    // The pointer has rested for a while: the eyes wander, and come back.
    if (Math.abs(this.lookX - this.lastLookX) > 0.004 || Math.abs(this.lookY - this.lastLookY) > 0.004) {
      this.lastLookX = this.lookX;
      this.lastLookY = this.lookY;
      this.lastLookMove = n;
      this.glanceTgX = 0;
      this.glanceTgY = 0;
    } else if (n - this.lastLookMove > 2.5 && n > this.nextGlance && GLANCES.has(this.state)) {
      const away = this.glanceTgX === 0 && this.glanceTgY === 0;
      this.glanceTgX = away ? Math.random() * 2 - 1 : 0;
      this.glanceTgY = away ? Math.random() * 1.2 - 0.5 : 0;
      this.nextGlance = n + (away ? 0.5 + Math.random() * 0.8 : 1.5 + Math.random() * 3);
    }
    if (!GLANCES.has(this.state)) {
      this.glanceTgX = 0;
      this.glanceTgY = 0;
    }
    // Eyes jump to where they look (a saccade); they don't drift.
    const k = 1 - Math.pow(1e-7, dt);
    this.glanceX += (this.glanceTgX - this.glanceX) * k;
    this.glanceY += (this.glanceTgY - this.glanceY) * k;
  }

  /** 0…1, the jaw going while it chews (idling). */
  private chewAmount(): number {
    const n = now();
    if (n >= this.chewUntil) return 0;
    return 0.5 + 0.5 * Math.sin(n * 13);
  }

  /** 0…1, the nostrils flaring: all the time while searching, in bursts otherwise. */
  private sniffAmount(): number {
    const n = now();
    if (this.state === "searching") return Math.max(0, Math.sin(n * 15));
    return n < this.sniffUntil ? Math.max(0, Math.sin((n - this.sniffStart) * 15)) : 0;
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /**
   * Draws the capybara (ears, head, face, paws, mikan), its badge and particles
   * into a canvas of `w`×`h` CSS pixels (the caller has already applied the DPR
   * transform).
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * 0.3;
    const cx = W / 2 + this.ox * R;
    const cy = H / 2 + this.particleOverhang / 2 + this.oy * R + R * DROP;

    x.save();
    x.translate(cx, cy);
    // A roll (dizzy) turns the whole figure, mikan and all.
    if (this.roll !== 0) x.rotate(this.roll);

    // The badge sits at the figure's top left: the capybara's ear, or the picture's corner.
    let badgeAt: [number, number];
    if (this.skin) {
      badgeAt = this.drawSkin(x, R, this.skin);
    } else {
      if (this.tilt !== 0) x.rotate(this.tilt);
      x.scale(this.sx, this.sy);
      badgeAt = [-R * 0.98 * this.sx, -R * 1.02 * this.sy];
      const face = this.face(R);
      this.drawEars(x, R, face);
      const head = superellipse(HEAD_RX * R, HEAD_RY * R, HEAD_N);
      this.drawHead(x, head, R);
      x.save();
      x.clip(head);
      this.drawCheeks(x, R, face);
      this.drawSnout(x, R, face);
      this.drawEyes(x, R, face);
      x.restore();
      this.drawPaws(x, R);
      this.drawMikan(x, R);
    }
    x.restore();

    if (this.badge && this.badgeS > 0.01) {
      this.drawBadge(x, this.badge, R, cx + badgeAt[0], cy + badgeAt[1]);
    }
    this.drawParticles(x, R, cx, cy);
  }

  /**
   * Where the face sits as the head turns toward the pointer: a fake 3-D turn.
   * The snout is nearest, so it moves most; the ears, at the back, move against it.
   */
  private face(R: number) {
    const fx = Math.sin(this.yaw);
    const fy = Math.sin(this.pitch);
    return {
      fx,
      fy,
      eyeX: fx * 0.28 * R,
      eyeY: -fy * 0.18 * R,
      snoutX: fx * 0.32 * R,
      snoutY: -fy * 0.12 * R,
      earX: -fx * 0.06 * R,
      glanceX: this.glanceX * 0.1 * R,
      glanceY: -this.glanceY * 0.07 * R,
    };
  }

  private drawEars(x: CanvasRenderingContext2D, R: number, f: Face) {
    for (const sd of [-1, 1]) {
      const flick = sd < 0 ? this.earL : this.earR;
      x.save();
      x.translate(sd * (EAR.x + this.earPose * 0.06) * R + f.earX, (EAR.y + this.earPose * 0.14) * R - f.fy * 0.04 * R);
      x.rotate(sd * (this.earPose + flick));
      x.beginPath();
      x.ellipse(0, -EAR.rise * R, EAR.rx * R, EAR.ry * R, 0, 0, Math.PI * 2);
      x.lineWidth = R * 0.09;
      x.strokeStyle = RIM;
      x.stroke();
      x.fillStyle = rgba(EAR_FUR);
      x.fill();
      x.beginPath();
      x.ellipse(0, -EAR.rise * R + 0.01 * R, EAR.rx * 0.57 * R, EAR.ry * 0.53 * R, 0, 0, Math.PI * 2);
      x.fillStyle = rgba(EAR_IN);
      x.fill();
      x.restore();
    }
  }

  private drawHead(x: CanvasRenderingContext2D, head: Path2D, R: number) {
    // The rim first: the fill covers its inner half.
    x.lineWidth = R * 0.09;
    x.lineJoin = "round";
    x.strokeStyle = RIM;
    x.stroke(head);
    const g = x.createLinearGradient(0, -HEAD_RY * R, 0, HEAD_RY * R);
    g.addColorStop(0, rgba(FUR_TOP));
    g.addColorStop(1, rgba(FUR_BOTTOM));
    x.fillStyle = g;
    x.fill(head);
    // The state's colour rises from below, a glow in the fur.
    if (this.tint > 0.01) {
      const tg = x.createLinearGradient(0, HEAD_RY * R, 0, -HEAD_RY * R * 0.2);
      tg.addColorStop(0, rgba(this.col, 0.6 * this.tint));
      tg.addColorStop(1, rgba(this.col, 0));
      x.fillStyle = tg;
      x.fill(head);
    }
    // Soft light from the top left, like the mikan's.
    const hl = x.createRadialGradient(-0.45 * R, -0.55 * R, 0, -0.45 * R, -0.55 * R, R * 0.9);
    hl.addColorStop(0, "rgba(255,240,220,0.35)");
    hl.addColorStop(1, "rgba(255,240,220,0)");
    x.fillStyle = hl;
    x.fill(head);
  }

  private drawCheeks(x: CanvasRenderingContext2D, R: number, f: Face) {
    const v = Math.min(1, 0.4 + Math.max(this.blush, this.tint * 0.4) * 0.6);
    x.fillStyle = `rgba(${BLUSH},${0.55 * v})`;
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.ellipse(sd * 0.8 * R + f.eyeX * 0.8, -0.06 * R + f.eyeY, 0.13 * R, 0.09 * R, 0, 0, Math.PI * 2);
      x.fill();
    }
  }

  /** The long boxy snout: nostrils that sniff, the split lip, a ω that chews, or an open mouth. */
  private drawSnout(x: CanvasRenderingContext2D, R: number, f: Face) {
    const squeeze = 1 - 0.08 * Math.abs(f.fx);
    const chew = this.chewAmount();
    const sniff = this.sniffAmount();
    const sx = f.snoutX;
    const sy = SNOUT.y * R + f.snoutY;
    x.fillStyle = rgba(MUZZLE);
    x.fill(superellipse(SNOUT.rx * R * squeeze, SNOUT.ry * R + chew * 0.03 * R, SNOUT.n, sx, sy + chew * 0.015 * R, 48));

    const ny = sy - 0.19 * R - sniff * 0.02 * R;
    x.fillStyle = NOSE;
    for (const sd of [-1, 1]) {
      x.save();
      x.translate(sx + sd * 0.18 * R * squeeze + f.fx * 0.04 * R, ny);
      x.rotate(sd * 0.35);
      x.beginPath();
      x.ellipse(0, 0, 0.085 * R * (1 + 0.3 * sniff), 0.06 * R * (1 + 0.2 * sniff), 0, 0, Math.PI * 2);
      x.fill();
      x.restore();
    }

    const mx = sx + f.fx * 0.03 * R;
    const top = ny + 0.08 * R;
    const base = sy + 0.08 * R + chew * 0.035 * R;
    x.strokeStyle = NOSE;
    x.lineWidth = Math.max(1.2, 0.065 * R);
    x.lineCap = "round";
    x.lineJoin = "round";
    x.beginPath();
    x.moveTo(mx, top);
    x.lineTo(mx, base);
    x.stroke();
    if (this.slotH > 0.02) {
      const oh = this.slotH * 0.5 * R;
      x.fillStyle = "rgb(60,24,20)";
      x.beginPath();
      x.ellipse(mx, base + oh * 0.5, 0.21 * R, oh * 0.65 + 0.03 * R, 0, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "rgb(225,110,110)";
      x.beginPath();
      x.ellipse(mx, base + oh * 0.8, 0.13 * R, oh * 0.3, 0, 0, Math.PI * 2);
      x.fill();
    } else {
      const w = 0.2 * R * (1 + chew * 0.15);
      x.beginPath();
      x.moveTo(mx - w, base - 0.03 * R);
      x.quadraticCurveTo(mx - w / 2, base + 0.11 * R, mx, base);
      x.quadraticCurveTo(mx + w / 2, base + 0.11 * R, mx + w, base - 0.03 * R);
      x.stroke();
    }
  }

  private drawEyes(x: CanvasRenderingContext2D, R: number, f: Face) {
    let shape: EyeShape = this.eyeOverride ?? this.cfg.eye;
    if (!this.eyeOverride && this.slotHTarget > 0.05) shape = "cup";
    const ink = INK;
    for (const sd of [-1, 1]) {
      // The far eye narrows as the head turns.
      const narrow = 1 - 0.3 * Math.max(0, -sd * f.fx);
      const ex = sd * EYE.x * R * (1 - 0.1 * Math.abs(f.fx)) + f.eyeX + f.glanceX;
      const ey = EYE.y * R + f.eyeY + f.glanceY;
      x.save();
      x.translate(ex, ey);
      x.scale(narrow, 1);
      x.fillStyle = ink;
      x.strokeStyle = ink;
      this.drawEyeShape(x, shape, EYE.w * R * this.es, EYE.h * R * this.es, sd, ink);
      x.restore();
    }
  }

  private drawEyeShape(
    x: CanvasRenderingContext2D, shape: EyeShape,
    w: number, h: number, sd: number, ink: string,
  ) {
    const t = now();
    x.lineCap = "round";
    switch (shape) {
      case "wide":
      case "cup":
        this.bead(x, w * 1.2, h * 1.18, ink, true);
        break;
      case "pill":
        this.bead(x, w, h, ink, false);
        break;
      case "dot":
        x.beginPath();
        x.arc(0, 0, w * 0.32, 0, Math.PI * 2);
        x.fill();
        break;
      case "line":
        x.rotate(sd * 0.22);
        roundRectPath(x, -w * 0.7, -w * 0.14, w * 1.4, w * 0.28, w * 0.14);
        x.fill();
        break;
      case "flat":
        roundRectPath(x, -w * 0.65, -w * 0.13, w * 1.3, w * 0.26, w * 0.13);
        x.fill();
        break;
      case "happy":
        x.lineWidth = w * 0.38;
        x.beginPath();
        x.arc(0, h * 0.25, w * 0.62, Math.PI * 1.15, Math.PI * 1.85);
        x.stroke();
        break;
      case "closed":
        x.lineWidth = w * 0.32;
        x.beginPath();
        x.arc(0, -h * 0.1, w * 0.6, Math.PI * 0.15, Math.PI * 0.85);
        x.stroke();
        break;
      case "spiral": {
        x.lineWidth = w * 0.2;
        x.beginPath();
        for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
          const r = w * 0.05 + a * w * 0.05;
          const aa = a + t * 9 * sd;
          if (a === 0) x.moveTo(Math.cos(aa) * r, Math.sin(aa) * r);
          else x.lineTo(Math.cos(aa) * r, Math.sin(aa) * r);
        }
        x.stroke();
        break;
      }
      case "heart":
        x.fillStyle = "#FF4D6D";
        heartPath(x, w * 1.05);
        x.fill();
        break;
      case "star":
        x.fillStyle = "#F7B32B";
        x.rotate(t * 1.5 * sd);
        starPath(x, w * 0.95, w * 0.42);
        x.fill();
        break;
      case "tired":
        // Heavy lids: the bottom half of the eye under a straight lid.
        x.save();
        x.beginPath();
        x.rect(-w, -h * 0.05, w * 2, h);
        x.clip();
        this.bead(x, w, h, ink, false);
        x.restore();
        x.lineWidth = w * 0.22;
        x.beginPath();
        x.moveTo(-w * 0.62, -h * 0.05);
        x.lineTo(w * 0.62, -h * 0.05);
        x.stroke();
        break;
      case "wink":
        if (sd < 0) {
          this.bead(x, w, h, ink, false);
        } else {
          x.lineWidth = w * 0.38;
          x.beginPath();
          x.arc(0, h * 0.25, w * 0.62, Math.PI * 1.15, Math.PI * 1.85);
          x.stroke();
        }
        break;
    }
  }

  /** A capybara's beady eye: dark, with a glint that keeps to the light. Blinks shut to a lid line. */
  private bead(x: CanvasRenderingContext2D, w: number, h: number, ink: string, wide: boolean) {
    const hh = h * Math.max(0, Math.min(1, this.open));
    x.fillStyle = ink;
    x.strokeStyle = ink;
    if (hh < w * 0.35) {
      x.lineWidth = w * 0.3;
      x.beginPath();
      x.moveTo(-w * 0.55, 0);
      x.quadraticCurveTo(0, w * 0.22, w * 0.55, 0);
      x.stroke();
      return;
    }
    x.beginPath();
    x.ellipse(0, 0, w / 2, hh / 2, 0, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#fff";
    x.beginPath();
    x.ellipse(-w * 0.16, -hh * 0.18, w * 0.17, Math.min(w * 0.17, hh * 0.2), 0, 0, Math.PI * 2);
    x.fill();
    if (wide) {
      x.beginPath();
      x.arc(w * 0.14, hh * 0.18, w * 0.07, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = ink;
  }

  /** Two small paws under the chin; the right one rises and waves while greeting. */
  private drawPaws(x: CanvasRenderingContext2D, R: number) {
    if (R <= 10) return;
    const n = now();
    const waving = this.waveStart > 0 && n >= this.waveStart && n < this.waveUntil;
    for (const sd of [-1, 1]) {
      let px = sd * PAW.x * R;
      let py = PAW.y * R;
      let rot = 0;
      if (sd > 0 && this.hands > 0.01) {
        const wt = waving ? n - this.waveStart : 0;
        const wave = waving ? Math.sin(13 * wt) : 0;
        px = lerp(px, 1.12 * R + Math.cos(13 * wt) * 0.05 * R, this.hands);
        py = lerp(py, -0.05 * R - wave * 0.12 * R, this.hands);
        rot = lerp(0, -0.9 + wave * 0.35, this.hands);
      }
      x.save();
      x.translate(px, py);
      x.rotate(rot);
      x.beginPath();
      x.ellipse(0, 0, PAW.rx * R, PAW.ry * R, 0, 0, Math.PI * 2);
      x.lineWidth = R * 0.07;
      x.strokeStyle = RIM;
      x.stroke();
      x.fillStyle = rgba(PAW_FUR);
      x.fill();
      x.strokeStyle = "rgba(43,26,16,0.55)";
      x.lineWidth = Math.max(0.8, R * 0.025);
      for (const k of [-1, 1]) {
        x.beginPath();
        x.moveTo(k * PAW.rx * R * 0.3, PAW.ry * R * 0.05);
        x.lineTo(k * PAW.rx * R * 0.3, PAW.ry * R * 0.75);
        x.stroke();
      }
      x.restore();
    }
  }

  /**
   * The user's picture where the capybara stands, about its height, posed
   * about its feet, and the plan's usage at its top, where the mikan would be.
   * Returns where the badge goes (its top left corner, as posed).
   */
  private drawSkin(x: CanvasRenderingContext2D, R: number, pic: ImageBitmap): [number, number] {
    const k = Math.min((SKIN.h * R) / pic.height, (SKIN.w * R) / pic.width);
    const w = pic.width * k;
    const h = pic.height * k;
    const left = -w / 2;
    const feet = (PAW.y + PAW.ry) * R;
    const top = feet - h;
    const pose = this.skinPose();
    // A point of the picture where the pose takes it.
    const posed = (px: number, py: number): [number, number] => {
      const dy = (py - feet) * pose.sy;
      const dx = px * pose.sx + pose.skew * dy;
      const c = Math.cos(pose.lean);
      const s = Math.sin(pose.lean);
      return [dx * c - dy * s, feet + dx * s + dy * c];
    };

    x.save();
    x.translate(0, feet);
    x.rotate(pose.lean);
    x.transform(1, 0, pose.skew, 1, 0, 0);
    x.scale(pose.sx, pose.sy);
    x.translate(0, -feet);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(pic, left, top, w, h);
    x.restore();

    const pct = this.usagePct == null ? null : Math.max(0, Math.min(100, Math.round(this.usagePct)));
    if (pct != null) {
      // Carried by the picture, but never squashed: it is something to read.
      const [gx, gy] = posed(0, top + R * 0.1);
      x.save();
      x.translate(gx, gy);
      x.rotate(pose.lean);
      this.drawGauge(x, R, 0, 0, pct);
      x.restore();
    }
    return posed(left + R * 0.15, top + R * 0.45);
  }

  /**
   * A picture has no head to turn: it leans toward the pointer and tilts as
   * he would, breathes even awake, and wobbles like jelly after a hop or a
   * turn (the mikan's spring). All about its feet, which stay put.
   */
  private skinPose() {
    const t = now() - this.t0;
    // Asleep, `breathes` already does it, deeper.
    const breath = this.cfg.breathes ? 0 : Math.sin(t * 2.1) * 0.012;
    return {
      lean: this.tilt + this.yaw * 0.08,
      skew: -this.physDx * 0.06,
      sx: this.sx * (1 - breath * 0.6 + this.physDy * 0.025),
      sy: this.sy * (1 + breath - this.physDy * 0.04 + this.pitch * 0.08),
    };
  }

  /** The plan's usage on its own, for a picture: a dark disc, the ring and the number. */
  private drawGauge(x: CanvasRenderingContext2D, R: number, gx: number, gy: number, pct: number) {
    const r = R * 0.36;
    x.beginPath();
    x.arc(gx, gy, r, 0, Math.PI * 2);
    x.fillStyle = "rgba(24,18,14,0.88)";
    x.fill();
    x.lineWidth = R * 0.07;
    x.lineCap = "round";
    x.strokeStyle = "rgba(255,255,255,0.18)";
    x.beginPath();
    x.arc(gx, gy, r, 0, Math.PI * 2);
    x.stroke();
    if (pct > 0) {
      x.strokeStyle = this.usageColor;
      x.beginPath();
      x.arc(gx, gy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100);
      x.stroke();
    }
    const label = `${pct}%`;
    x.font = `800 ${r * (label.length > 3 ? 0.62 : 0.78)}px ${FONT}`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillStyle = "#fff";
    x.fillText(label, gx, gy + r * 0.06);
  }

  /** The mikan on its head: it lags behind moves on a spring, its leaf flutters, and it flies when tossed. */
  private drawMikan(x: CanvasRenderingContext2D, R: number) {
    const r = MIKAN.r * R;
    const mx = Math.sin(this.yaw) * 0.08 * R + this.physDx * 0.12 * R;
    const my = (MIKAN.y + this.mikanY) * R - Math.sin(this.pitch) * 0.04 * R + this.physDy * 0.08 * R;
    x.save();
    x.translate(mx, my);
    x.rotate(this.physDx * 0.35 + this.mikanSpin);

    const pct = this.usagePct == null ? null : Math.max(0, Math.min(100, Math.round(this.usagePct)));
    if (pct != null) {
      // The plan gauge: a ring around the mikan that fills clockwise from the top.
      const ringR = r + R * 0.13;
      x.lineWidth = R * 0.075;
      x.lineCap = "round";
      x.strokeStyle = "rgba(43,26,16,0.55)";
      x.beginPath();
      x.arc(0, 0, ringR, 0, Math.PI * 2);
      x.stroke();
      if (pct > 0) {
        x.strokeStyle = this.usageColor;
        x.beginPath();
        x.arc(0, 0, ringR, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100);
        x.stroke();
      }
    }

    x.beginPath();
    x.arc(0, 0, r, 0, Math.PI * 2);
    x.lineWidth = R * 0.09;
    x.strokeStyle = RIM;
    x.stroke();
    const g = x.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, -r * 0.1, -r * 0.1, r * 1.25);
    g.addColorStop(0, MIKAN_LIGHT);
    g.addColorStop(1, MIKAN_DARK);
    x.fillStyle = g;
    x.fill();
    x.fillStyle = "rgba(200,90,10,0.35)";
    for (const [px, py] of PORES) {
      x.beginPath();
      x.arc(px * r, py * r, r * 0.045, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = "rgba(255,255,255,0.55)";
    x.beginPath();
    x.ellipse(-r * 0.38, -r * 0.42, r * 0.2, r * 0.12, -0.6, 0, Math.PI * 2);
    x.fill();

    if (pct != null) {
      const label = `${pct}%`;
      x.font = `800 ${r * (label.length > 3 ? 0.6 : 0.72)}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.lineJoin = "round";
      x.lineWidth = R * 0.08;
      x.strokeStyle = RIM;
      x.strokeText(label, 0, r * 0.08);
      x.fillStyle = "#fff";
      x.fillText(label, 0, r * 0.08);
    }

    x.fillStyle = STEM;
    x.beginPath();
    x.ellipse(0, -r * 0.97, r * 0.09, r * 0.16, 0, 0, Math.PI * 2);
    x.fill();

    const flutter = Math.sin(now() * 3.1) * 0.08 - this.physDx * 0.4;
    x.save();
    x.translate(r * 0.06, -r * 0.88);
    x.rotate(-0.44 + flutter);
    x.beginPath();
    x.moveTo(0, 0);
    x.quadraticCurveTo(r * 0.45, -r * 0.32, r * 0.9, 0);
    x.quadraticCurveTo(r * 0.45, r * 0.32, 0, 0);
    x.closePath();
    x.lineWidth = R * 0.06;
    x.strokeStyle = RIM;
    x.stroke();
    x.fillStyle = LEAF;
    x.fill();
    x.strokeStyle = LEAF_VEIN;
    x.lineWidth = Math.max(0.8, R * 0.025);
    x.beginPath();
    x.moveTo(r * 0.08, 0);
    x.lineTo(r * 0.75, 0);
    x.stroke();
    x.restore();

    x.restore();
  }

  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, R: number, bx: number, by: number) {
    const bs = this.badgeS;
    const t = now();

    x.save();
    x.translate(bx, by);
    x.scale(bs, bs);
    const col = rgba(badge.color);

    if (badge.kind === "dots") {
      const pw = R * 0.72;
      const ph = R * 0.36;
      roundRectPath(x, -pw / 2, -ph / 2, pw, ph, ph / 2);
      x.fillStyle = col;
      x.fill();
      for (let i = 0; i < 3; i++) {
        const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
        const dotR = R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)));
        x.fillStyle = "#fff";
        x.beginPath();
        x.arc((i - 1) * R * 0.18, 0, dotR, 0, Math.PI * 2);
        x.fill();
      }
    } else if (badge.kind === "bang" || badge.kind === "question") {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, R * 0.3, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, R * 0.23, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#fff";
      x.font = `900 ${R * 0.32}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(badge.kind === "bang" ? "!" : "?", 0, R * 0.02);
    } else {
      x.fillStyle = "#000";
      x.beginPath();
      x.arc(0, 0, R * 0.2, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, R * 0.135, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.age <= 0) continue;
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = cx + (p.x + p.vx * p.age) * R * 1.3;
      const py = cy + (p.y + p.vy * p.age) * R * 1.3;
      const sz = R * p.size * (1 + k * 0.4);

      x.save();
      x.translate(px, py);
      x.globalAlpha = Math.min(1, Math.max(0, a));
      switch (p.type) {
        case "heart":
          x.rotate(Math.sin(p.age * 6) * 0.3);
          x.fillStyle = "#FF4D6D";
          heartPath(x, sz);
          x.fill();
          break;
        case "star":
          x.rotate(p.rot + p.age * 2);
          x.fillStyle = "#F7B32B";
          starPath(x, sz, sz * 0.45);
          x.fill();
          break;
        case "spark":
          x.rotate(p.rot);
          x.fillStyle = "#fff";
          starPath(x, sz * 0.8, sz * 0.18);
          x.fill();
          break;
        case "sweat":
          x.fillStyle = "#7CC7FF";
          x.beginPath();
          x.moveTo(0, -sz);
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6);
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz);
          x.fill();
          break;
        case "z":
          x.fillStyle = "rgb(209,219,235)";
          x.font = `700 ${sz * 1.9}px ${FONT}`;
          x.textAlign = "center";
          x.textBaseline = "middle";
          x.fillText("z", 0, 0);
          break;
      }
      x.restore();
    }
  }
}
