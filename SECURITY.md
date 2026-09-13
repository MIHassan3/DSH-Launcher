# Security Policy

## Supported versions

Only the latest release of DSH-Dock receives security fixes.

| Version | Supported |
| :--- | :--- |
| v0.5.x (preview) | ✅ |
| v0.1.x (legacy PowerShell) | ❌ — unmaintained |

## Reporting a vulnerability

Please report security issues **privately** by opening a draft security advisory at:

https://github.com/MIHassan3/DSH-Launcher/security/advisories/new

Or by email to the maintainer listed in the repository profile. Do not open a public issue for security problems.

Expect an initial response within a few days. If the issue is confirmed, a patched release will be published with an advisory.

## Scope

DSH-Dock is a launcher. Its security model is simple:

- **It only talks to `127.0.0.1`.** The launcher makes no outbound network requests except to the npm registry when installing or checking for harness updates. It has no cloud component, no telemetry, and no analytics.
- **It never modifies the DeepSeek Harness.** The harness runs as an unmodified official package. Bugs in the harness itself are out of scope for DSH-Dock.
- **It never touches `$DSH_HOME`.** Your sessions, credentials, and settings in `%USERPROFILE%\.dsh\` (or wherever `DSH_HOME` points) are never read, written, or cached.
- **The harness window is capability-isolated.** The window that renders the harness UI is granted no Tauri commands. A hostile page loaded there cannot call into the launcher's Rust code.

## What is out of scope

- Unsigned binaries. The preview releases are not code-signed; SmartScreen warnings are expected and are not vulnerabilities.
- Bugs in the official DeepSeek Harness. Report those to [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- Local privilege escalation via a compromised user account. DSH-Dock runs with the user's privileges; it does not attempt to sandbox a compromised user.

## Build provenance

Every release is built from a tagged commit in this repository. You can verify by:

1. Cloning the repo at the tag: `git checkout v0.5.0`
2. Building locally: `cargo tauri build`
3. Comparing the SHA-256 of your output against the checksum published in the release notes.

Do not trust binaries from anywhere other than the official Releases page.