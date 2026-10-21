// The panel's drawer (src/buddy/drawer.ts): btw, the terminal, and a tab for
// each other model set up in Settings → AI models.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { Drawer, aiProvider } = await import("../src/buddy/drawer.ts");

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
