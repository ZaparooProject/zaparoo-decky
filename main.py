import asyncio
import base64
import binascii
import contextlib
import hashlib
import itertools
import json
import os
import platform
import re
import ssl
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Coroutine
from dataclasses import dataclass
from datetime import datetime
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
WEBSOCKET_CLOSE_TIMEOUT = 0.5
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
WORKFLOW_CLAIM_TIMEOUT = 5.0
WORKFLOW_CLEANUP_RETRY_DELAY = 5.0
UNLOAD_CLEANUP_TIMEOUT = 3.0
BOOTSTRAP_ROLLBACK_TIMEOUT = 2.0
MINIMUM_CORE_VERSION = (2, 17, 0)
VERSION_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
PLUGIN_VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
VERSION_OUTPUT_PATTERN = re.compile(r"^Zaparoo v(\d+\.\d+\.\d+) \(steamos\)$")
SYSTEMD_SERVICE_NAME = "zaparoo.service"
LOG_UPLOAD_URL = "https://logs.zaparoo.org/"
LOG_UPLOAD_HOST = "logs.zaparoo.org"
LOG_UPLOAD_CA_FILE = "/etc/ssl/cert.pem"
ONLINE_VERIFICATION_HOST = "online.zaparoo.com"
ONLINE_VERIFICATION_MAX_URL_BYTES = 4 << 10
LOG_UPLOAD_MAX_BYTES = 16 << 20
LOG_UPLOAD_MAX_URL_BYTES = 2 << 10
CORE_ERROR_MAX_CHARS = 512
CORE_MAX_CLIENTS = 512
CORE_MAX_CLIENT_ID_CHARS = 512
CORE_MAX_PAIRING_PIN_CHARS = 64
CORE_MAX_LOG_FILENAME_BYTES = 255
CORE_MAX_ONLINE_CODE_CHARS = 64
CORE_MAX_ONLINE_TEXT_CHARS = 4 << 10
CORE_MAX_ONLINE_EXPIRY_CHARS = 128
JS_MAX_SAFE_INTEGER = (1 << 53) - 1
HTTP_OK_STATUS = 200
LOG_DOWNLOAD_MAX_RESPONSE_BYTES = ((LOG_UPLOAD_MAX_BYTES + 2) // 3 * 4) + (4 << 10)


def _load_plugin_version() -> str:
    try:
        decoded = json.loads(Path(__file__).with_name("package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "Unknown"
    if not isinstance(decoded, dict):
        return "Unknown"
    package = cast(dict[str, Any], decoded)
    version = package.get("version")
    if not isinstance(version, str) or PLUGIN_VERSION_PATTERN.fullmatch(version) is None:
        return "Unknown"
    return version


PLUGIN_VERSION = _load_plugin_version()


class CoreAPIError(RuntimeError):
    pass


class LogUploadOutcomeUnknown(CoreAPIError):
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


def _decode_log_download(value: Any) -> bytes:
    if not isinstance(value, dict):
        raise CoreAPIError("Core returned an invalid log download")
    download = cast(dict[str, Any], value)
    filename = download.get("filename")
    size = download.get("size")
    encoded = download.get("content")
    if (
        not isinstance(filename, str)
        or not filename
        or len(filename.encode("utf-8")) > CORE_MAX_LOG_FILENAME_BYTES
        or type(size) is not int
        or size < 0
        or size > LOG_UPLOAD_MAX_BYTES
        or not isinstance(encoded, str)
        or len(encoded) > ((LOG_UPLOAD_MAX_BYTES + 2) // 3 * 4)
    ):
        raise CoreAPIError("Core returned an invalid log download")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise CoreAPIError("Core returned an invalid log download") from error
    if len(content) != size:
        raise CoreAPIError("Core returned an invalid log download")
    return content


def _valid_online_verification_url(value: Any) -> bool:
    if not isinstance(value, str) or len(value.encode("utf-8")) > ONLINE_VERIFICATION_MAX_URL_BYTES:
        return False
    try:
        parsed = urllib.parse.urlparse(value)
        return (
            parsed.scheme == "https"
            and parsed.hostname == ONLINE_VERIFICATION_HOST
            and parsed.port in (None, 443)
            and parsed.username is None
            and parsed.password is None
            and bool(parsed.path.strip("/"))
        )
    except ValueError:
        return False


def _validate_log_url(value: str) -> str:
    candidate = value.strip()
    if not candidate or len(candidate.encode("utf-8")) > LOG_UPLOAD_MAX_URL_BYTES:
        raise CoreAPIError("Log upload service returned an invalid URL")
    try:
        parsed = urllib.parse.urlparse(candidate)
        valid = (
            parsed.scheme == "https"
            and parsed.hostname == LOG_UPLOAD_HOST
            and parsed.port in (None, 443)
            and parsed.username is None
            and parsed.password is None
            and bool(parsed.path.strip("/"))
        )
    except ValueError as error:
        raise CoreAPIError("Log upload service returned an invalid URL") from error
    if not valid:
        raise CoreAPIError("Log upload service returned an invalid URL")
    return candidate


def _log_upload_tls_context() -> ssl.SSLContext:
    try:
        return ssl.create_default_context(cafile=LOG_UPLOAD_CA_FILE)
    except OSError as error:
        detail = f"{type(error).__name__}: {error}"
        decky.logger.exception("Log upload TLS trust store is unavailable")
        raise CoreAPIError(f"Log upload TLS trust store is unavailable ({detail})") from error


async def _upload_log_content(content: bytes) -> str:
    if len(content) > LOG_UPLOAD_MAX_BYTES:
        raise CoreAPIError("Core log file is too large to upload")
    form = aiohttp.FormData()
    form.add_field(
        "file",
        content,
        filename="core.log",
        content_type="application/octet-stream",
    )
    timeout = aiohttp.ClientTimeout(total=30.0, connect=10.0)
    tls_context = _log_upload_tls_context()
    try:
        async with (
            aiohttp.ClientSession(timeout=timeout) as session,
            session.post(
                LOG_UPLOAD_URL,
                data=form,
                allow_redirects=False,
                ssl=tls_context,
                headers={"Accept": "text/plain", "User-Agent": "zaparoo-decky-log-upload"},
            ) as response,
        ):
            if str(response.url) != LOG_UPLOAD_URL:
                raise LogUploadOutcomeUnknown(
                    "Log upload outcome is unknown. No valid share URL was returned."
                )
            if response.status != HTTP_OK_STATUS:
                raise LogUploadOutcomeUnknown(
                    "Log upload outcome is unknown. Service returned an error after transmission."
                )
            response_body = bytearray()
            async for chunk in response.content.iter_chunked(1 << 10):
                response_body.extend(chunk)
                if len(response_body) > LOG_UPLOAD_MAX_URL_BYTES:
                    raise LogUploadOutcomeUnknown(
                        "Log upload outcome is unknown. Service response was too large."
                    )
    except LogUploadOutcomeUnknown:
        raise
    except CoreAPIError:
        raise
    except aiohttp.ClientConnectorError as error:
        detail = f"{type(error).__name__}: {error}"
        if len(detail) > CORE_ERROR_MAX_CHARS:
            detail = detail[: CORE_ERROR_MAX_CHARS - 3] + "..."
        decky.logger.exception("Unable to connect to log upload service")
        raise CoreAPIError(f"Unable to connect to log upload service ({detail})") from error
    except (aiohttp.ClientError, TimeoutError) as error:
        decky.logger.exception("Log upload outcome is unknown")
        raise LogUploadOutcomeUnknown(
            "Log upload outcome is unknown. Service may have received the log, but no share URL "
            "was returned. Wait before retrying."
        ) from error
    try:
        return _validate_log_url(response_body.decode("utf-8"))
    except (CoreAPIError, UnicodeDecodeError) as error:
        raise LogUploadOutcomeUnknown(
            "Log upload outcome is unknown. Service returned an invalid share URL."
        ) from error


class Plugin:
    def __init__(self) -> None:
        self._request_ids = itertools.count(1)
        self._workflow_ids = itertools.count(1)
        self._notification_task: asyncio.Task[None] | None = None
        self._workflow_tasks: set[asyncio.Task[None]] = set()
        self._active_upload_task: asyncio.Task[Any] | None = None
        self._active_bootstrap_task: asyncio.Task[Any] | None = None
        self._bootstrap_lock = asyncio.Lock()
        self._workflow_lock = asyncio.Lock()
        self._upload_lock = asyncio.Lock()
        self._unloading = False
        self._pairing_workflow_id: int | None = None
        self._pairing_workflow_delivered = False
        self._pairing_workflow_claimed = False
        self._pairing_restore_encryption = False
        self._pairing_client_ids: frozenset[str] = frozenset()
        self._pairing_last_terminal_id: int | None = None
        self._online_link_workflow_id: int | None = None
        self._online_link_workflow_delivered = False
        self._online_link_workflow_claimed = False
        self._online_link_last_terminal: tuple[int, dict[str, Any]] | None = None
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
        binary_installed = binary.exists() or binary.is_symlink()
        service_installed = self._service_unit().is_file()
        service_active = self._service_active_sync()
        if not supported:
            action = "unsupported"
        elif binary_installed:
            action = "start"
        else:
            action = "install"
        return {
            "supported": supported,
            "connected": False,
            "binaryInstalled": binary_installed,
            "serviceInstalled": service_installed,
            "serviceActive": service_active,
            "action": action,
            "progress": dict(self._bootstrap_progress),
            **({"reason": reason} if reason is not None else {}),
        }

    async def get_bootstrap_status(self) -> dict[str, Any]:
        status = await asyncio.to_thread(self._bootstrap_status_sync)
        try:
            version = await self._rpc("version")
        except CoreAPIError:
            return status
        status.update({"connected": True, "action": "none", "version": version})
        return status

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

    async def _prepare_core_binary(self, release: CoreRelease, temporary_path: Path) -> Path:
        archive_path = temporary_path / release.archive_name
        temporary_binary = temporary_path / "zaparoo"
        await self._set_bootstrap_progress(
            "downloading", f"Downloading Core {release.version}", version=release.version
        )
        await asyncio.to_thread(_download_core_release_sync, release, archive_path)
        await self._set_bootstrap_progress(
            "verifying", "Verifying Core release", version=release.version
        )
        await asyncio.to_thread(_extract_core_binary_sync, archive_path, temporary_binary)
        await self._verify_binary(temporary_binary, release.version)
        return temporary_binary

    async def _install_prepared_core(
        self,
        release: CoreRelease,
        temporary_binary: Path,
        binary: Path,
    ) -> dict[str, Any]:
        latest_status = await self.get_bootstrap_status()
        if latest_status["connected"] or latest_status["binaryInstalled"]:
            raise CoreAPIError("Core appeared during installation; no files were replaced")
        application_install_started = False
        try:
            await self._set_bootstrap_progress(
                "installing", "Installing Core application", version=release.version
            )
            application_install_started = True
            await self._run_command(str(temporary_binary), "-install", "application", timeout=30.0)
            if not await asyncio.to_thread(_is_regular_file, binary):
                raise CoreAPIError("Core application installer did not create canonical binary")
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
            return await self._wait_for_core(release.version)
        except asyncio.CancelledError:
            if application_install_started:
                try:
                    await asyncio.wait_for(
                        self._rollback_bootstrap(binary),
                        timeout=BOOTSTRAP_ROLLBACK_TIMEOUT,
                    )
                except (Exception, asyncio.CancelledError):
                    decky.logger.exception("Could not roll back cancelled Core installation")
            raise
        except Exception:
            if application_install_started:
                await self._rollback_bootstrap(binary)
            raise

    async def install_core(self) -> dict[str, Any]:
        self._ensure_workflow_start_allowed()
        async with self._bootstrap_lock:
            self._ensure_workflow_start_allowed()
            task = asyncio.current_task()
            self._active_bootstrap_task = task
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
                binary = self._canonical_binary()
                with tempfile.TemporaryDirectory(prefix="zaparoo-decky-") as temporary:
                    temporary_binary = await self._prepare_core_binary(release, Path(temporary))
                    version = await self._install_prepared_core(release, temporary_binary, binary)
                await self._set_bootstrap_progress(
                    "complete",
                    f"Core {release.version} is ready",
                    busy=False,
                    version=release.version,
                )
                return version
            except Exception as error:
                message = str(error) if str(error) else "Core installation failed"
                await self._set_bootstrap_progress("failed", message, busy=False, error=message)
                if isinstance(error, CoreAPIError):
                    raise
                raise CoreAPIError(message) from error
            finally:
                if self._active_bootstrap_task is task:
                    self._active_bootstrap_task = None

    async def start_core(self) -> dict[str, Any]:
        self._ensure_workflow_start_allowed()
        async with self._bootstrap_lock:
            self._ensure_workflow_start_allowed()
            task = asyncio.current_task()
            self._active_bootstrap_task = task
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
            finally:
                if self._active_bootstrap_task is task:
                    self._active_bootstrap_task = None

    @staticmethod
    async def _read_http_body(response: Any, maximum_bytes: int) -> bytes:
        body = bytearray()
        async for chunk in response.content.iter_chunked(1 << 14):
            body.extend(chunk)
            if len(body) > maximum_bytes:
                raise CoreAPIError("Core response is too large")
        return bytes(body)

    @staticmethod
    def _bounded_core_error(value: Any) -> str:
        if isinstance(value, dict):
            raw = cast(dict[str, Any], value).get("message", "Unknown Core error")
        else:
            raw = value
        message = str(raw)
        if len(message) > CORE_ERROR_MAX_CHARS:
            return message[: CORE_ERROR_MAX_CHARS - 3] + "..."
        return message

    async def _rpc(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        maximum_response_bytes: int = MAX_RESPONSE_BYTES,
    ) -> Any:
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": next(self._request_ids),
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        client_timeout = aiohttp.ClientTimeout(total=timeout, connect=min(timeout, DEFAULT_TIMEOUT))
        try:
            async with (
                aiohttp.ClientSession(timeout=client_timeout) as session,
                session.post(
                    API_URL,
                    json=payload,
                    allow_redirects=False,
                    headers={"Accept": "application/json"},
                ) as response,
            ):
                if str(response.url) != API_URL or response.status != HTTP_OK_STATUS:
                    raise CoreAPIError(f"Core request failed: {method}")
                response_data = await self._read_http_body(response, maximum_response_bytes)
            decoded = json.loads(response_data)
        except CoreAPIError as error:
            if str(error) == "Core response is too large":
                raise CoreAPIError(f"Core response is too large: {method}") from error
            raise
        except (
            aiohttp.ClientError,
            TimeoutError,
            json.JSONDecodeError,
            UnicodeDecodeError,
        ) as error:
            raise CoreAPIError(f"Core request failed: {method}") from error
        if not isinstance(decoded, dict):
            raise CoreAPIError(f"Core returned an invalid response: {method}")
        body = cast(dict[str, Any], decoded)
        rpc_error = body.get("error")
        if rpc_error is not None:
            raise CoreAPIError(self._bounded_core_error(rpc_error))
        if "result" not in body:
            raise CoreAPIError(f"Core response has no result: {method}")
        return body["result"]

    async def get_status(self) -> dict[str, Any]:
        try:
            version = await self._rpc("version")
        except CoreAPIError as error:
            return {"connected": False, "pluginVersion": PLUGIN_VERSION, "error": str(error)}

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
        status: dict[str, Any] = {
            "connected": True,
            "pluginVersion": PLUGIN_VERSION,
            "version": version,
            "errors": {},
        }
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

    def _ensure_workflow_start_allowed(self) -> None:
        if self._unloading:
            raise CoreAPIError("Zaparoo plugin is unloading")

    def _track_workflow_task(self, operation: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(operation)
        self._workflow_tasks.add(task)
        task.add_done_callback(self._workflow_tasks.discard)

    async def _cleanup_unclaimed_pairing(self, workflow_id: int) -> None:
        await asyncio.sleep(WORKFLOW_CLAIM_TIMEOUT)
        while not self._unloading:
            async with self._workflow_lock:
                if self._pairing_workflow_id != workflow_id or self._pairing_workflow_claimed:
                    return
                try:
                    await self._finish_client_pairing_locked(
                        cancel=True,
                        restore=True,
                        workflow_id=workflow_id,
                    )
                except Exception:
                    decky.logger.exception("Could not clean up unclaimed client pairing")
                if self._pairing_workflow_id != workflow_id:
                    return
            await asyncio.sleep(WORKFLOW_CLEANUP_RETRY_DELAY)

    async def _cleanup_unclaimed_online_link(self, workflow_id: int) -> None:
        await asyncio.sleep(WORKFLOW_CLAIM_TIMEOUT)
        while not self._unloading:
            async with self._workflow_lock:
                if (
                    self._online_link_workflow_id != workflow_id
                    or self._online_link_workflow_claimed
                ):
                    return
                try:
                    await self._cancel_online_link_locked(workflow_id)
                except Exception:
                    decky.logger.exception("Could not clean up unclaimed Online link")
                if self._online_link_workflow_id != workflow_id:
                    return
            await asyncio.sleep(WORKFLOW_CLEANUP_RETRY_DELAY)

    @staticmethod
    def _validate_workflow_id(workflow_id: Any) -> int:
        if type(workflow_id) is not int or workflow_id <= 0:
            raise CoreAPIError("Invalid workflow ID")
        return workflow_id

    @staticmethod
    def _client_ids(value: Any) -> frozenset[str]:
        if not isinstance(value, dict):
            raise CoreAPIError("Core returned invalid client status")
        clients_value = cast(dict[str, Any], value).get("clients")
        if not isinstance(clients_value, list):
            raise CoreAPIError("Core returned invalid client status")
        clients = cast(list[Any], clients_value)
        if len(clients) > CORE_MAX_CLIENTS:
            raise CoreAPIError("Core returned invalid client status")
        client_ids: set[str] = set()
        for client in clients:
            if not isinstance(client, dict):
                raise CoreAPIError("Core returned invalid client status")
            client_id = cast(dict[str, Any], client).get("clientId")
            if (
                not isinstance(client_id, str)
                or not client_id
                or len(client_id) > CORE_MAX_CLIENT_ID_CHARS
            ):
                raise CoreAPIError("Core returned invalid client status")
            client_ids.add(client_id)
        return frozenset(client_ids)

    async def _encryption_enabled_locked(self) -> bool:
        settings = await self._rpc("settings", timeout=5.0)
        if (
            not isinstance(settings, dict)
            or type(cast(dict[str, Any], settings).get("encryption")) is not bool
        ):
            raise CoreAPIError("Core returned invalid encryption status")
        return cast(bool, cast(dict[str, Any], settings)["encryption"])

    async def _pairing_has_new_client_locked(self) -> bool:
        clients = self._client_ids(await self._rpc("clients", timeout=5.0))
        return bool(clients.difference(self._pairing_client_ids))

    def _clear_client_pairing_locked(self, workflow_id: int) -> None:
        self._pairing_last_terminal_id = workflow_id
        self._pairing_workflow_id = None
        self._pairing_workflow_delivered = False
        self._pairing_workflow_claimed = False
        self._pairing_restore_encryption = False
        self._pairing_client_ids = frozenset()

    def _require_client_pairing_locked(self, workflow_id: int) -> bool:
        if self._pairing_workflow_id == workflow_id:
            return True
        if self._pairing_last_terminal_id == workflow_id:
            return False
        raise CoreAPIError("Client pairing workflow is no longer active")

    async def _restore_pairing_encryption_locked(self) -> None:
        try:
            await self._rpc("settings.update", {"encryption": False}, timeout=5.0)
        except Exception as update_error:
            try:
                enabled = await self._encryption_enabled_locked()
            except Exception as status_error:
                raise CoreAPIError("Could not restore client pairing encryption") from status_error
            if enabled:
                raise CoreAPIError("Could not restore client pairing encryption") from update_error
        self._pairing_restore_encryption = False

    async def _finish_client_pairing_locked(
        self,
        *,
        cancel: bool,
        restore: bool,
        workflow_id: int | None = None,
    ) -> None:
        current_id = self._pairing_workflow_id
        if workflow_id is not None and not self._require_client_pairing_locked(workflow_id):
            return
        if current_id is None:
            return

        errors: list[Exception] = []
        cancel_confirmed = not cancel
        if cancel:
            try:
                await self._rpc("clients.pair.cancel", timeout=5.0)
                cancel_confirmed = True
            except Exception as error:
                errors.append(error)

        if restore and self._pairing_restore_encryption:
            try:
                paired = await self._pairing_has_new_client_locked()
            except Exception as error:
                errors.append(error)
            else:
                if paired:
                    self._clear_client_pairing_locked(current_id)
                    return
                if cancel_confirmed:
                    try:
                        await self._restore_pairing_encryption_locked()
                    except Exception as error:
                        errors.append(error)

        if errors:
            raise CoreAPIError("Could not finish client pairing") from errors[0]
        self._clear_client_pairing_locked(current_id)

    async def start_client_pairing(self, secure: bool = False) -> Any:
        if type(secure) is not bool:
            raise CoreAPIError("Invalid secure pairing request")
        self._ensure_workflow_start_allowed()
        async with self._workflow_lock:
            self._ensure_workflow_start_allowed()
            if self._pairing_workflow_id is not None:
                if self._pairing_workflow_delivered:
                    raise CoreAPIError("Client pairing is already active")
                await self._finish_client_pairing_locked(cancel=True, restore=True)

            client_ids = self._client_ids(await self._rpc("clients", timeout=5.0))
            enable_encryption = secure and not await self._encryption_enabled_locked()
            workflow_id = next(self._workflow_ids)
            self._pairing_workflow_id = workflow_id
            self._pairing_workflow_delivered = False
            self._pairing_workflow_claimed = False
            self._pairing_client_ids = client_ids
            self._pairing_restore_encryption = enable_encryption
            try:
                if enable_encryption:
                    await self._rpc("settings.update", {"encryption": True}, timeout=5.0)
                result = await self._rpc("clients.pair.start", timeout=5.0)
                if not isinstance(result, dict):
                    raise CoreAPIError("Core returned invalid client pairing details")
                pairing = cast(dict[str, Any], result)
                pin = pairing.get("pin")
                expires_at = pairing.get("expiresAt")
                if (
                    not isinstance(pin, str)
                    or not pin
                    or len(pin) > CORE_MAX_PAIRING_PIN_CHARS
                    or type(expires_at) is not int
                    or expires_at < 0
                    or expires_at > JS_MAX_SAFE_INTEGER
                ):
                    raise CoreAPIError("Core returned invalid client pairing details")
            except Exception:
                try:
                    await self._finish_client_pairing_locked(cancel=True, restore=True)
                except Exception as cleanup_error:
                    self._track_workflow_task(self._cleanup_unclaimed_pairing(workflow_id))
                    raise CoreAPIError(
                        "Could not roll back client pairing startup"
                    ) from cleanup_error
                raise
            self._pairing_workflow_delivered = True
            self._track_workflow_task(self._cleanup_unclaimed_pairing(workflow_id))
            return {**cast(dict[str, Any], result), "workflowId": workflow_id}

    async def claim_client_pairing(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            if not self._require_client_pairing_locked(workflow_id):
                raise CoreAPIError("Client pairing workflow is no longer active")
            self._pairing_workflow_claimed = True

    async def cancel_client_pairing(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            await self._finish_client_pairing_locked(
                cancel=True,
                restore=True,
                workflow_id=workflow_id,
            )

    async def complete_client_pairing(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            if not self._require_client_pairing_locked(workflow_id):
                return
            if not await self._pairing_has_new_client_locked():
                raise CoreAPIError("Client pairing has not completed")
            self._clear_client_pairing_locked(workflow_id)

    async def expire_client_pairing(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            await self._finish_client_pairing_locked(
                cancel=True,
                restore=True,
                workflow_id=workflow_id,
            )

    async def upload_logs(self) -> dict[str, str]:
        self._ensure_workflow_start_allowed()
        if self._upload_lock.locked():
            raise CoreAPIError("A Core log upload is already in progress")
        async with self._upload_lock:
            self._ensure_workflow_start_allowed()
            task = asyncio.current_task()
            self._active_upload_task = task
            try:
                download = await self._rpc(
                    "settings.logs.download",
                    timeout=10.0,
                    maximum_response_bytes=LOG_DOWNLOAD_MAX_RESPONSE_BYTES,
                )
                content = await asyncio.to_thread(_decode_log_download, download)
                try:
                    url = await _upload_log_content(content)
                except LogUploadOutcomeUnknown as error:
                    return {"outcome": "unknown", "error": str(error)[:CORE_ERROR_MAX_CHARS]}
                return {"outcome": "success", "url": url}
            finally:
                if self._active_upload_task is task:
                    self._active_upload_task = None

    @staticmethod
    def _online_link_result(value: Any) -> tuple[dict[str, Any], str]:
        if not isinstance(value, dict):
            raise CoreAPIError("Core returned invalid Online link details")
        result = dict(cast(dict[str, Any], value))
        status = result.get("status")
        if status not in {"none", "pending", "approved", "failed", "cancelled"}:
            raise CoreAPIError("Core returned invalid Online link details")
        user_code = result.get("userCode")
        error = result.get("error")
        expires_at = result.get("expiresAt")
        if (
            (
                user_code is not None
                and (not isinstance(user_code, str) or len(user_code) > CORE_MAX_ONLINE_CODE_CHARS)
            )
            or (
                error is not None
                and (not isinstance(error, str) or len(error) > CORE_MAX_ONLINE_TEXT_CHARS)
            )
            or (
                expires_at is not None
                and (
                    not isinstance(expires_at, str)
                    or len(expires_at) > CORE_MAX_ONLINE_EXPIRY_CHARS
                )
            )
        ):
            raise CoreAPIError("Core returned invalid Online link details")
        if isinstance(expires_at, str):
            try:
                datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            except ValueError as error_value:
                raise CoreAPIError("Core returned invalid Online link details") from error_value
        if status == "pending":
            urls = [result.get("verificationUrl"), result.get("verificationUrlComplete")]
            provided_urls = [url for url in urls if url is not None]
            if not provided_urls or any(
                not _valid_online_verification_url(url) for url in provided_urls
            ):
                raise CoreAPIError("Core returned invalid Online link details")
        return result, cast(str, status)

    def _clear_online_link_locked(self, result: dict[str, Any]) -> None:
        workflow_id = self._online_link_workflow_id
        if workflow_id is not None:
            self._online_link_last_terminal = (workflow_id, dict(result))
        self._online_link_workflow_id = None
        self._online_link_workflow_delivered = False
        self._online_link_workflow_claimed = False

    def _require_online_link_locked(self, workflow_id: int) -> bool:
        if self._online_link_workflow_id == workflow_id:
            return True
        if (
            self._online_link_last_terminal is not None
            and self._online_link_last_terminal[0] == workflow_id
        ):
            return False
        raise CoreAPIError("Online link workflow is no longer active")

    async def _reconcile_online_cancel_locked(self, reason: Exception) -> None:
        try:
            status_result, status = self._online_link_result(
                await self._rpc("settings.auth.link.status", timeout=5.0)
            )
        except Exception as status_error:
            raise CoreAPIError("Could not cancel Online link") from status_error
        if status == "pending":
            raise CoreAPIError("Could not cancel Online link") from reason
        self._clear_online_link_locked(status_result)

    async def _cancel_online_link_locked(self, workflow_id: int | None = None) -> None:
        current_id = self._online_link_workflow_id
        if workflow_id is not None and not self._require_online_link_locked(workflow_id):
            return
        if current_id is None:
            return
        try:
            result = await self._rpc("settings.auth.link.cancel", timeout=5.0)
        except Exception as cancel_error:
            await self._reconcile_online_cancel_locked(cancel_error)
            return
        try:
            terminal, status = self._online_link_result(result)
        except CoreAPIError as result_error:
            await self._reconcile_online_cancel_locked(result_error)
            return
        if status == "pending":
            await self._reconcile_online_cancel_locked(
                CoreAPIError("Online cancellation did not reach a terminal state")
            )
            return
        self._clear_online_link_locked(terminal)

    async def start_online_link(self) -> Any:
        self._ensure_workflow_start_allowed()
        async with self._workflow_lock:
            self._ensure_workflow_start_allowed()
            if self._online_link_workflow_id is not None:
                if self._online_link_workflow_delivered:
                    raise CoreAPIError("Online linking is already active")
                await self._cancel_online_link_locked()
            workflow_id = next(self._workflow_ids)
            self._online_link_workflow_id = workflow_id
            self._online_link_workflow_delivered = False
            self._online_link_workflow_claimed = False
            try:
                result, status = self._online_link_result(
                    await self._rpc("settings.auth.link", timeout=10.0)
                )
            except Exception:
                try:
                    await self._cancel_online_link_locked(workflow_id)
                except Exception as cleanup_error:
                    self._track_workflow_task(self._cleanup_unclaimed_online_link(workflow_id))
                    raise CoreAPIError("Could not roll back Online link startup") from cleanup_error
                raise
            result["workflowId"] = workflow_id
            if status != "pending":
                self._clear_online_link_locked(result)
                return result
            self._online_link_workflow_delivered = True
            self._track_workflow_task(self._cleanup_unclaimed_online_link(workflow_id))
            return result

    async def claim_online_link(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            if not self._require_online_link_locked(workflow_id):
                raise CoreAPIError("Online link workflow is no longer active")
            self._online_link_workflow_claimed = True

    async def get_online_link_status(self, workflow_id: int) -> Any:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            if not self._require_online_link_locked(workflow_id):
                assert self._online_link_last_terminal is not None
                return {**self._online_link_last_terminal[1], "workflowId": workflow_id}
            result, status = self._online_link_result(
                await self._rpc("settings.auth.link.status", timeout=5.0)
            )
            result["workflowId"] = workflow_id
            if status != "pending":
                self._clear_online_link_locked(result)
            return result

    async def cancel_online_link(self, workflow_id: int) -> None:
        workflow_id = self._validate_workflow_id(workflow_id)
        async with self._workflow_lock:
            await self._cancel_online_link_locked(workflow_id)

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
        if notification is None:
            return
        if notification.get("method") == "clients.paired":
            async with self._workflow_lock:
                workflow_id = self._pairing_workflow_id
                if workflow_id is not None:
                    try:
                        paired = await self._pairing_has_new_client_locked()
                    except CoreAPIError:
                        paired = False
                    if paired:
                        self._clear_client_pairing_locked(workflow_id)
        await decky.emit(CORE_NOTIFICATION_EVENT, notification)

    async def _notification_session(self, timeout: aiohttp.ClientTimeout) -> None:
        connected = False
        # Decky's aiohttp uses the legacy float close timeout; newer stubs omit that form.
        websocket_timeout = cast(Any, WEBSOCKET_CLOSE_TIMEOUT)
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as session,
                session.ws_connect(
                    WS_API_URL,
                    heartbeat=30.0,
                    max_msg_size=MAX_RESPONSE_BYTES,
                    timeout=websocket_timeout,
                ) as websocket,
            ):
                decky.logger.info("Connected to Core notification stream")
                await decky.emit(CORE_CONNECTION_EVENT, True)
                connected = True
                async for message in websocket:
                    if self._unloading:
                        break
                    if message.type is aiohttp.WSMsgType.TEXT:
                        await self._forward_notification(message.data)
                    elif message.type in {
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.ERROR,
                    }:
                        break
        finally:
            if connected and not self._unloading:
                await decky.emit(CORE_CONNECTION_EVENT, False)

    async def _notification_loop(self) -> None:
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=DEFAULT_TIMEOUT,
            sock_read=None,
        )
        while not self._unloading:
            try:
                await self._notification_session(timeout)
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, TimeoutError) as error:
                decky.logger.debug("Core notification stream unavailable: %s", error)
            except Exception:
                decky.logger.exception("Unexpected Core notification stream failure")
            if not self._unloading:
                await asyncio.sleep(NOTIFICATION_RECONNECT_DELAY)

    async def _main(self) -> None:
        decky.logger.info("Zaparoo plugin loaded")
        self._notification_task = asyncio.create_task(self._notification_loop())

    async def _cancel_active_upload(self) -> None:
        task = self._active_upload_task
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _cancel_active_bootstrap(self) -> None:
        task = self._active_bootstrap_task
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _cancel_workflow_tasks(self) -> None:
        tasks = list(self._workflow_tasks)
        self._workflow_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _detach_notifications(self) -> None:
        task = self._notification_task
        self._notification_task = None
        if task is not None and task.done():
            self._consume_task_result(task)
        # Decky stops the plugin event loop immediately after _unload returns.
        # Awaiting aiohttp WebSocket teardown here can instead force Decky's SIGKILL.

    @staticmethod
    def _consume_task_result(task: asyncio.Task[Any]) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            task.exception()

    async def _complete_unload(self) -> None:
        self._detach_notifications()
        await self._cancel_active_upload()
        await self._cancel_active_bootstrap()
        await self._cancel_workflow_tasks()
        await self._cleanup_workflows()

    async def _cleanup_workflows(self) -> None:
        async with self._workflow_lock:
            try:
                await self._finish_client_pairing_locked(cancel=True, restore=True)
            except Exception:
                decky.logger.exception("Could not clean up client pairing during plugin unload")
            try:
                await self._cancel_online_link_locked()
            except Exception:
                decky.logger.exception("Could not clean up Online linking during plugin unload")

    async def _unload(self) -> None:
        self._unloading = True
        shutdown_task = asyncio.current_task()
        assert shutdown_task is not None
        timed_out = False

        def expire_cleanup() -> None:
            nonlocal timed_out
            timed_out = True
            shutdown_task.cancel()

        deadline = asyncio.get_running_loop().call_later(
            UNLOAD_CLEANUP_TIMEOUT,
            expire_cleanup,
        )
        try:
            await self._complete_unload()
        except asyncio.CancelledError:
            if not timed_out:
                raise
            decky.logger.warning("Zaparoo plugin unload cleanup exceeded its deadline")
        except Exception:
            decky.logger.exception("Unexpected Zaparoo plugin unload cleanup failure")
        finally:
            deadline.cancel()
        decky.logger.info("Zaparoo plugin unloaded")
