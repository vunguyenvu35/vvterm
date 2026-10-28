# VVTerm 1.0.0

Release date: 2026-10-28 · Platform: macOS (arm64 build verified) · Status: feature complete for the MVP scope in [docs/Architecture.md](docs/Architecture.md); see [Known issues](#known-issues) before using it as your only SSH client.

## Highlights

- SSH client with an **encrypted vault**: private keys and passwords are protected by a master password (Argon2id → AES-256-GCM envelope encryption) and never reach the UI.
- **Hosts** with nested groups, tags and environment colours; **jump host** chains; tabs and **split panes**; terminal search.
- **Port forwarding**: local, remote and SOCKS5.
- **No lock-in**: import and export `~/.ssh/config`, plain JSON and password-encrypted backups.
- **Git sync** of an encrypted bundle with per-record merge.
- **SQLite** storage in a single `vvterm.db`.
- **Clean architecture** with an enforced dependency rule.

## What's new (everything is new in 1.0.0)

### Vault and security
- Create / unlock / lock / change master password; minimum 12 characters.
- Per-secret AES-256-GCM with the secret id as additional data (ciphertext cannot be swapped between records); KDF parameters stored in the header and validated on load.
- Auto-lock after inactivity (default 15 min), wiping the key from memory; the UI returns to the unlock screen.
- Optional keychain unlock (macOS Keychain). It is *not* biometric-gated yet (see Known issues).
- Strict host key verification: trust on first use with a SHA-256 fingerprint, **changed keys are blocked with no override**, `InsecureIgnoreHostKey` is never used.
- Forwards bind to `127.0.0.1` unless explicitly allowed.

### Terminal
- Multiple tabs, binary split panes, scrollback search (Ctrl/Cmd+F), light and dark themes.
- Output is coalesced into ~16 ms batches; nothing is lost between opening a session and the UI attaching.
- Keepalive; on a dropped link the content stays and a banner offers *Press Enter to reconnect* (never automatic).

### Data
- Import `~/.ssh/config` (follows `Include`, group = file name, `ProxyJump` chains, forwards, `IdentityFile` keys) with skip / overwrite / copy policies and a warnings report.
- Export ssh config per group (keys only on explicit opt-in, mode 0600), metadata-only JSON, and encrypted backups with a separate password.
- Sync through a private Git repo: only `bundle.enc` and `vault-header.json` are published; push races are retried; unchanged data produces no commit.

### Engineering
- Layers: `domain` → `usecase` (ports) ← adapters; `app` is the Wails delivery layer and composition root. See [docs/CleanArchitecture.md](docs/CleanArchitecture.md).
- `make test`, `make e2e`, `make build`, `make release`; GitHub Actions workflow in `.github/workflows/ci.yml`.

## Quality gates

| Gate | Result |
| --- | --- |
| `go vet ./...` | clean |
| `go test -race ./...` | **141 passing** (139 test functions + sub-tests), 0 failing, 12 packages |
| Go statement coverage | **80.2 %** overall |
| Frontend `tsc --noEmit` + Vitest | clean, **81 passing** in 10 files |
| End-to-end walkthrough (real backend, SQLite, vault, two SSH servers) | **passed**: 12 steps, 19 screenshots in `docs/screenshots` |
| Architecture rule (`internal/archtest`) | 5 tests, verified to fail on a deliberate violation |
| Production build | `wails build` OK, `vvterm.app` 13 MB |

Build artifact checksum (`build/bin/vvterm.app/Contents/MacOS/vvterm`, SHA-256):
`48c8a9965fa6331f4de67b3b61b718077a9caa8cef48139948ed71bf2358e34e`

Test cases: [docs/TestInventory.md](docs/TestInventory.md) (generated, complete) · plan and manual checklist: [docs/TestPlan.md](docs/TestPlan.md) · evaluation: [docs/Assessment.md](docs/Assessment.md).

## Defects found and fixed while building 1.0.0

Each has a regression test.

- Exported ssh config could be injected with extra directives through a hostname/username containing a newline.
- Every sync created a commit even without changes (random encryption nonces).
- Early output and host key prompts could be lost before the UI subscribed.
- Import crashed the UI to a white screen because Go sent `null` for empty lists (caught by the end-to-end walkthrough).
- Untrusted KDF parameters (sync repo, backup file) could crash or exhaust memory.

## Changes from the original design

| Design | 1.0.0 | Why |
| --- | --- | --- |
| JSON files, no SQLite in the MVP | SQLite (`vvterm.db`) | product requirement ([ADR-0001](docs/CleanArchitecture.md)) |
| `kevinburke/ssh_config` | own parser | needs per-file group names ([ADR-0003](docs/CleanArchitecture.md)) |
| Services in `app/` | services in `internal/usecase`, Wails glue in `app/` | clean architecture ([ADR-0002](docs/CleanArchitecture.md)) |
| Svelte or React | React + TypeScript | open question resolved |
| Touch ID | keychain unlock without biometric enforcement | needs a native bridge |

## Known issues

1. **Keychain unlock is not biometric-gated**; anyone who can read your login keychain can unlock the vault.
2. **The vault does not lock when the Mac sleeps**; only the idle timer applies.
3. The native macOS window, native file dialogs and keychain prompts were not exercised in this environment (the app builds; the UI was verified in a browser against the real backend). Run the manual checklist in [docs/TestPlan.md](docs/TestPlan.md) first.
4. Terminal performance on heavy output (`tail -f` of busy logs) in WKWebView is unmeasured.
5. Sync was tested against local Git remotes, not GitHub/GitLab. Edits made during the few seconds of a sync run can be overwritten.
6. Last-write-wins depends on reasonably correct clocks.
7. `ssh_config` features not supported: `ProxyCommand`, `Match`, token expansion (reported as warnings).
8. No CLI (`vvt`), no keyboard-shortcut customisation, no SFTP/snippets (out of MVP scope).
9. Windows and Linux are not built or tested.
10. Use cases still depend directly on some infrastructure packages (documented debt, capped by a test).

## Upgrading and data

This is the first release; there is nothing to migrate. Data lives in `~/Library/Application Support/vvterm/` (override with `VVTERM_DATA_DIR`). **If you forget the master password the vault cannot be recovered**: export an encrypted backup regularly.

## How to verify this release

```bash
make test        # all unit, integration and component tests
make e2e         # walkthrough against the real backend; refreshes docs/screenshots
make build       # build/bin/vvterm.app
```
