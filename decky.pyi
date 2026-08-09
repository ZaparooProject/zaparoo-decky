# Derived from SteamDeckHomebrew/decky-plugin-template under BSD-3-Clause.
# See the retained Decky template notice in LICENSE.

"""
This module exposes various constants and helpers useful for decky plugins.

* Plugin's settings and configurations should be stored under `DECKY_PLUGIN_SETTINGS_DIR`.
* Plugin's runtime data should be stored under `DECKY_PLUGIN_RUNTIME_DIR`.
* Plugin's persistent log files should be stored under `DECKY_PLUGIN_LOG_DIR`.

Avoid writing outside of `DECKY_HOME`, storing under the suggested paths is strongly recommended.

Migration helpers include `migrate_any`, `migrate_settings`, `migrate_runtime`,
and `migrate_logs`.

A logging facility `logger` is available which writes to the recommended location.
"""

__version__ = "1.0.0"

import logging
from typing import Any

HOME: str
"""The home directory of the effective user running the process."""

USER: str
"""The effective username running the process."""

DECKY_VERSION: str
"""The version of Decky Loader."""

DECKY_USER: str
"""The user whose home Decky resides in."""

DECKY_USER_HOME: str
"""The home of the user where Decky resides."""

DECKY_HOME: str
"""The root of the Decky folder."""

DECKY_PLUGIN_SETTINGS_DIR: str
"""The recommended path for plugin configuration files."""

DECKY_PLUGIN_RUNTIME_DIR: str
"""The recommended path for plugin runtime data."""

DECKY_PLUGIN_LOG_DIR: str
"""The recommended path for persistent plugin logs."""

DECKY_PLUGIN_DIR: str
"""The root of the plugin directory."""

DECKY_PLUGIN_NAME: str
"""The plugin name from plugin.json."""

DECKY_PLUGIN_VERSION: str
"""The plugin version from package.json."""

DECKY_PLUGIN_AUTHOR: str
"""The plugin author from plugin.json."""

DECKY_PLUGIN_LOG: str
"""The path to the plugin's main log file."""

def migrate_any(target_dir: str, *files_or_directories: str) -> dict[str, str]:
    """Migrate files and directories to a target directory."""

def migrate_settings(*files_or_directories: str) -> dict[str, str]:
    """Migrate plugin settings to DECKY_PLUGIN_SETTINGS_DIR."""

def migrate_runtime(*files_or_directories: str) -> dict[str, str]:
    """Migrate runtime data to DECKY_PLUGIN_RUNTIME_DIR."""

def migrate_logs(*files_or_directories: str) -> dict[str, str]:
    """Migrate logs to DECKY_PLUGIN_LOG_DIR."""

logger: logging.Logger
"""The main plugin logger writing to DECKY_PLUGIN_LOG."""

async def emit(event: str, *args: Any) -> None:
    """Send an event to the frontend."""
