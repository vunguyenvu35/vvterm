<p align="center"><img src="brand/logo-mark-256.png" alt="VVTerm" width="88"></p>

# Assessment of v1.0.0 against the design

An honest comparison of what was built with [Architecture.md](Architecture.md), including gaps and risks. "Verified" means covered by an automated test or the E2E walkthrough; "not verified" means built but not exercised in this environment.

## 1. Requirement coverage

| Requirement (Architecture.md) | Status | Evidence / note |
| --- | --- | --- |
| Hosts by group, tag, environment colour (§1, §4) | Done | store + domain tests, `HostList`/`HostForm` tests, E2E |
| Vault with master password, envelope encryption, Argon2id (m=64 MiB, t=3, p=4), AES-256-GCM, secret id as AAD (§5) | Done | `vault_test.go` (swap attack, tamper, wrong password, hostile KDF params) |
| Change master password re-wraps DEK only (§5) | Done | `TestChangePasswordKeepsSecrets` |
| Keychain quick unlock (§5) | Partial | Works through the OS keychain (`go-keyring`); **not biometric-gated** (see gap G1) |
| Auto-lock after N minutes (§5) | Done | timer tests, UI returns to unlock screen |
| Auto-lock when the machine sleeps (§5) | **Missing** | gap G2 |
| Strict `known_hosts`, TOFU prompt with SHA-256 fingerprint, no override on change (§5) | Done | `sshx` + session tests + E2E; `InsecureIgnoreHostKey` is never used |
| Frontend never receives secrets; strict CSP (§5) | Done | identity metadata only; CSP in `index.html`; tests grep for secret material |
| Multi-tab terminal, split panes (§1, §6) | Done | component tests, E2E |
| Jump host chains, depth limit (§6) | Done | store + sshx tests, E2E through a bastion |
| Output batched ~16 ms (§6, §8) | Done | `Batcher` tests, `TestOutputIsBatchedIntoFewEvents` |
| Keepalive, manual reconnect, auto_start forwards rebuilt (§6) | Done | keepalive + reconnect tests |
| Port forwarding L/R/D, loopback by default (§6) | Done | forward tests, real TCP check in E2E |
| Import `~/.ssh/config` incl. `Include`, group from file name, ProxyJump, forwards (§7) | Done | importer tests; custom parser (ADR-0003) |
| Export ssh config per group, keys opt-in with warning and 0600 (§7) | Done | exporter tests |
| Plain JSON export, encrypted JSON backup with its own password (§7) | Done | exporter + service tests |
| Git sync of `bundle.enc` + `vault-header.json`, per-record merge, retry on push race (§7) | Done (local remotes) | tests use real `git` against bare repos; **not verified against GitHub/GitLab** |
| Storage | **Changed** | SQLite instead of JSON files (ADR-0001, requested) |
| Snippets (§1 "out of scope") | **Added** | requested; sync, backup and export included |
| Settings: theme, terminal themes, font, cursor, scrollback | **Added** | Settings window, native since 1.1.0 (see G13) |
| Test connection and Connect-with-save in the host form | **Added** | `SessionService.TestConnection`: jump chain, inline host key trust, nothing stored |
| Lost master password | **Added** | reset vault (keeps hosts, erases secrets); cannot be recovered by design |
| Project structure and binding API (§8) | Done, adapted | services live in `internal/usecase`, Wails glue in `app/` (ADR-0002). Extra methods added: `Attach`, `Reconnect`, `EnableBiometric`, forward CRUD, settings |
| CLI `vvt` (§9 open question 1 mentions the name) | Not built | no CLI in scope of the listed requirements |
| `settings.json` keyboard shortcuts (§4) | **Done** | configurable in Settings → Shortcuts; overrides stored in `settings.json`, validated by `ValidateShortcuts`, conflicts refused |
| SFTP (not in the original scope) | **Added** | `SftpService` over a dedicated SSH connection (jump chain supported), `sftpx` adapter, atomic transfers, no silent overwrite; files only |
| Settings: General, Account, zoom, maximise (not in the original scope) | **Added** | interface zoom, reduce motion, confirm close, local profile; sign-in is a disabled placeholder |
| Decide Svelte vs React (§9) | Decided: React + TypeScript | |
| Platforms (§1) | macOS only built | Windows/Linux not built or tested, as the design allows |

## 2. Gaps and risks

| ID | Gap | Impact | Suggested next step |
| --- | --- | --- | --- |
| G1 | "Touch ID" is not enforced. `go-keyring` stores the key in the login keychain without an access-control flag that demands biometrics. | Anyone able to read the user's keychain can unlock the vault. The UI therefore says "keychain unlock". | Native `SecAccessControl` (`.biometryCurrentSet`) through a small cgo bridge. |
| G2 | No lock on system sleep. | Vault stays unlocked during sleep until the idle timer fires. | Subscribe to `NSWorkspaceWillSleepNotification` and call `Vault.Lock()`. |
| G3 | Not launched as a native window in this environment. | The Wails build succeeds (`vvterm.app`), but WKWebView rendering, native dialogs and keychain prompts were not exercised; E2E runs in Chromium against the real backend. | Run the manual checklist in [TestPlan.md](TestPlan.md). |
| G4 | xterm.js heavy-output performance on WKWebView not measured (design risk §2). | Possible lag on `tail -f` of busy logs. | Measure; consider the WebGL addon. |
| G5 | Sync merge window: edits made between the snapshot and the write-back of a sync run can be overwritten. | Rare data loss for concurrent edits during a sync (seconds). | Re-apply local changes after sync or lock writes during sync. |
| G6 | Last-write-wins relies on machine clocks (accepted in §7). | Wrong winner when clocks differ by more than the edit gap. | Version vectors (design already notes this). |
| G7 | Clean-architecture debt: the use cases still import `sshx`, `forward`, `importer`, `exporter`, `syncgit`, `vault` helpers directly. | Those cannot be swapped without touching use cases. | Introduce the ports listed in [CleanArchitecture.md](CleanArchitecture.md); the allow-list test prevents growth. |
| G8 | SQLite saves rewrite all rows in one transaction. | Fine for hundreds of hosts; wasteful for very large inventories. | Per-record upserts behind the same persister. |
| G9 | `ProxyCommand`, `Match`, token expansion in `ssh_config` are unsupported. | Such hosts import with a warning or incompletely. | Extend the parser. |
| G10 | Legacy keys (RSA/SHA-1, DSA) are limited by `x/crypto/ssh`; there is no dedicated "unsupported key" message. | Old servers may fail with a generic handshake error. | Detect and explain. |
| G11 | Passwords for `password` identities are stored in the vault and sent via both `password` and `keyboard-interactive`. | Servers that prompt for 2FA are not supported. | Add interactive prompts. |
| G12 | The domain package's own coverage is 43 % because the merge tests still live in `syncgit` (they pass through type aliases). | Reporting artefact, not a behaviour gap. | Move those tests into `domain`. |
| G13 | Settings is a second native window implemented as a second process (Wails v2 has one window per process), connected by a local token-protected bridge. | A second Dock icon while open; a new local attack surface (loopback, token, allow-list). The native window was not exercised visually in this environment. | Wails v3 multi-window would remove the extra process. |
| G14 | A saved host cannot pick its own terminal theme; the theme is global. | Less flexible than Termius. | Add `terminal_theme` to the host record. |
| G15 | Replacing a host's saved password creates a new identity; the old one stays in Keychain. | Orphan identities until deleted by hand. | Offer to update the existing identity's secret. |
| G17 | SFTP moves single files only: no folders, queue, resume or drag and drop. | Large trees must be moved with `scp -r` or `rsync` in a terminal. | Recursive transfer with a queue. |
| G18 | Account is a local profile; Sign in is a placeholder. | No cloud features yet (by design). | Define the account service before enabling it. |
| G16 | Sync after a vault reset: the Git repository still holds the old vault. | `Sync now` fails with a different-key error. | Use a new repository (documented). |

## 3. Quality evidence

| Check | Result |
| --- | --- |
| Go tests (`go test -race ./...`) | 191 passing (test functions and sub-tests), 0 failing; also green in a Linux container |
| Go statement coverage | 81.1 % overall; importer 92 %, exporter 89 %, usecase 88 %, store 85 %, sftpx 82 %, sshx 82 %, forward 81 %, syncgit 78 %, sqlitedb 76 %, vault 75 %, app 73 %, domain 44 % (see G12) |
| Frontend (Vitest) | 323 passing in 22 files, strict TypeScript typecheck clean |
| E2E | 1 walkthrough, 17 steps, 40 screenshots, uses the real Go backend, SQLite, vault, two SSH servers, a real TCP check through a tunnel, real SFTP transfers verified on disk, a window drag, maximise/roll-up, a changed shortcut that really triggers its action, and a narrow-window overflow guard |
| Architecture rule | enforced by 5 tests, and verified to fail on a deliberately introduced violation |
| `go vet` | clean |

## 4. Defects found by testing during development (all fixed, each with a regression test)

1. **Config injection**: a hostname/username containing a newline could add directives (e.g. `ProxyCommand`) to an exported ssh config. Now rejected by the domain rule and skipped by the exporter.
2. **Sync creating a commit on every run**: random GCM nonces made identical content look changed. Content (plaintext + header) is now compared first.
3. **Lost first output / host key prompt**: events fired before the UI subscribed. Fixed with `Attach` and buffered replay (ADR-0004).
4. **White screen on import**: Go returned `null` for empty slices and the UI crashed on `.length`. Found by the E2E walkthrough; fixed in the backend and defensively in the UI.
5. **Hostile KDF parameters** from a sync repo or backup could panic Argon2 or exhaust memory. Parameters are now validated before use.
6. **Remote forward test server** sent origin port 0, which the SSH client rejects; fixed in the test server (not product code).

### Found while redesigning (all fixed, each with a regression test)

7. **Layout overflow** at a 960 px window: the panel's slide-in animation widened the page and produced a horizontal scrollbar. Found by the narrow-window E2E guard.
8. **Icon-only navigation had no accessible names** at narrow widths. Found by the same step.
9. **Wordmark**: tight letter-spacing made "VV" read as "W" (spotted on a screenshot).
10. **Vault reset** had to handle identities still referenced by hosts; covered by use-case tests (including that no old ciphertext survives on disk).
11. **Settings validation**: a font-family check escaped `\n` wrongly and rejected "Menlo"; found by the settings tests.

## 5. Verdict

Feature complete for the MVP scope in the design, with the security properties that can be tested automatically verified. Before calling it ready for daily use as the main SSH tool (Gate 4), close G1–G3 and run the manual checklist on a real Mac; G4 and G5 are the next most valuable.
