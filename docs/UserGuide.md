<p align="center"><img src="brand/logo-mark-256.png" alt="VVTerm" width="88"></p>

# VVTerm user guide

A step-by-step guide to every screen of VVTerm, from creating your vault to connecting, transferring files and getting help. The screenshots show the app as it looks today.

## Contents

1. [Create and unlock the vault](#1-create-and-unlock-the-vault)
2. [The main window](#2-the-main-window)
3. [Keychain: keys and passwords](#3-keychain-keys-and-passwords)
4. [Add a host: test, save, connect](#4-add-a-host-test-save-connect)
5. [Hosts and groups](#5-hosts-and-groups)
6. [Connect](#6-connect)
7. [Snippets](#7-snippets)
8. [Split panes and search](#8-split-panes-and-search)
9. [SFTP: browse and transfer files](#9-sftp-browse-and-transfer-files)
10. [Port forwarding](#10-port-forwarding)
11. [Import and export](#11-import-and-export)
12. [Settings](#12-settings)
13. [Sync between Macs](#13-sync-between-macs)
14. [Forgot your master password](#14-forgot-your-master-password)
15. [When something goes wrong](#15-when-something-goes-wrong)
16. [Where your data lives](#16-where-your-data-lives)
17. [Connecting: protocol, progress and errors](#17-connecting-protocol-progress-and-errors)
18. [Tabs: order, split, new window](#18-tabs-order-split-new-window)
19. [The terminal sidebar](#19-the-terminal-sidebar)
20. [This computer, Telnet and serial ports](#20-this-computer-telnet-and-serial-ports)
21. [Known Hosts and Logs](#21-known-hosts-and-logs)
22. [AI assistant](#22-ai-assistant)
23. [Shortcuts at a glance](#23-shortcuts-at-a-glance)

## 1. Create and unlock the vault

On first launch choose a master password (at least 12 characters). It protects your keys and passwords and **cannot be recovered** (see [section 13](#13-forgot-your-master-password) for what you can do if you lose it).

![Create vault](screenshots/01-create-vault.png)

Next time, or after auto-lock, enter it to unlock. A wrong password never unlocks anything.

![Wrong password](screenshots/56-unlock-wrong-password.png)

## 2. The main window

![Home](screenshots/02-home-empty.png)

- **Title bar:** the **Vaults** tab is home; every terminal you open becomes a tab. **+** returns home to find a host. At the right: the **Settings** gear, **Snippets** and the split buttons (active inside a terminal). Drag the bar to move the window.
- **Navigation:** Hosts, Keychain, Port Forwarding, Snippets; at the bottom Import / Export, Settings and Lock vault. In a narrow window the navigation shrinks to icons.

## 3. Keychain: keys and passwords

**Keychain** holds identities. Pick a tab:

- **Generate key**: creates an ed25519 key pair. Only the public key is shown. Copy it into `~/.ssh/authorized_keys` on your servers.
- **Import key**: from a file or pasted text; give the passphrase if the key is encrypted.
- **Add password** or **ssh-agent** identity.

![Generated key](screenshots/03-keychain-generated-key.png)

![Identities](screenshots/05-keychain-identities.png)

Private keys and passwords never leave the vault: the interface only shows names and public keys. A password you type in the host form is saved here automatically as an identity.

## 4. Add a host: test, save, connect

**New host** opens a form **docked next to the host list** (no popup), with a draft card showing what you are typing. If you move to another screen the form closes.

![New host](screenshots/08-new-host-panel.png)

The form follows one flow, top to bottom:

1. **Address** (IP or hostname).
2. **General**: label, parent group, environment colour, tags.
3. **SSH on … port**.
4. **Credentials**: username and password, or choose a saved key/identity. The eye shows or hides the password.
5. **Options**: host chaining (jump host) and keepalive.

Dropdowns open a custom menu with hints and keyboard support (arrows, Enter, Esc, type to jump):

![Dropdown](screenshots/07-custom-select.png)

At the bottom:

- **Test connection** checks what you typed (including the jump host) **without saving anything**. For an unknown server you confirm its fingerprint right in the form.
- **Save** stores the host.
- **Connect** saves it and opens a terminal.

![Unknown host key during a test](screenshots/09-test-connection-host-key.png)

![A failed test](screenshots/10-test-connection-failed.png)

![A successful test](screenshots/11-test-connection-ok.png)

A failed test explains why (wrong password, host unreachable, key not trusted) and never shows the password.

## 5. Hosts and groups

Groups appear as cards with their host count. Click one to open it (a breadcrumb takes you back).

![Groups](screenshots/15-hosts-groups.png)

![Hosts in a group](screenshots/16-hosts-in-group.png)

**Search** matches label, hostname, user and tags across all groups; the environment chips filter further.

![Search](screenshots/41-search-filter.png)

**Quick connect:** type `ssh user@host:port` and press Enter. If it matches a saved host you connect; otherwise *New host* opens pre-filled so you can save it.

![Quick connect](screenshots/42-quick-connect.png)

## 6. Connect

Double-click a host card (or press ▶), or use **Connect** in the New host form. The first time, VVTerm shows the server fingerprint. Verify it out of band, then choose **Trust and connect**. With a jump host you confirm each machine once.

![Host key prompt](screenshots/13-host-key-prompt.png)

![Terminal through a jump host](screenshots/14-terminal-via-jump-host.png)

Trusted keys go to `known_hosts` (OpenSSH format) and are not asked again.

## 7. Snippets

Snippets are commands you reuse. **Snippets → New snippet**: a label, an optional description and the script (one or more lines).

![New snippet](screenshots/17-new-snippet-panel.png)

![Snippets](screenshots/18-snippets-page.png)

- **Run** (▶) types the script and presses Enter in the focused pane of your terminal and switches to it.
- **Paste** types it *without* Enter, so you can read or edit it first.
- Inside a terminal, the **Snippets** menu in the title bar does the same without going back home.

![Snippet picker](screenshots/19-snippet-picker.png)

A terminal must be open and connected. Snippets sync with Git and are included in backups.

## 8. Split panes and search

Use the two buttons at the top right to split the focused pane right or down. Every pane is its own session to the same host. **Ctrl/Cmd+F** searches the scrollback. When a shell exits (`exit`) its pane closes; closing the last pane closes the tab.

![Split panes](screenshots/20-split-panes.png)

## 9. SFTP: browse and transfer files

Use the **folder button** on a host card to open a file browser in its own tab (the tab has a folder icon). VVTerm opens a separate SSH connection, through the jump hosts if the host has any, so you do not need an open terminal. The first time you connect to an unknown server you are asked to trust its key, exactly as for a terminal.

![SFTP browser](screenshots/29-sftp-browser.png)

- **Browse:** double-click a folder (or press Enter), use the arrows, breadcrumbs, *Up*, *Home*, *Refresh* or type a path in the box.
- **Upload** a file into the current folder, **Download** the selected file, **New folder**, **Rename**, **Delete** (folders are deleted with everything inside, after a confirmation).
- Nothing is overwritten silently: if the target already exists, on either side, you are asked whether to replace it. Transfers go through a temporary file and are renamed when complete, so an interrupted transfer never leaves half a file behind.
- A progress bar shows each transfer.

![SFTP transfer](screenshots/30-sftp-transfer.png)

- If the connection drops, a banner offers **Reconnect**.
- **Limits:** files only (no folder upload/download yet, no transfer queue or resume), and no drag and drop from Finder. Closing an SFTP tab asks first (see *Confirm before closing a tab*).

## 10. Port forwarding

Open **Port Forwarding**, pick *New forward for host…*, and add one:

| Type | Meaning |
| --- | --- |
| Local (-L) | listen on your Mac, connect to a destination through the host |
| Remote (-R) | listen on the server, connect back to a destination on your Mac |
| Dynamic (-D) | local SOCKS5 proxy through the host |

Forwards listen on `127.0.0.1`; other addresses need an explicit checkbox. *Start automatically* brings the forward up with the terminal.

![Forward wizard: pick the type](screenshots/21-forwarding-wizard-type.png)

![Forward wizard: ports and host](screenshots/22-forwarding-wizard-port.png)

The page lists every forward with its host and state.

![Forwards](screenshots/24-port-forwards-page.png)

## 11. Import and export

**Import / Export** in the navigation.

- **Import `~/.ssh/config`**: follows `Include`; the file name inside `config.d/` becomes the group; `ProxyJump` becomes a jump host; forwards and `IdentityFile` keys come along (vault must be unlocked). Choose what to do when a name already exists: skip, overwrite or create a copy.
- **Export ssh config**: one file per group; private keys only if you tick the checkbox (a warning is shown, files get mode `0600`).
- **Export host list (JSON)**: no secrets, safe to share.
- **Encrypted backup**: everything, protected by a *separate* password (8+ characters).

![Import and export](screenshots/25-import-export.png)

![Import report](screenshots/26-import-report.png)

Anything unsupported (for example `ProxyCommand`) is listed as a warning instead of being dropped silently.

## 12. Settings

Open **Settings** from the navigation, the gear in the title bar, or **⌘/Ctrl + ,** (it works from a terminal tab too). It opens as **a window of its own** (with the usual red, yellow and green buttons): move it anywhere, resize it, or use the green button for macOS full screen. Opening it again brings the existing window to the front, and it closes when you quit VVTerm. (Screenshots below show the same content in the in-app variant that the test run uses.)

![Settings window](screenshots/45-settings-general.png)

The menu on the left has **General, Account, Terminal, Security, AI assistant, Sync, Shortcuts, Storage**, then **Theme**, help links (documentation, feature requests, bug reports, release notes, Ko-fi) and the **version**. Changes apply immediately.

**Updates.** **Check for updates** (under the help links) asks GitHub for the latest release and compares it with your version. If there is a newer one, **Version X is available** appears: click it to open the release page and download the build for your system (macOS `.dmg` or `.zip`, Windows `.exe`, Linux `.tar.gz`). To update, quit VVTerm and replace the old app with the new one; your data is kept outside the app, so nothing is lost. The check only runs when you click it, and only the release information is read: nothing about you is sent. A pre-release is not offered as an update.

When VVTerm opens it also looks by itself, at most once a day (switch it off with **Check for updates automatically** in General). If a newer release exists, an **Update** chip appears in the top right corner; click it to see the news.

![The Update chip in the top right corner](updates/update-chip.png)

![About VVTerm with a newer version available](updates/about-update-available.png)

![The switch in Settings → General](updates/settings-auto-update.png)

**Help → About VVTerm** and **Help → Check for Updates…** open the same window, also while the vault is locked.

- **General:** **Zoom** makes the whole interface larger or smaller (80 % to 160 %, also with the zoom shortcuts), **Reduce motion** turns animations off, and **Confirm before closing a tab** asks before ending a terminal or SFTP connection.
- **Account:** a local profile (display name and email, stored only in your settings file), your plan, and a disabled **Sign in** for the cloud features planned for later. Nothing is sent anywhere. The **Donate** card lists USDT addresses (Tron and BSC), each with a **Copy** button, if you want to support the project.

![The Donate card](updates/settings-donate.png)

![Account](screenshots/46-settings-account.png)

![Maximised settings](screenshots/47-settings-maximized.png)

- **Shortcuts:** every action has a default, shown as key caps (⇧ ⌘ T). Click it, press the new combination and it is saved. To make a **two-step shortcut** such as ⌘K then M, press the first combination and, within about a second, the second key (it needs no modifier); wait instead and it stays a one-step shortcut. While a two-step shortcut is running, a small note at the bottom says it is waiting for the next key; Esc cancels it. Two-step shortcuts have no key hint in the menu bar. One shortcut cannot be both a one-step shortcut and the first step of another. A combination already in use is refused and tells you which action owns it; plain keys are refused (add Ctrl, Alt or ⌘; F-keys are allowed). *Reset* returns one action to its default, *Reset all* all of them. Esc and a few terminal keys are fixed and listed below the table.
- **Storage:** **Clear cache** removes files VVTerm can make again and what it remembers about your AI tools (they are looked up again; it reports what it removed). **Reset settings** puts appearance, terminal, general options, shortcuts and auto-lock back to their defaults after you confirm. Your profile, sync target, hosts, keys and the vault are never touched.

![Shortcuts](screenshots/51-settings-shortcuts.png)

- **Terminal theme:** 26 colour themes with live swatches (Dracula, Nord, Tokyo Night, Solarized, Gruvbox, Kanagawa, Rosé Pine…), filterable by dark/light, or *Match app theme*. A preview shows your font, size, cursor and colours.
- **Font, size, cursor** (block, bar, underline), blinking, **scrollback**.

![Terminal themes](screenshots/48-settings-terminal-theme.png)

- **Theme (sidebar):** *Auto* follows your Mac's light/dark mode, or force *Light* or *Dark*.

![Theme dropdown](screenshots/52-theme-dropdown.png)

![Light theme](screenshots/53-light-theme.png)

- **Security:** auto-lock after N idle minutes (default 15; the key is wiped from memory), a password hint (a reminder shown on the lock screen, never the password itself), unlock with **Touch ID** on a Mac that has it (the vault key stays in your Keychain and each unlock asks for your fingerprint, Apple Watch or Mac password) or with **Windows Hello** on Windows (fingerprint, face or PIN; the key stays in Windows Credential Manager), or with the plain system keychain where neither exists, change the master password.

![Security](screenshots/49-settings-security.png)

## 13. Sync between Macs

Open **Settings → Sync**.

1. Create an empty **private** Git repository and make sure `git` can push to it (ssh-agent or a credential helper).
2. **Repository URL → Save repository → Sync now.**
3. On a new Mac open **Settings → Sync**, enter the URL, and choose **Restore from repository** with the master password of the synced vault (only before a local vault exists).

**No Git? Use a cloud folder instead.** Choose **Cloud folder**, then **Browse…** and pick a folder that Google Drive for Desktop, iCloud Drive, Dropbox or OneDrive keeps in step (for example `~/Google Drive/VVTerm`), then **Use this folder → Sync now**. There is no sign-in and no token: VVTerm only writes `bundle.enc` and `vault-header.json` into that folder and the cloud client uploads them. On a new Mac, pick the same folder, wait until the files have downloaded, and choose **Restore from folder**. If two Macs save at the same moment, the cloud client may keep an extra copy such as `bundle (1).enc`; the next sync merges every copy per record and deletes the extra ones. A copy that is still downloading or belongs to another vault is left alone.

The repository (or folder) only holds `bundle.enc` and `vault-header.json`, both encrypted: hostnames and IPs are not visible. Conflicts are merged per record (newest edit wins; a newer edit beats an older delete and the reverse).

![Sync](screenshots/50-sync.png)

## 14. Forgot your master password

**It cannot be recovered.** The password never leaves your Mac, so nobody can reset it for you. On the unlock screen choose **Forgot password?**:

![Forgot password](screenshots/58-forgot-password.png)

You can **reset the vault**. Type `RESET` to confirm. This permanently erases every saved key and password, and **keeps** your hosts, groups, snippets and port forwards. Hosts that used a saved credential need new ones. Then create a new master password:

![Vault reset](screenshots/59-vault-reset.png)

If you have an **encrypted backup**, restore it from **Import / Export** after unlocking the new vault to bring your keys back. If you synced with Git, the repository still holds the *old* vault: use a new repository for the new vault.

## 15. When something goes wrong

| Symptom | What it means / what to do |
| --- | --- |
| Red banner *connection lost… Press Enter to reconnect* | The link dropped. VVTerm never reconnects by itself so commands are not replayed by surprise: press Enter in the pane. |
| *HOST KEY CHANGED* | The server shows a different key than the one you trusted. The connection is blocked with no override. Check with the server's owner; if the change is legitimate, remove the old line from `known_hosts` by hand. |
| *vault is locked* | Unlock the vault and retry. |
| *identity is used by host …* | Detach the identity from its hosts before deleting it. |
| Snippet: *Open a terminal first* / *not connected yet* | Open a host, wait for the prompt, then run the snippet. |
| *Test connection* fails with *Authentication failed* | Wrong password, key not accepted, or the user does not exist on the server. |
| Sync error *encrypted with a different vault key* | The repository belongs to another vault. Use a new repository, or restore from it on a fresh install. |
| Old icon in the Dock | macOS caches icons. Restart the Dock (`killall Dock`) or move the app to refresh it. |

![Connection lost](screenshots/54-connection-lost.png)

![Host key changed](screenshots/55-host-key-changed.png)

In a narrow window the layout adapts: the navigation becomes icons and the New host panel floats over the list instead of squeezing it.

![Narrow window](screenshots/60-narrow-window.png)

## 16. Where your data lives

| Item | macOS path (`~/Library/Application Support/vvterm/`) |
| --- | --- |
| Hosts, groups, identities (metadata), forwards, snippets, encrypted vault | `data/vvterm.db` (SQLite) |
| Trusted host keys | `data/known_hosts` |
| Appearance, terminal theme, auto-lock, sync URL | `data/settings.json` |
| Git working copy (ciphertext only) | `sync/` |

Set `VVTERM_DATA_DIR` to relocate everything. Back up with **Import / Export → Encrypted backup**; losing the master password without a backup means losing the vault.

## 17. Connecting: protocol, progress and errors

Opening a host first asks **which protocol** to use (SSH, Mosh, Telnet), like Termius. SSH is chosen for you: press **Continue** (or double-click it). Mosh is shown but not supported yet; Telnet can be picked once the host has Telnet turned on (see [section 20](#20-this-computer-telnet-and-serial-ports)). Turn the question off in **Settings → Terminal → Ask which protocol to use**; a host that has Telnet still asks.

![Choose protocol](screenshots/12-choose-protocol.png)

Then the **connecting screen** shows who you are connecting to and a line from the plug to the terminal. The line moves **smoothly**: slowly while the server answers, further once the login is done, and to the end when the shell is open, and only then does the terminal show. If it fails, the line stops where it got to and turns red, with the reason and **Retry**, **Show logs** (opens the Logs page) and **Close**.

The state of every tab is a small badge on its icon: a spinner while connecting, a **green** dot while connected, a **red** dot when the connection is lost (press Enter in the pane, or Retry, to reconnect: VVTerm never reconnects by itself).

## 18. Tabs: order, split, new window

- **The + button** opens a **New Tab**: a search box for hosts and open tabs (⌘/Ctrl + K), **Local Terminal** on its own, and your **Recent connections**. Pick one and the tab becomes that connection.
- **Drag a tab left or right** to put your tabs in order. SFTP always stays first.
- **Drag a tab onto a pane** to split it: the side nearest to the pointer lights up (left / right: side by side, top / bottom: one above the other). The dragged tab joins as a split and its sessions **keep running**, nothing reconnects.
- **Take a pane back out**: hover over a pane of a split and press **Move pane to its own tab**.
- **Right-click a tab**: Duplicate, **Duplicate in new window**, Rename, Split right, Split down, Close. Double-click a tab to rename it.
- **Many tabs** shrink like in a browser; the active tab always shows its whole name, and a hovered one shows its close button.
- **Duplicate in new window** opens the whole app in a second window (Vaults, SFTP, tabs, sidebar) with that host open in its first tab. Both windows share the same data and the same unlocked vault, and the sessions opened in the new window end when you close it. It runs as a second process, so it has its own Dock icon.

![New Tab](screenshots/40-new-tab.png)

## 19. The terminal sidebar

The panel on the right of every terminal (the last button of the title bar shows or hides it):

| Tab | What it does |
| --- | --- |
| Hosts | Search your hosts and open one in a new tab. |
| Snippets | One line each; click one to see the whole script with **Run** and **Paste**. |
| History | The commands you typed, newest first, searchable. Click to type one again, double-click to run it. Only lines the terminal echoed are kept, so what you type at a password prompt never is. |
| Themes and font | Pick the terminal theme from pictures, change the font and the text size. |

![History](screenshots/37-sidebar-history.png)
![Themes and font](screenshots/38-sidebar-themes.png)

## 20. This computer, Telnet and serial ports

- **Terminal** (button beside New host, or ⌘/Ctrl + Shift + T) opens a real shell on this computer. **Serial** opens a serial port at a baud rate.
- **Telnet**: in the host form press **Add Telnet** for its port, its own user name and password (kept in the vault) and the encoding (UTF-8 or ISO-8859-1). Telnet is **not encrypted**: use it only on networks you trust, for devices that offer nothing else.
- **Terminal theme per host**: a card with a picture of the theme; pick *Use the app setting* to follow Settings.
- **Highlighting**: errors, IP addresses, paths and URLs are coloured (switch in Settings → Terminal). **Copy on select**, right-click to paste (or a menu, or nothing) and the copy / paste keys are configurable.

![Telnet in the host form](screenshots/43-new-host-telnet.png)
![Local terminal](screenshots/36-local-terminal.png)

## 21. Known Hosts and Logs

- **Known Hosts** lists every server key you trusted (type and fingerprint) and lets you **forget** one so the next connection asks again. Keys stored hashed in an existing `known_hosts` cannot be forgotten from here.
- **Logs** is a filterable, searchable list of what happened, newest first: connections, transfers, forwards, host-key decisions, unlocks, sync. It never contains a password or key.

![Logs](screenshots/57-logs.png)

## 22. AI assistant

Ask an AI about what is on a terminal. VVTerm uses the AI command-line tool you already have and are signed in to (Claude Code, Codex CLI, Gemini CLI, or a command you add), so your own subscription is used and no key is stored.

![Settings → AI assistant: providers, models and privacy](assistant/assistant-settings.png)

1. **Settings → AI assistant** lists the tools VVTerm found. Switch one on. It stays off until you do, and it must pass a short isolation test (the tool is asked to run a command and must be unable to). If a tool says *Needs sign-in*, run the command shown next to it in a terminal first.
2. Pick the model for each tool. The list is read from the tool itself; you choose from that list. A tool that cannot list its models uses its default one.
3. Open a terminal, then the sparkle icon in the sidebar. Choose the provider and model from the chip under the message box, type a question, press Enter. **Ask about selection** sends only the text you selected. To change the model without the mouse, press **⌘ ⇧ M** (Ctrl Shift M elsewhere): it moves to the next model of the provider, wrapping round at the end, and shows the name in a short message.
4. The assistant only *suggests* commands. **Insert** puts one on the prompt without pressing Enter. **Run** sends a command that only reads at once; a command that can change something shows **Run…** and asks in its card first (and the word `run` for a risky one). A command that contains a hidden value cannot be run from the panel.

![The assistant answers about the terminal: a command that only reads ran by itself, a risky one asks first](assistant/assistant-chat.png)

![The provider and model menu](assistant/assistant-model-menu.png)

**Files and screenshots.** Drag a log, a config file or a screenshot onto the panel, paste a screenshot, or use the paperclip. Text files are redacted like the screen. A picture cannot be redacted, so VVTerm asks you to confirm each time and only sends pictures to tools that take them (Claude Code, Codex CLI).

![A log and a screenshot added to a question; the picture is confirmed in the chat](assistant/assistant-attach.png)

**Your secrets.** Before anything is sent, keys, tokens, passwords and anything saved in your vault are replaced by `*******`; the same happens to every answer before you see it. **What will be sent** shows the exact text first. This cannot be switched off, and it is best-effort: a password written in an ordinary sentence cannot always be recognised.

**Per host.** On a host's form, *AI assistant* is Off, Ask first (in the chat), or On. The default is On, and Off on a production host, where the assistant also never runs commands. Reading the screen to answer a question needs no confirmation; the assistant asks you, in the chat, only before something that could change things.

**MCP servers** (Settings → AI assistant) give the assistant extra tools. Add a server (a command or an HTTP address), test it, then choose a mode for each tool: Allow, Ask each time or Off. New tools stay off until you review them, a secret in a tool's arguments blocks the call, and results are redacted. Environment values and headers are kept in the vault and are never shown again.

![An MCP server: its tools and the mode of each](assistant/assistant-mcp.png)

**Reading needs no confirmation.** The assistant runs commands that only look (`ls`, `df`, `which`, `pgrep`, `brew list`, `systemctl status`, `git status`… also joined with `;`, `&&`, `||` or a pipe) by itself and reads the output; anything that could change something asks first, in the chat. This is **Settings → AI assistant → Run read-only commands by itself** (on by default; never on production hosts).

## 23. Shortcuts at a glance

All of them can be changed in **Settings → Shortcuts**. ⌘ on a Mac is Ctrl elsewhere.

| Keys | Action |
| --- | --- |
| ⌘ N | New host |
| ⌘ T | New tab (search hosts or tabs) |
| ⌘ Shift T | Terminal on this computer |
| ⌘ ⇧ H | Back to Vaults (the home screen), on the page you left |
| ⌘ ⇧ S | Open SFTP |
| ⌘ 1 … 6 | Hosts, Keychain, Port Forwarding, Snippets, Known Hosts, Logs (shown at the right of the navigation item when you point at it) |
| ⌘ , | Settings |
| ⌘ L | Lock the vault |
| ⌘ W / ⌘ Shift W | Close the tab / the pane |
| ⌘ D / ⌘ Shift D | Split right / down |
| ⌘ B | Broadcast input to every pane of the tab |
| ⌘ F | Search the terminal's scrollback |
| ⌘ ⇧ M | Switch the AI assistant to its next model |

The SFTP file lists have a **right-click menu**: Open, Open with…, Copy to target directory, Rename, Delete, Refresh, New Folder and **Edit Permissions** (a grid of read / write / execute, or the octal number).

![SFTP right-click menu](screenshots/34-sftp-context-menu.png)
