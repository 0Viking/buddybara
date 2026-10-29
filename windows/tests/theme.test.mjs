// The fonts of Settings → Customization (src/core/theme.ts FONTS): stored by id,
// so none may go or be renamed, and each falls back to fonts the other
// interface languages' scripts need.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FONTS, SCHEMES } from "../src/core/theme.ts";

test("every font keeps its id, falls back, and covers the other languages' scripts", () => {
  const ids = FONTS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  // Stored in settings since 1.0.0: still there.
  for (const id of ["rounded", "clean", "geometric", "serif", "mono"]) assert.ok(ids.includes(id), id);
  for (const s of SCHEMES) assert.ok(ids.includes(s.font), `${s.id}: ${s.font}`);
  for (const f of FONTS) {
    assert.ok(f.stack.includes(f.family), `${f.id}: its own family first`);
    assert.ok(f.stack.endsWith(`"Droid Sans Fallback", sans-serif`), `${f.id}: the scripts' fallbacks last`);
    assert.ok(f.stack.includes(`"Microsoft YaHei UI"`), `${f.id}: Chinese`);
  }
});
