// The usage box above the panel's Settings (src/buddy/usage.ts): the plan's
// bars when Claude Code has a plan, else a conversation's totals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
globalThis.window ??= globalThis;
const { renderUsage } = await import("../src/buddy/usage.ts");
const { State } = await import("../src/core/state.ts");

const totals = {
  project: "C:\\p", session: "s", title: "Slash commands", costUsd: 370.3, apiMs: 49_421_631, wallMs: 308_110_406,
  linesAdded: 11_850, linesRemoved: 1_006, unknownCost: false,
};
const plan = { fiveHour: { usedPct: 42, resetsAt: Date.now() + 3_600_000 }, updatedAt: Date.now() };

test("a plan's bars win over the dollar totals, whatever the mikan switch; without a plan the totals show", () => {
  const el = dom.root();
  try {
    // A plan (a subscription): its bars, and no dollar estimate, mikan switch off or on.
    State.settings.showPlanInNotch = false;
    State.planUsage = plan;
    renderUsage(el, totals);
    assert.ok(el.querySelector(".b-use-bar"));
    assert.equal(el.querySelector(".b-use-name"), null);
    assert.equal(el.style.display, "");

    // No plan (an API key, a gateway): the conversation's totals, with their cost.
    State.planUsage = null;
    renderUsage(el, totals);
    assert.equal(el.querySelector(".b-use-bar"), null);
    assert.equal(el.querySelector(".b-use-name").textContent, "Slash commands");

    // Neither: no box.
    renderUsage(el, null);
    assert.equal(el.style.display, "none");
  } finally {
    State.planUsage = null;
  }
});
