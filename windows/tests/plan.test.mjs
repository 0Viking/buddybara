// Plan usage (src/core/plan.ts): the status line's `rate_limits` (a port of the
// Mac's tests/ClaudePlanGaugeTests.swift), the account's answer, and what the
// mikan shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dominantPct, effectivePct, parseClaudePlan, parseClaudeUsageText, planColor, restorePlanUsage,
} from "../src/core/plan.ts";
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { State } from "../src/core/state.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const future = NOW / 1000 + 7200; // 2 hours from now, epoch seconds
const past = NOW / 1000 - 100;
const claude = (rl) => parseClaudePlan(rl, NOW);
const win = (pct, epochS) => ({ usedPct: pct, resetsAt: epochS * 1000 });

// ── ClaudePlanGauge.parse ─────────────────────────────────────────────────────

test("a full payload gives both windows", () => {
  const u = claude({
    five_hour: { used_percentage: 23.5, resets_at: future },
    seven_day: { used_percentage: 67.0, resets_at: future },
  });
  assert.equal(u.fiveHour.usedPct, 23.5);
  assert.equal(u.sevenDay.usedPct, 67);
  assert.equal(u.fiveHour.resetsAt, future * 1000);
  assert.equal(u.updatedAt, NOW);
});

test("missing or empty rate_limits is nothing", () => {
  assert.equal(claude(undefined), null);
  assert.equal(claude({}), null);
  assert.equal(claude("x"), null);
});

test("percentages: 150 is shown full, above 200 or below 0 is dropped, ints are fine", () => {
  const one = (pct) => claude({ five_hour: { used_percentage: pct, resets_at: future } })?.fiveHour;
  assert.equal(one(250), undefined);
  assert.equal(one(201), undefined);
  assert.equal(one(-5), undefined);
  assert.equal(one(150).usedPct, 100);
  assert.equal(one(42).usedPct, 42);
  assert.equal(one("42"), undefined);
});

test("a reset more than 400 days away is milliseconds in disguise", () => {
  const far = NOW / 1000 + 401 * 86400;
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: far } }), null);
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: NOW } }), null);
  assert.equal(claude({ five_hour: { used_percentage: 50, resets_at: 0 } }), null);
});

test("one good window is enough", () => {
  const u = claude({
    five_hour: { used_percentage: 250, resets_at: future },
    seven_day: { used_percentage: 10, resets_at: future },
  });
  assert.equal(u.fiveHour, undefined);
  assert.equal(u.sevenDay.usedPct, 10);
});

// ── effectivePct / dominantPct ────────────────────────────────────────────────

test("a window whose reset has passed counts as 0", () => {
  assert.equal(effectivePct(win(80, past), NOW), 0);
  assert.equal(effectivePct(win(80, future), NOW), 80);
});

test("the dominant percentage is the higher window", () => {
  const both = { fiveHour: win(30, future), sevenDay: win(70, future), updatedAt: NOW };
  const fhOnly = { fiveHour: win(55, future), updatedAt: NOW };
  const empty = { updatedAt: NOW };
  assert.equal(dominantPct(both, NOW), 70);
  assert.equal(dominantPct(fhOnly, NOW), 55);
  assert.equal(dominantPct(empty, NOW), null);
  assert.equal(dominantPct(null, NOW), null);
  // An expired week no longer dominates.
  assert.equal(dominantPct({ fiveHour: win(30, future), sevenDay: win(90, past), updatedAt: NOW }, NOW), 30);
});

// ── colour ──────────────────────────────────────────────────────────────────

test("colours: grey, then green below 50, orange below 80, red", () => {
  assert.equal(planColor(null), "#6B7079");
  assert.equal(planColor(0), "#22C55E");
  assert.equal(planColor(49), "#22C55E");
  assert.equal(planColor(50), "#F59E0B");
  assert.equal(planColor(79), "#F59E0B");
  assert.equal(planColor(80), "#F4505E");
  assert.equal(planColor(100), "#F4505E");
});

test("the last Claude numbers survive a restart, and junk does not", () => {
  const u = { fiveHour: win(30, future), updatedAt: NOW };
  assert.deepEqual(restorePlanUsage(JSON.stringify(u)), u);
  assert.equal(restorePlanUsage(null), null);
  assert.equal(restorePlanUsage("{"), null);
  assert.equal(restorePlanUsage(JSON.stringify({ updatedAt: NOW, fiveHour: { usedPct: 900, resetsAt: 1 } })), null);
});

// ── Claude Code's /usage (claude.rs plan_usage) ────────────────────────────────

test("/usage: the session and the week (all models), resets in local time", () => {
  const now = new Date(2026, 9, 22, 20, 0).getTime();
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 15% used · resets Oct 23, 12:50am (America/Sao_Paulo)",
    "Current week (all models): 18% used · resets Oct 27, 10pm (America/Sao_Paulo)",
    "Current week (Sonnet only): 3% used · resets Oct 27, 10pm (America/Sao_Paulo)",
  ].join("
");
  const u = parseClaudeUsageText(text, now);
  assert.deepEqual(u.fiveHour, { usedPct: 15, resetsAt: new Date(2026, 9, 23, 0, 50).getTime() });
  assert.deepEqual(u.sevenDay, { usedPct: 18, resetsAt: new Date(2026, 9, 27, 22, 0).getTime() });
  // A time alone is today, or tomorrow once past; a date behind is next year's.
  assert.equal(parseClaudeUsageText("Current session: 5% used · resets 9pm", now).fiveHour.resetsAt, new Date(2026, 9, 22, 21, 0).getTime());
  assert.equal(parseClaudeUsageText("Current session: 5% used · resets 7pm", now).fiveHour.resetsAt, new Date(2026, 9, 23, 19, 0).getTime());
  const eve = new Date(2026, 11, 31, 23, 0).getTime();
  assert.equal(parseClaudeUsageText("Current week: 40% used · resets Jan 1, 2am", eve).sevenDay.resetsAt, new Date(2027, 0, 1, 2, 0).getTime());
  assert.equal(parseClaudeUsageText("Current session: 140% used · resets 9pm", now).fiveHour.usedPct, 100);
  // An API key has no plan, and nothing else is a usage.
  assert.equal(parseClaudeUsageText("You are using an API key.", now), null);
  assert.equal(parseClaudeUsageText(null, now), null);
});

// ── The status line relay ─────────────────────────────────────────────────────

registerHookHandlers({ alert() {} });

test("a status line call updates the numbers and nothing else", () => {
  const tasks = JSON.stringify(State.tasks);
  emit("hook", {
    hook_event_name: "StatusLine",
    session_id: "s1",
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Date.now() / 1000 + 3600 } },
  });
  assert.equal(State.planUsage.fiveHour.usedPct, 42);
  assert.equal(JSON.stringify(State.tasks), tasks);
  // Without limits (API-key users) the last numbers stay.
  emit("hook", { hook_event_name: "StatusLine", session_id: "s1" });
  assert.equal(State.planUsage.fiveHour.usedPct, 42);
});
