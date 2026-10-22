// The panel's drawer (src/buddy/drawer.ts): btw, the terminal, and a tab for
// each other model set up in Settings → AI models.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { Drawer, aiProvider, paneId } = await import("../src/buddy/drawer.ts");

test("the + menu offers each other model set up, and its tab shows that model's chat", () => {
  let ready = ["openai", "google"];
  const panes = new Map();
  const picked = [];
  const host = {
    terminal: dom.root(),
    picked: (tab) => picked.push(tab),
    closed: () => {},
    slid: () => {},
    btwView: () => dom.root(),
    panes: () => [],
    paneView: () => dom.root(),
    closePane: () => {},
    aiReady: () => ready,
    aiView: (provider) => {
      if (!panes.has(provider)) {
        const pane = dom.root();
        pane.textContent = `chat with ${provider}`;
        panes.set(provider, pane);
      }
      return panes.get(provider);
    },
  };
  const drawer = new Drawer(dom.root(), host);
  assert.deepEqual(drawer.missing(), ["btw", "terminal", "ai:openai", "ai:google"]);

  drawer.show("ai:google");
  assert.deepEqual(picked, ["ai:google"]);
  assert.deepEqual(drawer.missing(), ["btw", "terminal", "ai:openai"]);
  assert.ok(drawer.el.textContent.includes("Google AI"), "the tab says which model");
  assert.ok(drawer.el.textContent.includes("chat with google"), "and shows its chat");

  // Its key taken out in Settings: not offered any more; the open tab stays until closed.
  ready = [];
  assert.deepEqual(drawer.missing(), ["btw", "terminal"]);
  assert.ok(drawer.has("ai:google"));

  assert.equal(aiProvider("ai:openrouter"), "openrouter");
  assert.equal(aiProvider("btw"), null);
  assert.equal(aiProvider(null), null);
});

test("a plugin's pane is a tab while it is open: shown, closed through the plugin, gone with it", () => {
  let panes = [{ id: "weather", title: "Weather", plugin: "weather" }];
  const closed = [];
  const view = dom.root();
  view.textContent = "the pane";
  const main = dom.root();
  const drawer = new Drawer(main, {
    terminal: dom.root(), picked: () => {}, closed: () => {}, slid: () => {},
    btwView: () => dom.root(), aiReady: () => [], aiView: () => dom.root(),
    panes: () => panes, paneView: () => view, closePane: (id) => closed.push(id),
  });
  drawer.show("pane:weather");
  assert.ok(drawer.has("pane:weather"));
  assert.ok(drawer.el.textContent.includes("Weather"));
  assert.ok(drawer.el.textContent.includes("the pane"));
  // Its ×: the plugin is asked; the tab stays until the plugin closes it.
  drawer.close("pane:weather");
  assert.deepEqual(closed, ["weather"]);
  assert.ok(drawer.has("pane:weather"));
  // Closed: its tab goes, and the drawer slides down.
  panes = [];
  drawer.render();
  assert.equal(drawer.has("pane:weather"), false);
  assert.equal(drawer.active, null);
  assert.equal(main.classList.contains("drawer-open"), false);
  assert.equal(paneId("pane:x"), "x");
  assert.equal(paneId("btw"), null);
});
