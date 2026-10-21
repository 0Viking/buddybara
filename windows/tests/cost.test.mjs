// A conversation's totals as the usage box and Settings → Claude Code → Usage
// say them (src/core/cost.ts): code.rs `usage` reads them off its file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { duration, usd } from "../src/core/cost.ts";

test("the cost reads as money, with its cents", () => {
  assert.equal(usd(370.3015074499996, "en"), "$370.30");
  assert.equal(usd(0, "en"), "$0.00");
  assert.equal(usd(1234.5, "en"), "$1,234.50");
});

test("durations read as Claude Code's /usage says them: the three largest units", () => {
  // 13h 43m 41s of API, 3d 13h 35m in all (the seconds go once there are days).
  assert.equal(duration(49_421_631, "en"), "13h 43m 41s");
  assert.equal(duration(308_110_406, "en"), "3d 13h 35m");
  assert.equal(duration(42_000, "en"), "42s");
  assert.equal(duration(5 * 60_000 + 3_000, "en"), "5m 3s");
  // A zero in the middle isn't said.
  assert.equal(duration(13 * 3_600_000 + 17_000, "en"), "13h 17s");
  assert.equal(duration(0, "en"), "0s");
  assert.equal(duration(-5, "en"), "0s");
});
