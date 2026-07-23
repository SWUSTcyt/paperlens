from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tomllib
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence
from uuid import uuid4

import httpx


REPOSITORY = "SWUSTcyt/paperlens"
RELEASES_API_URL = f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=100"
CHECK_INTERVAL = timedelta(hours=24)
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_CHECKSUM_BYTES = 4096
MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 4096

_TAG_PATTERN = re.compile(r"^mineru-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)$")
_VERSION_PATTERN = re.compile(r"^(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)$")
_SHA256_PATTERN = re.compile(r"^(?P<digest>[0-9a-fA-F]{64})[ \t]+\*?(?P<name>[^ \t]+)$")
_STAGING_PATTERN = re.compile(r"^staging_[A-Za-z0-9_-]{1,80}$")
_FORBIDDEN_SEGMENT_CHARS = frozenset('<>:"|?*')
_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
_ALLOWED_ASSET_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    }
)
_REQUIRED_FILES = (
    "pyproject.toml",
    "README.md",
    "src/paperlens_mineru/__init__.py",
    "schemas/v1/health.schema.json",
    "scripts/install-windows.ps1",
    "scripts/uninstall-windows.ps1",
    "scripts/manage-windows-task.ps1",
    "scripts/startup-windows.ps1",
    "scripts/update-windows.ps1",
)


class UpdateError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class _Release:
    version: str
    tag: str
    archive_name: str
    archive_url: str
    checksum_url: str


@dataclass(frozen=True)
class UpdateResult:
    code: str
    current_version: str
    latest_version: str | None = None
    _release: _Release | None = field(default=None, repr=False, compare=False)

    def to_public_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "code": self.code,
            "currentVersion": self.current_version,
            "latestVersion": self.latest_version,
        }


def check_for_update(
    current_version: str,
    data_root: Path,
    *,
    scheduled: bool = False,
    client: httpx.Client | None = None,
    now: Callable[[], datetime] | None = None,
) -> UpdateResult:
    clock = now or (lambda: datetime.now(UTC))
    attempted_at = _utc(clock())
    root = data_root.expanduser().resolve()
    if scheduled and _inside_check_interval(root, attempted_at):
        state = _read_state(root)
        return UpdateResult(
            code="UPDATE_INTERVAL_SKIPPED",
            current_version=current_version,
            latest_version=_optional_string(state.get("latestVersion")) if state else None,
        )
    try:
        result = _discover_update(current_version, client=client)
    except UpdateError as error:
        _write_state(root, attempted_at, error.code, None)
        raise
    _write_state(root, attempted_at, result.code, result.latest_version)
    return result


def prepare_update(
    current_version: str,
    data_root: Path,
    destination: Path,
    *,
    scheduled: bool = False,
    client: httpx.Client | None = None,
    now: Callable[[], datetime] | None = None,
) -> UpdateResult:
    clock = now or (lambda: datetime.now(UTC))
    attempted_at = _utc(clock())
    root = data_root.expanduser().resolve()
    target = _validate_destination(root, destination)
    if scheduled and _inside_check_interval(root, attempted_at):
        state = _read_state(root)
        return UpdateResult(
            code="UPDATE_INTERVAL_SKIPPED",
            current_version=current_version,
            latest_version=_optional_string(state.get("latestVersion")) if state else None,
        )

    try:
        result = _discover_update(current_version, client=client)
        if result.code != "UPDATE_AVAILABLE" or result._release is None:
            _write_state(root, attempted_at, result.code, result.latest_version)
            return result
        archive = _download_verified_archive(result._release, client=client)
        _extract_package(archive, target, expected_version=result.latest_version)
    except UpdateError as error:
        _remove_tree(target)
        _write_state(root, attempted_at, error.code, None)
        raise

    prepared = UpdateResult(
        code="UPDATE_PREPARED",
        current_version=current_version,
        latest_version=result.latest_version,
    )
    _write_state(root, attempted_at, prepared.code, prepared.latest_version)
    return prepared


def _discover_update(current_version: str, *, client: httpx.Client | None) -> UpdateResult:
    current = _parse_version(current_version)
    payload = _get_json(RELEASES_API_URL, client=client)
    if not isinstance(payload, list):
        raise UpdateError("UPDATE_RELEASE_INVALID", "稳定通道返回了无效的 Release 列表。")

    candidates: list[tuple[tuple[int, int, int], Mapping[str, object]]] = []
    for item in payload:
        if (
            not isinstance(item, Mapping)
            or item.get("draft") is not False
            or item.get("prerelease") is not False
            or not isinstance(item.get("tag_name"), str)
        ):
            continue
        matched = _TAG_PATTERN.fullmatch(item["tag_name"])
        if not matched:
            continue
        candidates.append((_parse_version(matched.group("version")), item))
    if not candidates:
        return UpdateResult(code="UPDATE_CURRENT", current_version=current_version)

    latest_tuple, latest = max(candidates, key=lambda candidate: candidate[0])
    latest_version = ".".join(str(part) for part in latest_tuple)
    if latest_tuple <= current:
        return UpdateResult(
            code="UPDATE_CURRENT",
            current_version=current_version,
            latest_version=latest_version,
        )
    release = _parse_release(latest, latest_version)
    return UpdateResult(
        code="UPDATE_AVAILABLE",
        current_version=current_version,
        latest_version=latest_version,
        _release=release,
    )


def _parse_release(value: Mapping[str, object], version: str) -> _Release:
    tag = str(value["tag_name"])
    archive_name = f"paperlens-mineru-windows-{version}.zip"
    checksum_name = f"{archive_name}.sha256"
    assets = value.get("assets")
    if not isinstance(assets, Sequence) or isinstance(assets, (str, bytes)):
        raise UpdateError("UPDATE_ASSET_MISSING", "稳定 Release 缺少 Windows 更新资产。")
    by_name = {
        item.get("name"): item
        for item in assets
        if isinstance(item, Mapping) and isinstance(item.get("name"), str)
    }
    archive = by_name.get(archive_name)
    checksum = by_name.get(checksum_name)
    if not isinstance(archive, Mapping) or not isinstance(checksum, Mapping):
        raise UpdateError("UPDATE_ASSET_MISSING", "稳定 Release 缺少 ZIP 或 SHA-256 资产。")
    archive_url = _trusted_asset_url(archive, tag, archive_name)
    checksum_url = _trusted_asset_url(checksum, tag, checksum_name)
    _validate_advertised_size(archive, MAX_ARCHIVE_BYTES)
    _validate_advertised_size(checksum, MAX_CHECKSUM_BYTES)
    return _Release(
        version=version,
        tag=tag,
        archive_name=archive_name,
        archive_url=archive_url,
        checksum_url=checksum_url,
    )


def _trusted_asset_url(asset: Mapping[str, object], tag: str, name: str) -> str:
    url = asset.get("browser_download_url")
    expected = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"
    if not isinstance(url, str) or url != expected:
        raise UpdateError("UPDATE_ASSET_UNTRUSTED", "Release 资产不属于固定的 PaperLens 稳定通道。")
    return url


def _validate_advertised_size(asset: Mapping[str, object], maximum: int) -> None:
    size = asset.get("size")
    if not isinstance(size, int) or size <= 0 or size > maximum:
        raise UpdateError("UPDATE_ASSET_TOO_LARGE", "Release 资产大小不符合限制。")


def _download_verified_archive(release: _Release, *, client: httpx.Client | None) -> bytes:
    checksum_payload = _download(release.checksum_url, MAX_CHECKSUM_BYTES, client=client)
    expected = _parse_checksum(checksum_payload, release.archive_name)
    archive = _download(release.archive_url, MAX_ARCHIVE_BYTES, client=client)
    if not hashlib.sha256(archive).hexdigest().lower() == expected:
        raise UpdateError("UPDATE_HASH_MISMATCH", "Windows 更新 ZIP 的 SHA-256 校验失败。")
    return archive


def _parse_checksum(payload: bytes, archive_name: str) -> str:
    try:
        lines = [line.strip() for line in payload.decode("ascii").splitlines() if line.strip()]
    except UnicodeDecodeError as error:
        raise UpdateError("UPDATE_CHECKSUM_INVALID", "SHA-256 资产格式无效。") from error
    if len(lines) != 1:
        raise UpdateError("UPDATE_CHECKSUM_INVALID", "SHA-256 资产必须只包含一条记录。")
    matched = _SHA256_PATTERN.fullmatch(lines[0])
    if not matched or matched.group("name") != archive_name:
        raise UpdateError("UPDATE_CHECKSUM_INVALID", "SHA-256 资产与版本化 ZIP 不匹配。")
    return matched.group("digest").lower()


def _get_json(url: str, *, client: httpx.Client | None) -> object:
    owned = client is None
    active = client or _new_client()
    try:
        response = active.get(url)
        response.raise_for_status()
        if str(response.url) != RELEASES_API_URL:
            raise UpdateError("UPDATE_REDIRECT_UNTRUSTED", "Release API 重定向到了非固定地址。")
        return response.json()
    except UpdateError:
        raise
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as error:
        raise UpdateError("UPDATE_NETWORK_FAILED", "无法读取固定的 PaperLens 稳定通道。") from error
    finally:
        if owned:
            active.close()


def _download(url: str, maximum: int, *, client: httpx.Client | None) -> bytes:
    owned = client is None
    active = client or _new_client()
    try:
        with active.stream("GET", url) as response:
            response.raise_for_status()
            if response.url.scheme != "https" or response.url.host not in _ALLOWED_ASSET_HOSTS:
                raise UpdateError("UPDATE_REDIRECT_UNTRUSTED", "Release 资产重定向到了非 GitHub 地址。")
            advertised = response.headers.get("content-length")
            if advertised is not None:
                try:
                    if int(advertised) > maximum:
                        raise UpdateError("UPDATE_ASSET_TOO_LARGE", "下载资产超过大小上限。")
                except ValueError as error:
                    raise UpdateError("UPDATE_DOWNLOAD_INVALID", "下载长度格式无效。") from error
            output = bytearray()
            for chunk in response.iter_bytes():
                output.extend(chunk)
                if len(output) > maximum:
                    raise UpdateError("UPDATE_ASSET_TOO_LARGE", "下载资产超过大小上限。")
            return bytes(output)
    except UpdateError:
        raise
    except httpx.HTTPError as error:
        raise UpdateError("UPDATE_NETWORK_FAILED", "稳定通道资产下载失败。") from error
    finally:
        if owned:
            active.close()


def _new_client() -> httpx.Client:
    return httpx.Client(
        follow_redirects=True,
        timeout=httpx.Timeout(30, connect=10),
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "PaperLens-MinerU-Updater/1",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )


def _validate_destination(data_root: Path, destination: Path) -> Path:
    updates_root = (data_root / "updates").resolve()
    target = destination.expanduser().resolve()
    if target.parent != updates_root or not _STAGING_PATTERN.fullmatch(target.name):
        raise UpdateError("UPDATE_DESTINATION_UNTRUSTED", "更新暂存目录不在受信任的数据目录中。")
    if target.exists():
        raise UpdateError("UPDATE_DESTINATION_EXISTS", "更新暂存目录已存在。")
    return target


def _extract_package(archive_bytes: bytes, destination: Path, *, expected_version: str | None) -> None:
    if expected_version is None:
        raise UpdateError("UPDATE_PACKAGE_INVALID", "Release 缺少服务版本。")
    temporary = destination.parent / f".{destination.name}.{uuid4().hex}.tmp"
    temporary.mkdir(parents=True, exist_ok=False)
    try:
        with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 文件数量超过限制。")
            total = 0
            seen: set[str] = set()
            validated: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
            for info in infos:
                parts = _validate_archive_name(info)
                normalized = "/".join(parts).casefold()
                if normalized in seen:
                    raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 含有重复路径。")
                seen.add(normalized)
                total += info.file_size
                if total > MAX_EXTRACTED_BYTES:
                    raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 解压后超过大小限制。")
                validated.append((info, parts))

            for info, parts in validated:
                target = temporary.joinpath(*parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)

        package = temporary / "paperlens-mineru"
        _validate_package(package, expected_version)
        os.replace(temporary, destination)
    except UpdateError:
        _remove_tree(temporary)
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        _remove_tree(temporary)
        raise UpdateError("UPDATE_ARCHIVE_INVALID", "无法安全解压 Windows 更新 ZIP。") from error


def _validate_archive_name(info: zipfile.ZipInfo) -> tuple[str, ...]:
    name = info.filename
    if not name or "\\" in name or "\x00" in name:
        raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 含有非法路径。")
    path = PurePosixPath(name)
    parts = tuple(part for part in path.parts if part != "")
    if path.is_absolute() or not parts or parts[0] != "paperlens-mineru":
        raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 必须只有固定的包根目录。")
    if any(not _safe_windows_segment(part) for part in parts):
        raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 含有 Windows 非法路径。")
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type == stat.S_IFLNK or (file_type not in (0, stat.S_IFREG, stat.S_IFDIR)):
        raise UpdateError("UPDATE_ARCHIVE_UNSAFE", "更新 ZIP 不允许链接或特殊文件。")
    return parts


def _safe_windows_segment(segment: str) -> bool:
    if segment in (".", "..") or segment.endswith((" ", ".")):
        return False
    if any(ord(character) < 32 or character in _FORBIDDEN_SEGMENT_CHARS for character in segment):
        return False
    return segment.split(".", 1)[0].upper() not in _WINDOWS_DEVICE_NAMES


def _validate_package(package: Path, expected_version: str) -> None:
    if any(not (package / relative).is_file() for relative in _REQUIRED_FILES):
        raise UpdateError("UPDATE_PACKAGE_INVALID", "Windows 更新包结构不完整。")
    try:
        metadata = tomllib.loads((package / "pyproject.toml").read_text(encoding="utf-8"))
        project = metadata["project"]
        name = project["name"]
        version = project["version"]
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as error:
        raise UpdateError("UPDATE_PACKAGE_INVALID", "Windows 更新包元数据无效。") from error
    if name != "paperlens-mineru" or version != expected_version:
        raise UpdateError("UPDATE_PACKAGE_INVALID", "Windows 更新包版本与稳定 Release 不一致。")


def _inside_check_interval(data_root: Path, now: datetime) -> bool:
    state = _read_state(data_root)
    if not state or not isinstance(state.get("attemptedAt"), str):
        return False
    try:
        attempted = _utc(datetime.fromisoformat(state["attemptedAt"]))
    except ValueError:
        return False
    elapsed = now - attempted
    return elapsed < CHECK_INTERVAL


def _read_state(data_root: Path) -> dict[str, object] | None:
    path = data_root / "updates" / "update-state.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        return None
    return value


def _write_state(
    data_root: Path,
    attempted_at: datetime,
    code: str,
    latest_version: str | None,
) -> None:
    root = data_root / "updates"
    root.mkdir(parents=True, exist_ok=True)
    path = root / "update-state.json"
    temporary = root / f".update-state.{uuid4().hex}.tmp"
    payload = {
        "schemaVersion": 1,
        "attemptedAt": _utc(attempted_at).isoformat(),
        "code": code,
        "latestVersion": latest_version,
    }
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise UpdateError("UPDATE_STATE_UNWRITABLE", "无法保存脱敏更新状态。") from error


def _parse_version(value: str) -> tuple[int, int, int]:
    matched = _VERSION_PATTERN.fullmatch(value)
    if not matched:
        raise UpdateError("UPDATE_VERSION_INVALID", "服务版本不是受支持的稳定 SemVer。")
    return tuple(int(matched.group(name)) for name in ("major", "minor", "patch"))


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _remove_tree(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
