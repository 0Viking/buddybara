# Buddybara

**A capybara on your Windows desktop that runs Claude Code for you.** Buddybara floats wherever
you drop it, with a mikan on its head. Click it and a panel opens with your projects, their Claude
Code sessions and the conversation, so you can keep working with Claude without an editor or a
terminal.

Windows 10 or 11 (64-bit) · free and open source · no admin rights needed

### What it does

- **Your projects and conversations, one click away.** Pick a project, open a session or start a
  new one, and chat with Claude Code. Choose the mode (Manual, Edit automatically, Plan, Auto), the
  effort and the model. Send a message while Claude works and it reads it at its next step.
- **Permission requests and questions come to you.** They show in the panel, and nothing is
  approved without your click. A session that finishes lets you know.
- **Quiet while you play.** Nothing pops up while a game or a video is full screen.
- **Your plan's usage on the mikan**, so you see how much of your Claude plan is left.
- **A real terminal** for any conversation, when you want Claude Code's own screen.
- **Skills, plugins and connectors** from Anthropic's Directory, searchable and installed for
  Claude Code in one click.
- **More than Claude Code:** Codex, Gemini CLI, Cursor and other agents show their work here too;
  chat with other models (OpenAI, Google, OpenRouter, Ollama, LM Studio); and keep an eye on
  GitHub, Vercel, Stripe and other services in the Services tab.
- **In 10 languages**: English, 中文, हिन्दी, Español, العربية, Français, বাংলা, Português, Русский,
  Bahasa Indonesia.
- **Private by design.** No telemetry; keys stay in Windows Credential Manager; it only talks to
  the services you set up.

### What you need

- A Claude account with Claude Code (a Pro, Max, Team or Enterprise plan, or an Anthropic Console
  account).
- That's all. You don't need VS Code, Visual Studio, Node or anything else: Buddybara's first-run
  screen installs Claude Code for you if it's missing.

## Install

1. Get the installer, `Buddybara-Windows-<version>-setup.exe`, from the **Releases** section of
   this repository (or [build it yourself](#build-from-source)), and run it.
2. Windows may say **"Windows protected your PC"**: the installer isn't code-signed yet. Click
   **More info → Run anyway**.
3. Buddybara appears at the bottom right of your screen. Drag it wherever you like.

## First run

Click Buddybara. The first time, the panel shows what's left to set up:

1. **Claude Code**: if it isn't installed, **Install** sets it up with winget in a window of its own.
2. **Sign in**: opens your browser to sign in to your Claude account.
3. **Projects folder**: the folder whose subfolders are your projects (`%USERPROFILE%\projects`
   unless you change it).
4. **Claude Code hooks**: let Buddybara see your sessions and show their permission requests. It
   opens Settings, shows you the exact change to Claude Code's settings, and writes nothing until
   you confirm. Restart any Claude Code session that was already open.

Then click **Start**. Optional, in Settings (the gear in the panel, or right-click the capybara in
the notification area): **Launch at startup**, your plan's usage on the mikan, other agents, other
AI models, skills, plugins, connectors and services.

If you hide the buddy (the button at the top right of its head), start Buddybara again from the
Start menu. While it runs, starting it again opens the panel.

## Update

Run the installer of the newer release (from the **Releases** section). Your settings, keys and
hooks are kept.

## Uninstall

1. Optional: Settings → Claude Code → remove the **Claude Code hooks**. If you leave them, they do
   nothing once Buddybara is gone.
2. Windows Settings → Apps → **Buddybara** → Uninstall.
3. For a complete cleanup, also delete `%APPDATA%\Buddybara`.

## If something's off

- **Buddybara doesn't react when Claude works**: the hooks aren't installed (first run, step 4), or
  that Claude Code session started before they were. Restart it.
- **"Claude Code isn't installed" in the panel**: run the first-run screen's Install, or check that
  `claude --version` works in a new PowerShell.
- **Logs**: `%LOCALAPPDATA%\Buddybara\buddybara.log`.
- **Antivirus warnings**: Buddybara is unsigned and new, so Windows Defender's machine-learning
  scan can flag it by mistake. You can report a false positive to Microsoft at
  [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/wdsi/filesubmission). At work,
  check your IT rules before installing.

## Build from source

For developers. In PowerShell, as your normal user (only the Build Tools ask for admin rights):

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Close and reopen PowerShell, then:

```powershell
cd $env:USERPROFILE
git clone https://github.com/0Viking/buddybara.git
cd buddybara\windows
npm ci
npx tauri build --no-bundle    # the app: windows\target\release\Buddybara.exe
npm run pack                   # or the installer: windows\release\
```

Quit Buddybara before rebuilding: Windows locks a running app. A version tag (`v0.4.0`, matching
`windows/src-tauri/tauri.conf.json`) publishes the installer as a GitHub release.

## License

Buddybara is a fork of [Coucou](https://github.com/Louis-CFM/coucou). The code is MIT
([LICENSE](../LICENSE)), and Coucou's copyright notice stays in it, as MIT requires. The name, the
capybara character, its icon and the sounds are this repository's own.
