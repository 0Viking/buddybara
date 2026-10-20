// The side drawer: tabs that slide up over the bottom half of the conversation
// (the chat and its text box move into the top half), resized by their grip,
// and a bar under the text box that brings them back. Terminal is Claude
// Code's own screen (terminal.ts); btw holds side questions (buddy.ts askBtw),
// each answered from a copy of the conversation that is never saved.

import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

export type DrawerTab = "btw" | "terminal";

export interface DrawerHost {
  /** The terminal's own element, kept in its tab. */
  terminal: HTMLElement;
  /** A tab came to the front (the terminal starts, or takes the keyboard). */
  picked(tab: DrawerTab): void;
  /** A tab was closed. */
  closed(tab: DrawerTab): void;
  /** What the btw tab shows: the current conversation's side questions. */
  btwView(): HTMLElement;
}

const NAMES: Record<DrawerTab, string> = { btw: "btw", terminal: "Terminal" };
const COLORS: Record<DrawerTab, string> = { btw: "var(--mikan)", terminal: "var(--dim)" };

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

  constructor(private main: HTMLElement, private host: DrawerHost) {
    this.bar.addEventListener("click", () => this.show(this.active ?? this.tabs[0] ?? "btw"));
    const body = h("div", { class: "b-drawer-body" }, host.terminal, this.btwBox);
    this.el.append(this.grip(), this.head, body);
    this.render();
  }

  get open(): boolean {
    return this.main.classList.contains("drawer-open");
  }

  /** `tab` in front, added if it wasn't open, and the drawer up. */
  show(tab: DrawerTab) {
    if (!this.tabs.includes(tab)) this.tabs.push(tab);
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
  }

  close(tab: DrawerTab) {
    if (!this.tabs.includes(tab)) return;
    this.tabs = this.tabs.filter((x) => x !== tab);
    if (this.active === tab) this.active = this.tabs[this.tabs.length - 1] ?? null;
    if (!this.tabs.length) this.main.classList.remove("drawer-open");
    this.render();
    this.host.closed(tab);
    if (this.active && this.open) this.host.picked(this.active);
  }

  has(tab: DrawerTab): boolean {
    return this.tabs.includes(tab);
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
    const dot = (tab: DrawerTab) => h("i", { style: `background:${COLORS[tab]}` });
    clear(this.bar);
    this.bar.append(
      h("span", { class: "b-tabsbar-up", text: "▴" }),
      ...(this.tabs.length
        ? this.tabs.map((tab) => h("span", { class: "b-tabsbar-tab" }, dot(tab), NAMES[tab]))
        : [h("span", { text: "btw · Terminal" })]),
    );

    clear(this.head);
    for (const tab of this.tabs) {
      const x = h("span", { class: "b-drawer-x", text: "×", title: t("Close") });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(tab);
      });
      this.head.append(h("button", {
        class: tab === this.active ? "b-drawer-tab on" : "b-drawer-tab",
        onclick: () => this.show(tab),
      }, dot(tab), NAMES[tab], x));
    }
    const missing = (Object.keys(NAMES) as DrawerTab[]).filter((tab) => !this.tabs.includes(tab));
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
    if (this.adding) {
      this.head.append(h("div", { class: "b-drawer-menu" },
        ...missing.map((tab) => h("button", { onclick: () => this.show(tab) }, dot(tab), NAMES[tab]))));
    }

    this.host.terminal.hidden = this.active !== "terminal";
    this.btwBox.hidden = this.active !== "btw";
    if (this.active === "btw") {
      // The same element each time: put back, its text box would lose the keyboard.
      const view = this.host.btwView();
      if (this.btwBox.firstChild !== view) {
        clear(this.btwBox);
        this.btwBox.append(view);
      }
    }
  }
}
