"""Profile-scoped direct bridge owner for the native SpaceMolt plugin."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import threading
from typing import Any

from hermes_constants import get_hermes_home

from .runner import BridgeClient

_DEFAULT_CONTEXT = {
    "stance": "Logistics", "mood": "Focused",
    "objective": "Choose and complete one verified SpaceMolt objective, then finish docked.",
    "wildlife": False, "lock_stance": False, "lock_mood": False,
}
_SERVICES: dict[Path, "SpaceMoltService"] = {}
_SERVICES_LOCK = threading.Lock()


def credentials_configured() -> bool:
    value = os.environ.get("SPACEMOLT_CREDENTIALS_FILE")
    return bool(value and Path(value).is_file())


class SpaceMoltService:
    """The sole bridge owner for one Hermes profile in one process."""

    def __init__(self, home: Path):
        self.home = home
        self.runtime = home / "spacemolt"
        self.runtime.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._bridge: BridgeClient | None = None
        self._context = self._load_context()
        self._broken: str | None = None
        self._handoff_session_id: str | None = None
        self._monitor_stop = threading.Event()
        self._monitor: threading.Thread | None = None
        self._seen_control: str | None = None

    @property
    def source(self) -> Path:
        return Path(__file__).resolve().parent

    def _load_context(self) -> dict[str, Any]:
        try:
            value = json.loads((self.runtime / "service-context.json").read_text())
            return value if isinstance(value, dict) else dict(_DEFAULT_CONTEXT)
        except (OSError, ValueError):
            return dict(_DEFAULT_CONTEXT)

    def _save_context(self) -> None:
        target = self.runtime / "service-context.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._context, indent=2))
        os.chmod(temporary, 0o600)
        temporary.replace(target)

    def _write_status(self) -> None:
        target = self.runtime / "gateway-status.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.status(), indent=2))
        os.chmod(temporary, 0o600)
        temporary.replace(target)

    def _watch_control(self) -> None:
        control = self.runtime / "control.json"
        while not self._monitor_stop.wait(0.2):
            try:
                raw = control.read_text()
            except OSError:
                continue
            if raw == self._seen_control:
                continue
            self._seen_control = raw
            try:
                request = json.loads(raw)
                reason = str(request.get("reason") or "Tired")
            except (TypeError, ValueError):
                continue
            with self._lock:
                if self._bridge is not None:
                    self._bridge.signal_stop(reason)

    def _start_control_monitor(self) -> None:
        if self._monitor is None:
            self._monitor = threading.Thread(target=self._watch_control, daemon=True)
            self._monitor.start()

    def available(self) -> bool:
        return credentials_configured() and shutil.which("node") is not None

    def _ensure_bridge(self) -> BridgeClient:
        if self._broken:
            raise RuntimeError(f"SpaceMolt needs reconciliation after bridge failure: {self._broken}")
        if not self.available():
            raise RuntimeError("SpaceMolt requires SPACEMOLT_CREDENTIALS_FILE and Node.js before it can connect")
        if self._bridge is None:
            env = os.environ.copy()
            env["SPACEMOLT_RUNTIME_DIR"] = str(self.runtime / "runtime")
            self._bridge = BridgeClient(timeout=1800, cwd=self.source, env=env)
            configured = self._bridge.request("execution/configure", self._context)
            if not configured.get("ok"):
                self._broken = str(configured.get("error", "execution configuration failed"))
                raise RuntimeError(self._broken)
            context = configured.get("result", {}).get("context")
            if isinstance(context, dict):
                self._context = context
                self._save_context()
            self._start_control_monitor()
            self._write_status()
        return self._bridge

    def _request(self, action: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            try:
                reply = self._ensure_bridge().request(action, arguments)
            except (TimeoutError, EOFError, OSError, RuntimeError) as error:
                self._broken = str(error)
                self._write_status()
                raise
            if not reply.get("ok"):
                raise RuntimeError(str(reply.get("error", "SpaceMolt request failed")))
            return reply.get("result")

    def call(self, operation: str, arguments: dict[str, Any], *, session_id: str | None = None) -> dict[str, Any]:
        if self._handoff_session_id is not None and session_id and session_id != self._handoff_session_id:
            self._handoff_session_id = None
        if (self._handoff_session_id is not None and session_id == self._handoff_session_id
                and operation not in {"observe", "reconcile", "stop"}):
            return {"status": "handoff_required", "next_session_required": True,
                    "reason": "The plan changed context; continue in a new session."}
        if operation == "stop":
            with self._lock:
                bridge = self._ensure_bridge()
                bridge.signal_stop(str(arguments.get("reason") or "Tired"))
                self._write_status()
                return {"status": "stop_requested", "reason": str(arguments.get("reason") or "Tired")}
        if operation == "plan":
            observed = self._request("job/observe", {})
            planned = self._request("job/plan", arguments)
            if planned.get("status") == "handoff_required":
                handoff = self._request("execution/handoff", {})
                context = handoff.get("context")
                if isinstance(context, dict):
                    self._context = {**self._context, **context}
                    self._save_context()
                self._handoff_session_id = session_id
                return {"observed": observed, "plan": planned, "next_session_required": True}
            return {"observed": observed, "plan": planned}
        actions = {
            "observe": "job/observe", "assess": "job/assess", "prepare": "job/prepare",
            "transport": "job/transport", "return": "job/return_to_base",
            "reconcile": "execution/reconcile",
        }
        return self._request(actions[operation], arguments)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {"runtime": str(self.runtime), "connected": self._bridge is not None,
                    "bridge_pid": self._bridge.process.pid if self._bridge else None,
                    "blocked": self._broken, "credentials_configured": credentials_configured(),
                    "node_available": shutil.which("node") is not None}

    def close(self) -> None:
        with self._lock:
            if self._bridge is not None:
                self._bridge.close()
                self._bridge = None
            self._monitor_stop.set()
            if self._monitor is not None:
                self._monitor.join(timeout=1)
                self._monitor = None
            self._write_status()


def service() -> SpaceMoltService:
    home = Path(get_hermes_home()).resolve()
    with _SERVICES_LOCK:
        return _SERVICES.setdefault(home, SpaceMoltService(home))


def close_services() -> None:
    with _SERVICES_LOCK:
        for entry in _SERVICES.values():
            entry.close()
        _SERVICES.clear()


def request_stop(reason: str) -> dict[str, Any]:
    """Cross-process Tired request; only the gateway owner may touch the bridge."""
    runtime = Path(get_hermes_home()) / "spacemolt"
    runtime.mkdir(parents=True, exist_ok=True)
    target = runtime / "control.json"
    temporary = target.with_suffix(".tmp")
    payload = {"reason": reason or "Tired"}
    temporary.write_text(json.dumps(payload))
    os.chmod(temporary, 0o600)
    temporary.replace(target)
    return {"status": "stop_requested", **payload, "control": str(target)}


def persisted_status() -> dict[str, Any]:
    """Read gateway-written status without starting another controller."""
    path = Path(get_hermes_home()) / "spacemolt" / "gateway-status.json"
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {"connected": False, "status": "invalid status receipt"}
    except (OSError, ValueError):
        return {"connected": False, "status": "no gateway-owned SpaceMolt service has started"}


def _handler(operation: str):
    def handle(arguments: dict[str, Any], session_id: str | None = None, **_: Any) -> str:
        return json.dumps(service().call(operation, arguments, session_id=session_id), separators=(",", ":"))
    return handle


def _schema(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties, "additionalProperties": False}}


_EMPTY: dict[str, Any] = {}
TOOL_DEFINITIONS = tuple(
    {"name": name, "toolset": "spacemolt", "schema": _schema(name, description, properties),
     "handler": _handler(operation), "check_fn": lambda: credentials_configured() and shutil.which("node") is not None,
     "requires_env": ["SPACEMOLT_CREDENTIALS_FILE"], "description": description, "emoji": "🚀"}
    for name, operation, description, properties in (
        ("spacemolt_observe", "observe", "Observe authoritative SpaceMolt state and obligations.", _EMPTY),
        ("spacemolt_plan", "plan", "Choose stance, mood, objective, and observed home. Takes effect next session.", {"stance": {"type": "string"}, "mood": {"type": "string"}, "objective": {"type": "string"}, "home_base_id": {"type": "string"}, "home_rationale": {"type": "string"}}),
        ("spacemolt_assess", "assess", "Assess verified SpaceMolt opportunities or readiness.", {"kind": {"type": "string"}, "shipment_id": {"type": "string"}, "destination": {"type": "string"}}),
        ("spacemolt_prepare", "prepare", "Run verified servicing or passenger preparation.", {"kind": {"type": "string"}}),
        ("spacemolt_transport", "transport", "Execute or resume one verified transport job.", {"kind": {"type": "string"}, "shipment_id": {"type": "string"}, "destination": {"type": "string"}, "resume_job_id": {"type": "string"}}),
        ("spacemolt_return", "return", "Return to remembered home or observed fallback and service.", _EMPTY),
        ("spacemolt_reconcile", "reconcile", "Reconcile unfinished work without replaying uncertain commands.", _EMPTY),
        ("spacemolt_stop", "stop", "Signal Tired to active scripts; they own defensive return and cleanup.", {"reason": {"type": "string"}}),
    )
)
