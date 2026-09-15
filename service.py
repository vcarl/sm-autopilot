"""Bridge ownership for the SpaceMolt plugin.

One Node bridge per Hermes process owns the game connection and the journal; tool
handlers are clients of it and hold no connection state of their own.
"""
from __future__ import annotations

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
READY_TIMEOUT = 120.0
REQUEST_TIMEOUT = 1800.0  # one travel leg can wait out many minutes of game ticks

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


def available() -> bool:
    return credentials_file() is not None and shutil.which("node") is not None


class Bridge:
    """A live bridge subprocess. One request in flight at a time; no replay."""

    def __init__(self) -> None:
        credentials = credentials_file()
        if credentials is None:
            raise RuntimeError("SPACEMOLT_CREDENTIALS_FILE must point at a readable credentials file")
        runtime = Path(os.environ.get("SPACEMOLT_RUNTIME_DIR") or get_hermes_home() / "spacemolt" / "runtime")
        runtime.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "SPACEMOLT_CREDENTIALS_FILE": str(credentials), "SPACEMOLT_RUNTIME_DIR": str(runtime)}
        self.runtime = runtime
        self.inbox: queue.Queue = queue.Queue()
        self.counter = 0
        self.process = subprocess.Popen(
            BRIDGE_COMMAND, cwd=HERE, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True).start()
        try:
            ready = self._receive(READY_TIMEOUT)
            if ready.get("event") != "ready":
                raise RuntimeError(f"SpaceMolt bridge did not report ready: {ready}")
        except BaseException:
            self.close()
            raise

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
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)


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
