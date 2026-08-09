# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when available. Do not open a public issue for an unpatched vulnerability.

Include:

- Affected plugin and Zaparoo Core versions
- SteamOS and Decky Loader versions
- Reproduction steps
- Expected impact
- Relevant logs with credentials, pairing PINs, token values, and personal data removed

## Security boundary

The plugin runs without root privileges. Normal operation communicates with Zaparoo Core over loopback. Core owns hardware access, credentials, Online communication, backups, media launching, updates, and persistent application data.

After explicit confirmation, missing-Core bootstrap may contact only GitHub's release API and validated release asset hosts. It verifies exact asset identity, size, SHA-256 digest, archive structure, and binary version before invoking fixed Core installation arguments. Bootstrap installs only user-local application and systemd user-service files. It never invokes sudo, installs hardware rules, updates the Decky plugin, or calls private Decky APIs.

The separate Core installer may offer manual Decky plugin installation. That path verifies the packaged release before sudo is used for the exact Decky plugin directory and `plugin_loader.service` restart. It never installs Decky Loader itself.

Security-sensitive changes include:

- New network destinations
- Filesystem writes outside Decky's plugin settings directory
- New subprocesses or binaries
- Changes to pairing, encryption, NFC writing, or Online consent
- Steam UI mutation or any private Decky plugin-management API access
- New runtime dependencies

Such changes require explicit design review, focused tests, and an update to `docs/architecture.md`.
