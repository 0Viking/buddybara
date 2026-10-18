// The first-run screen, over the panel while Buddybara can't work yet: Claude
// Code installed and signed in, its hooks in place (setup.rs). Checked each
// time the panel opens. A step it starts runs in a window of its own, and the
// screen checks again every few seconds until that step is done.

import { Bridge, type SetupStatus } from "../core/bridge";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

/** Hooks left out on purpose: the panel works without them, so it never asks again. */
const SKIP_HOOKS = "setup-skip-hooks";

function hooksSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_HOOKS) === "1";
  } catch {
    return false;
  }
}

const errorText = (err: unknown) => String(err).replace(/^Error:\s*/, "");

export class Setup {
  readonly el = h("div", { class: "b-setup" });
  private status: SetupStatus | null = null;
  /** Closed with Start while the hooks are still missing: not asked again until Buddybara restarts. */
  private dismissed = false;
  private error = "";
  private poll = 0;

  constructor(
    private chooseFolder: () => Promise<void>,
    private openSettings: (page: string) => void,
  ) {}

  private missing(s: SetupStatus): boolean {
    return !s.claude || !s.signedIn || (!s.hooks && !hooksSkipped() && !this.dismissed);
  }

  /** The screen comes up when something is missing; once up, it stays until Start. */
  async check() {
    const s = await Bridge.setupStatus().catch(() => null);
    if (!s) return;
    this.status = s;
    if (this.missing(s)) this.el.classList.add("open");
    this.render();
  }

  /** Checks again every 5 s until `done`, for at most 5 minutes. */
  private watch(done: (s: SetupStatus) => boolean, left = 60) {
    window.clearTimeout(this.poll);
    this.poll = window.setTimeout(async () => {
      await this.check();
      if (left > 1 && !(this.status && done(this.status))) this.watch(done, left - 1);
    }, 5000);
  }

  private start(step: "install" | "login", done: (s: SetupStatus) => boolean) {
    this.error = "";
    Bridge.setupStart(step)
      .then(() => this.watch(done))
      .catch((err) => {
        this.error = errorText(err);
        this.render();
      });
  }

  private close() {
    window.clearTimeout(this.poll);
    this.dismissed = true;
    this.el.classList.remove("open");
  }

  private render() {
    const s = this.status;
    clear(this.el);
    if (!s) return;
    const button = (label: string, onclick: () => void, primary: boolean, disabled = false) => {
      const b = h("button", { class: primary ? "b-setup-go" : "b-setup-alt", text: label, onclick });
      b.disabled = disabled;
      return b;
    };
    const step = (ok: boolean, title: string, hint: string, ...actions: (HTMLElement | null)[]) =>
      h("div", { class: ok ? "b-setup-step ok" : "b-setup-step" },
        h("span", { class: "b-setup-step-dot" }),
        h("div", { class: "b-setup-step-text" }, h("b", { text: title }), h("small", { text: hint, title: hint })),
        ...actions,
      );
    this.el.append(
      h("div", { class: "b-setup-box" },
        h("h2", { text: t("Welcome to Buddybara") }),
        h("p", { text: t("A few steps, then Claude Code works from here.") }),
        step(s.claude, "Claude Code", s.claude ? t("Installed") : t("Installs it with winget, in a window of its own."),
          s.claude ? null : button(t("Install"), () => this.start("install", (x) => x.claude), true)),
        step(s.signedIn, t("Sign in"), s.signedIn ? t("Signed in") : t("Your Claude account, in your browser."),
          s.signedIn ? null : button(t("Sign in"), () => this.start("login", (x) => x.signedIn), true, !s.claude)),
        step(true, t("Projects folder"), s.root,
          button(t("Change"), () => void this.chooseFolder().then(() => this.check()), false)),
        step(s.hooks, t("Claude Code hooks"),
          s.hooks ? t("Installed") : t("So Buddybara sees your sessions and shows their permission requests. Settings shows the change before writing it."),
          s.hooks ? null : button(t("Skip"), () => {
            try {
              localStorage.setItem(SKIP_HOOKS, "1");
            } catch {
              this.dismissed = true;
            }
            void this.check();
          }, false),
          s.hooks ? null : button(t("Open Settings"), () => {
            this.openSettings("claude");
            this.watch((x) => x.hooks);
          }, true)),
        this.error ? h("div", { class: "b-setup-error", text: this.error }) : null,
        h("div", { class: "b-setup-foot" },
          button(t("Check again"), () => void this.check(), false),
          button(t("Start"), () => this.close(), true, !(s.claude && s.signedIn)),
        ),
      ),
    );
  }
}
