<p align="center"><img src="docs/brand/logo-horizontal-light.png" alt="VVTerm" width="520"></p>

<p align="center">
  <a href="https://ko-fi.com/vunguyenvu"><img src="https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white&style=for-the-badge" alt="Support VVTerm on Ko-fi"></a>
  <a href="#support-vvterm"><img src="https://img.shields.io/badge/Donate-USDT-26A17B?logo=tether&logoColor=white&style=for-the-badge" alt="Donate USDT to VVTerm"></a>
</p>

<p align="center">
  <b>An SSH client for people who want to own their data.</b><br>
  Hosts, keys and passwords live in an encrypted vault on your Mac, export to standard formats at any time, and sync through a private Git repository you control.
</p>

<p align="center"><img src="docs/screenshots/20-split-panes.png" alt="VVTerm with two terminals side by side" width="900"></p>

## What you can do

- **Add hosts the easy way.** A docked form (no popups) with **Test connection**, so you know the address, credentials and jump host work before you save, and **Connect** that saves and opens the terminal in one step.
- **Organise hosts** in groups, with tags and a colour per environment (prod / staging / dev). Find anything from one search box, or type `ssh user@host` to connect right away.
- **Keep secrets safe.** Private keys and passwords are encrypted with your master password. The interface never sees them.
- **Work in tabs and split panes**, through one or more jump hosts, with keep-alive and one-key reconnect. Drag tabs to order them, drag a tab onto a pane to split it (sessions keep running), open a host in a **new window**, and see at a glance which tabs are connected.
- **A sidebar beside every terminal**: hosts, snippets (run or paste), command history, and terminal themes and font.
- **More than SSH**: a shell on this computer, serial ports and Telnet (with its own login), a Termius-style *Choose protocol* and connecting screen, Known Hosts and Logs pages.
- **Browse and transfer files with SFTP** in a tab of its own (and in the terminal sidebar): two panes, several files and folders at once, drag and drop, and a **transfer queue** with pause, resume (a copy is continued from the bytes already sent, also after a lost connection), cancel and retry. Compare and **sync folders** (nothing is ever deleted), **edit a remote file** and have it saved back when you save, and a right-click menu with permissions. Nothing is replaced without asking.
- **Ask an AI about your terminal** with the tool you already use (Claude Code, Codex CLI, Gemini CLI): the screen is sent with every secret replaced by `*******`, the assistant only suggests commands, and you decide what runs. Add MCP servers for extra tools. See the [user guide](docs/UserGuide.md#22-ai-assistant) and the [design](docs/AIAssistant.md).
- **Save snippets** of commands you run often and type them into any terminal with a click.
- **Make it yours**: 26 terminal colour themes, light / dark / auto appearance, font, cursor and scrollback, interface zoom, your own keyboard shortcuts, all in a Settings window of its own.
- **Forward ports**: local, remote and SOCKS5 proxy.
- **Stay in control.** Import and export your `~/.ssh/config`, share a host list without secrets, make encrypted backups, or sync between your Macs through a private Git repository.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/16-hosts-in-group.png" alt="Hosts"><br><sub>Hosts and groups</sub></td>
    <td width="50%"><img src="docs/screenshots/18-snippets-page.png" alt="Snippets"><br><sub>Snippets</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/11-test-connection-ok.png" alt="New host with a successful connection test"><br><sub>New host: Test connection, Save or Connect</sub></td>
    <td><img src="docs/screenshots/48-settings-terminal-theme.png" alt="Settings window with terminal themes"><br><sub>Settings window and terminal themes</sub></td>
  </tr>
</table>

## Try it

**Requirements:** macOS, Windows (64-bit) or Linux (64-bit). VVTerm is currently a beta; macOS is the most tested, Windows and Linux builds are new.

### 1. Install

- **From a release (recommended):** download the file for your system from the [Releases](../../releases) page:

  | System | File | How to install |
  | --- | --- | --- |
  | macOS | `vvterm-<version>-macos.dmg` (or `.zip`) | open the DMG and drag **vvterm.app** to *Applications* |
  | Windows | `vvterm-<version>-windows-amd64.exe` | run it, no installer needed |
  | Linux | `vvterm-<version>-linux-amd64.tar.gz` | `tar xzf` it and run `./vvterm` (needs GTK 3 and WebKitGTK 4.0, for example `libgtk-3-0` and `libwebkit2gtk-4.0-37` on Ubuntu 22.04) |

  Each release also lists `SHA256SUMS` so you can check your download.
- **From source:** see the [Development guide](docs/Development.md) (three commands).

> **First launch.** Beta builds are not signed with a developer certificate yet. On macOS, right-click **vvterm.app → Open → Open** once (or run `xattr -dr com.apple.quarantine /Applications/vvterm.app`). On Windows, SmartScreen may warn: choose **More info → Run anyway**.

**Updates:** **Settings → Check for updates** tells you when a newer release is out and opens its page; replace the old app with the new one and your data is kept.

### 2. First five minutes

1. **Create your vault.** Choose a master password (12+ characters). It cannot be recovered, so keep it safe.
2. **Add a credential** in **Keychain**: generate a new key (copy the public key to your server's `~/.ssh/authorized_keys`), import an existing key, or save a password.
3. **Add a host** with **New host**: address, username and a password (or the key you just made). Press **Test connection** to check it, then **Connect** to save and open it. Optionally pick a group, an environment colour or a jump host.
4. **Connect**: double-click a saved host any time. The first time, check the server fingerprint and choose *Trust and connect*.
5. **Make it yours**: save a **Snippet**, split the pane, open **Port Forwarding**, import your existing `~/.ssh/config` from **Import / Export**, or open **Settings** (⌘/Ctrl + ,) to pick a terminal theme.

The [User guide](docs/UserGuide.md) walks through every screen with screenshots.

### No server to test with?

Start two throw-away demo SSH servers on your Mac (needs Docker):

```bash
docker compose --profile dev up -d
```

Add hosts `127.0.0.1` port `2201` (bastion) and `2202`, username `demo`, password `demo-password`. They echo whatever you type, which is enough to try tabs, jump hosts, snippets and forwards. Stop them with `docker compose --profile dev down`.

## Your data and your security

| | |
| --- | --- |
| **Where it lives** | `~/Library/Application Support/vvterm/` (one SQLite database plus a `known_hosts` file) |
| **What is encrypted** | Keys and passwords: AES-256-GCM, with a key derived from your master password (Argon2id) |
| **What leaves your Mac** | Nothing, unless you turn on Git sync, which only uploads encrypted data to *your* repository |
| **Unknown servers** | You confirm the fingerprint once. If a known server's key ever changes, the connection is **blocked with no override** |
| **Forwards** | Listen on `127.0.0.1` only, unless you explicitly allow more |
| **Auto-lock** | The vault locks after 15 idle minutes (configurable) |

Back up regularly with **Import / Export → Encrypted backup**.

**Forgot your master password?** It cannot be recovered. On the unlock screen choose *Forgot password?* to reset the vault: saved keys and passwords are erased, while hosts, groups, snippets and port forwards are kept. If you have an encrypted backup, restore it afterwards.

## Known limitations of this beta

- Windows and Linux builds are new and less tested than macOS. On Windows the **terminal on this computer** is not available yet (SSH, SFTP and the rest work). Touch ID and the macOS-specific window features exist only on a Mac.
- "Keychain unlock" stores the vault key in the macOS Keychain; it does **not** require Touch ID yet.
- The vault does not lock when the Mac sleeps (only on idle).
- Settings opens as a second window of the app (a second process): it shows a second Dock icon while open and needs the main app running.
- SFTP does not keep the modification time of copied files, and a transfer you abandon leaves a hidden `.vvterm-part-…` file next to its target.
- Git sync was tested with local repositories, not yet with every hosting provider.
- `ProxyCommand` and `Match` blocks in `~/.ssh/config` are reported as warnings on import and skipped.

The full list is in the [release notes](RELEASE_NOTES.md).

## Feedback and bug reports

Your feedback is the point of this beta. Please [open an issue](../../issues/new) and include:

- what you did, what you expected and what happened (a screenshot helps);
- your VVTerm version and macOS version;
- **never** paste passwords, private keys or your vault file.

## Support VVTerm

<p align="center">
  VVTerm is free and open source, built and maintained in spare time.<br>
  If it saves you time, you can help keep it going.
</p>

<table align="center">
  <tr>
    <td align="center" width="200"><h2>☕</h2><b>$3</b><br><sub>a cup of coffee</sub></td>
    <td align="center" width="200"><h2>🍜</h2><b>$10</b><br><sub>a lunch</sub></td>
    <td align="center" width="200"><h2>🚀</h2><b>$25</b><br><sub>fuel new features</sub></td>
  </tr>
</table>

<p align="center">
  <a href="https://ko-fi.com/vunguyenvu"><img src="https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white&style=for-the-badge" alt="Support VVTerm on Ko-fi"></a>
</p>

<p align="center"><b>Prefer crypto?</b> Scan a code or copy an address, and check the network before you send.</p>

<table align="center">
  <tr>
    <td align="center" width="300">
      <img src="https://img.shields.io/badge/USDT-Tron%20%C2%B7%20TRC20-EF0027?logo=tron&logoColor=white&style=flat-square" alt="USDT on Tron (TRC20)"><br><br>
      <img src="docs/donate/usdt-tron.png" width="190" alt="QR code of the USDT Tron address"><br>
      <sub><code>TMXXHRNG7qauoFWJKYbqEbd4FGgt3DgjBK</code></sub>
    </td>
    <td align="center" width="300">
      <img src="https://img.shields.io/badge/USDT-BSC%20%C2%B7%20BEP20-F0B90B?logo=binance&logoColor=black&style=flat-square" alt="USDT on BSC (BEP20)"><br><br>
      <img src="docs/donate/usdt-bsc.png" width="190" alt="QR code of the USDT BSC address"><br>
      <sub><code>0x4bdfd1d6456c28d06e3f8456ddac59e6168e5153</code></sub>
    </td>
  </tr>
</table>

<details>
<summary>Copy an address</summary>

```
TMXXHRNG7qauoFWJKYbqEbd4FGgt3DgjBK
```

```
0x4bdfd1d6456c28d06e3f8456ddac59e6168e5153
```

</details>

<p align="center"><sub>Stars, bug reports and pull requests help just as much. Thank you!</sub></p>

## Documentation

| | |
| --- | --- |
| [User guide](docs/UserGuide.md) | every feature, with screenshots |
| [Release notes](RELEASE_NOTES.md) | what is new, quality results, known issues |
| [Development guide](docs/Development.md) | build, test, Docker, deploy |
| [Architecture](docs/CleanArchitecture.md) | layers, decisions, technical debt |
| [Assessment](docs/Assessment.md) | honest comparison with the original design |

## License

See [LICENSE](LICENSE).
