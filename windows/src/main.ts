// Entry point: boot the bridge, load the settings, bring Buddybara out.

import "./style.css";
import { Bridge, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { refreshClaudePlan, registerHookHandlers } from "./island/hooks";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages } from "./i18n/i18n";
import { Buddy } from "./buddy/buddy";
import { applyTextSize, applyTheme } from "./core/theme";

/** Shows the language Settings asks for ("" = the system's, when Buddybara has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

/** The saved settings and the interface language, before anything is drawn. */
async function loadSettings() {
  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  // A language change redraws in place: the texts given as tl(…) relabel
  // themselves (views/dom.ts) and the rest redraws on this sync. Nothing is
  // rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  applyTheme(State.settings.theme, State.settings.themeCustom);
  applyTextSize(State.settings.textSize);
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  return boot;
}

function applySound() {
  Sound.setEnabled(State.settings.soundEnabled);
  Sound.setVolume(State.settings.soundVolume);
}

/**
 * Errors nobody would see in a window without devtools go to Buddybara's log
 * (%LOCALAPPDATA%\Buddybara\buddybara.log) — the first few, so it never floods.
 */
function logPageErrors() {
  let left = 20;
  const log = (what: string) => {
    if (left-- > 0) void Bridge.log(`page: ${what}`);
  };
  window.addEventListener("error", (e) => log(e.message));
  window.addEventListener("unhandledrejection", (e) => log(String(e.reason)));
}

/** Buddy mode: Buddybara on the desktop and the panel beside him (src/buddy). */
async function startBuddy(root: HTMLElement) {
  logPageErrors();
  const buddy = new Buddy(root);
  try {
    await loadSettings();
    applySound();
    registerHookHandlers(buddy);

    await onEvent<string>("tray", (what) => {
      if (what === "settings") {
        void Bridge.openSettingsWindow();
      } else if (what === "relaunch") {
        // Its shortcut, while it already runs: Buddybara, not the panel.
        buddy.summon();
      } else {
        buddy.open();
      }
    });
    await onEvent<null>("screen-changed", () => void Bridge.reposition());
    await onEvent<Settings>("settings-changed", (s) => {
      const planWasOn = State.settings.showPlanInNotch;
      const foldersWere = State.settings.allSessionFolders;
      State.settings = { ...State.settings, ...s };
      if (State.settings.allSessionFolders !== foldersWere) void buddy.refreshProjects();
      applyLanguage();
      applySound();
      applyTheme(State.settings.theme, State.settings.themeCustom);
      applyTextSize(State.settings.textSize);
      // Just switched on in Settings: the mikan shows the numbers at once.
      if (!planWasOn) refreshClaudePlan(true);
      State.notify();
    });
  } catch (err) {
    void Bridge.log(`buddy: start-up failed: ${String(err)}`);
  }
  // Whatever failed above, Buddybara still comes out and the panel still opens.
  await buddy.init();
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  void Sound.preload();
  await startBuddy(root);
}

void main();
