import asyncio
import io
import json
import os
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, call, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
sys.modules.setdefault("decky", types.SimpleNamespace(logger=MagicMock()))
# Decky Loader provides aiohttp at runtime. Unit tests stub the small surface
# referenced during module import so development needs no Python dependency.
aiohttp_stub = types.ModuleType("aiohttp")
aiohttp_stub.ClientError = type("ClientError", (Exception,), {})
aiohttp_stub.ClientTimeout = MagicMock()
sys.modules.setdefault("aiohttp", aiohttp_stub)

from main import (  # noqa: E402
    CORE_RELEASE_API_URL,
    MAX_RESPONSE_BYTES,
    CoreAPIError,
    CoreRelease,
    Plugin,
    _extract_core_binary_sync,
    _latest_core_release_sync,
    _semantic_version,
)


class Response:
    def __init__(self, body, url=CORE_RELEASE_API_URL):
        self.body = body
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, size=-1):
        return json.dumps(self.body).encode("utf-8")[:size]

    def geturl(self):
        return self.url


class EmptyWebSocket:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def __aiter__(self):
        async def messages():
            if False:
                yield None

        return messages()


class ClientSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def ws_connect(self, *_args, **_kwargs):
        return EmptyWebSocket()


class BootstrapHelpersTests(unittest.TestCase):
    def test_semantic_version_accepts_stable_release_only(self):
        self.assertEqual((2, 17, 0), _semantic_version("v2.17.0"))
        self.assertIsNone(_semantic_version("v2.17.0-beta.1"))
        self.assertIsNone(_semantic_version("latest"))

    def test_latest_release_requires_exact_asset_and_digest(self):
        digest = "a" * 64
        metadata = {
            "tag_name": "v2.17.0",
            "draft": False,
            "prerelease": False,
            "assets": [
                {
                    "name": "zaparoo-steamos_amd64-2.17.0.tar.gz",
                    "browser_download_url": (
                        "https://github.com/ZaparooProject/zaparoo-core/releases/download/"
                        "v2.17.0/zaparoo-steamos_amd64-2.17.0.tar.gz"
                    ),
                    "digest": f"sha256:{digest}",
                    "size": 1024,
                }
            ],
        }
        with patch("urllib.request.urlopen", return_value=Response(metadata)):
            release = _latest_core_release_sync()

        self.assertEqual(
            CoreRelease(
                version="2.17.0",
                archive_name="zaparoo-steamos_amd64-2.17.0.tar.gz",
                url=metadata["assets"][0]["browser_download_url"],
                digest=digest,
                size=1024,
            ),
            release,
        )

        metadata["assets"][0]["digest"] = None
        with (
            patch("urllib.request.urlopen", return_value=Response(metadata)),
            self.assertRaisesRegex(CoreAPIError, "SHA-256"),
        ):
            _latest_core_release_sync()

    def test_extracts_only_regular_zaparoo_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = os.path.abspath(temporary)
            archive_path = os.path.join(root, "core.tar.gz")
            destination = os.path.join(root, "zaparoo")
            payload = b"binary"
            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("release/zaparoo")
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            _extract_core_binary_sync(Path(archive_path), Path(destination))
            with open(destination, "rb") as binary:
                self.assertEqual(payload, binary.read())

            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("release/zaparoo")
                member.type = tarfile.SYMTYPE
                member.linkname = "/tmp/escape"
                archive.addfile(member)
            with self.assertRaisesRegex(CoreAPIError, "unsafe member"):
                _extract_core_binary_sync(Path(archive_path), Path(f"{destination}-unsafe"))


class CoreAPITests(unittest.IsolatedAsyncioTestCase):
    def test_rpc_sync_returns_result(self):
        plugin = Plugin()
        response = Response({"jsonrpc": "2.0", "id": 1, "result": {"version": "2.17.0"}})
        with patch("urllib.request.urlopen", return_value=response) as urlopen:
            result = plugin._rpc_sync("version")

        self.assertEqual({"version": "2.17.0"}, result)
        request = urlopen.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual("version", payload["method"])
        self.assertNotIn("params", payload)

    def test_rpc_sync_rejects_oversized_response(self):
        plugin = Plugin()
        response = Response({"result": "x" * MAX_RESPONSE_BYTES})

        with (
            patch("urllib.request.urlopen", return_value=response),
            self.assertRaisesRegex(CoreAPIError, "response is too large"),
        ):
            plugin._rpc_sync("version")

    def test_rpc_sync_raises_core_error(self):
        plugin = Plugin()
        response = Response(
            {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "busy"}}
        )
        with (
            patch("urllib.request.urlopen", return_value=response),
            self.assertRaisesRegex(CoreAPIError, "busy"),
        ):
            plugin._rpc_sync("media.generate")

    async def test_get_status_reports_disconnected_core(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(side_effect=CoreAPIError("Core request failed: version"))

        status = await plugin.get_status()

        self.assertFalse(status["connected"])
        self.assertIn("version", status["error"])

    async def test_bootstrap_status_gives_running_core_precedence(self):
        plugin = Plugin()
        version = {"version": "2.17.0", "platform": "steamos"}
        with (
            patch.object(plugin, "_supported_platform", return_value=(True, None)),
            patch.object(plugin, "_rpc_sync", return_value=version),
            patch.object(plugin, "_service_active_sync", return_value=False),
            tempfile.TemporaryDirectory() as home,
            patch.object(sys.modules["decky"], "DECKY_USER_HOME", home, create=True),
        ):
            status = await plugin.get_bootstrap_status()

        self.assertTrue(status["connected"])
        self.assertEqual("none", status["action"])
        self.assertEqual(version, status["version"])

    async def test_install_core_refuses_running_core(self):
        plugin = Plugin()
        plugin.get_bootstrap_status = AsyncMock(
            return_value={"supported": True, "connected": True, "binaryInstalled": False}
        )
        emit = AsyncMock()
        with (
            patch.object(sys.modules["decky"], "emit", emit, create=True),
            patch("main._latest_core_release_sync") as latest_release,
            self.assertRaisesRegex(CoreAPIError, "already running"),
        ):
            await plugin.install_core()

        latest_release.assert_not_called()
        self.assertEqual("failed", plugin._bootstrap_progress["phase"])

    async def test_install_core_uses_canonical_application_and_user_service(self):
        plugin = Plugin()
        release = CoreRelease(
            "2.17.0",
            "zaparoo-steamos_amd64-2.17.0.tar.gz",
            "https://github.com/ZaparooProject/zaparoo-core/releases/download/"
            "v2.17.0/zaparoo-steamos_amd64-2.17.0.tar.gz",
            "a" * 64,
            1024,
        )
        status = {"supported": True, "connected": False, "binaryInstalled": False}
        plugin.get_bootstrap_status = AsyncMock(side_effect=[status, status])
        plugin._verify_binary = AsyncMock(return_value="2.17.0")
        plugin._wait_for_core = AsyncMock(return_value={"version": "2.17.0", "platform": "steamos"})
        emit = AsyncMock()

        with (
            tempfile.TemporaryDirectory() as home,
            patch.object(sys.modules["decky"], "DECKY_USER_HOME", home, create=True),
            patch.object(sys.modules["decky"], "emit", emit, create=True),
            patch("main._latest_core_release_sync", return_value=release),
            patch("main._download_core_release_sync"),
            patch("main._extract_core_binary_sync") as extract,
        ):
            canonical = Path(home) / ".local" / "bin" / "zaparoo"

            def create_temporary_binary(_archive, destination):
                destination.write_bytes(b"temporary")
                destination.chmod(0o755)

            async def run_command(*args, **_kwargs):
                if args[1:] == ("-install", "application"):
                    canonical.parent.mkdir(parents=True, exist_ok=True)
                    canonical.write_bytes(b"installed")
                    canonical.chmod(0o755)
                return ""

            extract.side_effect = create_temporary_binary
            plugin._run_command = AsyncMock(side_effect=run_command)
            result = await plugin.install_core()

        self.assertEqual("2.17.0", result["version"])
        commands = [awaited.args for awaited in plugin._run_command.await_args_list]
        self.assertIn((str(canonical), "-install", "service"), commands)
        self.assertIn(("systemctl", "--user", "enable", "--now", "zaparoo.service"), commands)
        self.assertFalse(any("hardware" in command for command in commands))
        self.assertEqual("complete", plugin._bootstrap_progress["phase"])

    async def test_start_core_repairs_missing_service_without_reinstalling_application(self):
        plugin = Plugin()
        plugin.get_bootstrap_status = AsyncMock(
            return_value={"supported": True, "connected": False, "binaryInstalled": True}
        )
        plugin._verify_binary = AsyncMock(return_value="2.17.0")
        plugin._run_command = AsyncMock(return_value="")
        plugin._wait_for_core = AsyncMock(return_value={"version": "2.17.0", "platform": "steamos"})
        emit = AsyncMock()
        with (
            tempfile.TemporaryDirectory() as home,
            patch.object(sys.modules["decky"], "DECKY_USER_HOME", home, create=True),
            patch.object(sys.modules["decky"], "emit", emit, create=True),
        ):
            binary = Path(home) / ".local" / "bin" / "zaparoo"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"installed")
            await plugin.start_core()

        commands = [awaited.args for awaited in plugin._run_command.await_args_list]
        self.assertIn((str(binary), "-install", "service"), commands)
        self.assertNotIn((str(binary), "-install", "application"), commands)

    async def test_write_tag_sends_selected_reader(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        await plugin.write_tag("steam://1145360", "reader-1")

        plugin._rpc.assert_awaited_once_with(
            "readers.write",
            {"text": "steam://1145360", "readerId": "reader-1"},
            timeout=120.0,
        )

    async def test_set_encryption_uses_existing_core_setting(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        await plugin.set_encryption(True)

        plugin._rpc.assert_awaited_once_with("settings.update", {"encryption": True}, timeout=5.0)

    async def test_security_prompt_dismissal_persists_in_decky_settings(self):
        plugin = Plugin()
        with (
            tempfile.TemporaryDirectory() as settings_dir,
            patch.object(
                sys.modules["decky"], "DECKY_PLUGIN_SETTINGS_DIR", settings_dir, create=True
            ),
        ):
            self.assertFalse(await plugin.security_prompt_dismissed())
            await plugin.dismiss_security_prompt()
            self.assertTrue(await plugin.security_prompt_dismissed())

    async def test_start_client_pairing_uses_local_core_method(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value={"pin": "123456", "expiresAt": 1700000120})

        pairing = await plugin.start_client_pairing()

        self.assertEqual("123456", pairing["pin"])
        plugin._rpc.assert_awaited_once_with("clients.pair.start", timeout=5.0)

    async def test_cancel_client_pairing_uses_local_core_method(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value={})

        await plugin.cancel_client_pairing()

        plugin._rpc.assert_awaited_once_with("clients.pair.cancel", timeout=5.0)

    async def test_online_link_methods_use_existing_core_contracts(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value={"status": "pending"})

        await plugin.start_online_link()
        plugin._rpc.assert_awaited_once_with("settings.auth.link", timeout=10.0)

        plugin._rpc.reset_mock()
        await plugin.get_online_link_status()
        plugin._rpc.assert_awaited_once_with("settings.auth.link.status", timeout=5.0)

        plugin._rpc.reset_mock()
        await plugin.cancel_online_link()
        plugin._rpc.assert_awaited_once_with("settings.auth.link.cancel", timeout=5.0)

        plugin._rpc.reset_mock()
        await plugin.unlink_online()
        plugin._rpc.assert_awaited_once_with("settings.auth.unlink", timeout=5.0)

    async def test_dismiss_inbox_message_uses_existing_core_method(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        await plugin.dismiss_inbox_message(42)

        plugin._rpc.assert_awaited_once_with("inbox.delete", {"id": 42}, timeout=5.0)

        with self.assertRaisesRegex(CoreAPIError, "Invalid notification ID"):
            await plugin.dismiss_inbox_message(0)

    async def test_update_online_settings_allows_only_consent_fields(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)
        params = {"playtimeSyncEnabled": True, "backupRemoteSchedule": "weekly"}

        await plugin.update_online_settings(params)

        plugin._rpc.assert_awaited_once_with("settings.update", params, timeout=5.0)

        with self.assertRaisesRegex(CoreAPIError, "Invalid Online settings update"):
            await plugin.update_online_settings({"encryption": False})

    async def test_update_reader_settings_uses_existing_core_method(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)
        params = {"readersScanMode": "hold", "readersScanExitDelay": 2}

        await plugin.update_reader_settings(params)

        plugin._rpc.assert_awaited_once_with("settings.update", params, timeout=5.0)

    async def test_update_reader_settings_rejects_unknown_fields(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        with self.assertRaisesRegex(CoreAPIError, "Invalid reader settings update"):
            await plugin.update_reader_settings({"debugLogging": True})

        plugin._rpc.assert_not_awaited()

    async def test_update_media_database_uses_existing_core_method(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        await plugin.update_media_database()

        plugin._rpc.assert_awaited_once_with("media.generate", timeout=5.0)

    async def test_forwards_core_notifications_to_decky_frontend(self):
        plugin = Plugin()
        emit = AsyncMock()
        notification = {
            "jsonrpc": "2.0",
            "method": "media.indexing",
            "params": {"indexing": True},
        }

        with patch.object(sys.modules["decky"], "emit", emit, create=True):
            await plugin._forward_notification(json.dumps(notification))
            await plugin._forward_notification("not json")
            await plugin._forward_notification(json.dumps({"result": {}}))

        emit.assert_awaited_once_with("core_notification", notification)

    async def test_notification_session_reports_connect_and_disconnect(self):
        plugin = Plugin()
        emit = AsyncMock()

        with (
            patch("main.aiohttp.ClientSession", return_value=ClientSession(), create=True),
            patch.object(sys.modules["decky"], "emit", emit, create=True),
        ):
            await plugin._notification_session(MagicMock())

        self.assertEqual(
            [call("core_connection", True), call("core_connection", False)],
            emit.await_args_list,
        )

    async def test_notification_loop_recovers_from_unexpected_failure(self):
        plugin = Plugin()
        plugin._notification_session = AsyncMock(side_effect=RuntimeError("event failed"))

        with (
            patch("main.asyncio.sleep", AsyncMock(side_effect=asyncio.CancelledError)),
            self.assertRaises(asyncio.CancelledError),
        ):
            await plugin._notification_loop()

        plugin._notification_session.assert_awaited_once()
        sys.modules["decky"].logger.exception.assert_called_with(
            "Unexpected Core notification stream failure"
        )

    async def test_plugin_lifecycle_starts_and_stops_notification_task(self):
        plugin = Plugin()
        plugin._notification_loop = AsyncMock()

        await plugin._main()
        await asyncio.sleep(0)
        task = plugin._notification_task
        self.assertIsNotNone(task)

        await plugin._unload()
        self.assertIsNone(plugin._notification_task)
        plugin._notification_loop.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
