// Buddybara on the desktop, panel side: runs his life cycle (the controller in
// buddybara/desktop-logic.ts) against the real app and tells the desktop window
// what to show. The window itself lives in src-tauri/src/desktop.rs and draws
// him in src/desktop/main.ts.

import { Bridge, IS_TAURI, emitToWindow, onEvent, type DesktopInfo, type DesktopMode } from "../core/bridge";
import type { BotEmoteName } from "../core/layout";
import { dominantPct } from "../core/plan";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { DESKTOP_EVENTS, DesktopBuddybaraController, type DesktopSnapshot } from "../buddybara/desktop-logic";

/** Label of the desktop Buddybara's window (desktop.rs LABEL). */
const WINDOW = "buddybara";

/** What the desktop window asks of the panel. */
export interface DesktopHost {
  /** A click on him: the panel opens or closes. */
  clicked(): void;
  /** His minimize button: he and the panel leave the screen. */
  minimize(): void;
}

export class DesktopLink {
  mode: DesktopMode = "off";
  readonly controller: DesktopBuddybaraController;

  /** His launch in flight, if one is. */
  private launching: Promise<void> | null = null;
  private pushed = "";
  private host: DesktopHost;

  constructor(host: DesktopHost) {
    this.host = host;
    this.controller = new DesktopBuddybaraController({
      flyOut: async (anywhere) => (await Bridge.desktopFlyOut(anywhere)) ?? false,
      emote: (emote: BotEmoteName, duration = 1.8) =>
        void emitToWindow(WINDOW, DESKTOP_EVENTS.emote, { emote, duration }),
    });
  }

  /** False where windows can't be placed (GNOME on Wayland). */
  get supported(): boolean {
    return this.mode !== "off";
  }

  async init() {
    const info = await this.askInfo();
    if (!info || info.mode === "off") return;
    this.mode = info.mode;
    this.controller.enabled = info.onDesktop;

    // Dragged to a new spot: the panel opens beside it now.
    await onEvent<null>(DESKTOP_EVENTS.dropped, () => void Bridge.reposition());
    await onEvent<null>(DESKTOP_EVENTS.click, () => this.host.clicked());
    await onEvent<null>(DESKTOP_EVENTS.minimize, () => this.host.minimize());
    // The window's page (re)loaded: it knows nothing yet.
    await onEvent<null>(DESKTOP_EVENTS.ready, () => {
      this.pushed = "";
      this.push();
    });

    State.subscribe(() => this.sync());
    this.sync();
  }

  /**
   * How his window works here. Asked again when there is no answer: one lost
   * at start-up would leave him off for the whole session.
   */
  private async askInfo(): Promise<DesktopInfo | null> {
    if (!IS_TAURI) return null;
    for (let tries = 0; tries < 5; tries++) {
      const info = await Bridge.desktopInfo();
      if (info) return info;
      await new Promise((done) => window.setTimeout(done, 400));
    }
    void Bridge.log("desktop Buddybara: no answer from desktop_buddybara_info");
    return null;
  }

  /** Start-up: out to his spot. */
  launch() {
    if (this.supported) void this.launchBuddy();
  }

  /**
   * He always lives out there: his saved spot, else the bottom-right corner.
   * He is the only way into the panel, so a flight that fails is tried again.
   * One launch at a time: two would cut each other's flights.
   */
  private launchBuddy(): Promise<void> {
    this.launching ??= this.flyBuddyOut().finally(() => (this.launching = null));
    return this.launching;
  }

  private async flyBuddyOut() {
    for (let tries = 0; tries < 3; tries++) {
      this.controller.enabled = true;
      await this.controller.launchFlyIfNeeded(true);
      if (this.controller.phase !== "home") return;
      await new Promise((done) => window.setTimeout(done, 1500));
    }
    void Bridge.log("desktop Buddybara: could not fly out");
  }

  /** An emote on the desktop Buddybara (a deploy that went out, a workflow that failed…). */
  emote(emote: BotEmoteName, duration = 1.6) {
    if (this.controller.phase === "onDesktop") void emitToWindow(WINDOW, DESKTOP_EVENTS.emote, { emote, duration });
  }

  /** Buddybara started again: out he comes if he isn't on screen, else a wave says where he is. */
  async summon() {
    if (!this.supported) return;
    // On his way out already: that launch is the answer.
    if (this.launching) return this.launching;
    const info = await Bridge.desktopInfo();
    if (!info) return;
    if (info.shown) {
      void emitToWindow(WINDOW, DESKTOP_EVENTS.emote, { emote: "happy", duration: 1.2 });
      Sound.play("pop");
      return;
    }
    // Not out, whatever the life cycle believed: off he goes.
    if (this.controller.phase !== "flyingOut") this.controller.phase = "home";
    await this.launchBuddy();
  }

  // ── State → desktop window ──────────────────────────────────────────────────

  private sync() {
    this.controller.updateState(State.effectiveState);
    this.push();
  }

  private push() {
    const snapshot: DesktopSnapshot = {
      state: State.effectiveState,
      soundEnabled: State.settings.soundEnabled,
      soundVolume: State.settings.soundVolume,
      usage: State.settings.showPlanInNotch ? dominantPct(State.planUsage) : null,
    };
    const key = JSON.stringify(snapshot);
    if (key === this.pushed) return;
    this.pushed = key;
    void emitToWindow(WINDOW, DESKTOP_EVENTS.state, snapshot);
  }
}
