import asyncio
import base64
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
aiohttp_stub.ClientConnectorError = type(
    "ClientConnectorError",
    (aiohttp_stub.ClientError,),
    {},
)
aiohttp_stub.ClientSession = MagicMock()
aiohttp_stub.ClientTimeout = MagicMock()
aiohttp_stub.FormData = MagicMock()
aiohttp_stub.WSMsgType = types.SimpleNamespace(
    TEXT=object(),
    CLOSE=object(),
    CLOSED=object(),
    ERROR=object(),
)
sys.modules.setdefault("aiohttp", aiohttp_stub)

from main import (  # noqa: E402
    API_URL,
    CORE_ERROR_MAX_CHARS,
    CORE_RELEASE_API_URL,
    LOG_DOWNLOAD_MAX_RESPONSE_BYTES,
    LOG_UPLOAD_CA_FILE,
    LOG_UPLOAD_MAX_BYTES,
    LOG_UPLOAD_URL,
    MAX_RESPONSE_BYTES,
    PLUGIN_VERSION,
    CoreAPIError,
    CoreRelease,
    LogUploadOutcomeUnknown,
    Plugin,
    _decode_log_download,
    _extract_core_binary_sync,
    _latest_core_release_sync,
    _semantic_version,
    _upload_log_content,
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


class UploadContent:
    def __init__(self, chunks):
        self.chunks = chunks

    async def iter_chunked(self, _size):
        for chunk in self.chunks:
            yield chunk


class UploadResponse:
    def __init__(self, body, *, status=200, url=LOG_UPLOAD_URL):
        self.content = UploadContent([body])
        self.status = status
        self.url = url

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class UploadSession:
    def __init__(self, response):
        self.response = response
        self.post = MagicMock(return_value=response)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


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
    def __init__(self):
        self.ws_connect = MagicMock(return_value=EmptyWebSocket())

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


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

    def test_core_log_download_is_bounded_and_validated(self):
        content = b"test log content"
        download = {
            "filename": "core.log",
            "size": len(content),
            "content": base64.b64encode(content).decode("ascii"),
        }

        self.assertEqual(content, _decode_log_download(download))
        download["filename"] = "zaparoo.log"
        self.assertEqual(content, _decode_log_download(download))

        download["size"] = LOG_UPLOAD_MAX_BYTES + 1
        with self.assertRaisesRegex(CoreAPIError, "invalid log download"):
            _decode_log_download(download)

    def test_core_log_download_rejects_invalid_base64(self):
        with self.assertRaisesRegex(CoreAPIError, "invalid log download"):
            _decode_log_download({"filename": "core.log", "size": 1, "content": "!"})

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
    async def test_rpc_uses_total_timeout_and_returns_result(self):
        plugin = Plugin()
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"version": "2.17.0"}}).encode()
        response = UploadResponse(body, url=API_URL)
        session = UploadSession(response)
        with (
            patch("main.aiohttp.ClientTimeout") as client_timeout,
            patch("main.aiohttp.ClientSession", return_value=session),
        ):
            result = await plugin._rpc("version")

        self.assertEqual({"version": "2.17.0"}, result)
        client_timeout.assert_called_once_with(total=2.0, connect=2.0)
        session.post.assert_called_once()
        call_args = session.post.call_args
        self.assertEqual(API_URL, call_args.args[0])
        self.assertEqual("version", call_args.kwargs["json"]["method"])
        self.assertNotIn("params", call_args.kwargs["json"])
        self.assertFalse(call_args.kwargs["allow_redirects"])

    async def test_rpc_rejects_oversized_response(self):
        plugin = Plugin()
        response = UploadResponse(b"x" * (MAX_RESPONSE_BYTES + 1), url=API_URL)
        with (
            patch("main.aiohttp.ClientSession", return_value=UploadSession(response)),
            self.assertRaisesRegex(CoreAPIError, "response is too large"),
        ):
            await plugin._rpc("version")

    async def test_rpc_bounds_core_error_message(self):
        plugin = Plugin()
        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "x" * 10_000}}
        ).encode()
        response = UploadResponse(body, url=API_URL)
        with (
            patch("main.aiohttp.ClientSession", return_value=UploadSession(response)),
            self.assertRaises(CoreAPIError) as raised,
        ):
            await plugin._rpc("media.generate")

        self.assertEqual(CORE_ERROR_MAX_CHARS, len(str(raised.exception)))
        self.assertTrue(str(raised.exception).endswith("..."))

    async def test_get_status_reports_disconnected_core(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(side_effect=CoreAPIError("Core request failed: version"))

        status = await plugin.get_status()

        self.assertFalse(status["connected"])
        self.assertEqual(PLUGIN_VERSION, status["pluginVersion"])
        self.assertIn("version", status["error"])

    async def test_bootstrap_status_gives_running_core_precedence(self):
        plugin = Plugin()
        version = {"version": "2.17.0", "platform": "steamos"}
        with (
            patch.object(plugin, "_supported_platform", return_value=(True, None)),
            patch.object(plugin, "_rpc", AsyncMock(return_value=version)),
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

    async def test_plugin_unload_cancels_active_bootstrap_and_rolls_back_install(self):
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
        plugin._rollback_bootstrap = AsyncMock()
        service_install_started = asyncio.Event()

        with (
            tempfile.TemporaryDirectory() as home,
            patch.object(sys.modules["decky"], "DECKY_USER_HOME", home, create=True),
            patch.object(sys.modules["decky"], "emit", AsyncMock(), create=True),
            patch("main._latest_core_release_sync", return_value=release),
            patch("main._download_core_release_sync"),
            patch("main._extract_core_binary_sync"),
        ):
            canonical = Path(home) / ".local" / "bin" / "zaparoo"

            async def run_command(*args, **_kwargs):
                if args[1:] == ("-install", "application"):
                    canonical.parent.mkdir(parents=True, exist_ok=True)
                    canonical.write_bytes(b"installed")
                    return ""
                if args[1:] == ("-install", "service"):
                    service_install_started.set()
                    await asyncio.Event().wait()
                return ""

            plugin._run_command = AsyncMock(side_effect=run_command)
            install = asyncio.create_task(plugin.install_core())
            await service_install_started.wait()
            self.assertIs(plugin._active_bootstrap_task, install)

            await plugin._unload()

        self.assertTrue(install.cancelled())
        plugin._rollback_bootstrap.assert_awaited_once_with(canonical)
        self.assertIsNone(plugin._active_bootstrap_task)

    async def test_bootstrap_is_rejected_after_unload_begins(self):
        plugin = Plugin()
        plugin._unloading = True
        plugin.get_bootstrap_status = AsyncMock()

        with self.assertRaisesRegex(CoreAPIError, "unloading"):
            await plugin.install_core()
        with self.assertRaisesRegex(CoreAPIError, "unloading"):
            await plugin.start_core()

        plugin.get_bootstrap_status.assert_not_awaited()

    async def test_queued_bootstrap_is_rejected_after_unload_begins(self):
        plugin = Plugin()
        plugin.get_bootstrap_status = AsyncMock()
        await plugin._bootstrap_lock.acquire()
        queued = asyncio.create_task(plugin.start_core())
        await asyncio.sleep(0)
        plugin._unloading = True
        plugin._bootstrap_lock.release()

        with self.assertRaisesRegex(CoreAPIError, "unloading"):
            await queued
        plugin.get_bootstrap_status.assert_not_awaited()

    async def test_write_tag_sends_selected_reader(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value=None)

        await plugin.write_tag("steam://1145360", "reader-1")

        plugin._rpc.assert_awaited_once_with(
            "readers.write",
            {"text": "steam://1145360", "readerId": "reader-1"},
            timeout=120.0,
        )

    def test_encryption_is_not_exposed_as_direct_callable(self):
        self.assertFalse(hasattr(Plugin(), "set_encryption"))

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

    async def test_start_client_pairing_returns_owned_workflow(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"clients": []},
                {"pin": "123456", "expiresAt": 1700000120},
            ]
        )

        pairing = await plugin.start_client_pairing()

        self.assertEqual("123456", pairing["pin"])
        self.assertEqual(1, pairing["workflowId"])
        self.assertEqual(
            [call("clients", timeout=5.0), call("clients.pair.start", timeout=5.0)],
            plugin._rpc.await_args_list,
        )

    async def test_invalid_pairing_response_is_cancelled_before_return(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(side_effect=[{"clients": []}, {"pin": []}, {}])

        with self.assertRaisesRegex(CoreAPIError, "invalid client pairing"):
            await plugin.start_client_pairing()

        self.assertIsNone(plugin._pairing_workflow_id)
        self.assertEqual(
            [
                call("clients", timeout=5.0),
                call("clients.pair.start", timeout=5.0),
                call("clients.pair.cancel", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )

    async def test_cancel_client_pairing_requires_owning_workflow(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(return_value={})
        plugin._pairing_workflow_id = 2
        plugin._pairing_workflow_delivered = True

        with self.assertRaisesRegex(CoreAPIError, "no longer active"):
            await plugin.cancel_client_pairing(1)
        plugin._rpc.assert_not_awaited()

        await plugin.cancel_client_pairing(2)
        plugin._rpc.assert_awaited_once_with("clients.pair.cancel", timeout=5.0)
        self.assertIsNone(plugin._pairing_workflow_id)

    async def test_secure_pairing_start_rolls_back_encryption_on_ambiguous_failure(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"clients": []},
                {"encryption": False},
                None,
                CoreAPIError("pairing failed"),
                {},
                {"clients": []},
                None,
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "pairing failed"):
            await plugin.start_client_pairing(True)

        self.assertEqual(
            [
                call("clients", timeout=5.0),
                call("settings", timeout=5.0),
                call("settings.update", {"encryption": True}, timeout=5.0),
                call("clients.pair.start", timeout=5.0),
                call("clients.pair.cancel", timeout=5.0),
                call("clients", timeout=5.0),
                call("settings.update", {"encryption": False}, timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )
        self.assertIsNone(plugin._pairing_workflow_id)
        self.assertFalse(plugin._pairing_restore_encryption)

    async def test_ambiguous_pairing_cleanup_remains_backend_owned(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"clients": []},
                {"encryption": False},
                CoreAPIError("enable response lost"),
                CoreAPIError("cancel response lost"),
                CoreAPIError("client status unavailable"),
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "roll back client pairing"):
            await plugin.start_client_pairing(True)

        self.assertEqual(1, plugin._pairing_workflow_id)
        self.assertFalse(plugin._pairing_workflow_delivered)
        self.assertTrue(plugin._pairing_restore_encryption)
        self.assertEqual(1, len(plugin._workflow_tasks))
        await plugin._cancel_workflow_tasks()

    async def test_failed_pairing_cancel_does_not_restore_encryption_early(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_workflow_claimed = True
        plugin._pairing_restore_encryption = True
        plugin._rpc = AsyncMock(side_effect=[CoreAPIError("cancel response lost"), {"clients": []}])

        with self.assertRaisesRegex(CoreAPIError, "Could not finish client pairing"):
            await plugin.cancel_client_pairing(1)

        self.assertTrue(plugin._pairing_restore_encryption)
        self.assertNotIn(
            call("settings.update", {"encryption": False}, timeout=5.0),
            plugin._rpc.await_args_list,
        )

    async def test_expired_pairing_requires_confirmed_cancel_before_encryption_restore(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_workflow_claimed = True
        plugin._pairing_restore_encryption = True
        plugin._rpc = AsyncMock(side_effect=[CoreAPIError("cancel response lost"), {"clients": []}])

        with self.assertRaisesRegex(CoreAPIError, "Could not finish client pairing"):
            await plugin.expire_client_pairing(1)

        self.assertEqual(
            [
                call("clients.pair.cancel", timeout=5.0),
                call("clients", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )
        self.assertTrue(plugin._pairing_restore_encryption)

    async def test_secure_pairing_does_not_claim_preexisting_encryption(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"clients": []},
                {"encryption": True},
                {"pin": "123456", "expiresAt": 1700000120},
                {},
            ]
        )

        pairing = await plugin.start_client_pairing(True)
        await plugin.cancel_client_pairing(pairing["workflowId"])

        self.assertNotIn(
            call("settings.update", {"encryption": False}, timeout=5.0),
            plugin._rpc.await_args_list,
        )

    async def test_complete_pairing_requires_new_core_client(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_client_ids = frozenset({"existing"})
        plugin._rpc = AsyncMock(return_value={"clients": [{"clientId": "existing"}]})

        with self.assertRaisesRegex(CoreAPIError, "has not completed"):
            await plugin.complete_client_pairing(1)
        self.assertEqual(1, plugin._pairing_workflow_id)

        plugin._rpc = AsyncMock(
            return_value={"clients": [{"clientId": "existing"}, {"clientId": "new"}]}
        )
        await plugin.complete_client_pairing(1)
        self.assertIsNone(plugin._pairing_workflow_id)

    async def test_pairing_cleanup_preserves_encryption_after_client_is_paired(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_restore_encryption = True
        plugin._pairing_client_ids = frozenset({"existing"})
        plugin._rpc = AsyncMock(
            side_effect=[
                {},
                {"clients": [{"clientId": "existing"}, {"clientId": "new"}]},
            ]
        )

        await plugin._unload()

        self.assertEqual(
            [call("clients.pair.cancel", timeout=5.0), call("clients", timeout=5.0)],
            plugin._rpc.await_args_list,
        )
        self.assertIsNone(plugin._pairing_workflow_id)
        self.assertFalse(plugin._pairing_restore_encryption)

    async def test_pairing_start_rejects_superseding_active_workflow(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._rpc = AsyncMock()

        with self.assertRaisesRegex(CoreAPIError, "already active"):
            await plugin.start_client_pairing()

        plugin._rpc.assert_not_awaited()

    async def test_unclaimed_pairing_is_cleaned_after_claim_timeout(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._rpc = AsyncMock(return_value={})

        with patch("main.asyncio.sleep", AsyncMock(return_value=None)):
            await plugin._cleanup_unclaimed_pairing(1)

        plugin._rpc.assert_awaited_once_with("clients.pair.cancel", timeout=5.0)
        self.assertIsNone(plugin._pairing_workflow_id)

    async def test_claimed_pairing_is_not_cleaned_by_timeout(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._rpc = AsyncMock()

        await plugin.claim_client_pairing(1)
        with patch("main.asyncio.sleep", AsyncMock(return_value=None)):
            await plugin._cleanup_unclaimed_pairing(1)

        self.assertTrue(plugin._pairing_workflow_claimed)
        plugin._rpc.assert_not_awaited()

    async def test_terminal_workflows_cannot_be_claimed(self):
        plugin = Plugin()
        plugin._pairing_last_terminal_id = 1
        plugin._online_link_last_terminal = (2, {"status": "cancelled"})

        with self.assertRaisesRegex(CoreAPIError, "pairing workflow is no longer active"):
            await plugin.claim_client_pairing(1)
        with self.assertRaisesRegex(CoreAPIError, "Online link workflow is no longer active"):
            await plugin.claim_online_link(2)

    async def test_log_upload_uses_total_timeout_and_disables_redirects(self):
        form = MagicMock()
        response = UploadResponse(b" https://logs.zaparoo.org/abc123.log\n")
        session = UploadSession(response)
        tls_context = MagicMock()
        with (
            patch("main.aiohttp.FormData", return_value=form),
            patch("main.aiohttp.ClientTimeout") as client_timeout,
            patch("main.aiohttp.ClientSession", return_value=session),
            patch("main.ssl.create_default_context", return_value=tls_context) as create_context,
        ):
            url = await _upload_log_content(b"core log")

        self.assertEqual("https://logs.zaparoo.org/abc123.log", url)
        client_timeout.assert_called_once_with(total=30.0, connect=10.0)
        create_context.assert_called_once_with(cafile=LOG_UPLOAD_CA_FILE)
        form.add_field.assert_called_once_with(
            "file",
            b"core log",
            filename="core.log",
            content_type="application/octet-stream",
        )
        session.post.assert_called_once_with(
            LOG_UPLOAD_URL,
            data=form,
            allow_redirects=False,
            ssl=tls_context,
            headers={"Accept": "text/plain", "User-Agent": "zaparoo-decky-log-upload"},
        )

    async def test_log_upload_reports_bounded_connection_cause(self):
        session = UploadSession(MagicMock())
        session.post.side_effect = aiohttp_stub.ClientConnectorError("dns failed")
        logger = sys.modules["decky"].logger
        with (
            patch("main.aiohttp.FormData", return_value=MagicMock()),
            patch("main.aiohttp.ClientSession", return_value=session),
            patch("main.ssl.create_default_context", return_value=MagicMock()),
            self.assertRaisesRegex(CoreAPIError, "ClientConnectorError: dns failed"),
        ):
            await _upload_log_content(b"core log")

        logger.exception.assert_called_with("Unable to connect to log upload service")

    async def test_log_upload_timeout_reports_unknown_outcome(self):
        session = UploadSession(MagicMock())
        session.post.side_effect = TimeoutError("response timeout")
        logger = sys.modules["decky"].logger
        with (
            patch("main.aiohttp.FormData", return_value=MagicMock()),
            patch("main.aiohttp.ClientSession", return_value=session),
            patch("main.ssl.create_default_context", return_value=MagicMock()),
            self.assertRaisesRegex(LogUploadOutcomeUnknown, "outcome is unknown"),
        ):
            await _upload_log_content(b"core log")

        logger.exception.assert_called_with("Log upload outcome is unknown")

    async def test_log_upload_http_error_reports_unknown_outcome(self):
        response = UploadResponse(b"server error", status=500)
        session = UploadSession(response)
        with (
            patch("main.aiohttp.FormData", return_value=MagicMock()),
            patch("main.aiohttp.ClientSession", return_value=session),
            patch("main.ssl.create_default_context", return_value=MagicMock()),
            self.assertRaisesRegex(LogUploadOutcomeUnknown, "outcome is unknown"),
        ):
            await _upload_log_content(b"core log")

    async def test_upload_logs_downloads_content_from_core_api(self):
        plugin = Plugin()
        content = b"core log"
        plugin._rpc = AsyncMock(
            return_value={
                "filename": "core.log",
                "size": len(content),
                "content": base64.b64encode(content).decode("ascii"),
            }
        )
        with patch(
            "main._upload_log_content",
            AsyncMock(return_value="https://logs.zaparoo.org/abc123.log"),
        ) as upload:
            result = await plugin.upload_logs()

        self.assertEqual(
            {"outcome": "success", "url": "https://logs.zaparoo.org/abc123.log"},
            result,
        )
        plugin._rpc.assert_awaited_once_with(
            "settings.logs.download",
            timeout=10.0,
            maximum_response_bytes=LOG_DOWNLOAD_MAX_RESPONSE_BYTES,
        )
        upload.assert_awaited_once_with(content)

    async def test_upload_logs_returns_structured_unknown_outcome(self):
        plugin = Plugin()
        content = b"core log"
        plugin._rpc = AsyncMock(
            return_value={
                "filename": "core.log",
                "size": len(content),
                "content": base64.b64encode(content).decode("ascii"),
            }
        )
        with patch(
            "main._upload_log_content",
            AsyncMock(side_effect=LogUploadOutcomeUnknown("Service may have received log")),
        ):
            result = await plugin.upload_logs()

        self.assertEqual(
            {"outcome": "unknown", "error": "Service may have received log"},
            result,
        )

    async def test_upload_logs_rejects_concurrent_callable(self):
        plugin = Plugin()
        content = b"core log"
        started = asyncio.Event()
        release = asyncio.Event()

        async def download(*_args, **_kwargs):
            started.set()
            await release.wait()
            return {
                "filename": "core.log",
                "size": len(content),
                "content": base64.b64encode(content).decode("ascii"),
            }

        plugin._rpc = AsyncMock(side_effect=download)
        with patch(
            "main._upload_log_content",
            AsyncMock(return_value="https://logs.zaparoo.org/abc123.log"),
        ):
            first = asyncio.create_task(plugin.upload_logs())
            await started.wait()
            with self.assertRaisesRegex(CoreAPIError, "already in progress"):
                await plugin.upload_logs()
            release.set()
            await first

    async def test_upload_is_cancelled_and_new_uploads_rejected_during_unload(self):
        plugin = Plugin()
        started = asyncio.Event()

        async def download(*_args, **_kwargs):
            started.set()
            await asyncio.Event().wait()

        plugin._rpc = AsyncMock(side_effect=download)
        upload = asyncio.create_task(plugin.upload_logs())
        await started.wait()

        await plugin._unload()

        self.assertTrue(upload.cancelled())
        self.assertIsNone(plugin._active_upload_task)
        with self.assertRaisesRegex(CoreAPIError, "unloading"):
            await plugin.upload_logs()

    async def test_online_link_methods_use_owned_workflow(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {
                    "status": "pending",
                    "verificationUrl": "https://online.zaparoo.com/link",
                },
                {
                    "status": "pending",
                    "verificationUrl": "https://online.zaparoo.com/link",
                },
                {"status": "cancelled"},
                None,
            ]
        )

        link = await plugin.start_online_link()
        self.assertEqual(1, link["workflowId"])
        status = await plugin.get_online_link_status(link["workflowId"])
        self.assertEqual("pending", status["status"])
        await plugin.cancel_online_link(link["workflowId"])
        await plugin.unlink_online()

        self.assertEqual(
            [
                call("settings.auth.link", timeout=10.0),
                call("settings.auth.link.status", timeout=5.0),
                call("settings.auth.link.cancel", timeout=5.0),
                call("settings.auth.unlink", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )

    async def test_online_terminal_start_does_not_wedge_future_link(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"status": "approved"},
                {
                    "status": "pending",
                    "verificationUrl": "https://online.zaparoo.com/link",
                },
            ]
        )

        terminal = await plugin.start_online_link()
        pending = await plugin.start_online_link()

        self.assertEqual("approved", terminal["status"])
        self.assertEqual(1, terminal["workflowId"])
        self.assertEqual("pending", pending["status"])
        self.assertEqual(2, pending["workflowId"])

    async def test_online_start_rejects_untrusted_verification_url_and_cancels(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {"status": "pending", "verificationUrl": "http://attacker.example/link"},
                {"status": "cancelled"},
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "invalid Online link"):
            await plugin.start_online_link()

        self.assertIsNone(plugin._online_link_workflow_id)
        self.assertEqual(
            [
                call("settings.auth.link", timeout=10.0),
                call("settings.auth.link.cancel", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )

    async def test_online_start_response_loss_is_reconciled(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                CoreAPIError("response lost"),
                CoreAPIError("no active link request"),
                {"status": "none"},
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "response lost"):
            await plugin.start_online_link()

        self.assertIsNone(plugin._online_link_workflow_id)
        self.assertEqual(
            [
                call("settings.auth.link", timeout=10.0),
                call("settings.auth.link.cancel", timeout=5.0),
                call("settings.auth.link.status", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )

    async def test_malformed_online_status_retains_cancellation_ownership(self):
        plugin = Plugin()
        plugin._online_link_workflow_id = 1
        plugin._online_link_workflow_delivered = True
        plugin._rpc = AsyncMock(
            return_value={"status": "pending", "verificationUrl": "https://attacker.example/link"}
        )

        with self.assertRaisesRegex(CoreAPIError, "invalid Online link"):
            await plugin.get_online_link_status(1)

        self.assertEqual(1, plugin._online_link_workflow_id)

    async def test_malformed_online_cancel_result_reconciles_before_clearing(self):
        plugin = Plugin()
        plugin._online_link_workflow_id = 1
        plugin._online_link_workflow_delivered = True
        plugin._online_link_workflow_claimed = True
        plugin._rpc = AsyncMock(
            side_effect=[
                {},
                {
                    "status": "pending",
                    "verificationUrl": "https://online.zaparoo.com/link",
                },
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "Could not cancel Online link"):
            await plugin.cancel_online_link(1)

        self.assertEqual(1, plugin._online_link_workflow_id)
        self.assertEqual(
            [
                call("settings.auth.link.cancel", timeout=5.0),
                call("settings.auth.link.status", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )

    async def test_ambiguous_online_start_schedules_cleanup_retry(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                CoreAPIError("start response lost"),
                CoreAPIError("cancel response lost"),
                CoreAPIError("status unavailable"),
            ]
        )

        with self.assertRaisesRegex(CoreAPIError, "roll back Online link startup"):
            await plugin.start_online_link()

        self.assertEqual(1, plugin._online_link_workflow_id)
        self.assertFalse(plugin._online_link_workflow_delivered)
        self.assertEqual(1, len(plugin._workflow_tasks))
        await plugin._cancel_workflow_tasks()

    async def test_online_workflow_rejects_stale_owner(self):
        plugin = Plugin()
        plugin._online_link_workflow_id = 2
        plugin._online_link_workflow_delivered = True
        plugin._rpc = AsyncMock()

        with self.assertRaisesRegex(CoreAPIError, "no longer active"):
            await plugin.cancel_online_link(1)
        with self.assertRaisesRegex(CoreAPIError, "already active"):
            await plugin.start_online_link()

        plugin._rpc.assert_not_awaited()

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

    async def test_paired_notification_preserves_encryption_ownership(self):
        plugin = Plugin()
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_restore_encryption = True
        plugin._pairing_client_ids = frozenset({"existing"})
        plugin._rpc = AsyncMock(
            return_value={"clients": [{"clientId": "existing"}, {"clientId": "new"}]}
        )
        notification = {"jsonrpc": "2.0", "method": "clients.paired", "params": {}}
        emit = AsyncMock()

        with patch.object(sys.modules["decky"], "emit", emit, create=True):
            await plugin._forward_notification(json.dumps(notification))

        self.assertIsNone(plugin._pairing_workflow_id)
        self.assertFalse(plugin._pairing_restore_encryption)
        emit.assert_awaited_once_with("core_notification", notification)

    async def test_notification_session_reports_connect_and_disconnect(self):
        plugin = Plugin()
        emit = AsyncMock()
        session = ClientSession()

        with (
            patch("main.aiohttp.ClientSession", return_value=session, create=True),
            patch.object(sys.modules["decky"], "emit", emit, create=True),
        ):
            await plugin._notification_session(MagicMock())

        self.assertEqual(0.5, session.ws_connect.call_args.kwargs["timeout"])
        self.assertEqual(
            [call("core_connection", True), call("core_connection", False)],
            emit.await_args_list,
        )

    async def test_notification_session_skips_disconnect_emit_during_unload(self):
        plugin = Plugin()

        async def mark_unloading(_event, connected):
            if connected:
                plugin._unloading = True

        emit = AsyncMock(side_effect=mark_unloading)
        with (
            patch("main.aiohttp.ClientSession", return_value=ClientSession(), create=True),
            patch.object(sys.modules["decky"], "emit", emit, create=True),
        ):
            await plugin._notification_session(MagicMock())

        emit.assert_awaited_once_with("core_connection", True)

    async def test_notification_detach_does_not_wait_for_websocket_teardown(self):
        plugin = Plugin()
        task = asyncio.create_task(asyncio.Event().wait())
        plugin._notification_task = task

        plugin._detach_notifications()

        self.assertIsNone(plugin._notification_task)
        self.assertFalse(task.done())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

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

    async def test_plugin_unload_cleans_active_pairing_and_online_workflows(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock(
            side_effect=[
                {},
                {"clients": []},
                None,
                {"status": "cancelled"},
            ]
        )
        plugin._pairing_workflow_id = 1
        plugin._pairing_workflow_delivered = True
        plugin._pairing_restore_encryption = True
        plugin._online_link_workflow_id = 2
        plugin._online_link_workflow_delivered = True

        await plugin._unload()

        self.assertEqual(
            [
                call("clients.pair.cancel", timeout=5.0),
                call("clients", timeout=5.0),
                call("settings.update", {"encryption": False}, timeout=5.0),
                call("settings.auth.link.cancel", timeout=5.0),
            ],
            plugin._rpc.await_args_list,
        )
        self.assertIsNone(plugin._pairing_workflow_id)
        self.assertFalse(plugin._pairing_restore_encryption)
        self.assertIsNone(plugin._online_link_workflow_id)
        self.assertTrue(plugin._unloading)

    async def test_plugin_unload_returns_with_live_notification_task(self):
        plugin = Plugin()
        notification = asyncio.create_task(asyncio.Event().wait())
        plugin._notification_task = notification

        await asyncio.wait_for(plugin._unload(), timeout=0.2)

        self.assertIsNone(plugin._notification_task)
        self.assertFalse(notification.done())
        notification.cancel()
        await asyncio.gather(notification, return_exceptions=True)

    async def test_plugin_unload_runs_cleanup_in_shutdown_task(self):
        plugin = Plugin()
        shutdown_task = asyncio.current_task()
        cleanup_tasks: list[asyncio.Task[object] | None] = []

        async def complete_unload():
            cleanup_tasks.append(asyncio.current_task())

        plugin._complete_unload = AsyncMock(side_effect=complete_unload)

        await plugin._unload()

        self.assertEqual([shutdown_task], cleanup_tasks)

    async def test_plugin_unload_bounds_stalled_workflow_cleanup(self):
        plugin = Plugin()
        cleanup_started = asyncio.Event()

        async def stalled_cleanup():
            cleanup_started.set()
            await asyncio.Event().wait()

        plugin._cleanup_workflows = AsyncMock(side_effect=stalled_cleanup)
        with patch("main.UNLOAD_CLEANUP_TIMEOUT", 0.01):
            await asyncio.wait_for(plugin._unload(), timeout=0.2)
        await asyncio.sleep(0)

        self.assertTrue(cleanup_started.is_set())
        self.assertIsNone(plugin._notification_task)
        sys.modules["decky"].logger.warning.assert_any_call(
            "Zaparoo plugin unload cleanup exceeded its deadline"
        )

    async def test_queued_workflow_start_is_rejected_after_unload_begins(self):
        plugin = Plugin()
        plugin._rpc = AsyncMock()
        await plugin._workflow_lock.acquire()
        start = asyncio.create_task(plugin.start_online_link())
        await asyncio.sleep(0)
        unload = asyncio.create_task(plugin._unload())
        await asyncio.sleep(0)
        plugin._workflow_lock.release()

        with self.assertRaisesRegex(CoreAPIError, "unloading"):
            await start
        await unload
        plugin._rpc.assert_not_awaited()

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
