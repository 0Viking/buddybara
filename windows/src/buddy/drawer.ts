// The side drawer: tabs that slide up over the bottom half of the conversation
// (the chat and its text box move into the top half), resized by their grip,
// and a bar under the text box that brings them back. Terminal is Claude
// Code's own screen (terminal.ts); btw holds side questions (buddy.ts askBtw),
// each answered from a copy of the conversation that is never saved. The
// other models set up in Settings → AI models (OpenAI, Google AI,
// OpenRouter, a model server) each open as a tab of their own too: a chat
// with that model (buddy.ts aiView), kept while Buddybara runs. A plugin's
// pane open in the conversation on screen (a weather plugin's /forecast, say) is a tab
// too, while it is open (buddy.ts paneView, pane.ts).

import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";
import { providerDef } from "../core/providers";
import type { PaneInfo } from "../core/bridge";

/** `ai:<provider>`: a chat with that other model (core/providers.ts ProviderId). `pane:<id>`: a plugin's pane. */
export type DrawerTab = "btw" | "terminal" | `ai:${string}` | `pane:${string}`;

export interface DrawerHost {
  /** The terminal's own element, kept in its tab. */
  terminal: HTMLElement;
  /** A tab came to the front (the terminal starts, or takes the keyboard). */
  picked(tab: DrawerTab): void;
  /** A tab was closed. */
  closed(tab: DrawerTab): void;
  /** The drawer slid down (its tabs stay). */
  slid(): void;
  /** What the btw tab shows: the current conversation's side questions. */
  btwView(): HTMLElement;
  /** The other models that can be chatted with now (a key, or a server, and a model). */
  aiReady(): string[];
  /** What an other model's tab shows. */
  aiView(provider: string): HTMLElement;
  /** The panes open in the conversation on screen: a tab each. */
  panes(): PaneInfo[];
  /** What a pane's tab shows. */
  paneView(id: string): HTMLElement;
  /** Its tab's ×: the plugin is asked to close it (it may keep it open). */
  closePane(id: string): void;
}

/** The provider of an other model's tab, or null for btw and the terminal. */
export function aiProvider(tab: DrawerTab | null): string | null {
  return tab?.startsWith("ai:") ? tab.slice(3) : null;
}

/** The pane of a pane's tab, or null. */
export function paneId(tab: DrawerTab | null): string | null {
  return tab?.startsWith("pane:") ? tab.slice(5) : null;
}

/** A plugin's dot: one of a few colours, the same each time for the same plugin. */
const PANE_COLORS = ["var(--cyan)", "var(--pink)", "var(--amber)", "var(--green)"];

function pluginColor(plugin: string): string {
  let n = 0;
  for (const ch of plugin) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PANE_COLORS[n % PANE_COLORS.length];
}

function tabName(tab: DrawerTab, panes: PaneInfo[]): string {
  const pane = paneId(tab);
  if (pane != null) return panes.find((p) => p.id === pane)?.title || pane;
  const provider = aiProvider(tab);
  if (provider) return t(providerDef(provider)?.name ?? provider);
  return tab === "btw" ? "btw" : "Terminal";
}

function tabColor(tab: DrawerTab, panes: PaneInfo[]): string {
  const pane = paneId(tab);
  if (pane != null) return pluginColor(panes.find((p) => p.id === pane)?.plugin ?? pane);
  const provider = aiProvider(tab);
  if (provider) return providerDef(provider)?.color ?? "var(--green)";
  return tab === "btw" ? "var(--mikan)" : "var(--dim)";
}

export class Drawer {
  readonly el = h("div", { class: "b-drawer" });
  /** Under the main text box while the drawer is down: a click brings it up. */
  readonly bar = h("button", { class: "b-tabsbar" });
  /** Below the bar: grows to the drawer's height, pushing the chat into the top half. */
  readonly space = h("div", { class: "b-drawer-space" });
  private tabs: DrawerTab[] = [];
  /** The tab in front (shown while the drawer is up). */
  active: DrawerTab | null = null;
  private adding = false;
  private head = h("div", { class: "b-drawer-tabs" });
  private btwBox = h("div", { class: "b-drawer-btw" });
  private aiBox = h("div", { class: "b-drawer-btw" });
  private paneBox = h("div", { class: "b-drawer-btw" });

  constructor(private main: HTMLElement, private host: DrawerHost) {
    this.bar.addEventListener("click", () => this.show(this.active ?? this.tabs[0] ?? "btw"));
    const body = h("div", { class: "b-drawer-body" }, host.terminal, this.btwBox, this.aiBox, this.paneBox);
    this.el.append(this.grip(), this.head, body);
    this.render();
  }

  get open(): boolean {
    return this.main.classList.contains("drawer-open");
  }

  /** `tab` in front, added if it wasn't open, and the drawer up. */
  show(tab: DrawerTab) {
    // A pane's tab is there while the pane is open: it isn't kept.
    if (paneId(tab) == null && !this.tabs.includes(tab)) this.tabs.push(tab);
    this.active = tab;
    this.main.classList.add("drawer-open");
    this.adding = false;
    this.render();
    this.host.picked(tab);
  }

  /** The drawer slides down; its tabs stay, listed on the bar. */
  hide() {
    this.main.classList.remove("drawer-open");
    this.adding = false;
    this.render();
    this.host.slid();
  }

  close(tab: DrawerTab) {
    const pane = paneId(tab);
    if (pane != null) return this.host.closePane(pane);
    if (!this.tabs.includes(tab)) return;
    this.tabs = this.tabs.filter((x) => x !== tab);
    if (this.active === tab) this.active = this.tabs[this.tabs.length - 1] ?? null;
    if (!this.tabs.length) this.main.classList.remove("drawer-open");
    this.render();
    this.host.closed(tab);
    if (this.active && this.open) this.host.picked(this.active);
  }

  has(tab: DrawerTab): boolean {
    return this.all().includes(tab);
  }

  /** Every tab: those opened, then the panes of the conversation on screen. */
  private all(): DrawerTab[] {
    return [...this.tabs, ...this.host.panes().map((p): DrawerTab => `pane:${p.id}`)];
  }

  /** The tabs the + menu offers: btw, the terminal, and each other model set up now, less those open. */
  missing(): DrawerTab[] {
    const all: DrawerTab[] = ["btw", "terminal", ...this.host.aiReady().map((p): DrawerTab => `ai:${p}`)];
    return all.filter((tab) => !this.tabs.includes(tab));
  }

  /** The grip: dragged, the drawer takes 25–80 % of the column. */
  private grip(): HTMLElement {
    const grip = h("div", { class: "b-drawer-grip", title: t("Drag to resize") }, h("i"));
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      this.main.classList.add("drawer-dragging");
      const move = (ev: PointerEvent) => {
        const r = this.main.getBoundingClientRect();
        const share = Math.min(0.8, Math.max(0.25, (r.bottom - ev.clientY) / r.height));
        this.main.style.setProperty("--dh", `${Math.round(share * 100)}%`);
      };
      const up = () => {
        this.main.classList.remove("drawer-dragging");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    return grip;
  }

  /** Redrawn with the panel: the btw tab follows the conversation. */
  render() {
    const panes = this.host.panes();
    const tabs = this.all();
    // A pane closed (or another conversation on screen): its tab goes, and
    // the drawer slides down if it was showing it.
    if (this.active && !tabs.includes(this.active)) {
      this.active = this.tabs[this.tabs.length - 1] ?? null;
      this.main.classList.remove("drawer-open");
      this.adding = false;
    }
    const dot = (tab: DrawerTab) => h("i", { style: `background:${tabColor(tab, panes)}` });
    const name = (tab: DrawerTab) => tabName(tab, panes);
    clear(this.bar);
    this.bar.append(
      h("span", { class: "b-tabsbar-up", text: "▴" }),
      ...(tabs.length
        ? tabs.map((tab) => h("span", { class: "b-tabsbar-tab" }, dot(tab), name(tab)))
        : [h("span", { text: "btw · Terminal" })]),
    );

    clear(this.head);
    for (const tab of tabs) {
      const x = h("span", { class: "b-drawer-x", text: "×", title: t("Close") });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(tab);
      });
      this.head.append(h("button", {
        class: tab === this.active ? "b-drawer-tab on" : "b-drawer-tab",
        onclick: () => this.show(tab),
      }, dot(tab), name(tab), x));
    }
    const missing = this.missing();
    if (missing.length) {
      this.head.append(h("button", { class: "b-drawer-add", text: "+", title: t("Open a tab"), onclick: () => {
        this.adding = !this.adding;
        this.render();
      } }));
    }
    this.head.append(
      h("span", { class: "b-drawer-gap" }),
      h("button", { class: "b-drawer-down", text: "▾", title: t("Slide down"), onclick: () => this.hide() }),
    );
    if (this.adding && missing.length) {
      this.head.append(h("div", { class: "b-drawer-menu" },
        ...missing.map((tab) => h("button", { onclick: () => this.show(tab) }, dot(tab), name(tab)))));
    }

    const provider = aiProvider(this.active);
    const pane = paneId(this.active);
    this.host.terminal.hidden = this.active !== "terminal";
    this.btwBox.hidden = this.active !== "btw";
    this.aiBox.hidden = provider == null;
    this.paneBox.hidden = pane == null;
    // The same element each time: put back, its text box would lose the keyboard.
    const view = this.active === "btw" ? this.host.btwView()
      : provider ? this.host.aiView(provider)
      : pane != null ? this.host.paneView(pane)
      : null;
    const box = this.active === "btw" ? this.btwBox : pane != null ? this.paneBox : this.aiBox;
    if (view && box.firstChild !== view) {
      clear(box);
      box.append(view);
    }
  }
}
