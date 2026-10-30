<p align="center"><img src="docs/brand/logo-mark-256.png" alt="VVTerm" width="88"></p>

# VVTerm 1.1.1

Release date: 2026-10-30 · Platform: macOS (arm64 build verified) · Status: beta. Read [Known issues](#known-issues) first.

## What's new in 1.1.1

A patch release: fixes for typing and for the macOS input tools, and two new things in the terminal and in Settings.

### New: command suggestions in the terminal

- **A list of matching commands appears under the cursor while you type.** Each row says where it comes from: a command you ran in VVTerm, the shell history of this computer (local terminal: `~/.zsh_history`, `~/.bash_history`), one of your one-line Snippets (also found by its name) or, if you turn it on, the shell history of an SSH server.
- **Nothing is taken unless you choose it.** ↓ ↑ choose a row, then **Enter** or **Tab** put it on the line (it is never run for you); **Esc** closes the list. Until a row is chosen, Enter, Tab and the arrows are the shell's, as always.
- **⌘⇧G** (Ctrl+Shift+G elsewhere) turns suggestions off and on; **⌘⇧J** (Ctrl+Shift+J) opens the list by hand, also on an empty line. Both are in the **View** menu and can be changed in Settings → Shortcuts. **Settings → Terminal → Suggest commands** switches it off for good.
- **Safe by design.** No suggestions at a password prompt, in vim or htop, or while the shell is changing the line; a line that looks like a password, token or key is never suggested; a Snippet of several lines is never suggested (its first lines would run at once). The shell history of an SSH server is **off by default**, read once per terminal, kept in memory only, and goes through the secret filter on the way in.
- **The history keeps the command that ran**, as the screen shows it, instead of the keys that were pressed: a line completed with Tab or with your shell's own suggestion is saved whole, and a command with long output (`ls -la`) is no longer lost.

### New: Settings → Storage

- **Clear cache** removes the files VVTerm can make again and forgets what it found out about your AI tools (they are looked up again). It says what it removed.
- **Reset settings** puts appearance, terminal, general options, shortcuts and auto-lock back to their defaults, after a confirmation. Your profile, sync target, hosts, keys and vault are never touched.

### Fixed

- **A password field no longer leaves macOS "secure input" switched on.** While it is on, input tools such as OpenKey and GoTiengViet stop working in every app. Clicking an empty part of the unlock card (or of a panel with a password field) and then unlocking used to leave it on until some text field was focused; VVTerm now releases it. Measured with the system web view: a focused password field turns it on, a click on empty space keeps it on, focusing a text field turns it off.
- **Vietnamese typed in the terminal on macOS**: words replaced by the input method (`insertReplacementText`) were lost.
- **Settings → AI assistant no longer re-reads the whole page every 0.6 s** while it looks for your AI tools, which could make the page unresponsive; it also keeps what you are typing, and no longer makes the main window refresh for it. A failing load can no longer repeat itself on every notification.
- **Settings window ran a stale helper** after a rebuild or an app update.
- Development only: `make dev` hides the line macOS' Vietnamese input method prints for every key typed.

## Also in 1.1.1: AI terminal assistant

Ask an AI about what is on your terminal, without leaving VVTerm and without handing it your secrets. VVTerm runs the AI command-line tool you already use and are signed in to, so your own subscription is used and **no API key is stored**.

### Get started

1. **Settings → AI assistant**: switch on a tool VVTerm found (Claude Code, Codex CLI, or a command of your own; the Antigravity and Gemini CLIs are listed but cannot be switched on yet, see Limits). It stays off until you do, after a short isolation test.
2. Open a terminal, then the ✨ icon in the sidebar. Pick the provider and model from the chip under the message box, and ask.
3. Drop a log or a screenshot on the panel, or paste one, to add it to your question.

### What you get

- **A chat beside every terminal.** It reads the screen (or only the text you selected), explains errors, and suggests commands. Answers show code as blocks with a Copy button; an empty chat offers a few starting questions. The sidebar can be dragged wider or narrower (double-click the edge to reset).
- **It looks at your machine for you.** Commands that only read (`which`, `pgrep`, `ls`, `df`, `brew list`, `systemctl status`, `git status`… also chained with `;`, `&&`, `||` or a pipe) run **without asking**, and the assistant reads their output before it answers. This is on by default (**Settings → AI assistant → Run read-only commands by itself**) and never applies to production hosts.
- **Anything that could change something asks first, in the chat.** A command that edits, installs, restarts or deletes shows **Run…** and a confirmation in its own card; a risky one needs you to type `run`. **Insert** puts a command on the prompt without pressing Enter. Risk is judged by VVTerm, never by the AI. Nothing opens as a popup.
- **Files and screenshots.** Text files (up to 5, 100 KB each) are added to the question and redacted like the screen. Pictures (up to 3, 5 MB each) work with Claude Code and Codex CLI.
- **Several providers, real model lists.** Models are read from each provider itself (nothing is hard-coded) and chosen from a menu with full descriptions. A provider that cannot list its models uses its default one.
- **MCP servers.** Add MCP servers (a command or an HTTP address), test them, and choose a mode per tool: *Allow*, *Ask each time* or *Off*. New tools of a server stay off until you review them. Import servers from Claude Code or Gemini CLI. Currently used through Claude Code.
- **Per-host switch.** On a host's form: *Off*, *Ask first (in the chat)* or *On*. Hosts are **On** by default and **Off** on production hosts.
- **Typing Vietnamese (and other input methods)** in the terminal now shows the text you are composing at the cursor, highlighted, until you commit it.
- **Vietnamese and other accented text typed in a terminal** is now sent to the shell as whole letters. macOS input methods can deliver a letter in pieces (the `ệ` of *việt* as `e` + dot + circumflex); `zsh` cannot edit those and showed them as `<0087>`.

### Your secrets stay yours

- Before anything is sent, keys, tokens, passwords, URLs with credentials, `NAME=value` secrets and **everything saved in your vault** are replaced by `*******`. The same is done to every answer before you see it, and to commands before they can run. You can add your own patterns; you cannot turn redaction off.
- **What will be sent** shows the exact redacted text, inside the chat, before or after you ask. Every use is written to the activity log (Logs → Assistant).
- A command with a hidden value cannot be run from the panel. A secret in a tool's arguments blocks the call; tool results are redacted.
- **Pictures are the exception**: a secret inside a picture cannot be found, so VVTerm asks you to confirm each time (in the chat) and says so plainly.
- The AI tool runs in an empty temporary folder with a cleaned environment and no tools of its own. A provider can only be switched on after a self-test in which it is asked to run a command and to search the web, and must fail at both. Codex CLI is started with its shell tool, its apps connector and its web search turned off.
- Redaction is best effort. A password written in an ordinary sentence cannot always be recognised.

### Also new: sync through a cloud folder

**Settings → Sync → Cloud folder**: pick a folder inside Google Drive, iCloud Drive, Dropbox or OneDrive. Only the two encrypted files are written there, with no sign-in and no token. Extra "conflict copies" made by the cloud client are merged per record (newest edit wins) and removed. Git sync still works as before.

### Also new: find things in every list

- **Snippets, Port Forwarding, Known Hosts and Keychain** now have what the host list has: a search box, filter chips (state and type of a forward, key type of a known host, key / password / ssh-agent in the Keychain), a **Sort** menu (name, host, type, status, port, recently changed…) and a **Grid / List** switch. The **host list** gets a Sort menu too (name, production first, recently connected), the **Logs** page sorts by newest, oldest, host or problems first, and each **SFTP pane** sorts by name or size or date (folders always first). The sort and the view are remembered for each page. Names sort the way people read them (case and accents ignored, `web-2` before `web-10`).

### Also fixed in this release

- **The vault no longer auto-locks while you are working in a terminal**: typing and output now count as activity.
- **Locking the vault closes the Settings window.** The Settings window also opens in front of the main window (macOS 14+), without a white flash, and its AI page appears at once.
- **A host list that cannot be reached** from the Settings window now shows a message you can act on instead of an internal service name.

### Limits you should know about

- **Antigravity CLI cannot be switched on yet.** Its web search tool keeps working whatever deny rule is given (several were tried), so text from your terminal could leave in a search query, and the isolation self-test correctly fails. It will be usable when Antigravity offers a way to turn that tool off.
- Gemini CLI shares `~/.gemini` with Antigravity, which sets a sign-in the Gemini CLI does not support. Sign in again with `gemini` (Login with Google) to use it.
- The Gemini CLI adapter could not be tested against a signed-in account; its isolation is checked by the self-test when you switch it on.
- MCP tools work through Claude Code only. Pictures work with Claude Code and Codex CLI only.
- The assistant is not run on Windows or Linux yet, and chat history is kept in memory only (a new chat starts empty after a restart).
- If you saved the AI settings before this release, your saved value of *Run read-only commands by itself* is kept; switch it on in Settings if you want the new default.

Design, verification notes and the live checks that were run: [docs/AIAssistant.md](docs/AIAssistant.md). How to use it: [user guide](docs/UserGuide.md#22-ai-assistant).

## Highlights

- **New host, the Termius way**: a form docked next to the list (no popup) that follows the natural flow, with **Test connection** (checks address, credentials and jump host without saving anything) and **Connect** (save + open a terminal).
- **Settings as its own macOS window**: a real window with its own title bar, movable outside the main window, with macOS full screen, holding terminal themes (26), light / dark / auto appearance, font, cursor, scrollback, security and sync, plus help links and the version (⌘/Ctrl + ,). It closes when you quit VVTerm.
- **Forgot your master password?** The unlock screen now offers a clearly explained **reset** that keeps your hosts and erases only the secrets.
- **SFTP**: a file browser in its own tab, through jump hosts, with upload, download, new folder, rename, delete and a confirmation before anything is replaced.
- **More in Settings**: new *General* (interface zoom, reduce motion, confirm before closing) and *Account* (local profile, ready for sign-in later) sections, **shortcuts you can change**, and a window you can maximise, roll up and resize.
- **Snippets**: save commands you run often and type them into the focused terminal with one click. They sync, back up and export like everything else.
- **New interface**, inspired by Termius: a *Vaults* tab with the terminals as tabs, left navigation, one search box that also connects (`ssh user@host`), group and host cards, custom dropdowns.
- **New brand**: logo and wordmark on one row, macOS and Windows icons, favicon, social preview ([brand kit](docs/brand/README.md)).
- **Docker** for CI and development fixtures, and a **dev / prod deploy script**.
- **Terminal sidebar** (hosts, snippets with Run / Paste, command history, themes and font), **drag a tab onto a pane to split** without reconnecting, drag tabs to order them, take a pane back out into a tab, and **Duplicate in new window** (the whole app in a second window).
- **Termius-style connecting**: *Choose protocol*, a connecting screen whose line moves with the real connection (error, Retry, Show logs), connected / lost badges on tabs, a **New Tab** page with recent connections.
- **This computer, Serial and Telnet** (own login, encoding), Known Hosts and Logs pages, output highlighting, copy on select and right-click paste, tag filter, drag hosts into groups, SFTP right-click menu with permissions.

## What's new in 1.1.0

### Windows, tabs and panes
- **Tabs**: the + opens a New Tab (search hosts or tabs, Local Terminal, recent connections). Tabs shrink like a browser's, show the server-type icon and a spinner / green / red badge, can be dragged to reorder, renamed, duplicated and split from a right-click menu.
- **Drag a tab onto a pane** to split it left / right / top / bottom; **Move pane to its own tab** undoes it. All panes of all tabs are drawn in one flat list, so moving a pane never rebuilds it and its session is not interrupted.
- **Duplicate in new window** opens the whole app in a second window (another process) that shares the vault, the hosts and the sessions' owner through a local bridge (loopback, random token in a 0600 file, see [ADR-0006](docs/CleanArchitecture.md)). Sessions it opened end with it.
- A native menu bar (File, Edit, View, Window, Help) that stays the same in the Settings window; the browser's own right-click menu (Look Up, Translate, Inspect Element) is turned off.

### Connecting
- *Choose protocol* (SSH, Mosh shown but unsupported, Telnet when enabled) on by default (**Settings → Terminal → Ask which protocol to use**); a connecting screen with a line that eases toward the real stage (connecting, authenticated, ready); on failure the line stops, turns red and shows the reason with Retry, Show logs and Close.
- The backend reports the stages (**term:progress**) and says *ready* as soon as the shell is open: the activity log, server-type detection and automatic forwards no longer delay it.

### Terminal
- Sidebar: Hosts, Snippets (one line; click for the whole script with Run and Paste), History (only echoed lines: nothing typed at a password prompt), Themes and font. Terminal on this computer, Serial ports, Telnet (own user name, password in the vault, UTF-8 / ISO-8859-1), per-host theme with picture cards, output highlighting, copy on select, configurable right-click and copy / paste keys, broadcast input and maximise for panes. Default terminal text is now green.
- Page shortcuts ⌘ 1 … 6 and ⌘ N / ⌘ Shift T; the key of an action shows at the right of its navigation item when you point at it.

### Hosts, files and pages
- Tag filter, **drag a host onto a group** (or onto *All hosts* to take it out), Grid / List view, *All hosts* lists every host including those in groups, a New host menu (New group, Import).
- SFTP: two panes, several files and folders at once, drag and drop, one *Replace?* question per batch, a right-click menu (Open, Open with…, Copy to target directory, Rename, Delete, Refresh, New Folder, **Edit Permissions**); remote files open from a private temporary folder, and files that run programs (.command, .app, .sh, .exe…) are never opened from here.
- **Known Hosts** (forget a trusted key) and **Logs** (connections, transfers, forwards, host keys, unlocks; never a secret), Keychain with *New Key* (private, public, certificate, drag a key file in), the Port Forwarding wizard.
- The database gets columns added later on every start (schema v4 + idempotent additions), so a database that already had the newest version is never left behind (the cause of a *no such column* start-up error).

### Known limits of this part
- Mosh and the cloud integrations of Termius (AWS, DigitalOcean, Azure) and multiplayer are not built.
- Telnet is not encrypted. Keys stored *hashed* in `known_hosts` are listed but cannot be forgotten from the app.
- The new window and the Settings window are separate processes: the new window has its own Dock icon, the Settings window is hidden from the Dock (macOS then shows no menu bar of its own for it). A change made in one window is picked up by the other when it next refreshes.
- Typing Vietnamese with a system-wide input method (GoTiengViet, OpenKey…) can fail to compose in the terminal: those tools treat unknown apps differently; add VVTerm to their app list.
- Native windows, the menu bar and the Dock icon cannot be screenshotted by the end-to-end run and were checked by hand only where noted.

### Add a host
- The New host / New group / New snippet forms are **docked beside the list** and show a draft card in the grid while you type. They close when you move to another screen instead of staying open.
- Flow: address → general (label, group, environment colour, tags) → SSH port → credentials (username and password, or a key identity; eye button to reveal) → options (jump host, keepalive).
- A typed password is stored in the vault as an identity; the host only references it.
- **Test connection** runs through the jump chain without saving a host or an identity, confirms unknown host keys inline, never shows the password, and reports why a test failed (authentication, unreachable, key not trusted).
- **Connect** saves, then opens the terminal. **Save** only saves.
- Every control has the same height and style; the native macOS dropdown was replaced by a **custom dropdown** (hints, check mark, keyboard: arrows, Enter, Esc, type-ahead; opens upward when there is no room).

### SFTP
- Folder button on a host card opens an SFTP tab on a separate SSH connection (jump chain supported, host key confirmation like a terminal). Browse, breadcrumbs, path box, Up / Home / Refresh.
- Upload, download, new folder, rename, delete (recursive, after confirmation). Existing files are never replaced silently on either side. Transfers use a temporary file and are renamed when finished; progress is shown.
- Connection drops show a banner with Reconnect. Closing the tab asks first. Snippets still go to the last terminal, never to an SFTP tab.
- Limits: single files only, no queue or resume, no drag and drop.

### Settings window
- **A second native window** (a second VVTerm process, see [ADR-0006](docs/CleanArchitecture.md)): the standard red / yellow / green buttons, resize, full screen. It opens from the navigation, the gear or the shortcut, is raised instead of opened twice, and closes when the main app quits. Where no native window exists (browser mode, the E2E run) the same settings appear in an in-app floating window (drag, roll up, maximise) (Esc closes an open dropdown first). Opens from the navigation, the gear in the title bar, or ⌘/Ctrl + , (also inside a terminal).
- Left menu like Termius: General, Account, Terminal, Security, Sync, Shortcuts, then Theme (Auto / Light / Dark), Documentation, Request a feature, Report a bug, Release notes, Support on Ko-fi, and the Version.
- **Terminal theme picker**: 26 themes in a two-column list with live swatches, dark/light filter, *Match app theme*, and a live preview with your font, size and cursor.
- Font, size stepper, cursor style, blinking, scrollback. Auto-lock, keychain unlock and master-password change under Security.
- **General**: interface zoom 80 %–160 %, reduce motion, confirm before closing a tab. **Account**: display name and email (local only), plan, disabled *Sign in*.
- **Shortcuts**: click a key chip and press a new combination. Duplicates and plain keys are refused with an explanation; reset one or all. `Ctrl+Tab`-style defaults work on every platform (Mod means ⌘ on a Mac and Ctrl elsewhere).
- Old `settings.json` files keep working: new fields get defaults.

### Lost master password
- *Forgot password?* on the unlock screen explains that the password cannot be recovered and what a reset does.
- **Reset vault** (type `RESET`): erases the vault and every key/password identity, keeps hosts, groups, snippets, port forwards and ssh-agent identities, clears the Keychain entry, and turns the screen into *Create vault*. It works while locked. An encrypted backup can be restored afterwards.

### Snippets
- Create, edit, delete snippets (label, optional description, multi-line script, validated: 64 KiB limit, no NUL bytes).
- **Run** types the script and presses Enter in the focused pane of the last terminal; **Paste** types it without Enter. A *Snippets* menu in the title bar does the same inside a terminal.
- Included in Git sync (merged per record), encrypted backups and the plain JSON export. The database upgrades itself from v1 to v2.

### Interface and brand
- Title bar with a **Vaults** home tab, one tab per terminal, `+`, settings gear, snippet picker and split buttons; drag the bar to move the window.
- Left navigation: Hosts, Keychain, Port Forwarding, Snippets, Import / Export, Settings, Lock vault. It shrinks to icons in a narrow window and the New host panel floats instead of squeezing the list.
- Hosts page: *Find a host or ssh user@hostname…* with **Connect**; an unknown target opens *New host* pre-filled. Group cards open with breadcrumbs.
- Logo and wordmark share one row; all emoji and text glyphs used as icons were replaced by one SVG icon set.

### Engineering
- `docker-compose.yml`: demo SSH servers (persistent host keys), a throw-away Git remote, and CI runners. Go tests also pass inside a Linux container.
- `scripts/deploy.sh dev|prod` with release gates, signing/notarization hooks, zip + checksums and an explicit confirmation before anything is published. `VERSION` is the single source of the version number.
- `e2e/run.sh` picks a free port, so it never collides with a `wails dev` you already have open.
- Go 1.26 is declared consistently (`go.mod`, Docker, CI, README). `docs/Development.md` for contributors; the README is written for people trying the app.

### Fixes
- The window could not be dragged by the title bar (wrong CSS mechanism for Wails).
- A maximised Settings window used to cover the macOS window buttons, showing two sets of dots; it now leaves the title bar free.
- The sidebar *Theme* dropdown showed a heavy box on hover; it now highlights softly.
- Holding a zoom shortcut could lose steps (each press used stale settings); saves are now applied immediately and in order.
- The *Vaults* tab stretched to 220 px (a CSS class collided with the page container).
- The wordmark's two V letters touched or drifted apart; the navigation had an odd gap in the middle.
- The page could scroll horizontally for a moment when a panel slid in.
- Navigation buttons had no accessible name when only icons were shown.
- Switching Keychain tabs while a save was still running pulled you back to the first tab.
- Typing `user@host` did not match saved hosts.
- Dock icon: the built app contains the new logo; macOS may show the old icon until its icon cache is refreshed (restart the Dock, or move the app).

## Quality gates

| Gate | Result |
| --- | --- |
| `go vet ./...` | clean |
| `go test -race ./...` | **296 passing** (test functions and sub-tests), 0 failing, 20 packages; also green in a Linux container |
| Go statement coverage | **80.6 %** (`internal/…` and `app`) |
| Frontend `tsc --noEmit` + Vitest | clean, **575 passing** in 35 files |
| End-to-end walkthrough (real backend, SQLite, vault, two SSH servers) | **passed**: 20 steps, 60 screenshots in `docs/screenshots` |
| Architecture rule (`internal/archtest`) | 5 tests, verified to fail on a deliberate violation |
| `scripts/deploy.sh` | dev install, every prod gate and a dry run exercised |
| Docker dev fixtures | SSH host keys survive a restart; Git remote accepts a push |

The complete list of test cases is [docs/TestInventory.md](docs/TestInventory.md); the plan and the manual checklist are in [docs/TestPlan.md](docs/TestPlan.md); the honest evaluation is [docs/Assessment.md](docs/Assessment.md).

## Known issues

1. **Keychain unlock is not biometric-gated**: anyone who can read your login keychain can unlock the vault.
2. **The vault does not lock when the Mac sleeps**; only the idle timer applies.
3. **Settings runs as a second process**: it shows a second Dock icon while open. It reads and writes through a local, token-protected bridge to the main app, so it needs the main app running. The native window itself could not be screenshotted here, so its look is covered by tests and the in-app variant's screenshots; please check it on your Mac.
4. The packaged app was built and its icon, About box and bundle were checked, but it is **not notarized**: on first launch right-click → Open. The *release* pipeline can sign and notarize when you provide a Developer ID.
5. The native macOS window, file dialogs and Keychain prompts were not exercised in this environment (the UI is verified in a browser against the real backend). Run the manual checklist in [docs/TestPlan.md](docs/TestPlan.md).
6. Terminal performance on heavy output in WKWebView is unmeasured.
7. Sync was tested against local Git remotes only. Edits made during the few seconds of a sync can be overwritten. After a vault reset the sync repository still holds the old vault: use a new repository.
8. Last-write-wins depends on reasonably correct clocks.
9. `ssh_config`: `ProxyCommand`, `Match`, token expansion are reported as warnings and skipped.
10. Snippets run in the focused pane only (no multi-host targets or variables yet). A saved host cannot choose its own terminal theme (the theme is global). No CLI (`vvt`). SFTP moves single files only (no folders, queue or resume). Account sign-in is a placeholder.
11. Windows and Linux are not built or tested.
12. Use cases still depend directly on some infrastructure packages (documented debt, capped by a test).
13. Replacing a saved host password creates a new identity; the old one stays in Keychain until you delete it.

## Changes from the original design

| Design | Now | Why |
| --- | --- | --- |
| JSON files, no SQLite in the MVP | SQLite (`vvterm.db`, schema v2) | product requirement ([ADR-0001](docs/CleanArchitecture.md)) |
| Snippets out of scope | Snippets included | requested |
| No SFTP, fixed shortcuts | SFTP browser, configurable shortcuts, General and Account settings | requested |
| `kevinburke/ssh_config` | own parser | needs per-file group names ([ADR-0003](docs/CleanArchitecture.md)) |
| Services in `app/` | `internal/usecase`, Wails glue in `app/` | clean architecture ([ADR-0002](docs/CleanArchitecture.md)) |
| Svelte or React | React + TypeScript | open question resolved |
| Touch ID | keychain unlock without biometric enforcement | needs a native bridge |
| "Lost password: nothing to do" | reset vault (keeps hosts, erases secrets) | requested |

## Upgrading

Open the new build: the database migrates itself (v1 → v2) on first start. Back up first with **Import / Export → Encrypted backup** if the data matters. Data lives in `~/Library/Application Support/vvterm/` (override with `VVTERM_DATA_DIR`). **If you forget the master password the vault cannot be recovered** (you can reset it and keep your hosts).

## How to verify this release

```bash
make test        # all unit, integration and component tests
make e2e         # walkthrough against the real backend; refreshes docs/screenshots
make build       # build/bin/vvterm.app
scripts/deploy.sh prod --dry-run   # the release pipeline without side effects
```

---

# VVTerm 1.0.0

First release (2026-10-28): encrypted vault (Argon2id + AES-256-GCM), hosts with groups/tags/environments, jump host chains, tabs and split panes, strict host key checking (changed keys are blocked with no override), local/remote/SOCKS5 forwarding, `~/.ssh/config` import/export, plain JSON and encrypted backups, Git sync with per-record merge, SQLite storage and a clean-architecture codebase with an enforced dependency rule.

Defects found and fixed while building 1.0.0 (each has a regression test): config-file injection through newline characters in hostnames; a sync commit on every run caused by random encryption nonces; early output and host key prompts lost before the UI subscribed; a white screen after importing because Go sent `null` for empty lists; untrusted KDF parameters that could crash or exhaust memory.
