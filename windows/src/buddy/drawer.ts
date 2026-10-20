// ponytail: MOCKUP of the side-chat drawer, to try the feel before it is built:
// tabs (btw, Terminal, other models), the slide-up over the bottom half of the
// chat, resizing by its grip, and the bar under the text box that brings it
// back. Nothing is connected: the tabs hold sample lines and answer with a
// canned reply. Its words are English until it is real; then they go through
// t() in all 9 languages.

import { clear, h } from "../views/dom";

type Kind = "btw" | "terminal" | "openai" | "gemini";
type Said = [role: "user" | "assistant", text: string];

const KINDS: Record<Kind, { name: string; color: string }> = {
  btw: { name: "btw", color: "var(--mikan)" },
  terminal: { name: "Terminal", color: "var(--dim)" },
  openai: { name: "OpenAI · gpt-4o", color: "#10a37f" },
  gemini: { name: "Gemini 2.5 Flash", color: "#4f8df5" },
};

const SAMPLE: Record<Kind, Said[]> = {
  btw: [
    ["user", "btw, what does anchor_cwd do again?"],
    ["assistant", "It moves a hook's cwd back up to the folder the session started in. This is a side question: the main conversation never sees it."],
  ],
  terminal: [
    ["assistant", "PS C:\\Users\\yurik\\projects\\Claude assistant> npm run pack"],
    ["assistant", "Finished 1 bundle at: windows\\release\\Buddybara-Windows-0.4.0-setup.exe (4.15 MB)"],
  ],
  openai: [
    ["user", "Is there a shorter way to write this regex?"],
    ["assistant", "Yes: /^\\s*$/ does the same as your two checks."],
  ],
  gemini: [["user", "Summarise the conversation above in 3 bullets."]],
};

const CANNED = "Mockup: this tab isn't connected yet.";

interface Tab {
  kind: Kind;
  lines: Said[];
}

export class Drawer {
  readonly el = h("div", { class: "b-drawer" });
  /** Under the main text box while the drawer is down: a click brings it up. */
  readonly bar = h("button", { class: "b-tabsbar" });
  /** Below the bar: grows to the drawer's height, pushing the chat into the top half. */
  readonly space = h("div", { class: "b-drawer-space" });
  private tabs: Tab[] = (["btw", "terminal", "openai"] as Kind[]).map((kind) => ({ kind, lines: [...SAMPLE[kind]] }));
  private active = 0;
  private adding = false;

  constructor(private main: HTMLElement) {
    this.bar.addEventListener("click", () => this.setOpen(true));
    this.render();
  }

  private setOpen(open: boolean) {
    if (open && !this.tabs.length) this.add("btw");
    this.main.classList.toggle("drawer-open", open);
    this.adding = false;
    this.render();
  }

  private add(kind: Kind) {
    this.tabs.push({ kind, lines: [...SAMPLE[kind]] });
    this.active = this.tabs.length - 1;
    this.adding = false;
    this.render();
  }

  private close(i: number) {
    this.tabs.splice(i, 1);
    this.active = Math.min(this.active, this.tabs.length - 1);
    if (!this.tabs.length) this.setOpen(false);
    else this.render();
  }

  /** The grip: dragged, the drawer takes 25–80 % of the column. */
  private grip(): HTMLElement {
    const grip = h("div", { class: "b-drawer-grip", title: "Drag to resize" }, h("i"));
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

  private render() {
    // The bar: what is open, or what the drawer is for.
    clear(this.bar);
    this.bar.append(
      h("span", { class: "b-tabsbar-up", text: "▴" }),
      ...(this.tabs.length
        ? this.tabs.map((t) => h("span", { class: "b-tabsbar-tab" }, h("i", { style: `background:${KINDS[t.kind].color}` }), KINDS[t.kind].name))
        : [h("span", { text: "Side chats: btw, terminal, other models" })]),
    );

    clear(this.el);
    const tabRow = h("div", { class: "b-drawer-tabs" },
      ...this.tabs.map((t, i) => {
        const x = h("span", { class: "b-drawer-x", text: "×", title: "Close" });
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(i);
        });
        const tab = h("button", { class: i === this.active ? "b-drawer-tab on" : "b-drawer-tab" },
          h("i", { style: `background:${KINDS[t.kind].color}` }), KINDS[t.kind].name, x);
        tab.addEventListener("click", () => {
          this.active = i;
          this.render();
        });
        return tab;
      }),
      h("button", { class: "b-drawer-add", text: "+", title: "Open a side chat", onclick: () => { this.adding = !this.adding; this.render(); } }),
      h("span", { class: "b-drawer-gap" }),
      h("button", { class: "b-drawer-down", text: "▾", title: "Slide down", onclick: () => this.setOpen(false) }),
    );
    const menu = this.adding
      ? h("div", { class: "b-drawer-menu" },
        ...(Object.keys(KINDS) as Kind[]).map((k) =>
          h("button", { onclick: () => this.add(k) }, h("i", { style: `background:${KINDS[k].color}` }), KINDS[k].name)))
      : null;
    this.el.append(this.grip(), tabRow, menu ?? "", this.tabs[this.active] ? this.body(this.tabs[this.active]) : "");
  }

  private body(tab: Tab): HTMLElement {
    const term = tab.kind === "terminal";
    const log = h("div", { class: term ? "b-drawer-log term" : "b-drawer-log" },
      ...tab.lines.map(([role, text]) => h("div", { class: `b-drawer-line ${role}`, text })));
    const input = h("textarea", { class: "b-input", rows: "1", placeholder: term ? "> type a command" : `Ask ${KINDS[tab.kind].name}…` }) as HTMLTextAreaElement;
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      tab.lines.push(["user", term ? `> ${text}` : text]);
      this.render();
      window.setTimeout(() => {
        tab.lines.push(["assistant", CANNED]);
        this.render();
      }, 450);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    window.setTimeout(() => (log.scrollTop = log.scrollHeight));
    return h("div", { class: "b-drawer-body" },
      log,
      h("div", { class: "b-composer" }, input, h("button", { class: "b-send", text: "↑", onclick: send })));
  }
}
