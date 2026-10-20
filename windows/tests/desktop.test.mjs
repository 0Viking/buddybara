// Buddybara on the desktop: the pure logic and the life cycle (src/buddybara/desktop-logic.ts).
// The geometry of the window itself (clamping, saved spots) is tested in
// src-tauri/src/desktop.rs, where it lives.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_RADIUS_FRACTION, BUDDY_SIZES, DesktopBuddybaraController, PANEL_SIZE, POKES, POKE_WINDOW_MS,
  PokeCounter, SHAKE_SWING, ShakeMeter, agentActive, buddySize, gaze, hideButton, isOverBody,
  layerDragTopLeft, lookOrigin, pointerDistance, shouldSleep, windowDragTopLeft,
} from "../src/buddybara/desktop-logic.ts";
import { TEXT_SIZES, textSize } from "../src/core/theme.ts";

// ── shouldSleep ───────────────────────────────────────────────────────────────

test("shouldSleep: idle long enough and the pointer far away", () => {
  assert.equal(shouldSleep(5, 300), false, "active agent must not sleep");
  assert.equal(shouldSleep(200, 50), false, "mouse near panel must not sleep");
  assert.equal(shouldSleep(200, 200), true, "long idle + far mouse must sleep");
  assert.equal(shouldSleep(120, 300), false, "exactly at timeout must not sleep");
  assert.equal(shouldSleep(120.1, 300), true, "just over timeout must sleep");
  assert.equal(shouldSleep(200, 150), true, "at distance threshold must sleep");
});

test("agent work keeps him awake, idle and sleeping don't", () => {
  for (const s of ["working", "thinking", "searching", "approval", "question", "finished", "error"]) {
    assert.equal(agentActive(s), true, s);
  }
  assert.equal(agentActive("idle"), false);
  assert.equal(agentActive("sleeping"), false);
});

test("pointer distance: measured with a cursor poll, remembered without one", () => {
  assert.equal(pointerDistance(true, { x: 60, y: 60 }, 0), 0);
  assert.equal(pointerDistance(true, { x: 60 + 150, y: 60 }, 0), 150);
  assert.equal(pointerDistance(true, null, 0), Infinity, "no cursor yet: far");
  // Linux: near while the pointer was over him a moment ago.
  assert.equal(pointerDistance(false, null, 100), 0);
  assert.equal(pointerDistance(false, { x: 60, y: 60 }, 60_000), Infinity);
});

// ── isOverBody ────────────────────────────────────────────────────────────────

test("isOverBody: the round body, not the square window", () => {
  const s = 120;
  const r = s * BODY_RADIUS_FRACTION; // 28.8
  assert.equal(isOverBody({ x: 60, y: 60 }, s), true, "center must be inside body");
  assert.equal(isOverBody({ x: 60 + r - 0.5, y: 60 }, s), true, "inside radius must hit");
  assert.equal(isOverBody({ x: 60 + r + 0.5, y: 60 }, s), false, "outside radius must miss");
  assert.equal(isOverBody({ x: 0, y: 0 }, s), false, "corner must miss");
  const diag = r / Math.SQRT2 - 0.5;
  assert.equal(isOverBody({ x: 60 + diag, y: 60 + diag }, s), true, "diagonal inside must hit");
  assert.equal(PANEL_SIZE, 120);
});

// ── His size, and the text's (Settings → Customization) ───────────────────────

test("his sizes: three smaller down to 50 %, his own, three bigger up to 200 %", () => {
  assert.deepEqual([...BUDDY_SIZES], [50, 65, 80, 100, 125, 160, 200]);
  assert.equal(BUDDY_SIZES.indexOf(100), 3, "his own size is the middle stop");
  // What desktop.rs logic::side_for reads: the nearest, the smaller of two as near.
  assert.equal(buddySize(100), 100);
  assert.equal(buddySize(120), 125);
  assert.equal(buddySize(90), 80);
  assert.equal(buddySize(0), 50);
  assert.equal(buddySize(5000), 200);
  assert.equal(buddySize(undefined), 100, "a settings.json from before: his usual size");
});

test("his minimize button goes where his head is, and never onto his body", () => {
  assert.deepEqual(hideButton(120), { x: 94, y: 28, scale: 1 });
  assert.deepEqual(hideButton(240), { x: 188, y: 56, scale: 1.3 });
  assert.deepEqual(hideButton(60), { x: 47, y: 14, scale: 0.8 });
  for (const percent of BUDDY_SIZES) {
    const side = (PANEL_SIZE * percent) / 100;
    const b = hideButton(side);
    // Rust takes its clicks within 11 px × scale of its centre.
    assert.equal(isOverBody(b, side), false, `${percent} %`);
    const gap = Math.hypot(b.x - side / 2, b.y - side / 2) - side * BODY_RADIUS_FRACTION;
    assert.ok(gap >= 11 * b.scale, `${percent} %`);
  }
});

// ── Handled: shaken, poked ────────────────────────────────────────────────────

/** Feeds `xs` to a meter, one every `every` ms; the indexes that made him dizzy. */
function shakes(meter, xs, every = 80) {
  return xs.map((x, i) => (meter.feed(i * every, x) ? i : -1)).filter((i) => i >= 0);
}

test("shaken back and forth while carried, he gets dizzy on the third turn", () => {
  const s = SHAKE_SWING + 10;
  // Start, right, left, right, left: three turns.
  assert.deepEqual(shakes(new ShakeMeter(), [0, s, 0, s, 0]), [4]);
  // Every step of a swing counts toward it: a slow swing is still one swing.
  assert.deepEqual(shakes(new ShakeMeter(), [0, s / 2, s, s / 2, 0, s / 2, s, s / 2, 0]), [8]);
});

test("a drag across the screen, small wobbles or a slow shake make no one dizzy", () => {
  const meter = new ShakeMeter();
  assert.deepEqual(shakes(meter, [0, 100, 200, 300, 400, 500]), [], "one way only");
  assert.deepEqual(shakes(new ShakeMeter(), [0, 10, 0, 10, 0, 10, 0, 10]), [], "swings too small");
  const s = SHAKE_SWING + 10;
  assert.deepEqual(shakes(new ShakeMeter(), [0, s, 0, s, 0], 800), [], "turns too far apart");
});

test("a new drag starts the count again", () => {
  const meter = new ShakeMeter();
  const s = SHAKE_SWING + 10;
  assert.deepEqual(shakes(meter, [0, s, 0, s]), []);
  meter.reset();
  assert.equal(meter.feed(1000, 0), false, "only one more turn after a reset is not enough");
  assert.equal(meter.feed(1080, s), false);
});

test("poked too often, too fast, he is annoyed, and the count starts over", () => {
  const pokes = new PokeCounter();
  const answers = Array.from({ length: POKES * 2 }, (_, i) => pokes.poke(i * 200));
  assert.deepEqual(answers.map((a, i) => (a ? i : -1)).filter((i) => i >= 0), [POKES - 1, POKES * 2 - 1]);
  const slow = new PokeCounter();
  for (let i = 0; i < 10; i++) assert.equal(slow.poke(i * (POKE_WINDOW_MS / 2)), false, "clicks far apart");
});

test("text sizes: three smaller, the usual, three bigger", () => {
  assert.equal(TEXT_SIZES.length, 7);
  assert.equal(TEXT_SIZES.indexOf(100), 3);
  assert.equal(textSize(100), 100);
  assert.equal(textSize(118), 115);
  assert.equal(textSize(10), TEXT_SIZES[0]);
  assert.equal(textSize(900), TEXT_SIZES[6]);
  assert.equal(textSize(undefined), 100);
});

// ── lookOrigin / gaze ─────────────────────────────────────────────────────────

const sign = (v) => (v === 0 ? 0 : v < 0 ? -1 : 1);

/** The Mac test's AppKit points (y up from the menu-bar screen's bottom) → y down. */
const topDown = (p, desktopTop) => ({ x: p.x, y: desktopTop - p.y });

test("lookOrigin: the window centre, in desktop coordinates", () => {
  // Panel at (200, 300) from the top-left of the desktop.
  assert.deepEqual(lookOrigin(200, 300, 120), { x: 260, y: 360 });
  // On a secondary screen to the right: x stays global, not screen-relative.
  assert.deepEqual(lookOrigin(1540, 100, 120), { x: 1600, y: 160 });
});

test("gaze signs across a real arrangement of screens", () => {
  // Menu-bar MacBook 1512×982 at (0,0); external 2560×1440 above it at
  // (-500, 982); portrait 1080×1920 on the left at (-1080, -600). AppKit
  // coordinates as in the Swift test, turned y-down like a PC reports them.
  const top = 982;
  const look = (bot, mouse) => {
    const g = gaze(topDown(bot, top), topDown(mouse, top));
    return [sign(g.lookX), sign(g.lookY)];
  };
  // Buddybara in the island at the top of the external screen above.
  const islandOnTop = { x: 780, y: 2422 - 16 };
  assert.deepEqual(look(islandOnTop, { x: 1400, y: 100 }), [1, -1], "cursor on the MacBook below-right");
  assert.deepEqual(look(islandOnTop, { x: -1000, y: 0 }), [-1, -1], "cursor on the portrait screen");
  assert.deepEqual(look(islandOnTop, { x: 780, y: 2500 }), [0, 1], "cursor above Buddybara");
  // Buddybara on the desktop of the portrait screen, cursor on the external screen above.
  const panelMin = topDown({ x: -700, y: -200 + 120 }, top); // AppKit minY is the bottom edge
  const desktopOnLeft = lookOrigin(panelMin.x, panelMin.y, 120);
  const mouseAbove = topDown({ x: 1000, y: 2000 }, top);
  assert.ok(mouseAbove.x > desktopOnLeft.x && mouseAbove.y < desktopOnLeft.y,
    "desktop Buddybara looks right and up at a cursor on another screen");
  const g = gaze(desktopOnLeft, mouseAbove);
  assert.ok(g.lookX > 0 && g.lookY > 0);
});

// ── Linux drags ───────────────────────────────────────────────────────────────

test("layer-shell drag: display coordinates once the overlay is up", () => {
  const origin = { x: 500, y: 300 };
  const grab = { x: 60, y: 62 };
  // Not applied yet: the pointer is still relative to the small surface.
  assert.deepEqual(layerDragTopLeft(origin, { x: 70, y: 62 }, grab, false), { x: 510, y: 300 });
  // Applied: the pointer reads in display coordinates.
  assert.deepEqual(layerDragTopLeft(origin, { x: 900, y: 462 }, grab, true), { x: 840, y: 400 });
});

test("X11 drag: screen delta, in physical pixels", () => {
  assert.deepEqual(
    windowDragTopLeft({ x: 1000, y: 600 }, { x: 520, y: 310 }, { x: 500, y: 300 }, 2),
    { x: 1040, y: 620 },
  );
});

// ── Life cycle ────────────────────────────────────────────────────────────────

/** A world the controller acts on, with manual flights. */
function world({ flyOutOk = true } = {}) {
  const log = [];
  const flights = [];
  const w = {
    log,
    /** Lands the oldest pending flight. */
    async land(result) {
      const f = flights.shift();
      assert.ok(f, "a flight should be in the air");
      f.resolve(result ?? f.defaultResult);
      await new Promise((r) => setImmediate(r));
    },
    get flying() {
      return flights.map((f) => f.kind);
    },
    port: {
      flyOut: (anywhere) => {
        log.push(anywhere ? "out-anywhere" : "out-spot");
        return new Promise((resolve) => flights.push({ kind: "out", resolve, defaultResult: flyOutOk }));
      },
      emote: (e) => log.push(`emote:${e}`),
    },
  };
  w.c = new DesktopBuddybaraController(w.port);
  return w;
}

test("launch: flies out to his spot only if he lives on the desktop", async () => {
  const w = world();
  await w.c.launchFlyIfNeeded();
  assert.equal(w.c.phase, "home", "not enabled: stays home");
  assert.deepEqual(w.flying, []);

  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  assert.equal(w.c.phase, "flyingOut");
  await w.land();
  assert.equal(w.c.phase, "onDesktop");
});

test("launch: a spot on a display that is gone keeps him home", async () => {
  const w = world({ flyOutOk: false });
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  await w.land();
  assert.equal(w.c.phase, "home");
  assert.equal(w.c.enabled, false);
});

test("the launch keeps him home when his spot's display is gone", async () => {
  const w = world();
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  assert.deepEqual(w.log, ["out-spot"]);
});

test("a finished task gets a happy jump, only on the desktop", async () => {
  const w = world();
  w.c.updateState("working");
  w.c.updateState("finished");
  assert.ok(!w.log.includes("emote:happy"), "not out yet: nothing to celebrate");
  w.c.enabled = true;
  void w.c.launchFlyIfNeeded();
  await w.land();
  w.log.length = 0;
  w.c.updateState("working");
  w.c.updateState("finished");
  w.c.updateState("finished");
  assert.deepEqual(w.log, ["emote:happy"]);
});
