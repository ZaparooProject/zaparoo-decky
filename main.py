import asyncio
import contextlib
import hashlib
import itertools
import json
import os
import platform
import re
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import IO, Any, BinaryIO, cast

import aiohttp

import decky

API_URL = "http://127.0.0.1:7497/api/v0.1"
WS_API_URL = "ws://127.0.0.1:7497/api/v0.1"
CORE_NOTIFICATION_EVENT = "core_notification"
CORE_CONNECTION_EVENT = "core_connection"
DEFAULT_TIMEOUT = 2.0
MAX_RESPONSE_BYTES = 1 << 20
NOTIFICATION_RECONNECT_DELAY = 2.0
BOOTSTRAP_PROGRESS_EVENT = "bootstrap_progress"
CORE_RELEASE_API_URL = "https://api.github.com/repos/ZaparooProject/zaparoo-core/releases/latest"
CORE_RELEASE_DOWNLOAD_PREFIX = "https://github.com/ZaparooProject/zaparoo-core/releases/download/"
CORE_RELEASE_MAX_METADATA_BYTES = 1 << 20
CORE_RELEASE_MAX_ARCHIVE_BYTES = 100 << 20
CORE_RELEASE_MAX_EXTRACTED_BYTES = 200 << 20
CORE_RELEASE_MAX_MEMBERS = 128
CORE_RELEASE_MAX_ASSETS = 128
SUBPROCESS_MAX_OUTPUT_BYTES = 64 << 10
SUBPROCESS_ERROR_DETAIL_BYTES = 512
SUBPROCESS_TIMEOUT = 30.0
CORE_READY_TIMEOUT = 20.0
MINIMUM_CORE_VERSION = (2, 17, 0)
VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
VERSION_OUTPUT_PATTERN = re.compile(r"^Zaparoo v(\d+\.\d+\.\d+) \(steamos\)$")
SYSTEMD_SERVICE_NAME = "zaparoo.service"
HARDWARE_RULE_PATH = Path("/etc/udev/rules.d/60-zaparoo.rules")


class CoreAPIError(RuntimeError):
    pass


@dataclass(frozen=True)
class CoreRelease:
    version: str
    archive_name: str
    url: str
    digest: str
    size: int


def _semantic_version(value: str) -> tuple[int, int, int] | None:
    match = VERSION_PATTERN.fullmatch(value)
    if match is None:
        return None
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch)


def _is_regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _read_bounded(response: BinaryIO, maximum_bytes: int) -> bytes:
    body = response.read(maximum_bytes + 1)
    if len(body) > maximum_bytes:
        raise CoreAPIError("Release response is too large")
    return body


def _latest_core_release_sync() -> CoreRelease:
    request = urllib.request.Request(
        CORE_RELEASE_API_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "zaparoo-decky-bootstrap",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10.0) as response:
            final_url = urllib.parse.urlparse(str(response.geturl()))
            if final_url.scheme != "https" or final_url.hostname != "api.github.com":
                raise CoreAPIError("Core release metadata redirected to an untrusted host")
            metadata = json.loads(_read_bounded(response, CORE_RELEASE_MAX_METADATA_BYTES))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise CoreAPIError("Failed to load latest Core release") from error
    if not isinstance(metadata, dict):
        raise CoreAPIError("Core release metadata is invalid")
    return _core_release_from_metadata(cast(dict[str, Any], metadata))


def _core_release_from_metadata(release: dict[str, Any]) -> CoreRelease:
    tag = release.get("tag_name")
    version_tuple = _semantic_version(tag) if isinstance(tag, str) else None
    if (
        version_tuple is None
        or version_tuple < MINIMUM_CORE_VERSION
        or release.get("draft") is True
        or release.get("prerelease") is True
    ):
        raise CoreAPIError("No compatible stable Core release is available")
    version = ".".join(str(part) for part in version_tuple)
    archive_name = f"zaparoo-steamos_amd64-{version}.tar.gz"
    expected_url = f"{CORE_RELEASE_DOWNLOAD_PREFIX}v{version}/{archive_name}"
    assets_value = release.get("assets")
    if not isinstance(assets_value, list):
        raise CoreAPIError("Core release asset list is invalid")
    assets = cast(list[object], assets_value)
    if len(assets) > CORE_RELEASE_MAX_ASSETS:
        raise CoreAPIError("Core release asset list is invalid")
    for untyped_asset in assets:
        if not isinstance(untyped_asset, dict):
            continue
        asset = cast(dict[str, Any], untyped_asset)
        if asset.get("name") != archive_name:
            continue
        url = asset.get("browser_download_url")
        digest = asset.get("digest")
        size = asset.get("size")
        if not isinstance(url, str) or url != expected_url:
            raise CoreAPIError("Core release archive URL is invalid")
        if not isinstance(digest, str) or re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest) is None:
            raise CoreAPIError("Core release archive has no valid SHA-256 digest")
        if not isinstance(size, int) or size <= 0 or size > CORE_RELEASE_MAX_ARCHIVE_BYTES:
            raise CoreAPIError("Core release archive size is invalid")
        return CoreRelease(version, archive_name, url, digest.removeprefix("sha256:"), size)
    raise CoreAPIError(f"Core release is missing {archive_name}")


def _download_core_release_sync(release: CoreRelease, destination: Path) -> None:
    request = urllib.request.Request(
        release.url,
        headers={"User-Agent": "zaparoo-decky-bootstrap"},
    )
    digest = hashlib.sha256()
    written = 0
    trusted_hosts = {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
    try:
        with urllib.request.urlopen(request, timeout=30.0) as response:
            final_url = urllib.parse.urlparse(str(response.geturl()))
            if final_url.scheme != "https" or final_url.hostname not in trusted_hosts:
                raise CoreAPIError("Core release archive redirected to an untrusted host")
            with destination.open("xb") as output:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > release.size or written > CORE_RELEASE_MAX_ARCHIVE_BYTES:
                        raise CoreAPIError("Core release archive exceeded its declared size")
                    digest.update(chunk)
                    output.write(chunk)
    except (OSError, urllib.error.URLError, TimeoutError) as error:
        raise CoreAPIError("Failed to download Core release archive") from error
    if written != release.size:
        raise CoreAPIError("Core release archive size verification failed")
    if digest.hexdigest() != release.digest:
        raise CoreAPIError("Core release archive checksum verification failed")


def _select_core_binary_member(members: list[tarfile.TarInfo]) -> tarfile.TarInfo:
    if not members or len(members) > CORE_RELEASE_MAX_MEMBERS:
        raise CoreAPIError("Core release archive member count is invalid")
    extracted_size = 0
    candidates: list[tarfile.TarInfo] = []
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise CoreAPIError("Core release archive contains an unsafe path")
        if member.issym() or member.islnk() or member.isdev():
            raise CoreAPIError("Core release archive contains an unsafe member type")
        if member.isfile():
            extracted_size += member.size
            if path.name == "zaparoo":
                candidates.append(member)
    if extracted_size > CORE_RELEASE_MAX_EXTRACTED_BYTES:
        raise CoreAPIError("Core release archive is too large after extraction")
    if len(candidates) != 1:
        raise CoreAPIError("Core release archive must contain exactly one zaparoo binary")
    return candidates[0]


def _copy_core_binary(source: IO[bytes], destination: Path) -> None:
    with destination.open("xb") as output:
        copied = 0
        while True:
            chunk = source.read(1 << 20)
            if not chunk:
                break
            copied += len(chunk)
            if copied > CORE_RELEASE_MAX_EXTRACTED_BYTES:
                raise CoreAPIError("Core release binary is too large")
            output.write(chunk)
    destination.chmod(0o755)


def _extract_core_binary_sync(archive_path: Path, destination: Path) -> None:
    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            member = _select_core_binary_member(archive.getmembers())
            source = archive.extractfile(member)
            if source is None:
                raise CoreAPIError("Core release binary could not be read")
            with source:
                _copy_core_binary(source, destination)
    except (OSError, tarfile.TarError) as error:
        raise CoreAPIError("Core release archive extraction failed") from error


class Plugin:
    def __init__(self) -> None:
        self._request_ids = itertools.count(1)
        self._notification_task: asyncio.Task[None] | None = None
        self._bootstrap_lock = asyncio.Lock()
        self._bootstrap_progress: dict[str, Any] = {
            "phase": "idle",
            "busy": False,
            "message": "",
        }

    @staticmethod
    def _user_home() -> Path:
        configured = getattr(decky, "DECKY_USER_HOME", "") or os.environ.get("HOME", "")
        if not configured:
            raise CoreAPIError("Decky user home is unavailable")
        return Path(configured)

    @classmethod
    def _canonical_binary(cls) -> Path:
        return cls._user_home() / ".local" / "bin" / "zaparoo"

    @classmethod
    def _service_unit(cls) -> Path:
        return cls._user_home() / ".config" / "systemd" / "user" / SYSTEMD_SERVICE_NAME

    @staticmethod
    def _supported_platform() -> tuple[bool, str | None]:
        if platform.machine() != "x86_64":
            return False, "Core bootstrap supports SteamOS AMD64 only"
        try:
            values: dict[str, str] = {}
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if "=" not in line or line.lstrip().startswith("#"):
                    continue
                key, value = line.split("=", 1)
                values[key] = value.strip().strip("\"'")
        except OSError:
            return False, "SteamOS could not be detected"
        if values.get("ID", "").lower() != "steamos":
            return False, "Core bootstrap supports SteamOS only"
        return True, None

    @staticmethod
    def _service_active_sync() -> bool:
        try:
            completed = subprocess.run(
                ["systemctl", "--user", "is-active", "--quiet", SYSTEMD_SERVICE_NAME],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=2.0,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return completed.returncode == 0

    def _bootstrap_status_sync(self) -> dict[str, Any]:
        supported, reason = self._supported_platform()
        binary = self._canonical_binary()
        connected = False
        version: Any = None
        try:
            version = self._rpc_sync("version")
            connected = True
        except CoreAPIError:
            pass
        binary_installed = binary.exists() or binary.is_symlink()
        service_installed = self._service_unit().is_file()
        service_active = self._service_active_sync()
        if not supported:
            action = "unsupported"
        elif connected:
            action = "none"
        elif binary_installed:
            action = "start"
        else:
            action = "install"
        return {
            "supported": supported,
            "connected": connected,
            "binaryInstalled": binary_installed,
            "serviceInstalled": service_installed,
            "serviceActive": service_active,
            "hardwareInstalled": HARDWARE_RULE_PATH.is_file(),
            "action": action,
            "progress": dict(self._bootstrap_progress),
            **({"reason": reason} if reason is not None else {}),
            **({"version": version} if connected else {}),
        }

    async def get_bootstrap_status(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._bootstrap_status_sync)

    async def _set_bootstrap_progress(
        self,
        phase: str,
        message: str,
        *,
        busy: bool = True,
        error: str | None = None,
        version: str | None = None,
    ) -> None:
        progress: dict[str, Any] = {"phase": phase, "busy": busy, "message": message}
        if error is not None:
            progress["error"] = error
        if version is not None:
            progress["version"] = version
        self._bootstrap_progress = progress
        await decky.emit(BOOTSTRAP_PROGRESS_EVENT, dict(progress))

    @staticmethod
    async def _read_process_stream(stream: asyncio.StreamReader | None) -> bytes:
        if stream is None:
            return b""
        output = bytearray()
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return bytes(output)
            output.extend(chunk)
            if len(output) > SUBPROCESS_MAX_OUTPUT_BYTES:
                raise CoreAPIError("Installer command produced too much output")

    async def _run_command(self, *args: str, timeout: float = SUBPROCESS_TIMEOUT) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise CoreAPIError(f"Failed to start {Path(args[0]).name}") from error
        stdout_task = asyncio.create_task(self._read_process_stream(process.stdout))
        stderr_task = asyncio.create_task(self._read_process_stream(process.stderr))
        try:
            stdout, stderr = await asyncio.wait_for(
                asyncio.gather(stdout_task, stderr_task), timeout=timeout
            )
            return_code = await asyncio.wait_for(process.wait(), timeout=timeout)
        except (TimeoutError, CoreAPIError, asyncio.CancelledError):
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            stdout_task.cancel()
            stderr_task.cancel()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            with contextlib.suppress(ProcessLookupError):
                await process.wait()
            raise
        if return_code != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()
            if len(detail) > SUBPROCESS_ERROR_DETAIL_BYTES:
                detail = detail[:SUBPROCESS_ERROR_DETAIL_BYTES]
            command = Path(args[0]).name
            raise CoreAPIError(f"{command} failed{': ' + detail if detail else ''}")
        return stdout.decode("utf-8", errors="replace").strip()

    async def _verify_binary(self, binary: Path, expected_version: str | None = None) -> str:
        output = await self._run_command(str(binary), "-version", timeout=5.0)
        match = VERSION_OUTPUT_PATTERN.fullmatch(output.splitlines()[0] if output else "")
        if match is None:
            raise CoreAPIError("Core binary did not identify as a SteamOS release")
        version = match.group(1)
        if expected_version is not None and version != expected_version:
            raise CoreAPIError("Core binary version did not match release metadata")
        return version

    async def _wait_for_core(self, expected_version: str | None = None) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + CORE_READY_TIMEOUT
        while asyncio.get_running_loop().time() < deadline:
            try:
                untyped_version = await self._rpc("version")
            except CoreAPIError:
                await asyncio.sleep(0.5)
                continue
            if not isinstance(untyped_version, dict):
                raise CoreAPIError("Core returned invalid version information")
            version = cast(dict[str, Any], untyped_version)
            if version.get("platform") != "steamos":
                raise CoreAPIError("Running Core is not a SteamOS build")
            if expected_version is not None and version.get("version") != expected_version:
                raise CoreAPIError("Running Core version does not match installed release")
            return version
        raise CoreAPIError("Core did not become ready on 127.0.0.1:7497")

    async def _rollback_bootstrap(self, binary: Path) -> None:
        with contextlib.suppress(CoreAPIError):
            await self._run_command(
                "systemctl", "--user", "disable", "--now", SYSTEMD_SERVICE_NAME, timeout=10.0
            )
        if await asyncio.to_thread(_is_regular_file, binary):
            with contextlib.suppress(CoreAPIError):
                await self._run_command(str(binary), "-uninstall", "service", timeout=10.0)
            with contextlib.suppress(CoreAPIError):
                await self._run_command(str(binary), "-uninstall", "application", timeout=10.0)

    async def install_core(self) -> dict[str, Any]:
        async with self._bootstrap_lock:
            installed_application = False
            binary = self._canonical_binary()
            try:
                status = await self.get_bootstrap_status()
                if not status["supported"]:
                    raise CoreAPIError(str(status.get("reason", "Core bootstrap is unsupported")))
                if status["connected"]:
                    raise CoreAPIError("Core is already running; existing Core takes precedence")
                if status["binaryInstalled"]:
                    raise CoreAPIError("Core is already installed; start the existing installation")

                await self._set_bootstrap_progress("checking", "Checking latest Core release")
                release = await asyncio.to_thread(_latest_core_release_sync)
                await self._set_bootstrap_progress(
                    "downloading", f"Downloading Core {release.version}", version=release.version
                )
                with tempfile.TemporaryDirectory(prefix="zaparoo-decky-") as temporary:
                    temporary_path = Path(temporary)
                    archive_path = temporary_path / release.archive_name
                    temporary_binary = temporary_path / "zaparoo"
                    await asyncio.to_thread(_download_core_release_sync, release, archive_path)
                    await self._set_bootstrap_progress(
                        "verifying", "Verifying Core release", version=release.version
                    )
                    await asyncio.to_thread(
                        _extract_core_binary_sync, archive_path, temporary_binary
                    )
                    await self._verify_binary(temporary_binary, release.version)

                    latest_status = await self.get_bootstrap_status()
                    if latest_status["connected"] or latest_status["binaryInstalled"]:
                        raise CoreAPIError(
                            "Core appeared during installation; no files were replaced"
                        )
                    await self._set_bootstrap_progress(
                        "installing", "Installing Core application", version=release.version
                    )
                    await self._run_command(
                        str(temporary_binary), "-install", "application", timeout=30.0
                    )
                    installed_application = True
                    if not await asyncio.to_thread(_is_regular_file, binary):
                        raise CoreAPIError(
                            "Core application installer did not create canonical binary"
                        )
                    await self._verify_binary(binary, release.version)
                    await self._set_bootstrap_progress(
                        "service", "Installing Core service", version=release.version
                    )
                    await self._run_command(str(binary), "-install", "service", timeout=15.0)
                    await self._run_command("systemctl", "--user", "daemon-reload", timeout=10.0)
                    await self._run_command(
                        "systemctl", "--user", "enable", "--now", SYSTEMD_SERVICE_NAME, timeout=15.0
                    )
                    await self._set_bootstrap_progress(
                        "starting", "Waiting for Core", version=release.version
                    )
                    version = await self._wait_for_core(release.version)
                await self._set_bootstrap_progress(
                    "complete",
                    f"Core {release.version} is ready",
                    busy=False,
                    version=release.version,
                )
                return version
            except Exception as error:
                if installed_application:
                    await self._rollback_bootstrap(binary)
                message = str(error) if str(error) else "Core installation failed"
                await self._set_bootstrap_progress("failed", message, busy=False, error=message)
                if isinstance(error, CoreAPIError):
                    raise
                raise CoreAPIError(message) from error

    async def start_core(self) -> dict[str, Any]:
        async with self._bootstrap_lock:
            try:
                status = await self.get_bootstrap_status()
                if not status["supported"]:
                    raise CoreAPIError(str(status.get("reason", "Core bootstrap is unsupported")))
                if status["connected"]:
                    version = status.get("version")
                    return cast(dict[str, Any], version) if isinstance(version, dict) else {}
                binary = self._canonical_binary()
                if not await asyncio.to_thread(_is_regular_file, binary):
                    raise CoreAPIError("Core is not installed as a regular canonical binary")
                version = await self._verify_binary(binary)
                await self._set_bootstrap_progress(
                    "service", "Preparing existing Core service", version=version
                )
                if not self._service_unit().is_file():
                    await self._run_command(str(binary), "-install", "service", timeout=15.0)
                await self._run_command("systemctl", "--user", "daemon-reload", timeout=10.0)
                await self._run_command(
                    "systemctl", "--user", "enable", "--now", SYSTEMD_SERVICE_NAME, timeout=15.0
                )
                await self._set_bootstrap_progress("starting", "Waiting for Core", version=version)
                ready = await self._wait_for_core(version)
                await self._set_bootstrap_progress(
                    "complete", f"Core {version} is ready", busy=False, version=version
                )
                return ready
            except Exception as error:
                message = str(error) if str(error) else "Core start failed"
                await self._set_bootstrap_progress("failed", message, busy=False, error=message)
                if isinstance(error, CoreAPIError):
                    raise
                raise CoreAPIError(message) from error

    def _rpc_sync(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> Any:
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": next(self._request_ids),
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(response_data) > MAX_RESPONSE_BYTES:
                raise CoreAPIError(f"Core response is too large: {method}")
            decoded = json.loads(response_data)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise CoreAPIError(f"Core request failed: {method}") from error
        if not isinstance(decoded, dict):
            raise CoreAPIError(f"Core returned an invalid response: {method}")
        body = cast(dict[str, Any], decoded)
        rpc_error = body.get("error")
        if rpc_error is not None:
            if isinstance(rpc_error, dict):
                error_body = cast(dict[str, Any], rpc_error)
                message = str(error_body.get("message", "Unknown Core error"))
            else:
                message = str(rpc_error)
            raise CoreAPIError(message)
        if "result" not in body:
            raise CoreAPIError(f"Core response has no result: {method}")
        return body["result"]

    async def _rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> Any:
        return await asyncio.to_thread(self._rpc_sync, method, params, timeout)

    async def get_status(self) -> dict[str, Any]:
        try:
            version = await self._rpc("version")
        except CoreAPIError as error:
            return {"connected": False, "error": str(error)}

        calls = (
            self._rpc("readers"),
            self._rpc("tokens"),
            self._rpc("media"),
            self._rpc("settings"),
            self._rpc("clients"),
            self._rpc("settings.backup.status"),
            self._rpc("inbox"),
        )
        results = await asyncio.gather(*calls, return_exceptions=True)
        keys = ("readers", "tokens", "media", "settings", "clients", "backup", "inbox")
        status: dict[str, Any] = {"connected": True, "version": version, "errors": {}}
        for key, result in zip(keys, results, strict=True):
            if isinstance(result, Exception):
                status["errors"][key] = str(result)
            else:
                status[key] = result
        return status

    async def stop_media(self) -> Any:
        return await self._rpc("stop", timeout=5.0)

    async def write_tag(self, text: str, reader_id: str | None = None) -> Any:
        params: dict[str, Any] = {"text": text}
        if reader_id:
            params["readerId"] = reader_id
        return await self._rpc("readers.write", params, timeout=120.0)

    async def cancel_write(self, reader_id: str | None = None) -> Any:
        params: dict[str, Any] = {}
        if reader_id:
            params["readerId"] = reader_id
        return await self._rpc("readers.write.cancel", params, timeout=5.0)

    async def set_encryption(self, enabled: bool) -> Any:
        return await self._rpc("settings.update", {"encryption": enabled}, timeout=5.0)

    async def security_prompt_dismissed(self) -> bool:
        settings_dir = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", "")
        return bool(settings_dir) and (Path(settings_dir) / "security-prompt-dismissed").exists()

    async def dismiss_security_prompt(self) -> None:
        settings_dir = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", "")
        if not settings_dir:
            raise CoreAPIError("Decky plugin settings directory is unavailable")
        marker = Path(settings_dir) / "security-prompt-dismissed"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch(mode=0o600, exist_ok=True)

    async def start_client_pairing(self) -> Any:
        return await self._rpc("clients.pair.start", timeout=5.0)

    async def cancel_client_pairing(self) -> Any:
        return await self._rpc("clients.pair.cancel", timeout=5.0)

    async def start_online_link(self) -> Any:
        return await self._rpc("settings.auth.link", timeout=10.0)

    async def get_online_link_status(self) -> Any:
        return await self._rpc("settings.auth.link.status", timeout=5.0)

    async def cancel_online_link(self) -> Any:
        return await self._rpc("settings.auth.link.cancel", timeout=5.0)

    async def unlink_online(self) -> Any:
        return await self._rpc("settings.auth.unlink", timeout=5.0)

    async def dismiss_inbox_message(self, message_id: int) -> Any:
        if message_id <= 0:
            raise CoreAPIError("Invalid notification ID")
        return await self._rpc("inbox.delete", {"id": message_id}, timeout=5.0)

    async def update_online_settings(self, params: dict[str, Any]) -> Any:
        allowed = {
            "backupRemoteEnabled",
            "backupRemoteSchedule",
            "playtimeSyncEnabled",
        }
        if not params or any(key not in allowed for key in params):
            raise CoreAPIError("Invalid Online settings update")
        return await self._rpc("settings.update", params, timeout=5.0)

    async def update_reader_settings(self, params: dict[str, Any]) -> Any:
        allowed = {
            "audioScanFeedback",
            "readersAutoDetect",
            "readersScanExitDelay",
            "readersScanMode",
        }
        if not params or any(key not in allowed for key in params):
            raise CoreAPIError("Invalid reader settings update")
        return await self._rpc("settings.update", params, timeout=5.0)

    async def update_media_database(self) -> Any:
        return await self._rpc("media.generate", timeout=5.0)

    async def cancel_media_database_update(self) -> Any:
        return await self._rpc("media.generate.cancel", timeout=5.0)

    async def resume_media_database_update(self) -> Any:
        return await self._rpc("media.generate.resume", timeout=5.0)

    @staticmethod
    def _parse_notification(raw: str) -> dict[str, Any] | None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(message, dict):
            return None
        notification = cast(dict[str, Any], message)
        if not isinstance(notification.get("method"), str):
            return None
        return notification

    async def _forward_notification(self, raw: str) -> None:
        notification = self._parse_notification(raw)
        if notification is not None:
            await decky.emit(CORE_NOTIFICATION_EVENT, notification)

    async def _notification_session(self, timeout: aiohttp.ClientTimeout) -> None:
        connected = False
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as session,
                session.ws_connect(
                    WS_API_URL,
                    heartbeat=30.0,
                    max_msg_size=MAX_RESPONSE_BYTES,
                ) as websocket,
            ):
                decky.logger.info("Connected to Core notification stream")
                await decky.emit(CORE_CONNECTION_EVENT, True)
                connected = True
                async for message in websocket:
                    if message.type is aiohttp.WSMsgType.TEXT:
                        await self._forward_notification(message.data)
                    elif message.type in {
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.ERROR,
                    }:
                        break
        finally:
            if connected:
                await decky.emit(CORE_CONNECTION_EVENT, False)

    async def _notification_loop(self) -> None:
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=DEFAULT_TIMEOUT,
            sock_read=None,
        )
        while True:
            try:
                await self._notification_session(timeout)
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, TimeoutError) as error:
                decky.logger.debug("Core notification stream unavailable: %s", error)
            except Exception:
                decky.logger.exception("Unexpected Core notification stream failure")
            await asyncio.sleep(NOTIFICATION_RECONNECT_DELAY)

    async def _main(self) -> None:
        decky.logger.info("Zaparoo plugin loaded")
        self._notification_task = asyncio.create_task(self._notification_loop())

    async def _unload(self) -> None:
        if self._notification_task is not None:
            self._notification_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._notification_task
            self._notification_task = None
        decky.logger.info("Zaparoo plugin unloaded")
