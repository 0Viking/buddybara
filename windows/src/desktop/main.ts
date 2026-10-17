// The desktop Buddybara's own window (buddybara.html): draws him, and turns a
// click on him into the panel opening or closing, and a drag into a new spot.
//
// What he shows comes from the panel window (DESKTOP_EVENTS.state). The page draws only while the window is on screen, at 30 fps awake
// like the Mac, and a few frames a second asleep — with no cursor polling at
// all while he sleeps.

import { Bridge, emitToWindow, onEvent, postDroppedFiles, type DesktopMode } from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { planColor } from "../core/plan";
import { Sound } from "../core/sound";
import { BotEngine } from "../buddybara/engine";
import {
  DESKTOP_EVENTS, DRAG_THRESHOLD, FIGURE_RADIUS_FRACTION, PANEL_SIZE, agentActive, gaze, isOverBody,
  layerDragTopLeft, lookOrigin, pointerDistance, shouldSleep, windowDragTopLeft,
  type DesktopSnapshot, type Point,
} from "../buddybara/desktop-logic";

const ISLAND = "island";

/**
 * Width Buddybara is drawn at. The engine's body radius is 0.3 × width, so this
 * gives the 28.8 px body the hit test uses, and leaves room around him for
 * hats, hands and hearts inside the 120 px window.
 */
const DRAW_W = PANEL_SIZE * 0.8;
const SIDE = (PANEL_SIZE - DRAW_W) / 2;
/** Frame pacing: TimelineView(minimumInterval: 1/30) awake; asleep, barely. */
const AWAKE_FRAME_MS = 1000 / 30;
const ASLEEP_FRAME_MS = 250;

class DesktopBuddybara {
  private engine = new BotEngine();
  private canvas: HTMLCanvasElement;
  private mode: DesktopMode = "off";

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = this.dpr();
    canvas.width = Math.round(PANEL_SIZE * dpr);
    canvas.height = Math.round(PANEL_SIZE * dpr);
    this.engine.particleOverhang = 0;
    this.engine.setState("idle", true);
    this.wireInput();
    this.wireDrop();
    this.wireHide();
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
      if (info.shown && !this.visible) this.setVisible(true);
    }
    // His window is PANEL_SIZE high: a page another height is drawn at another
    // scale than the window's (WebView2 started off any monitor). He would sit
    // small in a corner while Rust's hit test looks for him at full size, and
    // every click would fall through: say so in the log.
    if (Math.abs(window.innerHeight - PANEL_SIZE) > 2) {
      void Bridge.log(`desktop Buddybara: page drawn at ${window.devicePixelRatio}, ${window.innerWidth}x${window.innerHeight} instead of ${PANEL_SIZE} high`);
    }
    await emitToWindow(ISLAND, DESKTOP_EVENTS.ready);
  }

  // ── State ───────────────────────────────────────────────────────────────────

  private onSnapshot(s: DesktopSnapshot) {
    this.snap = s;
    this.informed = true;
    Sound.setEnabled(s.soundEnabled);
    Sound.setVolume(s.soundVolume);
    if (agentActive(s.state)) this.lastAgentActive = performance.now();
    if (!this.asleep) this.engine.setState(s.state);
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
    if (!this.visible) return;
    const distance = pointerDistance(this.mode === "poll", this.cursor, now - this.lastPointer);
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
    this.cursor = p;
    this.setNear(p);
    this.lastPointer = performance.now();
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
    const dt = Math.min(0.05, Math.max(0, (now - this.lastDraw) / 1000));
    this.lastDraw = now;
    this.updateSleep(now);
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
      const g = this.cursor && fresh ? gaze(lookOrigin(0, 0), this.cursor) : { lookX: 0, lookY: 0 };
      engine.lookX = g.lookX;
      engine.lookY = g.lookY;
    }
    engine.update(dt);
    const dpr = this.dpr();
    // Dragged onto a display of another scale (175% to 100%), his canvas
    // takes the new one: at the old size he was drawn small in a corner, over
    // what the last frame left in the part no longer cleared.
    const px = Math.round(PANEL_SIZE * dpr);
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, SIDE * dpr, 0);
    ctx.clearRect(-SIDE, 0, PANEL_SIZE, PANEL_SIZE);
    engine.draw(ctx, DRAW_W, PANEL_SIZE);
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
      if (e.button !== 0 || !isOverBody(this.local(e))) return;
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
      // A click opens or closes the panel beside him, at once.
      this.lastAgentActive = performance.now();
      this.wake();
      this.schedule();
      void emitToWindow(ISLAND, DESKTOP_EVENTS.click);
    });

    document.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerleave", () => {
      if (this.mode !== "poll" && !this.dragging) {
        this.cursor = null;
        this.setNear(null);
      }
    });

    // A layer-shell drag stretches the window over the display; once it is
    // back to its own size, so is the canvas.
    window.addEventListener("resize", () => {
      if (!this.dragging && window.innerWidth <= PANEL_SIZE + 20) this.setOffset({ x: 0, y: 0 });
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
  }

  /** The pointer is over him (window coordinates), so the button shows. */
  private setNear(p: Point | null) {
    const c = PANEL_SIZE / 2;
    const near = p != null && this.visible && !this.dragging &&
      Math.hypot(p.x - c, p.y - c) <= PANEL_SIZE * FIGURE_RADIUS_FRACTION;
    document.body.classList.toggle("near", near);
  }

  private beginDrag() {
    this.dragging = true;
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
    const origin = this.dragOrigin;
    const press = this.press;
    if (!origin || !press || this.mode === "poll") return;
    if (this.mode === "layer") {
      const applied = window.innerWidth > PANEL_SIZE + 20;
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
