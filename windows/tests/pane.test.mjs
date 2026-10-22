// A plugin's pane in the drawer (src/buddy/pane.ts): the tree Claude Code sends
// (code.rs `ui`, `ui_render`) drawn with the panel's own elements, and what the
// person does sent back with the element's handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
globalThis.window ??= globalThis;
const { boxStyle, paneColor, renderPane, safeUrl, textOf } = await import("../src/buddy/pane.ts");

/** What a weather plugin's pane might send. */
const tree = {
  type: "Box", props: { flexDirection: "column", gap: 1 }, children: [
    { type: "Text", props: { bold: true, weight: "semibold" }, children: ["City"] },
    { type: "Input", props: { key: "city", placeholder: "e.g. Lisbon", value: "" }, press: { plugin: "weather", handle: 1 } },
    { type: "Select", props: { key: "units", value: "c", options: [{ value: "c", label: "Celsius" }, { value: "f", label: "Fahrenheit" }] }, press: { plugin: "weather", handle: 2 } },
    { type: "Box", props: { flexDirection: "row", gap: 1 }, children: [
      { type: "Button", props: { key: "refresh", label: "Refresh" }, press: { plugin: "weather", handle: 3 } },
      false,
      { type: "Client", props: {} },
    ] },
    { type: "Text", props: { dimColor: true }, children: ["Updated: ", "10:42"] },
  ],
};

function recorder() {
  const done = [];
  return {
    done,
    actions: {
      press: (n, href) => done.push(["press", n.press.handle, href]),
      input: (n, kind, value) => done.push(["input", n.press.handle, kind, value]),
      select: (n, value) => done.push(["select", n.press.handle, value]),
      openUrl: (url) => done.push(["open", url]),
    },
  };
}

const all = (el, cls) => el.find(`.${cls}`);

test("a pane's tree is drawn with the panel's elements", () => {
  const { actions } = recorder();
  const el = renderPane(tree, actions, "C:\\p");
  assert.equal(el.className, "pn-box");
  assert.equal(el.style.flexDirection, "column");
  assert.equal(el.style.gap, "6px");
  assert.equal(all(el, "pn-input")[0].getAttribute("placeholder"), "e.g. Lisbon");
  const select = all(el, "pn-select")[0];
  assert.equal(select.children.length, 2);
  assert.equal(select.value, "c");
  assert.equal(all(el, "pn-button")[0].textContent, "Refresh");
  // A web view only Claude Code Desktop draws says so; `false` draws nothing.
  assert.equal(all(el, "pn-unsupported").length, 1);
  const dim = all(el, "pn-text").find((t) => t.classList.contains("dim"));
  assert.equal(dim.textContent, "Updated: 10:42");
});

test("a click, a pick and Enter go back with the element's handler", () => {
  const { done, actions } = recorder();
  const el = renderPane(tree, actions, "C:\\p");
  all(el, "pn-button")[0].fire("click");
  const select = all(el, "pn-select")[0];
  select.value = "f";
  select.fire("change");
  const input = all(el, "pn-input")[0];
  input.value = "Lisbon";
  input.listeners.get("keydown")[0]({ key: "Enter" });
  assert.deepEqual(done, [["press", 3, undefined], ["select", 2, "f"], ["input", 1, "submit", "Lisbon"]]);
  // A link without a handler opens only http(s).
  const { done: opened, actions: a2 } = recorder();
  const link = renderPane({ type: "Link", props: { href: "https://example.com/x" }, children: ["Docs"] }, a2, "");
  link.fire("click");
  const bad = renderPane({ type: "Link", props: { href: "file:///C:/Windows/system32/calc.exe" } }, a2, "");
  bad.fire("click");
  assert.deepEqual(opened, [["open", "https://example.com/x"]]);
});

test("layout, colours and links are read the terminal's way, safely", () => {
  assert.deepEqual(boxStyle({}), { flexDirection: "row" });
  const s = boxStyle({ flexDirection: "column", paddingX: 2, marginTop: 1, width: "100%", justifyContent: "space-between", borderStyle: "round" });
  assert.equal(s.paddingLeft, "12px");
  assert.equal(s.paddingRight, "12px");
  assert.equal(s.marginTop, "6px");
  assert.equal(s.width, "100%");
  assert.equal(s.justifyContent, "space-between");
  assert.ok(s.border.startsWith("1px solid"));
  assert.equal(boxStyle({ alignItems: "javascript:alert(1)" }).alignItems, undefined);
  assert.equal(paneColor("redBright"), "var(--red-text)");
  assert.equal(paneColor("#ff8800"), "#ff8800");
  assert.equal(paneColor("url(x)"), null);
  assert.equal(safeUrl("https://a.b/c"), "https://a.b/c");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(textOf(["a", 1, { type: "Text", children: ["b"] }, null]), "a1b");
});
