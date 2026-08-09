# Zaparoo for Decky Loader

Official controller-native Steam Deck companion for [Zaparoo Core](https://github.com/ZaparooProject/zaparoo-core).

Zaparoo runs as an independent background service. This plugin provides common controls in Steam's Quick Access Menu without embedding Core, modifying Steam game pages, or requesting Decky root mode. When Core is absent, the plugin can install a verified standalone Core into standard user-local paths after explicit confirmation.

## Features

- Current media and running or viewed Steam game context
- Safe **Write to Tag** flow through connected Core NFC readers
- Current media stop action
- Attached-reader and latest-token status
- Live media database progress with update, cancel, and resume controls
- Core Inbox notifications with explicit dismissal
- Client pairing and encrypted-connection setup
- Zaparoo Online linking, play-history consent, and backup consent
- Link to the full local Core Web UI for advanced settings

## Requirements

- Steam Deck running SteamOS
- [Decky Loader](https://decky.xyz/)
- Zaparoo Core 2.17.0 or newer, installed separately or through the plugin onboarding flow

The plugin blocks operational controls on older or unrecognized release versions. Hash-based development builds remain available for matched Core and plugin development.

## Installation

### Core installer

The normal Core installer detects an existing Decky Loader installation on SteamOS and offers to install the optional plugin. The prompt defaults to no. Rerunning the installer updates Core normally, then offers to install or update the plugin:

```bash
curl -fsSL https://zaparoo.org/install.sh | bash
```

Core and plugin remain separate installations. Core uses its signed self-updater between manual installer runs.

### Manual Decky installation

Decky Loader's manual installation flow also works when Core is not installed:

1. In Decky settings, enable **Developer Mode**.
2. Open **Developer** settings and choose the plugin installation option.
3. Install this URL: `https://github.com/ZaparooProject/zaparoo-decky/releases/latest/download/Zaparoo.zip`
4. Open Zaparoo in the Quick Access Menu and select **Install Core**.
5. Review and confirm the download, user-local files, and service changes.

The plugin downloads a compatible immutable SteamOS AMD64 Core release, verifies GitHub's SHA-256 asset digest, validates the archive and binary identity, then installs:

- `~/.local/bin/zaparoo`
- `~/.config/systemd/user/zaparoo.service`
- Normal Core application metadata under `~/.local/share/`

An existing Core API or canonical binary always takes precedence. The plugin never replaces it or starts a second Core intentionally.

### Updates and removal

Decky does not remember a manually installed ZIP URL and cannot automatically update plugins that are absent from the selected Store. Update Zaparoo Decky by either rerunning the Core installer or repeating the manual URL installation above.

Core and plugin update independently:

- Core uses its signed self-updater. Rerunning `install.sh` is also a supported explicit Core update path.
- Plugin releases use GitHub release ZIPs and require one of the manual update methods above.
- Removing the plugin leaves Core, its service, configuration, and databases installed.
- Removing Core leaves the plugin installed in a disconnected state.

### NFC hardware access

Core software installation does not make root changes. Users who need Linux device permissions for NFC hardware can run this separate Desktop Mode command:

```bash
sudo ~/.local/bin/zaparoo -install hardware
```

## Security and privacy

- `plugin.json` requests no root or debug flags.
- Normal backend calls target only Core's loopback API at `127.0.0.1:7497`.
- Explicit Core bootstrap contacts only GitHub API and versioned Zaparoo Core release assets.
- Bootstrap runs only fixed Core and `systemctl --user` argument arrays; it never executes shell strings or requests sudo.
- Reader access, media launching, account credentials, backups, and Online requests remain inside Core.
- Outside explicit Core bootstrap, plugin stores only its security-prompt dismissal marker in Decky's plugin settings directory.
- Linking Zaparoo Online uploads nothing until the user separately enables a sync or backup feature.

See [Architecture](docs/architecture.md) for boundaries and external-resource inventory.

## Development

Use Node.js 20 or newer, pnpm 9, Python 3.10 or newer, and Ruff 0.16.x:

```bash
pnpm install --frozen-lockfile
python3 -m pip install --requirement requirements-dev.txt
pnpm check
pnpm package
```

`pnpm check` runs TypeScript checking, frontend tests, Python syntax checks, backend tests, and a production frontend build. `pnpm package` creates and validates a manual-install archive under `out/`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep Decky as a thin Core client and coordinate API contract changes with the Core repository.

## License

Zaparoo plugin code is licensed under GPL-3.0-or-later. Portions derived from the official Decky plugin template retain its BSD 3-Clause notice. Both texts are included in [LICENSE](LICENSE).
