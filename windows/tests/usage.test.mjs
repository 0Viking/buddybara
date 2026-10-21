// The usage box above the panel's Settings (src/buddy/usage.ts): the plan's
// bars, a conversation's totals, or both, taking turns.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
globalThis.window ??= globalThis;
const { renderUsage, TURN_MS } = await import("../src/buddy/usage.ts");
const { State } = await import("../src/core/state.ts");

const totals = {
  project: "C:\\p", session: "s", title: "Slash commands", costUsd: 370.3, apiMs: 49_421_631, wallMs: 308_110_406,
  linesAdded: 11_850, linesRemoved: 1_006, unknownCost: false,
};
const plan = { fiveHour: { usedPct: 42, resetsAt: Date.now() + 3_600_000 }, updatedAt: Date.now() };

test("with the cost and the plan's bars both, the box takes turns, the cost first; with one, it holds still", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const el = dom.root();
    State.settings.showPlanInNotch = true;
    State.planUsage = plan;
    renderUsage(el, totals);
    const [cost, bars] = el.children;
    const showing = () => [cost, bars].filter((s) => s.style.display !== "none" && !s.classList.contains("off"));
    assert.deepEqual(showing(), [cost]);
    mock.timers.tick(TURN_MS);
    assert.deepEqual(showing(), [bars]);
    // Redrawn meanwhile (any change of State): the turns go on where they were.
    renderUsage(el, totals);
    assert.deepEqual(showing(), [bars]);
    mock.timers.tick(TURN_MS);
    assert.deepEqual(showing(), [cost]);
    // The pointer over the box holds the side it shows.
    el.fire("mouseenter");
    mock.timers.tick(3 * TURN_MS);
    assert.deepEqual(showing(), [cost]);
    el.fire("mouseleave");
    mock.timers.tick(TURN_MS);
    assert.deepEqual(showing(), [bars]);

    // One of them only: it shows, and nothing moves.
    State.planUsage = null;
    renderUsage(el, totals);
    mock.timers.tick(3 * TURN_MS);
    assert.deepEqual(showing(), [cost]);
    State.planUsage = plan;
    renderUsage(el, null);
    mock.timers.tick(3 * TURN_MS);
    assert.deepEqual(showing(), [bars]);
    // Neither (plan usage off, no totals): no box.
    State.settings.showPlanInNotch = false;
    renderUsage(el, null);
    assert.equal(el.style.display, "none");
  } finally {
    mock.timers.reset();
    State.planUsage = null;
  }
});
