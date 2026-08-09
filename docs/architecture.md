# Architecture

## Boundary

Zaparoo for Decky Loader is a presentation client. Zaparoo Core remains the source of truth for:

- Reader discovery and NFC writes
- Tokens and mappings
- Media resolution, launching, stopping, and history
- Media database indexing
- Client pairing and encrypted service connections
- Zaparoo Online credentials, sync, and backups
- Core configuration and lifecycle

The plugin does not bundle Core. Its only lifecycle exception is explicit first-run bootstrap of a standalone Core when no Core API or canonical binary exists. Bootstrap uses fixed executable and argument arrays, never shell strings.

## Components

```text
Steam Quick Access Menu
        |
TypeScript/React frontend
        |
Decky callable API and events
        |
Python backend, running as deck user
        |
        +---- 127.0.0.1:7497 ---- Zaparoo Core
        |
        +---- explicit bootstrap ---- GitHub release + user-local Core service
```

### Frontend

`src/Content.tsx` renders one controller-scrollable Quick Access Menu page using Decky UI components. It obtains an initial snapshot from the Python backend, applies Core indexing notifications directly, refreshes invalidated status with debounce, and performs slow reconciliation while visible.

Steam context is read-only. The plugin checks Decky's running-app state first, then optionally reads the viewed Steam library route and app overview. It never patches or mutates Steam game pages.

### Backend

`main.py` provides bounded asynchronous methods over Decky's callable API. Blocking `urllib` requests run in worker threads. All JSON-RPC calls target Core on loopback and use method-specific timeouts.

The notification task uses `aiohttp`, which is an existing Decky Loader runtime dependency, to connect to Core's loopback WebSocket. It forwards parsed JSON-RPC notifications and connection-state changes through Decky's event API, then reconnects with a bounded delay. A disconnect immediately moves the visible panel into its retry state; reconnect triggers a fresh snapshot.

When the user confirms **Install Core**, backend bootstrap:

1. Rechecks SteamOS AMD64 support, loopback Core availability, and canonical binary absence.
2. Resolves latest stable compatible release through bounded GitHub metadata.
3. Requires exact versioned SteamOS asset name, URL, size, and GitHub SHA-256 digest.
4. Streams archive with byte limits and verifies size and digest.
5. Rejects unsafe tar paths and member types, extracts exactly one regular `zaparoo` member without `extractall`, and verifies its reported SteamOS version.
6. Rechecks Core absence, runs temporary binary with `-install application`, then canonical binary with `-install service`.
7. Runs fixed `systemctl --user daemon-reload` and `enable --now zaparoo.service` commands.
8. Waits for expected Core version on `127.0.0.1:7497`; failed new installations are rolled back.

Subprocess output, execution time, release metadata, download size, archive member count, and extracted size are bounded. Concurrent bootstrap calls are serialized. No sudo, hardware setup, arbitrary executable, shell command, plugin self-update, or private Decky API is used. The plugin bundles no Python modules or binaries.

### Persistent state

The plugin writes one optional marker named `security-prompt-dismissed` under `DECKY_PLUGIN_SETTINGS_DIR`. Explicit bootstrap delegates normal application and service installation to verified Core, producing canonical user-local files under `~/.local/` and `~/.config/systemd/user/`. Core owns all application data and credentials. Plugin uninstall does not remove Core or its data.

## Network and external resources

Runtime traffic initiated directly by the plugin:

| Destination | Purpose |
| --- | --- |
| `http://127.0.0.1:7497/api/v0.1` | Core JSON-RPC requests |
| `ws://127.0.0.1:7497/api/v0.1` | Core notification stream |
| `http://127.0.0.1:7497/app/` | Full Core Web UI opened by explicit user action |
| `https://api.github.com/repos/ZaparooProject/zaparoo-core/releases/latest` | Resolve compatible Core after install confirmation |
| `https://github.com/ZaparooProject/zaparoo-core/releases/download/v*/zaparoo-steamos_amd64-*.tar.gz` | Download exact versioned Core release after validation |
| GitHub release asset redirect hosts | Stream validated release bytes from GitHub infrastructure |

Online verification URLs are returned by Core and opened only after explicit user action. Core, not the plugin, owns Zaparoo Online API communication and credentials.

Manual plugin installation downloads packaged releases through Decky Loader or the Core installer. Runtime plugin code does not update or replace itself.

## Failure behavior

- Missing Core: show detected install/start/unsupported onboarding state and retry loopback connection.
- Core appears during bootstrap: stop before file installation and preserve existing Core.
- Existing stopped canonical Core: offer service installation/start without replacing application binary.
- Invalid release metadata, digest, archive, or binary: fail before canonical installation.
- Failed new Core service or readiness check: disable service and remove newly installed application files.
- Partial snapshot: show available sections and retain per-section errors.
- Notification disconnect: show reconnecting state immediately, reconnect, and fetch a fresh snapshot.
- No writable reader: disable **Write to Tag** with an explanation.
- Plugin unload: cancel backend notification task and remove frontend listeners and timers.
- Core mutation failure: show inline error, except tag-write success or failure may use a toast.

## Compatibility

Core 2.17.0 is the minimum supported release. Older and unrecognized release versions receive a compatibility-only panel with no operational controls. Hash-based development versions remain enabled for matched branch testing. Core API changes must remain backward-compatible or raise the explicit minimum here. Releases must be tested against Core 2.17.0 and current Core stable.
