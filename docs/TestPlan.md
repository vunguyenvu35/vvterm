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
| Clean architecture (ADR-0002) | `internal/archtest` |
| Regressions found during development | `TestReportsNeverMarshalNullSlices` and the Vitest null-array cases (E2E found a white-screen crash), `TestAttachReplays*` (lost first output), `TestSSHConfigSkipsHostWithInjectedHostname` |

## Manual checklist before a release

Not covered by automation; run on a real Mac build (`make build`, open `build/bin/vvterm.app`):

1. Native file dialogs work for: Import config, Export folder, Save backup, Choose key.
2. Keychain unlock: enable, quit, relaunch, unlock with the keychain; confirm the macOS prompt behaviour.
3. Heavy output: `yes | head -c 200M`, `tail -f` on a busy log; UI stays responsive (architecture §2 risk: WKWebView performance).
4. Real server: password login, key login, an ssh-agent identity, and a bastion in front of a private host.
5. Sync against a real private remote (GitHub/GitLab) using ssh-agent and using a credential helper.
6. Sleep/wake the Mac with the vault unlocked (see the sleep-lock gap in [Assessment](Assessment.md)).
7. Window resize and split panes with a full-screen program (`vim`, `htop`).

## Test data and environments

- SSH peer: `internal/testssh` (password + public-key auth, echo shell, `direct-tcpip`, `tcpip-forward`, keepalive), also exposed as `cmd/demoserver`.
- Git peer: a local bare repository created per test.
- Fast KDF parameters are used in tests only (`Memory: 64 KiB, Time: 1`); production uses 64 MiB / t=3 / p=4.
