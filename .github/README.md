# Buddybara

A Windows desktop buddy for Claude Code, forked from [Coucou](https://github.com/Louis-CFM/coucou):
the buddy floats on the desktop, and a click on it opens a panel with your projects, their
Claude Code sessions and the conversation — no editor needed.

> **License.** The code is MIT ([LICENSE](../LICENSE)); Coucou's copyright notice stays in it, as MIT
> requires. The name, the capybara character, its icon and the sounds are this repository's own.

## What it adds to Coucou

- **Buddy mode**: Buddybara stays wherever you drop it. Click it to open or close the panel beside it.
- **Projects panel**: the folders in `%USERPROFILE%\projects`, each one's sessions, the conversation,
  and a box to keep chatting. Pick the mode (Manual, Edit automatically, Plan, Auto) and the effort.
- **Permission requests and questions** show in the panel. A session that finishes opens it.
- **Game mode**: nothing pops up while a game or a video is full screen.
- **Plan usage on the mikan**: your Claude plan's usage, once Plan usage is on (step 4).

## Install on a new PC

Run everything in **PowerShell**, as your normal user. Only the Build Tools ask for admin rights.

### 1. Tools (once per PC)

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then **close and reopen PowerShell**, so the new tools are on your PATH.

### 2. Claude Code

```powershell
irm https://claude.ai/install.ps1 | iex
```

Open a new PowerShell and run `claude` once: sign in in the browser, then type `/exit`.

### 3. Get the code and build it

```powershell
cd $env:USERPROFILE
git clone https://github.com/0Viking/buddybara.git
cd buddybara\windows
npm ci
npx tauri build --no-bundle
```

The first build takes several minutes. The app is `windows\target\release\Buddybara.exe`.

### 4. First run

1. Start `windows\target\release\Buddybara.exe`. Buddybara appears at the bottom right: drag it wherever you like.
2. Right-click the capybara icon in the notification area (bottom right of the taskbar) → **Settings…** →
   install the **Claude Code hooks**, check the change it shows, and confirm.
   Restart any Claude Code session that was already open.
3. Optional, in the same Settings: **Plan usage** (the % on the mikan) and **Launch at startup**.

### 5. Desktop shortcut

In PowerShell (the path is where step 3 put the app):

```powershell
$exe = "$env:USERPROFILE\buddybara\windows\target\release\Buddybara.exe"
$link = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Buddybara.lnk")
$link.TargetPath = $exe
$link.WorkingDirectory = Split-Path $exe
$link.IconLocation = "$exe,0"
$link.Save()
```

Double-click **Buddybara** on the desktop to start it. If it's already running, the same
double-click opens the panel. Rebuilding replaces the app in place, so the shortcut keeps working.
Right-click it → **Pin to Start** or **Pin to taskbar** for those too.

Put it in the Start menu as well. That's where you start Buddybara again after hiding the buddy
with the button at the top right of its head (it shows while the pointer is over it):

```powershell
Copy-Item "$([Environment]::GetFolderPath('Desktop'))\Buddybara.lnk" ([Environment]::GetFolderPath('Programs'))
```

### Projects in another folder?

The panel lists the folders inside `%USERPROFILE%\projects`. If yours live elsewhere, say `D:\repos`:

```powershell
setx BUDDYBARA_PROJECTS "D:\repos"
```

Then quit Buddybara (right-click the notification-area icon → Quit) and start it again. If the list doesn't change,
sign out of Windows and back in.

## Update

Quit Buddybara first: Windows locks a running app, so the build can't replace it.

```powershell
cd $env:USERPROFILE\buddybara
git pull
cd windows
npm ci
npx tauri build --no-bundle
```

## Uninstall

1. Settings → remove the **Claude Code hooks**, so Claude Code stops calling Buddybara.
2. Quit Buddybara, then delete the `buddybara` folder, `%LOCALAPPDATA%\Buddybara` and `%APPDATA%\Buddybara`.

## If something's off

- **Buddybara doesn't react when Claude works**: the hooks aren't installed (step 4.2), or that
  Claude Code session started before they were. Restart it.
- **"Claude Code isn't installed" in the panel**: `claude --version` must work in a new PowerShell.
- **Logs**: `%LOCALAPPDATA%\Buddybara\buddybara.log`.
- **Antivirus or IT warnings**: a self-built, unsigned app can be flagged. That is expected for
  something built from source; check your workplace's rules before installing tools.
