# Contributing

## Setup

Requirements:

- Node.js 20 or newer
- pnpm 9
- Python 3.10 or newer
- Ruff 0.16.x

```bash
pnpm install --frozen-lockfile
pnpm check
```

Do not use another package manager or regenerate `pnpm-lock.yaml` in another lockfile format.

## Architecture

Read [docs/architecture.md](docs/architecture.md) before changing backend boundaries, Steam integration, persistence, or network behavior.

Decky is a thin Zaparoo Core client. New reader, media, mapping, launch, backup, credential, or update logic belongs in [zaparoo-core](https://github.com/ZaparooProject/zaparoo-core). The narrow exception is explicit installation/start of a missing standalone Core through its published installer interface. Coordinate lifecycle and API changes across repositories and retain backward compatibility where possible.

## Pull requests

- Keep one concern per pull request.
- Add tests for changed behavior.
- Run `pnpm check` and `pnpm package`.
- Do not commit generated output or local Deck state.
- Document new external URLs, persistence, permissions, or dependencies.
- Include real Steam Deck evidence for controller focus or Steam UI behavior.
- Do not request root mode, bundle binaries, invoke shell strings, or use private Decky plugin-management APIs.
- Keep bootstrap hosts, assets, subprocesses, output, time, and archive extraction bounded and tested.

## UI conventions

- Use official Decky controller-native components.
- Keep one scrollable Quick Access Menu page.
- Keep read-only rows focusable when needed for controller scrolling.
- Use Zaparoo App and Core terminology.
- Reserve toasts for tag-write success and failure.
- Avoid em and en dashes in user-facing strings.
- Never patch or mutate Steam game pages.

## Releases

Before proposing a release:

1. Bump `package.json` version.
2. Update `CHANGELOG.md`.
3. Run `pnpm check` and `pnpm package`.
4. Test changed behavior on a Steam Deck.
5. Obtain explicit approval before publishing.
6. Tag the matching `vX.Y.Z` version. Release automation publishes versioned ZIP plus stable `Zaparoo.zip` manual-install asset.
