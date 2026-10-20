// The desktop Buddybara's own window (buddybara.html): draws him, and turns a
// click on him into the panel opening or closing, and a drag into a new spot.
//
// What he shows comes from the panel window (DESKTOP_EVENTS.state). The page draws only while the window is on screen, at 30 fps awake
// like the Mac, and at half that asleep — still smooth for his breathing and
// his z's — with no cursor polling at all while he sleeps.

import { Bridge, emitToWindow, onEvent, postDroppedFiles, type DesktopMode } from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { planColor } from "../core/plan";
import { Sound } from "../core/sound";
import { BotEngine } from "../buddybara/engine";
import { loadSkin } from "../buddybara/skin";
import {
  DESKTOP_EVENTS, DRAG_THRESHOLD, FIGURE_RADIUS_FRACTION, PANEL_SIZE, PokeCounter, ShakeMeter,
  WINK_CHANCE, WINK_COOLDOWN_MS, WINK_REST_MS, agentActive, gaze, hideButton, isOverBody,
  layerDragTopLeft, lookOrigin, pointerDistance, shouldSleep, windowDragTopLeft,
  type DesktopPreview, type DesktopSnapshot, type Point,
} from "../buddybara/desktop-logic";

const ISLAND = "island";

/**
 * Width Buddybara is drawn at, as a share of his window's side. The engine's
 * body radius is 0.3 × width, so this gives the body the hit test uses (28.8 px
 * in the usual 120 px window), and leaves room around him for hats, hands and
 * hearts.
 */
const DRAW_FRACTION = 0.8;
/** #hide's side in buddybara.html, before it is scaled to his size. */
const HIDE_PX = 18;
/**
 * Frame pacing: TimelineView(minimumInterval: 1/30) awake; asleep, half that.
 * (4 fps, as it was, made his breathing and floating z's visibly jerky.)
 */
const AWAKE_FRAME_MS = 1000 / 30;
const ASLEEP_FRAME_MS = 1000 / 15;
/**
 * The longest step one frame moves his animation, seconds: a frame late (or
 * the first after he was off screen) doesn't jump. Over one asleep frame, or
 * every frame asleep would run his animation slower than time.
 */
const MAX_STEP_S = 0.1;
/** The longest step the engine is updated by at once (its springs stay steady). */
const ENGINE_STEP_S = 0.04;

class DesktopBuddybara {
  private engine = new BotEngine();
  private canvas: HTMLCanvasElement;
  private mode: DesktopMode = "off";
  /** Side of his window, logical pixels: Settings → Customization's size. */
  private side = PANEL_SIZE;
  private hide: HTMLButtonElement | null = null;

  private snap: DesktopSnapshot = {
    state: "idle", soundEnabled: true, soundVolume: 0.12, usage: null,
  };

  private visible = false;
  private asleep = false;
  /** Whether the island has told us anything yet. */
  private informed = false;
  private lastAgentActive = performance.now();
  /** Pointer in window coordinates, and when the page last heard of it. */
  private cursor: Point | null = null;
  private lastPointer = -Infinity;

  private timer: number | null = null;
  private lastDraw = 0;

  /** Canvas offset inside the window: non-zero only in a layer-shell drag. */
  private offset: Point = { x: 0, y: 0 };
  private press: { client: Point; screen: Point } | null = null;
  private dragging = false;
  /** Window's top-left corner when the drag began (mode's space). */
  private dragOrigin: Point | null = null;
  private dragTopLeft: Point | null = null;
  private moveFrame = false;
  /** When files dragged over him last made him smile. */
  private dragSmile = -Infinity;
  /** Settings' "Play every state", or a shake: until when a state shows over his real one. */
  private previewUntil = 0;
  private previewTimer = 0;
  /** Shaken while carried, he gets dizzy; poked too often, annoyed. */
  private shake = new ShakeMeter();
  private pokes = new PokeCounter();
  /** Where the pointer came to rest (window coordinates), since when, and whether that rest was used. */
  private restAt: Point | null = null;
  private restSince = 0;
  private restUsed = false;
  private lastWink = -Infinity;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine.particleOverhang = 0;
    this.engine.setState("idle", true);
    this.wireInput();
    this.wireDrop();
    this.wireHide();
    this.setSide(PANEL_SIZE);
  }

  async start() {
    void Sound.preload();

    await onEvent<DesktopSnapshot>(DESKTOP_EVENTS.state, (s) => this.onSnapshot(s));
    await onEvent<{ emote: BotEmoteName; duration: number }>(DESKTOP_EVENTS.emote, (e) => {
      this.lastAgentActive = performance.now();
      this.wake();
      this.engine.triggerEmote(e.emote, e.duration);
      this.schedule();
    });
    await onEvent<Point>(DESKTOP_EVENTS.cursor, (p) => this.notePointer(p));
    await onEvent<boolean>(DESKTOP_EVENTS.visible, (on) => this.setVisible(on));
    await onEvent<number>(DESKTOP_EVENTS.size, (side) => this.setSide(side));
    await onEvent<DesktopPreview>(DESKTOP_EVENTS.preview, (p) => this.showFor(p));
    // Windows: Rust carries his window, and says where to.
    await onEvent<number>(DESKTOP_EVENTS.carried, (x) => this.carried(x));
    // His own picture, chosen in Settings, in the capybara's place.
    await onEvent<null>("skin-changed", () => void this.wearSkin());
    void this.wearSkin();
    await onEvent<string>(DESKTOP_EVENTS.flight, (kind) => {
      // He fades in on the way out of the island (alphaValue 0 → 1 on macOS).
      if (kind !== "out") return;
      this.canvas.style.transition = "none";
      this.canvas.style.opacity = "0";
      void this.canvas.offsetWidth;
      this.canvas.style.transition = "";
      this.canvas.style.opacity = "1";
    });
    // Asked once the listeners are in: if Rust showed the window while this
    // page was still loading (a buddy flies out at launch), its
    // `desktop-visible` went unheard, and he would never be drawn.
    const info = await Bridge.desktopInfo();
    if (info) {
      this.mode = info.mode;
      if (info.side > 0) this.setSide(info.side);
      if (info.shown && !this.visible) this.setVisible(true);
    }
    // His window is `side` high: a page another height is drawn at another
    // scale than the window's (WebView2 started off any monitor). He would sit
    // small in a corner while Rust's hit test looks for him at full size, and
    // every click would fall through: say so in the log.
    if (Math.abs(window.innerHeight - this.side) > 2) {
      void Bridge.log(`desktop Buddybara: page drawn at ${window.devicePixelRatio}, ${window.innerWidth}x${window.innerHeight} instead of ${this.side} high`);
    }
    await emitToWindow(ISLAND, DESKTOP_EVENTS.ready);
  }

  private async wearSkin() {
    this.engine.skin?.close();
    this.engine.skin = await loadSkin();
    this.schedule();
  }

  /**
   * His window's side, from Rust: at launch, and when Settings → Customization
   * changes his size. The canvas takes it, and his minimize button goes where
   * his head is now.
   */
  private setSide(side: number) {
    this.side = side;
    this.canvas.style.width = `${side}px`;
    this.canvas.style.height = `${side}px`;
    const dpr = this.dpr();
    this.canvas.width = Math.round(side * dpr);
    this.canvas.height = Math.round(side * dpr);
    if (this.hide) {
      const b = hideButton(side);
      this.hide.style.left = `${b.x - HIDE_PX / 2}px`;
      this.hide.style.top = `${b.y - HIDE_PX / 2}px`;
      this.hide.style.transform = `scale(${b.scale})`;
    }
    this.schedule();
  }

  // ── State ───────────────────────────────────────────────────────────────────

  private previewing(): boolean {
    return performance.now() < this.previewUntil;
  }

  /**
   * A state (and a greeting, an idle fidget or a face) for a while, awake,
   * then his real state again: a step of Settings' "Play every state", or
   * dizzy after a shake.
   */
  private showFor(p: DesktopPreview) {
    if (!this.visible) return;
    window.clearTimeout(this.previewTimer);
    const now = performance.now();
    this.previewUntil = now + p.ms;
    this.lastAgentActive = now;
    if (this.asleep) {
      this.asleep = false;
      void Bridge.desktopSetAsleep(false);
    }
    this.engine.setState(p.state, true);
    if (p.greet) this.engine.greet();
    if (p.fidget != null) this.engine.fidget(p.fidget);
    if (p.emote) this.engine.triggerEmote(p.emote, Math.max(0.6, p.ms / 1000 - 0.3));
    this.previewTimer = window.setTimeout(() => {
      this.previewUntil = 0;
      this.lastAgentActive = performance.now();
      this.engine.setState(this.snap.state, true);
      this.schedule();
    }, p.ms);
    this.schedule();
  }

  /** Where he is carried across the screen (logical px): shaken, he gets dizzy. */
  private carried(x: number) {
    if (!this.dragging || !this.shake.feed(performance.now(), x)) return;
    Sound.play("dizzy");
    this.showFor({ state: "dizzy", ms: 2600 });
  }

  /** The pointer has rested on him a while, and he is idle: now and then, a wink. */
  private maybeWink(now: number) {
    const at = this.restAt;
    if (!at || this.restUsed || now - this.restSince < WINK_REST_MS) return;
    if (this.asleep || this.dragging || this.previewing() || this.engine.state !== "idle") return;
    const c = this.side / 2;
    if (Math.hypot(at.x - c, at.y - c) > this.side * FIGURE_RADIUS_FRACTION) return;
    this.restUsed = true;
    if (now - this.lastWink < WINK_COOLDOWN_MS || Math.random() >= WINK_CHANCE) return;
    this.lastWink = now;
    this.engine.triggerEmote("wink", 1.2);
    Sound.play("wink");
  }

  private onSnapshot(s: DesktopSnapshot) {
    this.snap = s;
    this.informed = true;
    Sound.setEnabled(s.soundEnabled);
    Sound.setVolume(s.soundVolume);
    if (agentActive(s.state)) this.lastAgentActive = performance.now();
    if (!this.asleep && !this.previewing()) this.engine.setState(s.state);
    // The plan's usage rides on the mikan.
    this.engine.usagePct = s.usage;
    this.engine.usageColor = planColor(s.usage);
    this.updateSleep(performance.now());
    this.schedule();
  }

  private setVisible(on: boolean) {
    this.visible = on;
    if (on) {
      // The two pages may have started in either order: ask again if needed.
      if (!this.informed) void emitToWindow(ISLAND, DESKTOP_EVENTS.ready);
      // Landing counts as something going on: he looks around for a while.
      this.lastAgentActive = performance.now();
      this.asleep = false;
      this.engine.setState(this.snap.state, true);
      // Out on the desktop: he says hello.
      this.engine.greet();
      this.schedule();
      return;
    }
    this.press = null;
    this.dragging = false;
    this.setNear(null);
    this.setOffset({ x: 0, y: 0 });
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    Sound.idle();
  }

  private updateSleep(now: number) {
    if (!this.visible || this.previewing()) return;
    const distance = pointerDistance(this.mode === "poll", this.cursor, now - this.lastPointer, this.side);
    const sleep =
      !this.dragging &&
      shouldSleep((now - this.lastAgentActive) / 1000, distance);
    if (sleep === this.asleep) return;
    this.asleep = sleep;
    this.engine.setState(sleep ? "sleeping" : this.snap.state);
    // Asleep, Rust stops the cursor poll; his whole little window then listens
    // for the pointer, and the first move over it wakes him.
    void Bridge.desktopSetAsleep(sleep);
    if (sleep) Sound.idle();
    this.schedule();
  }

  private wake() {
    if (!this.asleep) return;
    this.updateSleep(performance.now());
  }

  /** Pointer in window coordinates: his eyes, and waking up. */
  private notePointer(p: Point) {
    const now = performance.now();
    // Moved on: a new rest begins.
    if (!this.restAt || Math.hypot(p.x - this.restAt.x, p.y - this.restAt.y) > 3) {
      this.restAt = p;
      this.restSince = now;
      this.restUsed = false;
    }
    this.cursor = p;
    this.setNear(p);
    this.lastPointer = now;
    if (this.asleep) this.wake();
    this.schedule();
  }

  // ── Frames ──────────────────────────────────────────────────────────────────

  private schedule() {
    if (this.timer != null || !this.visible) return;
    const wait = this.asleep ? ASLEEP_FRAME_MS : AWAKE_FRAME_MS;
    const due = Math.max(0, this.lastDraw + wait - performance.now());
    this.timer = window.setTimeout(() => {
      // Awake, frames line up with the display; asleep, a timer is enough.
      if (this.asleep) {
        this.timer = null;
        this.frame(performance.now());
      } else {
        requestAnimationFrame((t) => {
          this.timer = null;
          this.frame(t);
        });
      }
    }, due);
  }

  private frame(now: number) {
    if (!this.visible) return;
    const dt = Math.min(MAX_STEP_S, Math.max(0, (now - this.lastDraw) / 1000));
    this.lastDraw = now;
    this.updateSleep(now);
    this.maybeWink(now);
    this.draw(dt, now);
    this.schedule();
  }

  private draw(dt: number, now: number) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const engine = this.engine;
    if (!this.asleep) {
      // Windows: the global cursor. Linux: only while the pointer is over him.
      const fresh = this.mode === "poll" || now - this.lastPointer < 1500;
      const g = this.cursor && fresh ? gaze(lookOrigin(0, 0, this.side), this.cursor) : { lookX: 0, lookY: 0 };
      engine.lookX = g.lookX;
      engine.lookY = g.lookY;
    }
    // The engine's springs want short steps: a long frame (asleep) runs as several.
    const steps = Math.max(1, Math.ceil(dt / ENGINE_STEP_S));
    for (let i = 0; i < steps; i++) engine.update(dt / steps);
    const dpr = this.dpr();
    const side = this.side;
    // Dragged onto a display of another scale (175% to 100%), his canvas
    // takes the new one: at the old size he was drawn small in a corner, over
    // what the last frame left in the part no longer cleared.
    const px = Math.round(side * dpr);
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const drawW = side * DRAW_FRACTION;
    const margin = (side - drawW) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, margin * dpr, 0);
    ctx.clearRect(-margin, 0, side, side);
    engine.draw(ctx, drawW, side);
  }

  private dpr(): number {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private local(e: MouseEvent): Point {
    return { x: e.clientX - this.offset.x, y: e.clientY - this.offset.y };
  }

  private wireInput() {
    document.addEventListener("pointerdown", (e) => {
      Sound.resume();
      if (e.button !== 0 || !isOverBody(this.local(e), this.side)) return;
      this.press = { client: this.local(e), screen: { x: e.screenX, y: e.screenY } };
      this.dragging = false;
      try {
        document.documentElement.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    });

    document.addEventListener("pointermove", (e) => {
      if (!this.dragging) this.notePointer(this.local(e));
      const press = this.press;
      if (!press) return;
      if (!this.dragging) {
        const l = this.local(e);
        if (Math.hypot(l.x - press.client.x, l.y - press.client.y) <= DRAG_THRESHOLD) return;
        this.beginDrag();
      }
      this.dragTo(e);
    });

    document.addEventListener("pointerup", (e) => {
      const press = this.press;
      this.press = null;
      if (!press) return;
      if (this.dragging) {
        this.endDrag(e);
        return;
      }
      // A click opens or closes the panel beside him, at once. Too many in a
      // row, and he lets it be known.
      const now = performance.now();
      this.lastAgentActive = now;
      this.wake();
      if (this.pokes.poke(now)) this.engine.triggerEmote("annoyed", 1.2);
      this.schedule();
      void emitToWindow(ISLAND, DESKTOP_EVENTS.click);
    });

    document.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerleave", () => {
      if (this.mode !== "poll" && !this.dragging) {
        this.cursor = null;
        this.restAt = null;
        this.setNear(null);
      }
    });

    // A layer-shell drag stretches the window over the display; once it is
    // back to its own size, so is the canvas.
    window.addEventListener("resize", () => {
      if (!this.dragging && window.innerWidth <= this.side + 20) this.setOffset({ x: 0, y: 0 });
    });
  }

  /**
   * Files dragged onto him are the panel's in buddy mode: he smiles, and the
   * drop opens it to take them (webview_drop.rs hands them over).
   */
  private wireDrop() {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const now = performance.now();
      if (now - this.dragSmile < 1500) return;
      this.dragSmile = now;
      this.lastAgentActive = now;
      this.wake();
      this.engine.triggerEmote("love", 1.2);
      this.schedule();
    });
    document.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files?.length) postDroppedFiles(files);
    });
  }

  /**
   * A button top-right of his head puts him and the panel away. Buddybara
   * runs on; started again (Start menu), he comes back out.
   */
  private wireHide() {
    const button = document.createElement("button");
    button.id = "hide";
    button.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    button.addEventListener("click", () => {
      this.setNear(null);
      void emitToWindow(ISLAND, DESKTOP_EVENTS.minimize);
    });
    document.body.append(button);
    this.hide = button;
  }

  /** The pointer is over him (window coordinates), so the button shows. */
  private setNear(p: Point | null) {
    const c = this.side / 2;
    const near = p != null && this.visible && !this.dragging &&
      Math.hypot(p.x - c, p.y - c) <= this.side * FIGURE_RADIUS_FRACTION;
    document.body.classList.toggle("near", near);
  }

  private beginDrag() {
    this.dragging = true;
    this.shake.reset();
    // Carried, the pointer stays where it is on him: that is no rest.
    this.restUsed = true;
    this.setNear(null);
    this.dragOrigin = null;
    this.dragTopLeft = null;
    void Bridge.desktopDragBegin().then((pos) => {
      if (!pos) {
        this.dragging = false;
        this.press = null;
        return;
      }
      this.dragOrigin = { x: pos[0], y: pos[1] };
    });
  }

  /** Linux: the page drives the drag. Windows: the cursor poll carries him. */
  private dragTo(e: PointerEvent) {
    // Linux: the page drives the drag, and watches for a shake itself.
    if (this.mode === "window") this.carried(e.screenX);
    else if (this.mode === "layer") this.carried(e.clientX);
    const origin = this.dragOrigin;
    const press = this.press;
    if (!origin || !press || this.mode === "poll") return;
    if (this.mode === "layer") {
      const applied = window.innerWidth > this.side + 20;
      const topLeft = layerDragTopLeft(origin, { x: e.clientX, y: e.clientY }, press.client, applied);
      this.dragTopLeft = topLeft;
      this.setOffset(applied ? topLeft : { x: topLeft.x - origin.x, y: topLeft.y - origin.y });
      return;
    }
    if (this.mode === "window") {
      const topLeft = windowDragTopLeft(origin, { x: e.screenX, y: e.screenY }, press.screen, this.dpr());
      this.dragTopLeft = topLeft;
      if (this.moveFrame) return;
      this.moveFrame = true;
      requestAnimationFrame(() => {
        this.moveFrame = false;
        const p = this.dragTopLeft;
        if (p && this.dragging) void Bridge.desktopDragMove(p.x, p.y);
      });
    }
  }

  private endDrag(e: PointerEvent) {
    this.dragTo(e);
    this.dragging = false;
    const topLeft = this.dragTopLeft;
    this.dragOrigin = null;
    this.dragTopLeft = null;
    if (this.mode === "poll" || !topLeft) return;
    void Bridge.desktopDragEnd(Math.round(topLeft.x), Math.round(topLeft.y));
  }

  private setOffset(p: Point) {
    this.offset = p;
    this.canvas.style.left = `${p.x}px`;
    this.canvas.style.top = `${p.y}px`;
  }
}

const canvas = document.getElementById("buddybara");
if (canvas instanceof HTMLCanvasElement) void new DesktopBuddybara(canvas).start();
