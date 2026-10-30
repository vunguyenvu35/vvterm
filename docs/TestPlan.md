<p align="center"><img src="brand/logo-mark-256.png" alt="VVTerm" width="88"></p>

# Test plan

The authoritative, always-current list of automated test cases is [TestInventory.md](TestInventory.md) (generated). This plan explains how features map to test levels and what is not covered.

## Levels

| Level | Tooling | Scope | Run with |
| --- | --- | --- | --- |
| Architecture | Go (`internal/archtest`) | dependency rule between layers | `go test ./internal/archtest` |
| Unit | Go `testing` | domain rules, store, vault crypto, parsers, merge, SOCKS5 | `make test-go` |
| Integration (backend) | Go + in-process SSH server (`internal/testssh`) + real `git` + real SQLite | sessions, jump hosts, host keys, forwards, sync between two "machines", backup restore | `make test-go` |
| Component | Vitest + Testing Library + fake backend | every screen and panel, error states | `make test-web` |
| End-to-end | Playwright → `wails dev -browser` (real Go backend) + two demo SSH servers | full user journey, 19 screenshots | `make e2e` |

## Feature to test mapping

| Feature (architecture §) | Main test cases |
| --- | --- |
| Vault: create, unlock, lock, change password (§5) | `vault_test.go`: weak password, wrong password, change password keeps secrets, tampered/swapped ciphertext (AAD), hostile KDF parameters; `UnlockScreen.test.tsx`; E2E *Create the vault*, *Lock and unlock* |
| Vault: keychain quick unlock, auto-lock (§5) | `TestKeychainQuickUnlock`, `TestKeychainWithForeignDEKIsRejectedAndPurged`, `TestAutoLockFiresCallback`, `TestActivityPostponesAutoLock`, `App › returns to the unlock screen when the vault auto-locks` |
| No secret reaches the UI (§5) | `TestIdentitiesNeverExposeSecrets`, `TestCiphertextHasNoPlaintext`, `TestDatabaseFileHoldsNoPlaintextSecrets`, `TestExportPlainJSONHasNoSecrets`, E2E asserts no `PRIVATE KEY` in the DOM |
| Hosts, groups, tags, env, search (§4) | `store_test.go` (CRUD, tombstones, filters, cycles, jump loops/depth), `domain/rules_test.go`, `HostList.test.tsx`, `HostForm.test.tsx` |
| SQLite persistence (ADR-0001) | `sqlitedb_test.go`: round trip, atomic save on failure, schema version, shared file for store and vault, 0600 permissions |
| SSH sessions, PTY, resize (§6) | `sshx_test.go`, `session_test.go` (lifecycle, batching, attach replay) |
| Host key verification (§5) | `TestUnknownHostPromptsOnceThenTrusted`, `TestRejectedHostKeyBlocksAndStoresNothing`, `TestChangedHostKeyIsBlockedWithoutPrompt`, `TestHostKeyConfirmationRules`, E2E *Host key changed* |
| Jump hosts (§6) | `TestJumpHostChain`, `TestThreeHopChainAndDepthLimit`, `TestFailedSecondHopClosesFirst`, `TestSessionViaJumpHost`, E2E *Connect through the jump host* |
| Keepalive, reconnect (§6) | `TestKeepaliveDetectsDeadConnection`, `TestConnectionLossAndManualReconnect`, `TestAutoStartForwardIsRebuiltAfterReconnect`, `TerminalPane › shows the connection-lost banner and reconnects only on Enter` |
| Port forwarding L/R/D (§6) | `forward_test.go` (local, remote, SOCKS5 incl. failure codes, loopback-only, stop semantics), `TestForwardOnDedicatedConnection`, `TestForwardAutoStartRidesSessionAndDiesWithIt`, E2E real TCP through the tunnel |
| Import/export ssh config (§7) | `importer_test.go`, `exporter_test.go` (round trip, Include/groups, ProxyJump chains, key export opt-in and 0600, injection), `TestImportSSHConfigWithKeysAndConflicts` |
| Encrypted backup (§7) | `TestBackupRoundTrip`, `TestBackupExportImportIntoFreshInstall` |
| Git sync and merge (§7) | `syncgit_test.go`: LWW/tombstone rules, two machines converge, push race retried, foreign vault and tampered bundle rejected, no empty commits; `TestSyncTwoMachinesEndToEnd` |
| Add a host: Test connection, Save, Connect (§6) | `test_connection_test.go` (password, saved identity, jump host, known host skips the prompt, wrong password never leaked, unreachable, rejected key leaves `known_hosts` empty, validation, locked vault, nothing stored), `HostForm.test.tsx` (flow order, docked, password becomes an identity, Connect saves first, inline trust prompt), E2E *Create a group, then a host with Test connection* and *Connect saves and opens the terminal* |
| Docked panels close on page change | `App › panels belong to the page they were opened on`, E2E *A side panel closes when you move to another screen* |
| Custom dropdown | `Select.test.tsx` (ARIA, keyboard, type-ahead, outside click, Esc does not close a parent, hidden native select kept in sync), E2E *custom-select* |
| Settings as a native window (ADR-0006) | `bridge_test.go` (token, 0600 file removed on close, allow-list, argument checks, errors pass through, change notifications, focus request, launcher opens once and raises afterwards, fallback without native windows), `SettingsApp.test.tsx` (native layout, Esc, theme/zoom/motion, re-read on focus), `backend.test.ts` (bridge calls), `App.test.tsx › Settings as a native window`; smoke run of both processes (connection file, window process stays up, exits when the main app quits) |
| Settings window, themes (§11) | `SettingsWindow.test.tsx` (layout, drag, Esc order, theme dropdown, 26-theme picker, preview, font/cursor/scrollback persistence, security, sync, links), `themes.test.ts` (valid palettes, contrast, ids accepted by the backend), `appearance.test.tsx` (Auto follows the OS), `services_test.go` (settings validation, old `settings.json`), E2E *Settings opens as its own window* |
| Settings: General, Account, window controls (§11) | `SettingsWindow.test.tsx` (zoom stepper and limits, reduce motion, confirm close, profile save/validation, disabled sign-in, maximise/restore/roll-up, drag disabled while maximised), `TestSettings*` in `services_test.go` (zoom range, account fields, shortcut overrides) |
| Keyboard shortcuts (§11) | `shortcuts.test.ts` (key mapping, Mod vs Ctrl, matching, validation, conflicts, formatting), `SettingsWindow.test.tsx › Shortcuts` (record, conflict, plain key, Esc, reset), `App.test.tsx › keyboard shortcuts` (custom combo works, old one does not, lock, zoom, tab cycling, close with confirm, quiet while recording), `shortcuts_test.go`, E2E *Shortcuts* |
| SFTP | `SftpBrowser.test.tsx` (browse, mkdir, rename, delete with confirm, upload/download, replace confirmations, prompt fallback, host key prompt, reconnect, connection lost, helpers), `App.test.tsx › SFTP tabs`, `HostList.test.tsx`, `layout.test.ts`, `sftp_service_test.go`, `sftpx_test.go` (real SFTP protocol against the in-process server), E2E *SFTP* (files verified on disk) |
| Lost master password | `TestResetVault*` (keeps hosts/snippets/forwards/agent identity, erases the rest, works while locked, no ciphertext left, new vault works, old password rejected), `vault_test` (`Destroy`), `UnlockScreen.test.tsx` (forgot flow), E2E *Forgot the master password* |
| Clean architecture (ADR-0002) | `internal/archtest` |
| Regressions found during development | `TestReportsNeverMarshalNullSlices` and the Vitest null-array cases (E2E found a white-screen crash), `TestAttachReplays*` (lost first output), `TestSSHConfigSkipsHostWithInjectedHostname` |

## Manual checklist before a release

- [ ] Settings opens as its own macOS window (⌘ + ,), the green button gives full screen, a second ⌘ + , raises it, changes (zoom, theme, shortcut) show up in the main window at once, and quitting VVTerm closes it.

Not covered by automation; run on a real Mac build (`make build`, open `build/bin/vvterm.app`):

1. Native file dialogs work for: Import config, Export folder, Save backup, Choose key.
2. Keychain unlock: enable, quit, relaunch, unlock with the keychain; confirm the macOS prompt behaviour.
3. Heavy output: `yes | head -c 200M`, `tail -f` on a busy log; UI stays responsive (architecture §2 risk: WKWebView performance).
4. Real server: password login, key login, an ssh-agent identity, and a bastion in front of a private host.
5. Sync against a real private remote (GitHub/GitLab) using ssh-agent and using a credential helper.
6. Sleep/wake the Mac with the vault unlocked (see the sleep-lock gap in [Assessment](Assessment.md)).
7. Window resize and split panes with a full-screen program (`vim`, `htop`).
8. **Duplicate in new window** on a real build: the new window shows the whole app with the host open, shares the unlocked vault, its sessions end when it is closed, and quitting VVTerm closes it.
9. **Settings window**: Esc closes it, its title is centred, the menu bar stays File / Edit / View / Window / Help, and no second icon appears in the Dock.
10. **Drag a tab onto a pane** while a command runs in both: neither session reconnects or loses output. Then *Move pane to its own tab*. Also drag a pane by its header: onto a side of another pane, up onto the tab bar (a tab of its own) and onto another tab; the same checks apply (no reconnect, no lost output).
11. **Connecting screen** against a slow or unreachable host: the line moves slowly, stops and turns red on failure; Retry works; a wrong password shows the reason.
12. Type Vietnamese with the system's Telex input and with a global input tool (GoTiengViet / OpenKey) in a terminal, and check the log has no *getApplicationProperty* line from VVTerm.
13. **Dock and app switcher icon**, the Caps Lock hint in the unlock field, and right-click anywhere (no *Look Up* / *Inspect Element* menu).

14. **Secure input** (macOS): while a password field has the keyboard, OpenKey / GoTiengViet are off (that is macOS). Click an empty part of the unlock card, unlock, then run `ioreg -l -w 0 | grep kCGSSessionSecureInputPID`: it must print nothing. Do the same after closing a panel with a password field (Settings → Security, New key with a passphrase).

## Test data and environments

- SSH peer: `internal/testssh` (password + public-key auth, echo shell, `direct-tcpip`, `tcpip-forward`, keepalive), also exposed as `cmd/demoserver`.
- Git peer: a local bare repository created per test.
- Fast KDF parameters are used in tests only (`Memory: 64 KiB, Time: 1`); production uses 64 MiB / t=3 / p=4.
