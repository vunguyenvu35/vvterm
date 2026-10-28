<p align="center"><img src="docs/brand/logo-mark-256.png" alt="VVTerm" width="88"></p>

# VVTerm 1.1.0

Release date: 2026-10-28 · Platform: macOS (arm64 build verified) · Status: beta. Read [Known issues](#known-issues) first.

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

## What's new in 1.1.0

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
| `go test -race ./...` | **191 passing** (test functions and sub-tests), 0 failing, 13 packages; also green in a Linux container |
| Go statement coverage | **81.1 %** (`internal/…` and `app`) |
| Frontend `tsc --noEmit` + Vitest | clean, **323 passing** in 22 files |
| End-to-end walkthrough (real backend, SQLite, vault, two SSH servers) | **passed**: 17 steps, 40 screenshots in `docs/screenshots` |
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
