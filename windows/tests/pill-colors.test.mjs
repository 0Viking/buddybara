// A colour of the user's own for each pill's Buddybara (src/core/pill-colors.ts),
// and how the app state paints with it. Mirrors tests/PillColorsTests.swift so
// every platform reads the same preference the same way.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { PILL_PALETTE, normalizeHex, parsePillColors, pillColor, withPillColor } from "../src/core/pill-colors.ts";
import { PILL_CATALOG, pillDefinition } from "../src/core/pills.ts";

const VS_CODE = pillDefinition("integration_claude").color;
const TEAL = "#2DD4BF";

// ── The pure half ─────────────────────────────────────────────────────────────

test("a colour is six hex digits, written #RRGGBB in upper case", () => {
  assert.equal(normalizeHex("#2dd4bf"), TEAL);
  assert.equal(normalizeHex("2DD4BF"), TEAL);
  assert.equal(normalizeHex("  #2DD4BF "), TEAL);
  for (const bad of ["", "#2DD4B", "#2DD4BFF", "#GGGGGG", "teal", "rgb(1,2,3)", null, undefined, 0x2dd4bf, {}]) {
    assert.equal(normalizeHex(bad), null, String(bad));
  }
});

test("the palette is ten different colours the catalog already uses", () => {
  // The same list as PillColors.palette on macOS (tests/PillColorsTests.swift).
  assert.deepEqual(PILL_PALETTE, [
    "#F5F6F8", "#F4505E", "#F29B38", "#FACC15", "#4ADE80",
    "#2DD4BF", "#38BDF8", "#818CF8", "#C084FC", "#E879F9",
  ]);
  const catalog = new Set(PILL_CATALOG.map((p) => p.color));
  assert.equal(new Set(PILL_PALETTE).size, 10);
  for (const hex of PILL_PALETTE) {
    assert.equal(normalizeHex(hex), hex, hex);
    assert.ok(catalog.has(hex), `${hex} is not a catalog colour`);
  }
});

test("a stored preference keeps what is a colour and drops the rest", () => {
  assert.deepEqual(
    parsePillColors({ integration_claude: "#2dd4bf", agent_cursor: "blue", "": "#FFFFFF", agent_new: "#abcdef", n: 3 }),
    { integration_claude: TEAL, agent_new: "#ABCDEF" },
  );
  for (const junk of [null, undefined, "x", 3, ["#2DD4BF"]]) assert.deepEqual(parsePillColors(junk), {});
});

test("a pill wears the user's colour when there is one, else the catalog's", () => {
  assert.equal(pillColor("integration_claude", VS_CODE, {}), VS_CODE);
  assert.equal(pillColor("integration_claude", VS_CODE, null), VS_CODE);
  assert.equal(pillColor("integration_claude", VS_CODE, { integration_claude: "#2dd4bf" }), TEAL);
  assert.equal(pillColor("integration_claude", VS_CODE, { integration_claude: "nope" }), VS_CODE);
  assert.equal(pillColor("agent_cursor", "#C0C4CC", { integration_claude: TEAL }), "#C0C4CC");
});

test("picking a colour stores it; the default, nothing or junk clears it", () => {
  const before = { agent_cursor: "#F4505E" };
  const picked = withPillColor(before, "integration_claude", "#2dd4bf", VS_CODE);
  assert.deepEqual(picked, { agent_cursor: "#F4505E", integration_claude: TEAL });
  assert.deepEqual(before, { agent_cursor: "#F4505E" }, "the preference given is not changed");

  assert.deepEqual(withPillColor(picked, "integration_claude", null, VS_CODE), before);
  assert.deepEqual(withPillColor(picked, "integration_claude", VS_CODE.toLowerCase(), VS_CODE), before);
  assert.deepEqual(withPillColor(picked, "integration_claude", "teal", VS_CODE), before);
});
