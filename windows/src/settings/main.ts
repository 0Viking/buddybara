// Settings window: a sidebar of pages (General, Claude Code, Connectors, Keys)
// and the page on the right. Anything that writes to disk is confirmed here,
// Claude Code's settings.json only ever after its diff was shown.

import "./settings.css";
import { Bridge, onEvent, type HookPreview, type HookStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { SOUND_NAMES } from "../core/sound";
import { BotEngine } from "../buddybara/engine";
import { h, clear, svg } from "../views/dom";
import { pageOf, renderDiff, statusDot } from "./parts";
import { agentsPage } from "./agents";
import { connectorsPage } from "./connectors";
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

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return el;
}

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
 * The 5-hour and weekly limits on the mikan, read from the account (claude.rs
 * plan_usage). The status line relay that used to bring them is not needed any
 * more: while one is still in settings.json, it can be taken out here.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) on the mikan. It is read from your Claude account every few minutes, with the sign-in Claude Code keeps on this computer, and goes nowhere else. Pro and Max plans only."); },
  get showClaude() { return t("Show on the mikan"); },
  get oldRelay() { return t("The status line relay is no longer needed: the usage now comes from your account."); },
};

function planCard(status: HookStatus): HTMLElement {
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

function claudePage(status: HookStatus): HTMLElement {
  return pageOf("Claude Code", null, hooksCard(status), planCard(status));
}

// ── Keys page ─────────────────────────────────────────────────────────────────

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

/** The keys Claude's runs get (code.rs KEYS_FOR_CLAUDE), by their secrets.rs ids. */
const CLAUDE_KEYS = [
  {
    key: "github-token",
    name: "GitHub",
    label: N_("Token"),
    placeholder: "github_pat_… / ghp_…",
    hint: N_("Lets Claude use gh and the GitHub API. A fine-grained token limited to the repositories you want is safest."),
  },
  {
    key: "obsidian-api-key",
    name: "Obsidian",
    label: N_("API key"),
    placeholder: "…",
    hint: N_("From Obsidian's Local REST API plugin (Settings → Local REST API). Claude reaches your vault through it while Obsidian is open."),
  },
];

function keysPage(present: Record<string, boolean>): HTMLElement {
  const stored = () => `••••••••  ${t("(stored)")}`;
  const list = h("div", { class: "stack" });
  for (const def of CLAUDE_KEYS) {
    const input = h("input", {
      type: "password",
      placeholder: present[def.key] ? stored() : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `${def.name} ${t(def.label)}`,
    }) as HTMLInputElement;
    const dotEl = statusDot(present[def.key] ?? false);
    const saveBtn = h("button", { text: t("Save") });
    // An empty field saved removes the key.
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      try {
        await Bridge.secretSet(def.key, value);
        present[def.key] = value.length > 0;
        input.value = "";
        input.placeholder = value ? stored() : def.placeholder;
        dotEl.style.background = value ? "var(--leaf)" : "var(--red)";
      } catch {
        dotEl.style.background = "var(--amber)";
      }
    });
    list.append(h("div", { class: "key" },
      h("div", { class: "key-body" },
        h("div", { class: "row" }, dotEl, h("b", { text: def.name })),
        h("div", { class: "row" }, h("label", { text: t(def.label) }), input, saveBtn),
        h("div", { class: "hint", text: t(def.hint) }),
      ),
    ));
  }
  return pageOf(
    t("Keys"),
    t("Keys Claude can use: runs started from the buddy and its terminal get them. They are stored in the {store}, never on disk.", { store: KEY_STORE }),
    h("div", { class: "card" }, list),
  );
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

  // Your own sounds: the folder, a reload, and how many are replaced.
  const customCount = h("span", { class: "hint" });
  const countCustom = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      customCount.textContent = n > 0 ? t("{0} custom", { 0: n }) : "";
    });
  countCustom();
  const soundsFolder = h("button", { text: t("Open sounds folder"), onclick: () => void Bridge.revealSoundsFolder() });
  const reloadSounds = h("button", {
    text: t("Reload sounds"),
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(countCustom, 300)),
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:76px",
    "aria-label": t("Auto-close"),
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  return pageOf(t("General"), null,
    h("div", { class: "card" },
      srow(t("Sound"), null, volume, toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); })),
      srow(null, t("Drop a file named like one of Buddybara's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload."),
        customCount, soundsFolder, reloadSounds),
    ),
    h("div", { class: "card" },
      srow(t("Auto-close"), t("seconds after you leave the buddy"), autoClose),
      srow(t("Launch at startup"), null, toggle(settings.autostart, (v) => { settings.autostart = v; void save(); })),
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

type PageId = "general" | "claude" | "agents" | "connectors" | "keys";

const PAGES: { id: PageId; label: string; icon: string }[] = [
  { id: "general", label: N_("General"), icon: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4" },
  { id: "claude", label: "Claude Code", icon: "M4 6l6 6-6 6M12 18h8" },
  { id: "agents", label: N_("Agents"), icon: "M8 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6M16 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6M3 19a5 5 0 0 1 10 0M11 19a5 5 0 0 1 10 0" },
  { id: "connectors", label: N_("Connectors"), icon: "M9 3v4M15 3v4M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" },
  { id: "keys", label: N_("Keys"), icon: "M4 16a4 4 0 1 0 8 0a4 4 0 1 0-8 0M10.8 13.2 20 4M17 7l2.5 2.5M14.5 9.5l2 2" },
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
  applyDirection();
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  await render();

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
    applyLanguage();
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
  } else if (page === "keys") {
    const present: Record<string, boolean> = {};
    for (const { key } of CLAUDE_KEYS) present[key] = (await Bridge.secretPresent(key)) ?? false;
    body = keysPage(present);
  } else if (page === "agents") {
    body = agentsPage(await Bridge.agentHooksList());
  } else if (page === "connectors") {
    body = connectorsPage();
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
