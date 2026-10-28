# VVTerm

A desktop SSH client whose data you control. Hosts and keys live in an encrypted local vault, can always be exported in standard formats, and sync through a Git repository you own.

![VVTerm with split panes](docs/screenshots/09-split-panes.png)

## Features

- **Hosts**: groups (nested), tags, environment colour (dev / staging / prod), search and filter.
- **Vault**: private keys and passwords encrypted with a master password (Argon2id + AES-256-GCM, envelope encryption). The UI never receives a secret.
- **Terminal**: tabs, split panes, search (Ctrl/Cmd+F), jump host chains, keepalive, manual reconnect.
- **Security by default**: strict `known_hosts` checking, host key changes are blocked with no override, forwards bind to loopback.
- **Port forwarding**: local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`).
- **No lock-in**: import/export `~/.ssh/config` (with `Include`), plain JSON (no secrets) and password-encrypted backups.
- **Sync**: encrypted bundle pushed to your private Git repo; records are merged per item (last write wins, tombstones for deletes).
- **Storage**: a single SQLite database (`vvterm.db`).

Platform: macOS is the primary target. Windows and Linux are expected to build but are untested (see [Assessment](docs/Assessment.md)).

## Quick start

```bash
# prerequisites: Go 1.24+, Node 22+, Wails v2 CLI
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.2

make dev        # hot-reload development mode
make build      # produces build/bin/vvterm.app
```

First launch asks you to create the vault. Then follow the **[User guide](docs/UserGuide.md)**.

Data location (macOS): `~/Library/Application Support/vvterm/` (override with `VVTERM_DATA_DIR`).

## Testing

```bash
make test       # go vet + go test -race + frontend typecheck + vitest
make e2e        # end-to-end walkthrough against the real backend; refreshes docs/screenshots
make inventory  # regenerate docs/TestInventory.md
```

Latest results are in the [release notes](RELEASE_NOTES.md); the complete list of test cases is in [docs/TestInventory.md](docs/TestInventory.md) and the plan in [docs/TestPlan.md](docs/TestPlan.md).

## Architecture

Clean architecture with the dependency rule enforced by a test (`internal/archtest`):

```
app (Wails delivery) ──► usecase ──► domain
                           │            ▲
                           └─ ports ◄── infrastructure (sqlitedb, store, vault, sshx, forward, ...)
```

See [docs/CleanArchitecture.md](docs/CleanArchitecture.md) and the original design in [docs/Architecture.md](docs/Architecture.md).

## Repository layout

| Path | Role |
| --- | --- |
| `internal/domain` | entities and pure business rules (validation, merge, jump chain checks) |
| `internal/usecase` | application services and the ports they depend on (`ports.go`) |
| `internal/sqlitedb`, `store`, `vault`, `sshx`, `forward`, `importer`, `exporter`, `syncgit` | infrastructure adapters |
| `app/` | Wails delivery layer and composition root |
| `frontend/` | React + TypeScript + xterm.js UI |
| `cmd/demoserver` | in-process demo SSH server used by the E2E walkthrough |
| `e2e/` | Playwright walkthrough |

## License

See [LICENSE](LICENSE).
