# Agent Instructions

## Project map

- Purpose: controller-native Decky Loader client for Zaparoo Core.
- Frontend: `src/` (TypeScript, React, Decky UI).
- Python backend: `main.py`; it proxies bounded loopback JSON-RPC and Core notifications, plus explicit missing-Core bootstrap.
- Tests: `src/*.test.ts` and `tests/test_main.py`.
- Core API implementation: sibling repository `../zaparoo-core`.

## Commands

- Install: `pnpm install --frozen-lockfile` using pnpm 9.
- Full check: `pnpm check`.
- Package: `pnpm package`.
- Frontend only: `pnpm typecheck && pnpm test && pnpm build`.
- Backend only: `python3 -m unittest discover tests`.

## Working rules

- Keep plugin a thin Core client. Do not duplicate readers, media indexing, mappings, launch logic, backups, credentials, or Core updates. Missing-Core install/start is the only lifecycle exception.
- Never request Decky root mode, execute shell strings, replace the plugin at runtime, or call private Decky plugin-management APIs.
- Keep normal backend traffic loopback-only. Explicit bootstrap may use only documented GitHub release endpoints with exact host, asset, digest, size, and archive validation. Treat all remote, Core, and event data as untrusted input.
- Keep subprocess executable/argument arrays fixed and bounded by output and timeout. Never perform NFC hardware or sudo setup from the plugin.
- Use official `@decky/api` and `@decky/ui` interfaces where possible.
- Steam internals are read-only and optional. Never patch or mutate Steam game pages.
- Maintain controller focus and one scrollable Quick Access Menu layout.
- Reserve toasts for tag-write success and failure.
- Avoid em and en dashes in user-facing UI text.
- Do not bundle binaries, vendored Python packages, telemetry, or dependencies without discussion. Verified Core downloads may occur only after explicit install confirmation and must land in canonical standalone paths.
- Keep `plugin.json` flags empty. Update `package.json` version for each release.
- Keep lockfile at version 9 and include GPL plus Decky template BSD notices in `LICENSE`.
- Do not commit `dist/`, `out/`, `node_modules/`, caches, credentials, or device-specific state.
- Hardware deployment or testing requires an available Steam Deck and explicit approval.
- Commits, pushes, and releases require explicit approval.

## Validation

Run `pnpm check` and `pnpm package` after code or metadata changes.
