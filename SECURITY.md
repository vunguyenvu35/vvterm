# Security policy

VVTerm keeps SSH keys and passwords, so security reports are taken seriously. Thank you for taking the time to send one.

## Supported versions

VVTerm is a beta. Only the **latest release** gets security fixes; please check that a problem still exists in the newest version on the [Releases](../../releases) page before you report it.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's private reporting instead:

1. Go to the **Security** tab of this repository.
2. Choose **Report a vulnerability** and describe the problem.

Please include:

- what you found and what an attacker could do with it;
- the VVTerm version and your operating system;
- steps to reproduce it, or a short proof of concept;
- whether the problem is already public.

**Never put real passwords, private keys or your vault file in a report.** Use throw-away credentials, for example the demo SSH servers described in the [README](README.md#no-server-to-test-with).

## What to expect

VVTerm is maintained in spare time, so these are goals rather than guarantees:

- an acknowledgement within **7 days**;
- an assessment, and a plan or a question, within **14 days**;
- a fix in the next release for a confirmed problem, sooner for a serious one, and a credit in the release notes if you want one.

Please keep the details private until a fixed release is out. If you hear nothing within the times above, a gentle reminder on the same report is welcome.

## Scope

In scope: the VVTerm application and this repository, for example:

- the vault and how secrets are stored, derived, synced, exported or backed up;
- SSH host key checking, jump hosts, port forwards and SFTP (path handling, overwriting, transfer of untrusted file names);
- the local bridge between the main app and the Settings window, and the MCP gateway of the AI assistant;
- the AI assistant's redaction and its read-only command rules;
- the build, release and CI configuration.

Out of scope:

- problems that need an already compromised computer or an unlocked vault, or physical access;
- weaknesses of the protocols themselves: Telnet and serial are unencrypted by nature;
- the AI tools VVTerm drives (Claude Code, Codex CLI, Gemini CLI) and servers you add yourself, which run with your rights;
- development-only tooling that does not ship in a release;
- reports from automated scanners with no demonstrated impact.

## How VVTerm handles security

Keys and passwords are encrypted with AES-256-GCM under a key derived from your master password (Argon2id). Unknown server keys are confirmed by you, and a changed key blocks the connection with no override. Nothing leaves your computer unless you turn on sync, which uploads only encrypted data to a repository or folder you control.

The details, the findings of the last review and the **known residual risks** (redaction in the AI assistant is best effort, for example) are in [docs/SecurityReview.md](docs/SecurityReview.md).

## Safe harbour

If you act in good faith, stay within the scope above, test only on your own data and systems, and give a reasonable time to fix a problem before you disclose it, VVTerm will not take action against you for the research.
