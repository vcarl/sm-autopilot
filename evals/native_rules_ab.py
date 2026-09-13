#!/usr/bin/env python3
"""Run a bounded before/after benchmark through Hermes' real AIAgent and plugin service.

The operator must stop the profile gateway first.  Each workload runs in a fresh child
process and a fresh HERMES_HOME, which gives it one service-owned bridge and independent
one-job state while leaving the selected profile configuration untouched.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import suppress
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from typing import Any
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[2]
with suppress(ValueError):
    sys.path.remove(str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT))


WORKLOADS = {
    "industry": (
        "Run one bounded Focused Industry gathering attempt. Observe first, plan Industry with "
        "the observed dock as home if a handoff is needed, assess a local resource opportunity, "
        "and call spacemolt_gather at most once with cycles=1. Make no discretionary purchases. "
        "You must execute the relevant tools now and continue until a terminal receipt exists; "
        "do not end by saying what you will assess or do. Finish docked and serviced. State only "
        "outcomes proved by tool receipts; if the attempt is infeasible, report the exact blocker "
        "returned by a tool without substituting another objective."
    ),
    "logistics": (
        "Run one bounded Focused Logistics delivery attempt. Observe first, plan Logistics with "
        "the observed dock as home if a handoff is needed, assess freight or passenger work, and "
        "call spacemolt_transport at most once for exactly one feasible delivery. Do not buy a "
        "ship, cabin, or other equipment. You must execute the relevant tools now and continue "
        "until a terminal receipt exists; do not end by saying what you will assess or do. Finish "
        "docked and serviced. State only outcomes proved by tool receipts; if no delivery is "
        "feasible, report the exact blocker returned by a tool."
    ),
}
FOLLOWUP_PROMPTS = {
    "industry": (
        "Continue the same bounded attempt now. Call the required assessment and spacemolt_gather "
        "tools; do not reply with a plan. End only after a terminal tool receipt or a tool-returned blocker."
    ),
    "logistics": (
        "Continue the same bounded attempt now. Call the targeted assessment and spacemolt_transport "
        "tools; do not reply with a plan. End only after a terminal tool receipt or a tool-returned blocker."
    ),
}
HANDOFF_PREFIX = (
    "This is the required fresh session after a plan handoff. The selected plan is already active: "
    "observe its context and do not call spacemolt_plan again when it matches this workload. "
)
PRODUCTIVE_TOOL = {"industry": "spacemolt_gather", "logistics": "spacemolt_transport"}
ALLOWED_TOOLS = (
    "spacemolt_observe", "spacemolt_plan", "spacemolt_assess", "spacemolt_prepare",
    "spacemolt_transport", "spacemolt_track", "spacemolt_hunt", "spacemolt_gather",
    "spacemolt_produce", "spacemolt_return", "spacemolt_reconcile", "spacemolt_stop",
)
TOPOLOGY = (
    "isolated local Hermes AIAgent process with the selected native plugin service and its single "
    "bridge; the operator paused the profile gateway; this is not Discord or cron delivery"
)


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_receipt(source: Path) -> dict[str, Any]:
    """Identify the selected executable roots without importing the workspace package."""
    source = source.expanduser().resolve()
    required = [source / "__init__.py", source / "service.py", source / "src" / "bridge.ts"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError("selected SpaceMolt source is incomplete: " + ", ".join(missing))
    executable = sorted(source.glob("*.py")) + sorted((source / "src").glob("*.ts"))
    skill_sources = sorted((source / "skills").glob("*/SKILL.md"))
    return {"source": str(source), "files": {
        str(path.relative_to(source)): _sha256(path) for path in executable + skill_sources
    }}


def _load_source(source: Path):
    alias = f"_spacemolt_eval_{hashlib.sha256(str(source).encode()).hexdigest()[:12]}"
    spec = importlib.util.spec_from_file_location(
        alias, source / "__init__.py", submodule_search_locations=[str(source)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load native plugin from {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    loaded = Path(module.__file__).resolve()
    if loaded != (source / "__init__.py").resolve():
        raise RuntimeError(f"source selection drifted to {loaded}")
    return module, alias


def _profile_runtime(profile_home: Path) -> tuple[dict[str, Any], str, dict[str, str]]:
    """Resolve the configured model in the profile without writing or exposing its secrets."""
    os.environ["HERMES_HOME"] = str(profile_home)
    from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider

    secrets = build_profile_secret_scope(profile_home)
    token = set_secret_scope(secrets)
    try:
        config = load_config() or {}
        model_config = config.get("model") if isinstance(config.get("model"), dict) else {}
        model = str(model_config.get("default") or model_config.get("model") or "").strip()
        if not model:
            raise RuntimeError("the selected profile has no configured default model")
        runtime = resolve_runtime_provider(
            requested=str(model_config.get("provider") or "").strip() or None,
            target_model=model,
        )
    finally:
        reset_secret_scope(token)
    return runtime, model, secrets


def _public_runtime(runtime: dict[str, Any], model: str) -> dict[str, Any]:
    parsed = urlsplit(str(runtime.get("base_url") or ""))
    return {
        "model": model,
        "provider": runtime.get("provider") or "",
        "requested_provider": runtime.get("requested_provider") or "",
        "api_mode": runtime.get("api_mode") or "",
        "endpoint": f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else "",
    }


def _write_eval_config(home: Path) -> None:
    """Pin eager native tools in the disposable run profile for an auditable catalog."""
    target = home / "config.yaml"
    target.write_text("tools:\n  tool_search:\n    enabled: off\n")
    os.chmod(target, 0o600)


def _plugin_prompt(module: Any, source: Path, workload: str) -> str:
    parts = [str(module._PROMPT).strip()]
    for skill in ("spacemolt-operations", f"spacemolt-{workload}"):
        path = source / "skills" / skill / "SKILL.md"
        if not path.is_file():
            raise FileNotFoundError(f"selected source is missing {path.relative_to(source)}")
        parts.append(path.read_text().strip())
    return "\n\n".join(parts)


def _parse_result(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def _walk(value: Any):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _credits(observation: Any) -> float | None:
    if not isinstance(observation, dict):
        return None
    state = observation.get("state") if isinstance(observation.get("state"), dict) else observation
    value = state.get("credits")
    return float(value) if isinstance(value, (int, float)) else None


def _inventory(observation: Any) -> list[dict[str, Any]]:
    if not isinstance(observation, dict):
        return []
    state = observation.get("state") if isinstance(observation.get("state"), dict) else observation
    rows = state.get("cargo") if isinstance(state.get("cargo"), list) else []
    return [
        {key: row.get(key) for key in ("item_id", "item_name", "quantity", "size") if key in row}
        for row in rows if isinstance(row, dict) and row.get("quantity")
    ]


def _obligations(observation: Any) -> dict[str, Any]:
    if not isinstance(observation, dict):
        return {"available": False}
    raw = observation.get("obligations")
    if not isinstance(raw, dict):
        return {"available": False}
    return {"available": True, "canonical": raw}


def _finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _productive_receipt_verified(workload: str, receipt: Any) -> bool:
    if not isinstance(receipt, dict) or receipt.get("status") != "completed":
        return False
    result = receipt.get("result")
    if not isinstance(result, dict):
        return False
    if workload == "industry":
        gather = result.get("gather")
        if not isinstance(gather, dict) or gather.get("status") != "completed":
            return False
        yields = gather.get("yields")
        retained = gather.get("retained_cargo")
        return bool(
            isinstance(gather.get("cycles_completed"), int) and gather["cycles_completed"] >= 1
            and isinstance(yields, dict) and yields
            and all(_finite_number(quantity) and quantity > 0 for quantity in yields.values())
            and isinstance(retained, dict)
            and all(retained.get(item) == quantity for item, quantity in yields.items())
            and gather.get("inventory_verification")
            == "Starting cargo preserved; measured new yield remains carried"
        )
    transport = result.get("transport")
    if not isinstance(transport, dict) or transport.get("status") != "completed":
        return False
    if transport.get("pending_action") or transport.get("accounting_unverified"):
        return False
    if transport.get("kind") == "freight":
        delivery = transport.get("delivery")
        contract = delivery.get("contract") if isinstance(delivery, dict) else None
        return bool(
            isinstance(contract, dict) and contract.get("id") == transport.get("shipment_id")
            and contract.get("status") == "delivered" and _finite_number(transport.get("payout"))
        )
    if transport.get("kind") == "passengers":
        loaded = transport.get("loaded")
        delivered = transport.get("delivered")
        if not isinstance(loaded, list) or not loaded or not isinstance(delivered, list):
            return False
        delivered_ids = {row.get("citizen_id") for row in delivered if isinstance(row, dict)}
        return bool(
            all(isinstance(row, dict) and row.get("citizen_id") in delivered_ids for row in loaded)
            and _finite_number(transport.get("fare_collected")) and transport["fare_collected"] >= 0
        )
    return False


_BLOCKING_STATUSES = {"blocked", "denied", "error", "failed", "infeasible"}


def _summary_blockers(private: dict[str, Any], receipts: list[dict[str, Any]], successful: bool) -> list[str]:
    """Return terminal failure evidence, excluding diagnostics from a completed run."""
    if successful:
        return []
    blockers: list[str] = []
    error = private.get("error")
    if isinstance(error, (str, int, float)) and str(error):
        blockers.append(str(error))
    for node in _walk([receipts, private.get("cleanup", []), private.get("sessions", [])]):
        if not isinstance(node, dict):
            continue
        for key in ("blocker", "blockers"):
            value = node.get(key)
            values = value if isinstance(value, list) else [value]
            blockers.extend(
                str(item) for item in values
                if isinstance(item, (str, int, float)) and str(item)
            )
        if str(node.get("status", "")).lower() in _BLOCKING_STATUSES:
            for key in ("reason", "error"):
                value = node.get(key)
                if isinstance(value, (str, int, float)) and str(value):
                    blockers.append(str(value))
    return list(dict.fromkeys(blockers))


def summarize_run(private: dict[str, Any]) -> dict[str, Any]:
    """Project a private trace into shareable evidence without profile or credential paths."""
    before, after = private.get("initial_observation"), private.get("final_observation")
    before_credits, after_credits = _credits(before), _credits(after)
    events = private.get("tool_events", [])
    tool_counts = Counter(
        event.get("name") for event in events
        if isinstance(event, dict) and event.get("phase") == "complete" and event.get("name")
    )
    receipts_by_id: dict[str, dict[str, Any]] = {}
    authoritative = after.get("receipts") if isinstance(after, dict) and isinstance(after.get("receipts"), list) else []
    for receipt in authoritative:
        if isinstance(receipt, dict) and isinstance(receipt.get("id"), str):
            receipts_by_id[receipt["id"]] = receipt
    receipts = list(receipts_by_id.values())
    cash_deltas = [
        float(receipt["cash_delta"]) for receipt in receipts
        if isinstance(receipt.get("cash_delta"), (int, float))
    ]
    gross_by_owner: dict[str, float | None] = {}
    cost_receipts = []
    for receipt in receipts:
        spending = receipt.get("budget_spending")
        gross = spending.get("gross_spend") if isinstance(spending, dict) else None
        owner = str(receipt.get("budget_owner_id") or receipt.get("id"))
        if isinstance(gross, (int, float)):
            gross_by_owner[owner] = float(gross)
        elif isinstance(spending, dict):
            gross_by_owner[owner] = None
        cost_receipts.append({
            "job_id": receipt.get("id"), "budget_owner_id": receipt.get("budget_owner_id"),
            "cash_delta": receipt.get("cash_delta"), "budget_spending": spending,
            "service_fuel_quotes": receipt.get("service_fuel_quotes"),
        })
    usage_keys = (
        "session_api_calls", "session_input_tokens", "session_output_tokens", "session_total_tokens",
        "session_cache_read_tokens", "session_cache_write_tokens", "session_reasoning_tokens",
        "session_estimated_cost_usd",
    )
    usage = {}
    for key in usage_keys:
        values = [s.get("usage", {}).get(key) for s in private.get("sessions", [])]
        usage[key.removeprefix("session_")] = (
            sum(float(value) for value in values) if values and all(isinstance(value, (int, float)) for value in values)
            else None
        )
    cost_statuses = [s.get("usage", {}).get("session_cost_status") for s in private.get("sessions", [])]
    if not cost_statuses or any(status in (None, "unknown") for status in cost_statuses):
        usage["estimated_cost_usd"] = None
    for key, value in list(usage.items()):
        if key != "estimated_cost_usd" and value is not None:
            usage[key] = int(value)
    workload = private.get("workload")
    productive_action = "gather" if workload == "industry" else "transport"
    productive_receipts = [receipt for receipt in receipts if receipt.get("action") == productive_action]
    receipt = productive_receipts[-1] if productive_receipts else None
    state = after.get("state") if isinstance(after, dict) and isinstance(after.get("state"), dict) else {}
    ship = state.get("ship") if isinstance(state.get("ship"), dict) else {}
    location = state.get("location") if isinstance(state.get("location"), dict) else {}
    terminal_ready = bool(
        location.get("docked_at") and not location.get("in_transit") and ship
        and all(isinstance(ship.get(key), (int, float)) for key in ("fuel", "max_fuel", "hull", "max_hull"))
        and all(isinstance(ship.get(key), (int, float)) for key in ("shield", "max_shield"))
        and ship.get("fuel") == ship.get("max_fuel") and ship.get("hull") == ship.get("max_hull")
        and ship.get("shield") == ship.get("max_shield")
        and not ship.get("incapacitated")
    )
    successful = _productive_receipt_verified(workload, receipt) and terminal_ready
    return {
        "schema": 1,
        "label": private.get("label"),
        "workload": private.get("workload"),
        "topology": TOPOLOGY,
        "source_receipt": private.get("source_receipt"),
        "runtime": private.get("runtime"),
        "protocol": private.get("protocol"),
        "status": "completed" if successful else "blocked",
        "elapsed_seconds": private.get("elapsed_seconds"),
        "sessions": len(private.get("sessions", [])),
        "followups": sum(int(session.get("followups_used", 0)) for session in private.get("sessions", [])),
        "usage": usage,
        "model_tool_calls": dict(sorted(tool_counts.items())),
        "harness_tool_calls": private.get("harness_tool_calls", {}),
        "credits": {
            "before": before_credits,
            "after": after_credits,
            "delta": after_credits - before_credits if before_credits is not None and after_credits is not None else None,
        },
        "recorded_receipt_cash_delta": sum(cash_deltas) if cash_deltas else None,
        "costs": {
            "model_estimate_usd": usage.get("estimated_cost_usd"),
            "game_gross_spend": (
                sum(gross_by_owner.values()) if gross_by_owner and all(value is not None for value in gross_by_owner.values())
                else None
            ),
            "receipts": cost_receipts,
        },
        "receipts": receipts,
        "retained_inventory": _inventory(after),
        "obligations": _obligations(after),
        "blockers": _summary_blockers(private, receipts, successful),
        "cleanup": private.get("cleanup", []),
        "terminal_ready": terminal_ready,
        "error": private.get("error"),
    }


def compare_summaries(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    if before.get("workload") != after.get("workload"):
        raise ValueError("comparison summaries describe different workloads")
    if before.get("runtime") != after.get("runtime"):
        raise ValueError("comparison arms did not use the same configured model runtime")
    if before.get("protocol") != after.get("protocol"):
        raise ValueError("comparison arms did not use the same workload protocol")
    def metric(summary: dict[str, Any], *path: str) -> Any:
        value: Any = summary
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        return value
    deltas = {}
    for name, path in {
        "elapsed_seconds": ("elapsed_seconds",), "api_calls": ("usage", "api_calls"),
        "total_tokens": ("usage", "total_tokens"), "model_cost_usd": ("usage", "estimated_cost_usd"),
        "game_gross_spend": ("costs", "game_gross_spend"),
        "credits": ("credits", "delta"),
    }.items():
        left, right = metric(before, *path), metric(after, *path)
        deltas[name] = right - left if isinstance(left, (int, float)) and isinstance(right, (int, float)) else None
    return {"schema": 1, "workload": before["workload"], "before": before, "after": after, "after_minus_before": deltas}


def _register_plugin(module: Any, source: Path, home: Path, workload: str):
    from hermes_cli.plugins import PluginContext, PluginManager
    from hermes_cli.plugins_manifest import PluginManifest
    from toolsets import create_custom_toolset

    manager = PluginManager(scope_key=str(home.resolve()))
    manifest = PluginManifest(
        name=f"spacemolt-eval-{workload}", source="project", path=str(source),
        provides_tools=[definition["name"] for definition in module.TOOL_DEFINITIONS],
    )
    context = PluginContext(manifest, manager)
    module.register(context)
    toolset = f"spacemolt_eval_{workload}"
    create_custom_toolset(toolset, f"Bounded native SpaceMolt {workload} comparison", list(ALLOWED_TOOLS))
    return manager, toolset


def _usage(agent: Any) -> dict[str, Any]:
    keys = (
        "session_api_calls", "session_input_tokens", "session_output_tokens", "session_total_tokens",
        "session_cache_read_tokens", "session_cache_write_tokens", "session_reasoning_tokens",
        "session_estimated_cost_usd", "session_cost_status", "session_cost_source",
    )
    result = {key: getattr(agent, key, None) for key in keys}
    if result.get("session_api_calls") and not isinstance(getattr(agent, "_last_turn_usage", None), dict):
        for key in (
            "session_input_tokens", "session_output_tokens", "session_total_tokens",
            "session_cache_read_tokens", "session_cache_write_tokens", "session_reasoning_tokens",
        ):
            result[key] = None
    return result


def _usage_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for key, value in after.items():
        previous = before.get(key)
        result[key] = value - previous if isinstance(value, (int, float)) and isinstance(previous, (int, float)) else value
    return result


def _session_decision(events: list[dict[str, Any]], productive_tool: str, pending_handoff: bool,
                      followups_used: int, max_followups: int) -> str:
    if pending_handoff:
        return "handoff"
    attempted = any(
        event.get("phase") == "complete" and event.get("name") == productive_tool
        and not (isinstance(event.get("result"), dict) and event["result"].get("status") == "handoff_required")
        for event in events
    )
    if attempted:
        return "done"
    return "followup" if followups_used < max_followups else "done"


def _requires_session_boundary(result: Any) -> bool:
    return bool(
        isinstance(result, dict)
        and (result.get("next_session_required") is True
             or result.get("status") in {"handoff_required", "needs_reconciliation"})
    )


def run_workload(args: argparse.Namespace) -> int:
    started = time.monotonic()
    source = Path(args.source).expanduser().resolve()
    profile_home = Path(args.profile_home).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    private_path, summary_path = output / "private.json", output / "summary.json"
    output.mkdir(parents=True, exist_ok=True)
    os.chmod(output, 0o700)
    private: dict[str, Any] = {
        "schema": 1, "label": args.label, "workload": args.workload,
        "source_receipt": source_receipt(source), "tool_events": [], "sessions": [],
        "harness_tool_calls": {}, "cleanup": [], "topology": TOPOLOGY,
        "protocol": {
            "prompt": WORKLOADS[args.workload], "followup_prompt": FOLLOWUP_PROMPTS[args.workload],
            "handoff_prefix": HANDOFF_PREFIX,
            "tool_grant": list(ALLOWED_TOOLS),
            "limits": {"max_sessions": args.max_sessions, "max_iterations": args.max_iterations,
                       "max_followups": args.max_followups, "max_tokens": args.max_tokens,
                       "run_budget_seconds": args.run_budget_seconds,
                       "productive_attempts": 1},
        },
    }
    _atomic_json(private_path, private)
    module = alias = manager = None
    agents = []
    try:
        runtime, model, profile_secrets = _profile_runtime(profile_home)
        from agent.secret_scope import reset_secret_scope, set_secret_scope
        secret_token = set_secret_scope(profile_secrets)
        private["runtime"] = _public_runtime(runtime, model)
        run_home = output / "hermes-home"
        run_home.mkdir(parents=True, exist_ok=True)
        os.chmod(run_home, 0o700)
        _write_eval_config(run_home)
        os.environ["HERMES_HOME"] = str(run_home)
        module, alias = _load_source(source)
        import run_agent
        hermes_core = Path(run_agent.__file__).resolve()
        if hermes_core != REPO_ROOT / "run_agent.py":
            raise RuntimeError(f"Hermes core import drifted to {hermes_core}")
        private["source_receipt"]["loaded_python"] = str(Path(module.__file__).resolve())
        private["source_receipt"]["bridge_cwd"] = str(Path(module.service.__file__).resolve().parent)
        private["source_receipt"]["hermes_core"] = str(hermes_core)
        manager, toolset = _register_plugin(module, source, run_home, args.workload)
        prompt = _plugin_prompt(module, source, args.workload)
        from tools.registry import registry

        scope = str(run_home.resolve())
        initial_raw = registry.dispatch("spacemolt_observe", {}, scope=scope, session_id="eval-initial")
        private["initial_observation"] = _parse_result(initial_raw)
        private["harness_tool_calls"]["spacemolt_observe"] = 1
        _atomic_json(private_path, private)

        for index in range(args.max_sessions):
            session_id = f"eval-{args.label}-{args.workload}-{index + 1}-{uuid.uuid4().hex[:8]}"
            def tool_start(call_id, name, call_args):
                private["tool_events"].append({"phase": "start", "call_id": call_id, "name": name, "args": call_args})
                _atomic_json(private_path, private)
            def tool_complete(call_id, name, call_args, result):
                parsed = _parse_result(result)
                private["tool_events"].append({"phase": "complete", "call_id": call_id, "name": name, "args": call_args, "result": parsed})
                _atomic_json(private_path, private)
                if _requires_session_boundary(parsed):
                    agent.interrupt()

            from run_agent import AIAgent
            agent = AIAgent(
                api_key=runtime.get("api_key"), base_url=runtime.get("base_url"),
                provider=runtime.get("provider"), requested_provider=runtime.get("requested_provider"),
                api_mode=runtime.get("api_mode"), credential_pool=runtime.get("credential_pool"),
                model=model, enabled_toolsets=[toolset], session_id=session_id,
                max_iterations=args.max_iterations, max_tokens=args.max_tokens,
                run_budget_seconds=args.run_budget_seconds, quiet_mode=True, platform="cli",
                ephemeral_system_prompt=prompt, skip_context_files=True, skip_memory=True,
                skip_background_review=True, pass_session_id=True,
                tool_start_callback=tool_start, tool_complete_callback=tool_complete,
            )
            agents.append(agent)
            agent.suppress_status_output = True
            if agent.valid_tool_names != set(ALLOWED_TOOLS) or "spacemolt_chat" in agent.valid_tool_names:
                raise RuntimeError(
                    "model tool grant differs from the fixed comparison catalog: "
                    + ", ".join(sorted(agent.valid_tool_names))
                )
            session = {"session_id": session_id, "turns": [], "valid_tools": sorted(agent.valid_tool_names)}
            private["sessions"].append(session)
            history = None
            event_start = len(private["tool_events"])
            followups_used = 0
            while True:
                turn_prompt = (
                    (HANDOFF_PREFIX if index else "")
                    + WORKLOADS[args.workload]
                    if not session["turns"] else FOLLOWUP_PROMPTS[args.workload]
                )
                before_usage = _usage(agent)
                turn = agent.run_conversation(turn_prompt, conversation_history=history)
                after_usage = _usage(agent)
                session["turns"].append({
                    "prompt": turn_prompt, "usage_delta": _usage_delta(before_usage, after_usage),
                    "result": turn,
                })
                session["usage"] = after_usage
                history = turn.get("messages") if isinstance(turn, dict) else None
                pending = (run_home / "spacemolt" / "pending-handoff.json").exists()
                decision = _session_decision(
                    private["tool_events"][event_start:], PRODUCTIVE_TOOL[args.workload],
                    pending, followups_used, args.max_followups,
                )
                _atomic_json(private_path, private)
                if decision != "followup":
                    break
                followups_used += 1
            session["followups_used"] = followups_used
            _atomic_json(private_path, private)
            agent.close()
            agents.remove(agent)
            if decision != "handoff":
                break
    except Exception as error:
        private["error"] = f"{type(error).__name__}: {error}"
    finally:
        if module is not None:
            scope = str((output / "hermes-home").resolve())
            for name in ("spacemolt_reconcile", "spacemolt_return", "spacemolt_observe"):
                try:
                    from tools.registry import registry
                    raw = registry.dispatch(name, {}, scope=scope, session_id="eval-cleanup")
                    result = _parse_result(raw)
                    if name == "spacemolt_observe":
                        private["final_observation"] = result
                except Exception as cleanup_error:
                    result = {"error": f"{type(cleanup_error).__name__}: {cleanup_error}"}
                private["cleanup"].append({"tool": name, "result": result})
                private["harness_tool_calls"][name] = private["harness_tool_calls"].get(name, 0) + 1
                _atomic_json(private_path, private)
            with suppress(Exception):
                module.close_services()
        for agent in agents:
            with suppress(Exception):
                agent.close()
        if manager is not None:
            with suppress(Exception):
                manager.unload()
        if alias:
            for name in [key for key in sys.modules if key == alias or key.startswith(alias + ".")]:
                sys.modules.pop(name, None)
        if "secret_token" in locals():
            with suppress(Exception):
                reset_secret_scope(secret_token)
        private["elapsed_seconds"] = round(time.monotonic() - started, 3)
        _atomic_json(private_path, private)
        _atomic_json(summary_path, summarize_run(private))
    print(json.dumps({"summary": str(summary_path), "status": json.loads(summary_path.read_text())["status"]}))
    return 0 if not private.get("error") else 1


def run_arm(args: argparse.Namespace) -> int:
    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    summaries = []
    for workload in WORKLOADS:
        target = output / workload
        command = [
            sys.executable, str(Path(__file__).resolve()), "workload", "--gateway-paused",
            "--label", args.label, "--workload", workload, "--source", args.source,
            "--profile-home", args.profile_home, "--output", str(target),
            "--max-sessions", str(args.max_sessions), "--max-iterations", str(args.max_iterations),
            "--max-followups", str(args.max_followups),
            "--max-tokens", str(args.max_tokens), "--run-budget-seconds", str(args.run_budget_seconds),
        ]
        completed = subprocess.run(command, text=True, capture_output=True)
        (target / "worker.stdout.log").write_text(completed.stdout)
        (target / "worker.stderr.log").write_text(completed.stderr)
        os.chmod(target / "worker.stdout.log", 0o600)
        os.chmod(target / "worker.stderr.log", 0o600)
        summary_path = target / "summary.json"
        if not summary_path.is_file():
            raise RuntimeError(f"{workload} worker exited {completed.returncode} without a summary")
        summary = json.loads(summary_path.read_text())
        summaries.append(summary)
        if completed.returncode:
            break
    arm = {"schema": 1, "label": args.label, "topology": TOPOLOGY, "workloads": summaries}
    _atomic_json(output / "summary.json", arm)
    print(json.dumps({"summary": str(output / "summary.json"), "workloads": [s["workload"] for s in summaries]}))
    return 0 if len(summaries) == len(WORKLOADS) and not any(s.get("error") for s in summaries) else 1


def run_compare(args: argparse.Namespace) -> int:
    before_root, after_root = Path(args.before), Path(args.after)
    comparisons = []
    for workload in WORKLOADS:
        before = json.loads((before_root / workload / "summary.json").read_text())
        after = json.loads((after_root / workload / "summary.json").read_text())
        comparisons.append(compare_summaries(before, after))
    result = {"schema": 1, "comparisons": comparisons}
    if args.output:
        _atomic_json(Path(args.output), result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--gateway-paused", action="store_true", required=True)
    common.add_argument("--label", required=True)
    common.add_argument("--source", required=True)
    common.add_argument("--profile-home", required=True)
    common.add_argument("--output", required=True)
    common.add_argument("--max-sessions", type=int, default=3)
    common.add_argument("--max-followups", type=int, default=2)
    common.add_argument("--max-iterations", type=int, default=12)
    common.add_argument("--max-tokens", type=int, default=4096)
    common.add_argument("--run-budget-seconds", type=float, default=1800)
    sub.add_parser("arm", parents=[common]).set_defaults(func=run_arm)
    work = sub.add_parser("workload", parents=[common])
    work.add_argument("--workload", choices=tuple(WORKLOADS), required=True)
    work.set_defaults(func=run_workload)
    compare = sub.add_parser("compare")
    compare.add_argument("--before", required=True)
    compare.add_argument("--after", required=True)
    compare.add_argument("--output")
    compare.set_defaults(func=run_compare)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
