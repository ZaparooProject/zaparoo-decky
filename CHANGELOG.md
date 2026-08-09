# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added

- Standalone repository structure and release tooling.
- Runtime validation for Core responses and notifications.
- Minimum Core 2.17.0 compatibility enforcement.
- Confirmed SteamOS onboarding that installs a verified standalone Core when absent.
- Existing stopped Core service start flow and separate NFC hardware setup documentation.
- Manual GitHub release workflow with stable Decky ZIP URL.
- Optional verified Decky plugin installation and updates through the normal Core installer.

### Fixed

- Core restart detection now shows reconnecting state immediately and refreshes after reconnection.

## [0.1.0] - Unreleased

### Added

- Controller-native Quick Access Menu client for Zaparoo Core.
- Reader, token, current-media, and media-database status.
- NFC tag writing for current Core media and Steam context.
- Client pairing and encryption setup.
- Zaparoo Online linking and independent sync and backup consent.
- Core Inbox notification viewer.
