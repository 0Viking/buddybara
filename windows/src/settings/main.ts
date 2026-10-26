// Settings window: a sidebar of pages (General, Claude Code, Connectors, Keys)
// and the page on the right. Anything that writes to disk is confirmed here,
// Claude Code's settings.json only ever after its diff was shown.

import "./settings.css";
import { Bridge, onEvent, type HookPreview, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { BotEngine } from "../buddybara/engine";
import { h, clear, svg } from "../views/dom";
import { pageOf, renderDiff, statusDot, toggle } from "./parts";
import { agentsPage } from "./agents";
import { connectorsPage } from "./connectors";
import { INTEGRATION_KEYS, integrationsPage } from "./integrations";
import { MODEL_KEYS, modelsPage } from "./models";
import { directoryPage } from "./directory";
import { addonsDragging, addonsDropped } from "./addons";
import { customizePage } from "./customize";
import { usageCard, type UsageTarget } from "./usage";
import { applyTextSize, applyTheme } from "../core/theme";
import { loadSkin } from "../buddybara/skin";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t,
} from "../i18n/i18n";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

/** A setting: its name and what it does on the left, its controls on the right. */
function srow(title: string | null, hint: string | null, ...controls: (Node | null)[]): HTMLElement {
  return h("div", { class: "srow" },
    h("div", { class: "srow-text" }, title ? h("b", { text: title }) : null, hint ? h("span", { text: hint }) : null),
    h("div", { class: "srow-ctl" }, ...controls),
  );
}

/** A card with a title (and its dot) over a free-form body. */
function cardOf(head: HTMLElement, body: HTMLElement): HTMLElement {
  return h("div", { class: "card" }, head, body);
}

// ── Buddybara in the corner ───────────────────────────────────────────────────
//
// Drawn by the same engine as on the desktop, his eyes on the pointer. He moves
// only while the window is in front: it is created hidden and closing only
// hides it, so he never draws unseen.

const MASCOT = 60;
const engine = new BotEngine();
engine.setState("idle", true);
const mascot = h("canvas", { "aria-hidden": "true" });
mascot.addEventListener("click", () => engine.greet());
let pointer: { x: number; y: number } | null = null;
let mascotTimer = 0;
let greeted = false;

document.addEventListener("pointermove", (e) => (pointer = { x: e.clientX, y: e.clientY }));
document.documentElement.addEventListener("pointerleave", () => (pointer = null));

function drawMascot(dt: number) {
  const ctx = mascot.getContext("2d");
  if (!ctx) return;
  const box = mascot.getBoundingClientRect();
  engine.lookX = pointer ? Math.tanh((pointer.x - (box.left + box.width / 2)) / 260) : 0;
  engine.lookY = pointer ? -Math.tanh((pointer.y - (box.top + box.height / 2)) / 200) : 0;
  engine.update(dt);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(MASCOT * dpr);
  if (mascot.width !== px) {
    mascot.width = px;
    mascot.height = px;
  }
  // The engine draws him 0.8 of the width across, with room left for his ears.
  const side = MASCOT * 0.1;
  ctx.setTransform(dpr, 0, 0, dpr, side * dpr, 0);
  ctx.clearRect(-side, 0, MASCOT, MASCOT);
  engine.draw(ctx, MASCOT - 2 * side, MASCOT);
}

/** 30 frames a second while the window is in front; the last one stays. */
function animate() {
  if (mascotTimer) return;
  if (!greeted && document.hasFocus()) {
    greeted = true;
    engine.greet();
  }
  let last = performance.now();
  const step = () => {
    mascotTimer = 0;
    if (!mascot.isConnected || document.hidden || !document.hasFocus()) return;
    const now = performance.now();
    drawMascot(Math.min(0.05, (now - last) / 1000));
    last = now;
    mascotTimer = window.setTimeout(step, 1000 / 30);
  };
  step();
}

window.addEventListener("focus", animate);

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Buddybara's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Buddybara's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code page ──────────────────────────────────────────────────────────

function hooksCard(status: HookStatus): HTMLElement {
  const body = h("div", { class: "stack" });
  const head = h("h2", {});
  const title = () => {
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: t("Hooks") }));
  };

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    title();
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Your Claude Code sessions are hooked up: tool calls, questions and permission requests show up in the buddy, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the buddy and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("buddybara-hook.exe is not in place yet. Restart Buddybara; if it still fails, build it with `cargo build -p buddybara-hook`."),
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  title();
  draw();
  return cardOf(head, body);
}

/**
 * The 5-hour and weekly limits on the mikan, as Claude Code's /usage says (claude.rs
 * plan_usage). The status line relay that used to bring them is not needed any
 * more: while one is still in settings.json, it can be taken out here.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) on the mikan. Claude Code reports it every few minutes with its own sign-in, which Buddybara never reads. Pro and Max plans only."); },
  get showClaude() { return t("Show on the mikan"); },
  get oldRelay() { return t("The status line relay is no longer needed: the usage now comes from your account."); },
};

/** `changed`: the switch moved (Usage above shows the plan's limits only while it is on). */
function planCard(status: HookStatus, changed: () => void): HTMLElement {
  const body = h("div", {});
  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    redraw();
  };

  function draw() {
    const sw = toggle(settings.showPlanInNotch, (on) => {
      settings.showPlanInNotch = on;
      void save();
      changed();
    });
    body.append(srow(PLAN_SETTINGS_TEXT.showClaude, PLAN_SETTINGS_TEXT.claude, sw));
    if (status.planRelayInstalled) {
      const stack = h("div", { class: "stack" });
      stack.append(h("div", { class: "row" },
        h("span", { class: "hint", text: PLAN_SETTINGS_TEXT.oldRelay }),
        h("button", {
          class: "danger",
          text: t("Uninstall relay…"),
          onclick: () => void reviewChange(stack, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
        }),
      ));
      body.append(stack);
    }
  }

  draw();
  return cardOf(h("h2", {}, h("span", { text: t("Plan usage") })), body);
}

/** Whose totals Usage shows: the conversation the panel's /usage was typed in, else the newest. */
let usageFor: UsageTarget = { project: null, session: null };

function claudePage(status: HookStatus): HTMLElement {
  const usage = usageCard(usageFor);
  return pageOf("Claude Code", null, usage.el, hooksCard(status), planCard(status, usage.planChanged));
}

// ── General page ──────────────────────────────────────────────────────────────

function generalPage(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
    "aria-label": t("Sound"),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  return pageOf(t("General"), null,
    h("div", { class: "card" },
      srow(t("Sound"), null, volume, toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); })),
    ),
    h("div", { class: "card" },
      srow(t("Launch at startup"), null, toggle(settings.autostart, (v) => { settings.autostart = v; void save(); })),
      srow(
        t("Show other folders with sessions"),
        t("Lists every folder Claude Code was used in (VS Code, a terminal), not only the projects folder's, so their sessions can be continued from the panel."),
        toggle(settings.allSessionFolders, (v) => { settings.allSessionFolders = v; void save(); }),
      ),
      srow(t("Language"), null, languageSelect()),
    ),
  );
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
 * system's language when Buddybara has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
function languageSelect(): HTMLElement {
  const select = h("select", { "aria-label": t("Language") }) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return select;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

type PageId = "general" | "customize" | "claude" | "agents" | "models" | "skills" | "plugins" | "connectors" | "integrations";

const PAGES: { id: PageId; label: string; icon: string }[] = [
  { id: "general", label: N_("General"), icon: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4" },
  { id: "customize", label: N_("Customization"), icon: "M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8l-.4-.9c-.5-1 .3-2.3 1.4-2.3H17a4 4 0 0 0 4-4c0-5-4-9-9-9zM7.5 12a1 1 0 1 0 0-.01M10 7.5a1 1 0 1 0 0-.01M15 7.5a1 1 0 1 0 0-.01" },
  { id: "claude", label: "Claude Code", icon: "M4 6l6 6-6 6M12 18h8" },
  { id: "agents", label: N_("Agents"), icon: "M8 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6M16 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6M3 19a5 5 0 0 1 10 0M11 19a5 5 0 0 1 10 0" },
  { id: "models", label: N_("AI models"), icon: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4zM9 10h6" },
  { id: "skills", label: N_("Skills"), icon: "M13 3 4 14h7l-1 7 9-11h-7z" },
  { id: "plugins", label: N_("Plugins"), icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5" },
  { id: "connectors", label: N_("Connectors"), icon: "M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" },
  { id: "integrations", label: N_("Integrations"), icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
];

let page: PageId = "general";

function sidebar(): HTMLElement {
  return h("nav", { class: "side" },
    h("div", { class: "brand" },
      mascot,
      h("div", {}, h("b", { text: "Buddybara" }), h("small", { text: version ? `v${version}` : "" })),
    ),
    ...PAGES.map((p) => h("button", {
      class: p.id === page ? "nav on" : "nav",
      "aria-current": p.id === page ? "page" : undefined,
      onclick: () => {
        if (p.id === page) return;
        page = p.id;
        // Opened from here, Usage shows the newest conversation.
        usageFor = { project: null, session: null };
        void rerender(false);
      },
    }, svg(p.icon, 18, { stroke: 1.9 }), t(p.label))),
    h("div", {
      class: "side-foot",
      text: t("No telemetry. Network requests only go to the services you configure yourself."),
    }),
  );
}

// ── Language ──────────────────────────────────────────────────────────────────

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = t("Settings — Buddybara");
}

let rendering: Promise<void> | null = null;
let renderAgain = false;

/** Redraws the window from fresh state, where it was scrolled to unless `keepScroll` is false. */
async function rerender(keepScroll = true) {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const scroll = keepScroll ? root.querySelector(".main")?.scrollTop ?? 0 : 0;
  rendering = render();
  try {
    await rendering;
  } finally {
    rendering = null;
  }
  const main = root.querySelector(".main");
  if (main) main.scrollTop = scroll;
  if (renderAgain) {
    renderAgain = false;
    await rerender();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyTheme(settings.theme, settings.themeCustom);
  applyTextSize(settings.textSize);
  applyDirection();
  // The corner Buddybara wears the desktop one's picture too.
  const wearSkin = async () => {
    engine.skin?.close();
    engine.skin = await loadSkin();
    drawMascot(0);
  };
  void wearSkin();
  void onEvent<null>("skin-changed", () => void wearSkin());
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  await render();

  void onEvent<Settings>("settings-changed", (s) => {
    // In place: the page on screen holds this very object, and a copy would
    // leave it changing a stale one (its next save would undo this).
    Object.assign(settings, s);
    applyLanguage();
    applyTheme(settings.theme, settings.themeCustom);
    applyTextSize(settings.textSize);
  });
  // Opened for one page (the panel's first-run screen: Claude Code).
  void onEvent<string>("settings-page", (p) => {
    if (p === page || !PAGES.some((x) => x.id === p)) return;
    page = p as PageId;
    void rerender(false);
  });
  // A file dragged over the window, then dropped: Skills → Add takes it (addons.ts).
  const toAdd = () => {
    if (page === "skills" || page === "plugins") return;
    page = "skills";
    void rerender(false);
  };
  void onEvent<boolean>("settings-drag", (on) => {
    addonsDragging(on);
    if (on) toAdd();
  });
  void onEvent<string[]>("settings-drop", (paths) => {
    if (!paths[0]) return;
    addonsDropped(paths[0]);
    toAdd();
  });
  // The panel's /usage: this page, its Usage on the conversation it was typed in.
  void onEvent<UsageTarget>("settings-usage", (target) => {
    usageFor = { project: target.project ?? null, session: target.session ?? null };
    page = "claude";
    void rerender(false);
  });
}

/** Reads what the page on screen shows, and draws the sidebar and the page. */
async function render() {
  let body: HTMLElement;
  if (page === "claude") {
    const status = (await Bridge.hooksStatus()) ?? {
      installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
    };
    body = claudePage(status);
  } else if (page === "models") {
    const present: Record<string, boolean> = {};
    for (const key of MODEL_KEYS) present[key] = (await Bridge.secretPresent(key)) ?? false;
    body = modelsPage(settings, save, present);
  } else if (page === "integrations") {
    const present: Record<string, boolean> = {};
    for (const key of INTEGRATION_KEYS) present[key] = (await Bridge.secretPresent(key)) ?? false;
    body = integrationsPage(settings, save, present);
  } else if (page === "agents") {
    body = agentsPage(await Bridge.agentHooksList());
  } else if (page === "skills" || page === "plugins") {
    body = directoryPage(page);
  } else if (page === "connectors") {
    body = connectorsPage();
  } else if (page === "customize") {
    body = customizePage(settings, save);
  } else {
    body = generalPage();
  }
  clear(root);
  root.append(sidebar(), h("main", { class: "main" }, body));
  animate();
  // The first frame now, whether or not the window is in front.
  drawMascot(0);
}

void main();
