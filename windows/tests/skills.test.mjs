// A new skill's name as Settings → Skills → New skill shows it (src/core/skills.ts),
// the same rules src-tauri/src/addons.rs `skill_name` writes it by.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skillName } from "../src/core/skills.ts";

test("a skill's name is made plain the way Claude Code wants it", () => {
  assert.equal(skillName("My Notes"), "my-notes");
  assert.equal(skillName("  daily_standup.v2 "), "daily-standup-v2");
  assert.equal(skillName("--x--"), "x");
  assert.equal(skillName("Résumé"), "rsum");
  assert.equal(skillName("!!!"), "");
  assert.equal(skillName("a".repeat(80)).length, 64);
  assert.equal(skillName(`${"a".repeat(63)} b`), "a".repeat(63), "never ends on a dash");
});
