"""The bridge's Node dependencies are installed by the launcher, against a stub ``npm``."""
from __future__ import annotations

import json
import os
import stat
import threading
from pathlib import Path

import pytest
from spacemolt import service

# Records each call, sleeps a little so a concurrent caller would overlap, then either fails
# or creates node_modules the way `npm ci` would (wiping what was there).
STUB = """#!/bin/sh
echo "$PWD $*" >> "$NPM_CALLS"
sleep 0.3
if [ -n "$NPM_FAIL" ]; then echo "npm ERR! lockfile is out of sync" >&2; exit 1; fi
rm -rf node_modules && mkdir node_modules
"""


@pytest.fixture
def npm(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "npm"
    stub.write_text(STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    (bin_dir / "node").symlink_to(stub)  # only has to exist on PATH
    calls = tmp_path / "npm-calls"
    monkeypatch.setenv("NPM_CALLS", str(calls))
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/bin{os.pathsep}/usr/bin")
    root = tmp_path / "plugin"
    root.mkdir()
    (root / "package-lock.json").write_text('{"v":1}')
    return root, lambda: calls.read_text().splitlines() if calls.exists() else []


def _journal(event: str) -> list[dict]:
    path = service.runtime_dir() / "gameplay.jsonl"
    lines = path.read_text().splitlines() if path.exists() else []
    return [entry for entry in map(json.loads, lines) if entry["event"] == event]


def test_missing_node_modules_installs_once_and_stamps(npm):
    root, calls = npm
    service.ensure_node_deps(root)
    assert calls() == [f"{root} ci --no-audit --no-fund"]
    assert (root / service.DEPS_STAMP).is_file()
    assert [entry["lock_sha256"] for entry in _journal("deps_installed")] == [
        (root / service.DEPS_STAMP).read_text().strip()]


def test_matching_stamp_calls_no_npm(npm):
    root, calls = npm
    service.ensure_node_deps(root)
    service.ensure_node_deps(root)
    assert len(calls()) == 1
    assert len(_journal("deps_installed")) == 1


def test_changed_lockfile_reinstalls(npm):
    root, calls = npm
    service.ensure_node_deps(root)
    (root / "package-lock.json").write_text('{"v":2}')
    service.ensure_node_deps(root)
    assert len(calls()) == 2


def test_failing_npm_carries_its_output_and_writes_no_stamp(npm, monkeypatch):
    root, calls = npm
    monkeypatch.setenv("NPM_FAIL", "1")
    with pytest.raises(RuntimeError, match="lockfile is out of sync"):
        service.ensure_node_deps(root)
    assert not (root / service.DEPS_STAMP).exists()
    assert _journal("deps_failed")[0]["error"] == "npm ci exited 1"
    monkeypatch.delenv("NPM_FAIL")
    service.ensure_node_deps(root)  # the next start tries again
    assert len(calls()) == 2


def test_concurrent_ensures_install_once(npm):
    root, calls = npm
    errors: list[BaseException] = []

    def ensure() -> None:
        try:
            service.ensure_node_deps(root)
        except BaseException as error:  # noqa: BLE001 - surfaced by the assert below
            errors.append(error)

    threads = [threading.Thread(target=ensure) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert len(calls()) == 1


def test_missing_npm_is_named(npm, monkeypatch):
    root, _ = npm
    (Path(os.environ["PATH"].split(os.pathsep)[0]) / "npm").unlink()
    with pytest.raises(RuntimeError, match="npm not found on PATH"):
        service.ensure_node_deps(root)
