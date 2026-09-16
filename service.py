"""Bridge ownership for the SpaceMolt plugin.

One Node bridge per Hermes process owns the game connection and the journal; tool
handlers are clients of it and hold no connection state of their own.
"""
from __future__ import annotations

import contextlib
import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

from agent.secret_scope import UnscopedSecretError, get_secret
from hermes_constants import get_hermes_home

HERE = Path(__file__).resolve().parent
BRIDGE_COMMAND = ["node", "src/bridge.ts"]  # tests point this at a stub
#: The journal's renderer, run as a one-shot rather than reimplemented in Python: the window
#: and the Discord drain then read the same lines from the same code.
RENDER_COMMAND = ["node", "src/journal-lines.ts"]
RENDER_TIMEOUT = 30.0
BRIDGE_STDERR = "bridge.stderr.log"
READY_TIMEOUT = 120.0
REQUEST_TIMEOUT = 1800.0  # one travel leg can wait out many minutes of game ticks
CLOSE_TIMEOUT = 5.0  # per stage of the EOF → SIGTERM → SIGKILL escalation

_lock = threading.RLock()
_bridge: "Bridge | None" = None


def credentials_file() -> Path | None:
    """This turn's credentials path, never another profile's secret."""
    try:
        value = get_secret("SPACEMOLT_CREDENTIALS_FILE", "")
    except UnscopedSecretError:
        return None
    path = Path(value).expanduser() if value else None
    return path if path and path.is_file() else None


def journal_webhook() -> str:
    """Where the rendered journal is posted, if the operator set one. This profile's secret,
    never another's; absent, the bridge starts no drain and posts nothing."""
    try:
        return get_secret("SPACEMOLT_JOURNAL_WEBHOOK", "") or ""
    except UnscopedSecretError:
        return ""


def runtime_dir() -> Path:
    """Where the bridge keeps the journal and its locks, for this profile."""
    return Path(os.environ.get("SPACEMOLT_RUNTIME_DIR") or get_hermes_home() / "spacemolt" / "runtime")


def pilot_path() -> Path:
    """The runner's pilot record — objective, stance, mood, home. The bridge reads the
    same file (``resolve(runtime,'..','pilot.json')``); the agent never writes it."""
    return runtime_dir().parent / "pilot.json"


def render_journal(limit: int) -> str:
    """The tail of the journal, one human line per thing the pilot did.

    ponytail: a subprocess per call, not a port of ``renderLine`` into Python. One renderer
    means the window, the drain and the proofs can never disagree about what a shift looked
    like; a copy in two languages would drift the first time a step gained a field.
    """
    done = subprocess.run([*RENDER_COMMAND, str(runtime_dir()), str(limit)],
                          cwd=HERE, capture_output=True, text=True, timeout=RENDER_TIMEOUT)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip()[-400:] or "the journal would not render")
    return done.stdout.strip()


def available() -> bool:
    return credentials_file() is not None and shutil.which("node") is not None


class Bridge:
    """A live bridge subprocess. One request in flight at a time; no replay."""

    def __init__(self) -> None:
        credentials = credentials_file()
        if credentials is None:
            raise RuntimeError("SPACEMOLT_CREDENTIALS_FILE must point at a readable credentials file")
        runtime = runtime_dir()
        runtime.mkdir(parents=True, exist_ok=True)
        webhook = journal_webhook()
        env = {**os.environ, "SPACEMOLT_CREDENTIALS_FILE": str(credentials), "SPACEMOLT_RUNTIME_DIR": str(runtime),
               **({"SPACEMOLT_JOURNAL_WEBHOOK": webhook} if webhook else {})}
        self.runtime = runtime
        self.inbox: queue.Queue = queue.Queue()
        self.counter = 0
        # The bridge gets its own log, never the gateway's stderr: under launchd that stderr is
        # the supervisor wrapper's read pipe, and a bridge holding it open keeps the wrapper
        # alive after the gateway exits, so launchd never restarts the gateway.
        self.stderr_path = runtime / BRIDGE_STDERR
        self._stderr_from = self.stderr_path.stat().st_size if self.stderr_path.exists() else 0
        with self.stderr_path.open("a", encoding="utf-8") as log:
            self.process = subprocess.Popen(
                BRIDGE_COMMAND, cwd=HERE, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1,
            )
        threading.Thread(target=self._read, daemon=True).start()
        try:
            ready = self._receive(READY_TIMEOUT)
            if ready.get("event") != "ready":
                raise RuntimeError(f"SpaceMolt bridge did not report ready: {ready}")
        except Exception as error:
            self.close()
            # The bridge's own complaint is the only readable account of why it never came up.
            raise RuntimeError(f"SpaceMolt bridge failed to start: {error}{self._stderr_tail()}") from error
        except BaseException:
            self.close()
            raise

    def _stderr_tail(self, limit: int = 2000) -> str:
        """What this bridge wrote before it gave up — never an earlier run's complaint."""
        try:
            with self.stderr_path.open("r", encoding="utf-8", errors="replace") as log:
                log.seek(self._stderr_from)
                text = log.read()[-limit:].strip()
        except OSError:
            return ""
        return f"\n--- {self.stderr_path} ---\n{text}" if text else ""

    def _read(self) -> None:
        try:
            for line in self.process.stdout:  # type: ignore[union-attr]
                if line.strip():
                    self.inbox.put(json.loads(line))
        except Exception as error:  # a malformed line kills the bridge rather than desyncing ids
            self.inbox.put(error)
        finally:
            self.inbox.put(EOFError("SpaceMolt bridge closed"))

    def _receive(self, timeout: float) -> dict[str, Any]:
        try:
            value = self.inbox.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError(
                "SpaceMolt did not answer in time; the action's outcome is unknown. Re-observe before acting."
            ) from error
        if isinstance(value, BaseException):
            raise value
        return value

    def request(self, action: str, params: dict[str, Any]) -> Any:
        self.counter += 1
        request_id = str(self.counter)
        self.process.stdin.write(json.dumps({"id": request_id, "action": action, "params": params}) + "\n")  # type: ignore[union-attr]
        self.process.stdin.flush()  # type: ignore[union-attr]
        reply = self._receive(REQUEST_TIMEOUT)
        if reply.get("id") != request_id:
            raise RuntimeError("SpaceMolt bridge response did not match the request")
        if not reply.get("ok"):
            raise RuntimeError(str(reply.get("error") or "SpaceMolt request failed"))
        return reply.get("result")

    def close(self) -> None:
        """End the bridge for good: stdin EOF is the polite ask, SIGTERM the insistent one, and
        SIGKILL reaches only a survivor. A bridge that outlives its gateway holds the game lock."""
        if self.process.stdin and not self.process.stdin.closed:
            with contextlib.suppress(OSError):
                self.process.stdin.close()
        for escalate in (None, self.process.terminate, self.process.kill):
            if escalate is not None:
                with contextlib.suppress(OSError):
                    escalate()
            try:
                self.process.wait(timeout=CLOSE_TIMEOUT)
                return
            except subprocess.TimeoutExpired:
                continue


def call(action: str, params: dict[str, Any] | None = None) -> Any:
    """Send one request, spawning or replacing a dead bridge first.

    ponytail: one bridge per process, not per profile. Key ``_bridge`` by
    ``get_hermes_home()`` when a multiplexed gateway needs several accounts.
    """
    global _bridge
    with _lock:
        if _bridge is not None and _bridge.process.poll() is not None:
            _bridge = None
        if _bridge is None:
            _bridge = Bridge()
        try:
            return _bridge.request(action, params or {})
        except (TimeoutError, EOFError, OSError):
            # The outcome is unknown; drop the connection rather than replay onto it.
            _bridge.close()
            _bridge = None
            raise


def close_bridge() -> None:
    global _bridge
    with _lock:
        if _bridge is not None:
            _bridge.close()
            _bridge = None
