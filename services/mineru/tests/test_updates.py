from __future__ import annotations

import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from paperlens_mineru.updates import (
    RELEASES_API_URL,
    UpdateError,
    check_for_update,
    prepare_update,
)


TOKEN = "update_test_token_1234567890abcdef"
NOW = datetime(2026, 7, 23, 8, 0, tzinfo=UTC)


class UpdateTests(unittest.TestCase):
    def test_offline_failure_is_redacted_and_counts_as_the_scheduled_attempt(self) -> None:
        def offline(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline internal detail", request=request)

        client = httpx.Client(transport=httpx.MockTransport(offline))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(UpdateError) as raised:
                check_for_update(
                    "0.1.0",
                    root,
                    client=client,
                    now=lambda: NOW,
                )
            state = json.loads((root / "updates" / "update-state.json").read_text(encoding="utf-8"))

            requests: list[str] = []
            skipped = check_for_update(
                "0.1.0",
                root,
                scheduled=True,
                client=httpx.Client(
                    transport=httpx.MockTransport(
                        lambda request: requests.append(str(request.url))
                        or httpx.Response(500, request=request)
                    )
                ),
                now=lambda: NOW + timedelta(hours=1),
            )

        self.assertEqual(raised.exception.code, "UPDATE_NETWORK_FAILED")
        self.assertEqual(state["code"], "UPDATE_NETWORK_FAILED")
        self.assertEqual(skipped.code, "UPDATE_INTERVAL_SKIPPED")
        self.assertEqual(requests, [])

    def test_current_or_older_stable_release_never_downloads_assets(self) -> None:
        archive = _archive("0.1.0")
        client, requests = _client(
            archive,
            releases=[_release("mineru-v0.1.0", "0.1.0")],
            release_version="0.1.0",
        )
        with tempfile.TemporaryDirectory() as directory:
            result = prepare_update(
                "0.1.0",
                Path(directory),
                Path(directory) / "updates" / "staging_current",
                client=client,
                now=lambda: NOW,
            )

        self.assertEqual(result.code, "UPDATE_CURRENT")
        self.assertEqual(requests, [RELEASES_API_URL])

    def test_selects_only_newer_stable_mineru_release_from_fixed_repository(self) -> None:
        archive = _archive("0.2.0")
        client, requests = _client(
            archive,
            releases=[
                _release("v9.9.9", "9.9.9"),
                _release("mineru-v9.9.9", "9.9.9", prerelease=True),
                _release("mineru-v0.2.0", "0.2.0"),
                _release("mineru-v0.1.1", "0.1.1"),
            ],
        )
        with tempfile.TemporaryDirectory() as directory:
            result = check_for_update(
                "0.1.0",
                Path(directory),
                client=client,
                now=lambda: NOW,
            )

        self.assertEqual(result.code, "UPDATE_AVAILABLE")
        self.assertEqual(result.latest_version, "0.2.0")
        self.assertEqual(requests, [RELEASES_API_URL])
        public = json.dumps(result.to_public_dict())
        self.assertNotIn(TOKEN, public)
        self.assertNotIn(directory, public)

    def test_scheduled_check_is_limited_to_once_per_24_hours(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_root = root / "updates"
            state_root.mkdir()
            (state_root / "update-state.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "attemptedAt": (NOW - timedelta(hours=23)).isoformat(),
                        "code": "UPDATE_NETWORK_FAILED",
                        "latestVersion": None,
                    }
                ),
                encoding="utf-8",
            )
            requests: list[str] = []
            client = httpx.Client(
                transport=httpx.MockTransport(
                    lambda request: requests.append(str(request.url))
                    or httpx.Response(500, request=request)
                )
            )

            result = check_for_update(
                "0.1.0",
                root,
                scheduled=True,
                client=client,
                now=lambda: NOW,
            )

        self.assertEqual(result.code, "UPDATE_INTERVAL_SKIPPED")
        self.assertEqual(requests, [])

    def test_prepare_verifies_hash_extracts_safe_package_and_records_redacted_state(self) -> None:
        archive = _archive("0.2.0")
        client, requests = _client(archive)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "updates" / "staging_test"

            result = prepare_update(
                "0.1.0",
                root,
                destination,
                client=client,
                now=lambda: NOW,
            )

            self.assertEqual(result.code, "UPDATE_PREPARED")
            self.assertTrue((destination / "paperlens-mineru" / "pyproject.toml").is_file())
            state = (root / "updates" / "update-state.json").read_text(encoding="utf-8")
            self.assertNotIn(TOKEN, state)
            self.assertNotIn(str(root), state)

        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[0], RELEASES_API_URL)

    def test_hash_mismatch_never_publishes_staging_directory(self) -> None:
        archive = _archive("0.2.0")
        client, _ = _client(archive, checksum="0" * 64)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "updates" / "staging_test"

            with self.assertRaises(UpdateError) as raised:
                prepare_update(
                    "0.1.0",
                    root,
                    destination,
                    client=client,
                    now=lambda: NOW,
                )

            self.assertFalse(destination.exists())
            state = json.loads((root / "updates" / "update-state.json").read_text(encoding="utf-8"))

        self.assertEqual(raised.exception.code, "UPDATE_HASH_MISMATCH")
        self.assertEqual(state["code"], "UPDATE_HASH_MISMATCH")

    def test_rejects_path_traversal_and_package_version_mismatch(self) -> None:
        malicious = _archive("0.2.0", extra={"paperlens-mineru/../../escape.txt": b"escape"})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "updates" / "staging_bad"
            with self.assertRaises(UpdateError) as raised:
                prepare_update(
                    "0.1.0",
                    root,
                    destination,
                    client=_client(malicious)[0],
                    now=lambda: NOW,
                )
            self.assertFalse((root / "escape.txt").exists())
        self.assertEqual(raised.exception.code, "UPDATE_ARCHIVE_UNSAFE")

        mismatched = _archive("0.3.0")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(UpdateError) as raised:
                prepare_update(
                    "0.1.0",
                    root,
                    root / "updates" / "staging_bad",
                    client=_client(mismatched, release_version="0.2.0")[0],
                    now=lambda: NOW,
                )
        self.assertEqual(raised.exception.code, "UPDATE_PACKAGE_INVALID")

    def test_rejects_missing_assets_and_non_github_download_url(self) -> None:
        archive = _archive("0.2.0")
        missing = _release("mineru-v0.2.0", "0.2.0")
        missing["assets"] = missing["assets"][:1]
        client, _ = _client(archive, releases=[missing])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(UpdateError) as raised:
                check_for_update(
                    "0.1.0",
                    Path(directory),
                    client=client,
                    now=lambda: NOW,
                )
        self.assertEqual(raised.exception.code, "UPDATE_ASSET_MISSING")

        foreign = _release("mineru-v0.2.0", "0.2.0")
        foreign["assets"][0]["browser_download_url"] = "https://example.com/payload.zip"
        client, _ = _client(archive, releases=[foreign])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(UpdateError) as raised:
                check_for_update(
                    "0.1.0",
                    Path(directory),
                    client=client,
                    now=lambda: NOW,
                )
        self.assertEqual(raised.exception.code, "UPDATE_ASSET_UNTRUSTED")


def _client(
    archive: bytes,
    *,
    checksum: str | None = None,
    releases: list[dict[str, object]] | None = None,
    release_version: str = "0.2.0",
) -> tuple[httpx.Client, list[str]]:
    digest = checksum or hashlib.sha256(archive).hexdigest()
    release_payload = releases or [_release(f"mineru-v{release_version}", release_version)]
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        requests.append(url)
        if url == RELEASES_API_URL:
            return httpx.Response(200, json=release_payload, request=request)
        if url.endswith(".zip.sha256"):
            name = f"paperlens-mineru-windows-{release_version}.zip"
            return httpx.Response(200, text=f"{digest}  {name}\n", request=request)
        if url.endswith(".zip"):
            return httpx.Response(200, content=archive, request=request)
        return httpx.Response(404, request=request)

    return (
        httpx.Client(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
            headers={"User-Agent": "paperlens-mineru-tests"},
        ),
        requests,
    )


def _release(
    tag: str,
    version: str,
    *,
    prerelease: bool = False,
) -> dict[str, object]:
    archive_name = f"paperlens-mineru-windows-{version}.zip"
    base = f"https://github.com/SWUSTcyt/paperlens/releases/download/{tag}"
    return {
        "tag_name": tag,
        "draft": False,
        "prerelease": prerelease,
        "assets": [
            {
                "name": archive_name,
                "browser_download_url": f"{base}/{archive_name}",
                "size": 1024,
            },
            {
                "name": f"{archive_name}.sha256",
                "browser_download_url": f"{base}/{archive_name}.sha256",
                "size": 128,
            },
        ],
    }


def _archive(
    version: str,
    *,
    extra: dict[str, bytes] | None = None,
) -> bytes:
    output = io.BytesIO()
    entries = {
        "paperlens-mineru/pyproject.toml": (
            "[project]\n"
            'name = "paperlens-mineru"\n'
            f'version = "{version}"\n'
        ).encode(),
        "paperlens-mineru/src/paperlens_mineru/__init__.py": b"",
        "paperlens-mineru/schemas/v1/health.schema.json": b"{}",
        "paperlens-mineru/scripts/install-windows.ps1": b"# install",
        "paperlens-mineru/scripts/uninstall-windows.ps1": b"# uninstall",
        "paperlens-mineru/scripts/manage-windows-task.ps1": b"# task",
        "paperlens-mineru/scripts/startup-windows.ps1": b"# startup",
        "paperlens-mineru/scripts/update-windows.ps1": b"# update",
        "paperlens-mineru/README.md": b"# PaperLens MinerU",
    }
    entries.update(extra or {})
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return output.getvalue()


if __name__ == "__main__":
    unittest.main()
