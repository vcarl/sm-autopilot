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
from datetime import datetime, timezone
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
#: A backstop only: the bridge caps a run itself (``RUN_CAP_MS`` + grace in run.ts, 26 min).
REQUEST_TIMEOUT = 1800.0
CLOSE_TIMEOUT = 5.0  # per stage of the EOF → SIGTERM → SIGKILL escalation

_lock = threading.RLock()
_bridge: Bridge | None = None


def source_fingerprint() -> str:
    """What the bridge's TypeScript looked like, cheaply enough to ask on every request.

    ponytail: the count and newest mtime of ``src/**/*.ts``, not a git sha — a sha costs a
    subprocess and misses the uncommitted edit a live session is usually testing. Ceiling:
    an edit that changes neither the file count nor the newest mtime is invisible.

    ponytail: this closes the *TypeScript* gap only. ``__init__.py``, ``juncture.py`` and
    this file are imported once by the Hermes process and cannot reload themselves from
    inside the plugin; a change to the plugin's Python still needs a gateway restart.
    """
    files = list((HERE / "src").rglob("*.ts"))
    return f"{len(files)} files, newest {max((f.stat().st_mtime_ns for f in files), default=0)}"


def credentials_file() -> Path | None:
    """This turn's credentials path, never another profile's secret."""
    try:
        value = get_secret("SPACEMOLT_CREDENTIALS_FILE", "")
    except UnscopedSecretError:
        return None
    path = Path(value).expanduser() if value else None
    return path if path and path.is_file() else None


def journal_webhook() -> str:
    """Where the rendered journal is posted, if the human set one. This profile's secret,
    never another's; absent, the bridge starts no drain and posts nothing."""
    try:
        return get_secret("SPACEMOLT_JOURNAL_WEBHOOK", "") or ""
    except UnscopedSecretError:
        return ""


def runtime_dir() -> Path:
    """Where the bridge keeps the journal and its locks, for this profile."""
    return Path(os.environ.get("SPACEMOLT_RUNTIME_DIR") or get_hermes_home() / "spacemolt" / "runtime")


def pilot_path() -> Path:
    """The pilot record — objective, goal, stance, permissions. The bridge is its one writer
    (``resolve(runtime,'..','pilot.json')``); Python only reads it."""
    return runtime_dir().parent / "pilot.json"


def pilot_file() -> Path:
    """The one file the pilot plays by editing: ``pilot/index.ts`` under the runtime dir.
    The bridge installs the example there on the first `check` or `run`."""
    return runtime_dir() / "pilot" / "index.ts"


def render_journal(limit: int) -> str:
    """The tail of the journal, one human line per thing the pilot did.

    ponytail: a subprocess per call, not a port of ``renderLine`` into Python. One renderer
    means the window and the drain can never disagree about what a shift looked
    like; a copy in two languages would drift the first time a step gained a field.
    """
    done = subprocess.run([*RENDER_COMMAND, str(runtime_dir()), str(limit)],
                          cwd=HERE, capture_output=True, text=True, timeout=RENDER_TIMEOUT, check=False)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip()[-400:] or "the journal would not render")
    return done.stdout.strip()


def rotate_log(path: Path) -> None:
    """A non-empty log moved aside as ``<stem>.<UTC stamp>.<ext>`` before a fresh one is opened
    (the bridge's own journal rotates the same way, in ``bootJournal``). ``_n`` on a clash sorts
    after the plain stamp, so the newer still reads as newer.

    ponytail: rotated logs are kept forever, for post hoc analysis; prune here if disk matters.
    """
    if not path.is_file() or not path.stat().st_size:
        return
    stem = f"{path.stem}.{datetime.now(timezone.utc):%Y-%m-%dT%H-%M-%SZ}"
    target, n = path.with_name(f"{stem}{path.suffix}"), 1
    while target.exists():
        n += 1
        target = path.with_name(f"{stem}_{n}{path.suffix}")
    path.rename(target)


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
        #: The sources this process booted on, so "is the bridge running the latest code?" is
        #: answered by reading rather than by dating a pid against a reflog.
        self.sources = source_fingerprint()
        env["SPACEMOLT_SOURCES"] = self.sources  # stamped on run/started (telemetry)
        self.deferred = ""
        self.inbox: queue.Queue = queue.Queue()
        #: One queue per request in flight, keyed by id: a `run` blocks for minutes while
        #: `status` and `stop` still want answers, so replies are routed, not read in order.
        self.waiting: dict[str, queue.Queue] = {}
        self.write_lock = threading.Lock()
        self.counter = 0
        # The bridge gets its own log, never the gateway's stderr: under launchd that stderr is
        # the supervisor wrapper's read pipe, and a bridge holding it open keeps the wrapper
        # alive after the gateway exits, so launchd never restarts the gateway.
        self.stderr_path = runtime / BRIDGE_STDERR
        rotate_log(self.stderr_path)  # so the log holds this bridge's complaints and no earlier one's
        with self.stderr_path.open("a", encoding="utf-8") as log:
            log.write(f"[bridge] booting on {self.sources}\n")
            log.flush()
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
            text = self.stderr_path.read_text(encoding="utf-8", errors="replace")[-limit:].strip()
        except OSError:
            return ""
        return f"\n--- {self.stderr_path} ---\n{text}" if text else ""

    def _read(self) -> None:
        try:
            for line in self.process.stdout:  # type: ignore[union-attr]
                if not line.strip():
                    continue
                message = json.loads(line)
                box = self.waiting.get(str(message.get("id")))
                (box if box is not None else self.inbox).put(message)
        except Exception as error:  # noqa: BLE001 - a malformed line kills the bridge rather than desyncing ids
            self.inbox.put(error)
            for box in list(self.waiting.values()):
                box.put(error)
        finally:
            closed = EOFError("SpaceMolt bridge closed")
            self.inbox.put(closed)
            for box in list(self.waiting.values()):
                box.put(closed)

    def _receive(self, timeout: float, box: queue.Queue | None = None) -> dict[str, Any]:
        try:
            value = (box if box is not None else self.inbox).get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError(
                "SpaceMolt did not answer in time; the action's outcome is unknown. Re-observe before acting."
            ) from error
        if isinstance(value, BaseException):
            raise value
        return value

    def request(self, action: str, params: dict[str, Any], on_line=None) -> Any:
        """One request, one reply. Event lines streamed under the same id go to ``on_line``
        as they arrive; the reply ends the wait."""
        box: queue.Queue = queue.Queue()
        with self.write_lock:
            self.counter += 1
            request_id = str(self.counter)
            self.waiting[request_id] = box
            self.process.stdin.write(json.dumps({"id": request_id, "action": action, "params": params}) + "\n")  # type: ignore[union-attr]
            self.process.stdin.flush()  # type: ignore[union-attr]
        try:
            while True:
                reply = self._receive(REQUEST_TIMEOUT, box)
                if reply.get("event") == "line":
                    if on_line is not None:
                        on_line(str(reply.get("text", "")))
                    continue
                break
        finally:
            self.waiting.pop(request_id, None)
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


def _in_flight(bridge: Bridge) -> bool:
    """Is work going on that a recycle would destroy? A request of ours still waiting for its
    reply, or a run the bridge has not ended — the signal the wake gate reads."""
    from .juncture import run_in_flight
    return bool(bridge.waiting) or run_in_flight()


def _defer_reload(bridge: Bridge, sources: str) -> None:
    """Say once, in the pilot's journal, that newer code is on disk and the run in flight keeps
    the bridge it has. Tearing down a working run to pick up an edit costs more than waiting."""
    if bridge.deferred == sources:
        return
    bridge.deferred = sources
    from .juncture import journal_event
    journal_event("log", script="bridge", message="reload deferred: a run is in flight",
                  booted_on=bridge.sources, on_disk=sources)


def call(action: str, params: dict[str, Any] | None = None, on_line=None) -> Any:
    """Send one request, spawning or replacing a dead — or outdated — bridge first. Requests run
    concurrently: a `run` blocks for minutes while `status` and `stop` still answer.

    ponytail: one bridge per process, not per profile. Key ``_bridge`` by
    ``get_hermes_home()`` when a multiplexed gateway needs several accounts.
    """
    global _bridge
    with _lock:
        if _bridge is not None and _bridge.process.poll() is not None:
            _bridge = None
        if _bridge is not None and _bridge.sources != (sources := source_fingerprint()):
            if _in_flight(_bridge):
                _defer_reload(_bridge, sources)
            else:
                # The old process holds the controller lock and the journal, so it ends before
                # a new one asks for them — by the same EOF → SIGTERM → SIGKILL escalation.
                _bridge.close()
                _bridge = None
        if _bridge is None:
            _bridge = Bridge()
        bridge = _bridge
    try:
        return bridge.request(action, params or {}, on_line)
    except (TimeoutError, EOFError, OSError):
        # The outcome is unknown; drop the connection rather than replay onto it.
        with _lock:
            if _bridge is bridge:
                _bridge = None
        bridge.close()
        raise


def close_bridge() -> None:
    global _bridge
    with _lock:
        if _bridge is not None:
            _bridge.close()
            _bridge = None
