"""Make the plugin importable as ``spacemolt`` and put Hermes on sys.path.

The plugin lives at this repository's root, but Hermes imports it as the package
``spacemolt`` (the name of the directory it is installed into), and the tests
import it the same way. So the root is bound to that name here rather than
duplicated into a ``spacemolt/`` subdirectory.

Hermes itself is not vendored. Its checkout is found through
``HERMES_AGENT_ROOT``, falling back to ``~/.hermes/hermes-agent``, which is where
``hermes`` installs it — the same two paths the live juncture gate puts on
sys.path. ``tests/`` joins them so a test can import a sibling helper module,
which ``--import-mode=importlib`` (see pytest.ini) does not arrange itself.
"""
from __future__ import annotations

import atexit
import hashlib
import importlib.util
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
HERMES = Path(os.environ.get("HERMES_AGENT_ROOT") or Path.home() / ".hermes" / "hermes-agent")

for path in (str(ROOT / "tests"), str(ROOT), str(HERMES)):
    if path not in sys.path:
        sys.path.insert(0, path)

# ── Nothing here may touch the real Hermes home ──────────────────────────────
# The plugin resolves its pilot record, its runtime directory and the cron jobs
# file under ``get_hermes_home()``, and some Hermes modules resolve that at
# import time. So the redirect has to be in place before the first test module
# is imported, and again per test, or a test run writes a cron job and a pilot
# record into the operator's own install. It comes before the plugin is bound
# below, because binding it imports Hermes modules too (09-25: a run from before
# this redirect existed wrote a pilot record, a lock and a cron job into ~/.hermes).
_SESSION_HOME = tempfile.mkdtemp(prefix="spacemolt-test-home-")
os.environ["HERMES_HOME"] = _SESSION_HOME
os.environ["HERMES_TEST_ISOLATION"] = _SESSION_HOME
atexit.register(shutil.rmtree, _SESSION_HOME, True)


if "spacemolt" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "spacemolt", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["spacemolt"] = module
    spec.loader.exec_module(module)
    # pytest sees an ``__init__.py`` beside its rootdir and collects the root as a
    # package, importing that file under the name ``__init__`` — where the plugin's
    # own relative imports cannot resolve. Answering with the module already loaded
    # keeps that collection from executing it a second time under the wrong name.
    sys.modules.setdefault("__init__", module)


@pytest.fixture(autouse=True)
def _isolated_hermes_home(tmp_path, monkeypatch):
    """A fresh Hermes home per test, and no credentials in the environment."""
    home = tmp_path / "hermes_home"
    for name in ("", "sessions", "cron", "memories", "skills"):
        (home / name).mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TZ", "UTC")  # journal lines are rendered as clock times
    time.tzset()
    monkeypatch.setenv("HERMES_TEST_ISOLATION", str(home))
    for name in list(os.environ):
        if name.startswith("SPACEMOLT_") or name.endswith(
            ("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIALS", "_WEBHOOK")
        ):
            monkeypatch.delenv(name, raising=False)
    # The tripwire: every path the plugin writes resolves under this test's home, or the test
    # does not run. A context-local home override in Hermes would bypass the env var above.
    from spacemolt import service
    assert service.runtime_dir().is_relative_to(home), service.runtime_dir()
    # A stub bridge never installs into the checkout: its deps dir is a scratch one whose stamp
    # already matches, so every bridge a test starts takes the no-npm path.
    deps = tmp_path / "deps"
    (deps / "node_modules").mkdir(parents=True)
    (deps / "package-lock.json").write_text("{}")
    (deps / service.DEPS_STAMP).write_text(hashlib.sha256(b"{}").hexdigest())
    monkeypatch.setattr(service, "DEPS_ROOT", deps)
