"""Decision evidence for native tools; complete bridge replies stay on disk."""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

from .model_receipts import _historical_projection, compact_response


def _job(value):
    return isinstance(value, dict) and all(key in value for key in ("id", "action", "status", "actions"))


def _history(value):
    if isinstance(value, list):
        return [_history(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key == "receipts" and isinstance(item, list) and item and all(_job(row) for row in item):
            # Keep actionable uncertainty regardless of age. Closed history cannot
            # grow the conversation indefinitely, but the latest blocker explains
            # why a later successful cleanup did not complete the objective.
            keep = {len(item) - 1}
            blockers = [i for i, row in enumerate(item) if row["status"] in {"blocked", "interrupted"}]
            if blockers:
                keep.add(blockers[-1])
            for i, row in enumerate(item):
                if (row["status"] not in {"completed", "blocked", "interrupted", "returned_to_base"}
                        or any(action.get("status") in {"pending", "uncertain"} for action in row["actions"])):
                    keep.add(i)
            result[key] = [_history(row) for i, row in enumerate(item) if i in keep]
            result["receipt_history"] = {
                "total": len(item), "included": len(keep),
                "statuses": dict(Counter(row["status"] for row in item)),
                "note": "Latest receipt, latest blocker, and every unresolved command/job are inline. Other closed receipts are in full_receipt; historical outcomes are not current state.",
            }
        else:
            result[key] = _history(item)
    return result


def _quantities(rows):
    if not isinstance(rows, list):
        return None
    totals = {}
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("item_id"), str)
                or type(row.get("quantity")) not in (int, float)
                or not math.isfinite(row["quantity"]) or row["quantity"] < 0):
            return None
        totals[row["item_id"]] = totals.get(row["item_id"], 0) + row["quantity"]
    return totals


def _cargo_summary(state):
    quantities = _quantities(state.get("cargo"))
    return {"status": "observed" if quantities is not None else "unverified",
            "item_quantities": quantities,
            "note": "Remaining carried inventory summed across canonical rows; these quantities are not consumed inputs or newly produced output."}


def _production_outcome(production):
    quote = production.get("quote") or {}
    uncertain = bool(production.get("pending_action") or production.get("accounting_unverified"))
    verified_retention = (not uncertain and production.get("status") in {"complete", "blocked"}
                          and production.get("retention_verification", {}).get("status") == "observed"
                          and isinstance(production.get("retained"), dict))
    result = {key: deepcopy(production[key]) for key in (
        "experiment_id", "job_id", "status", "reason", "disposition", "pending_action", "accounting_unverified",
    ) if key in production}
    result.update({
        "requested_quantity": quote.get("quantity"),
        "quantity_note": "Requested quantity is an instruction, never proof of executed output. Report verified retained output and consumed inputs below; null means unknown.",
        "retained_output": deepcopy(production["retained"]) if verified_retention else None,
        "retained_location": deepcopy(production.get("retained_location")) if verified_retention else None,
        "retention_verification": deepcopy(production.get("retention_verification", {"status": "unverified"})),
        "sold_output": deepcopy(production.get("sold")),
        "consumed_inputs": None,
        "consumption_verification": "Unknown: input requests, storage deposits and remaining cargo alone do not prove consumption.",
    })
    for field in ("spent", "earned"):
        amount = production.get(field)
        valid = type(amount) in (int, float) and math.isfinite(amount) and amount >= 0
        result[f"actual_{field}"] = amount if valid and not uncertain else None
        if uncertain and valid:
            result[f"known_recorded_{field}"] = amount
    result["accounting_note"] = "Actual spent/earned are production receipt totals to date, not wallet changes. Pending/partial work is unfinished. Retained inventory is not sale revenue; shared job servicing costs are reported separately."
    result["skill_progress"] = deepcopy(production.get("skill_progress", []))
    # This is deliberately narrower than 'complete': purchases, overlapping
    # recipes and missing custody snapshots need explicit consumption evidence.
    before, after = production.get("before", {}), production.get("after", {})
    inputs = _quantities(quote.get("evaluation", {}).get("inputs"))
    outputs = _quantities(quote.get("evaluation", {}).get("outputs"))
    before_cargo, before_storage = _quantities(before.get("cargo")), _quantities(before.get("storage"))
    after_cargo, after_storage = _quantities(after.get("cargo")), _quantities(after.get("storage"))
    if (production.get("status") == "complete" and not uncertain and verified_retention
            and production.get("job_id") and quote.get("source") == "inventory"
            and inputs is not None and outputs is not None and not (inputs.keys() & outputs.keys())
            and all(value is not None for value in (before_cargo, before_storage, after_cargo, after_storage))
            and all(before_cargo.get(item, 0) + before_storage.get(item, 0)
                    - after_cargo.get(item, 0) - after_storage.get(item, 0) == quantity
                    for item, quantity in inputs.items())):
        result["consumed_inputs"] = inputs
        result["consumption_verification"] = "Completed retained-output verification and combined cargo/storage depletion agree with the recorded recipe inputs; storage transfers are not counted as consumption."
    return result


def _outcome(job):
    result = {key: deepcopy(job[key]) for key in (
        "id", "action", "status", "error", "stopping_reason", "cash_delta",
        "spending", "budget_spending", "obligation_verification",
    ) if key in job}
    if isinstance(result.get("budget_spending"), dict):
        result["budget_spending"].pop("policy_decision", None)
    production = job.get("result")
    while isinstance(production, dict) and "partial" in production:
        production = production["partial"]
    if isinstance(production, dict) and isinstance(production.get("production"), dict):
        result["production"] = _production_outcome(production["production"])
    after = job.get("after")
    result["terminal_state"] = (
        {key: deepcopy(after[key]) for key in ("credits", "ship", "cargo") if key in after}
        if isinstance(after, dict) else {"status": "not_verified"}
    )
    if isinstance(after, dict):
        result["terminal_state"]["cargo_summary"] = _cargo_summary(after)
    if isinstance(after, dict) and isinstance(after.get("location"), dict):
        result["terminal_state"]["location"] = {
            key: deepcopy(value) for key, value in after["location"].items()
            if not key.startswith("nearby_")
        }
    result["custody"] = deepcopy(job.get("obligations_after", {"status": "not_verified"}))
    result["activity"] = []
    fields = {
        "cycles_requested", "cycles_completed", "yields", "retained_cargo", "unattributed_cargo_gains",
        "skill_progress", "inventory_verification", "stop_reason", "settlement", "realized_profit",
        "realized_revenue", "consumed_inputs", "delivered", "payment_verification",
    }

    def activity(value, path):
        if isinstance(value, dict):
            metrics = {key: deepcopy(item) for key, item in value.items() if key in fields}
            if metrics:
                result["activity"].append({"path": path, **metrics})
            for key, item in value.items():
                if key not in fields:
                    activity(item, f"{path}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                activity(item, f"{path}[{index}]")

    activity(job.get("result"), "result")
    if not result["activity"]:
        result["activity_evidence"] = "No explicit yield or settlement metrics recorded; do not infer success or zero yield from status alone."
    job_result = job.get("result")
    cleanup = job_result.get("cleanup") if isinstance(job_result, dict) else None
    if job.get("action") == "return_to_base" and isinstance(job_result, dict) and "service" in job_result:
        cleanup = job_result
    if isinstance(cleanup, dict):
        result["cleanup"] = deepcopy(cleanup)
    first = ("id", "action", "status", "error", "stopping_reason", "production", "activity")
    return {**{key: result[key] for key in first if key in result},
            **{key: value for key, value in result.items() if key not in first}}


def _store(runtime: Path, raw: bytes):
    digest = hashlib.sha256(raw).hexdigest()
    directory = runtime / "tool-receipts"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{digest}.json"
    if not path.exists():
        # Publish only complete private files; identical repeat observations share
        # one forensic receipt without mutating the execution host's journal.
        fd, temporary = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return {"path": str(path), "sha256": digest, "bytes": len(raw),
            "note": "Complete original reply, including mechanical journals and historical receipts. Inline evidence is sufficient for the reported outcome; this file is for forensic inspection."}


def native_response(response, runtime: Path):
    """Do not modify raw service results, durable jobs, or the standalone protocol."""
    raw = json.dumps(response, separators=(",", ":")).encode()
    reference = _store(runtime, raw)
    selected = _history(response)
    projected = compact_response(_historical_projection(selected))
    lead = {key: deepcopy(response[key]) for key in ("status", "error", "stopping_reason") if key in response}
    if _job(response):
        lead["outcome"] = _outcome(response)
    else:
        receipts = selected.get("receipts", selected.get("observed", {}).get("receipts", []))
        if receipts:
            lead["historical_outcomes"] = [_outcome(job) for job in receipts]
        current = selected.get("state", selected.get("observed", {}).get("state"))
        if isinstance(current, dict):
            lead["current_cargo_summary"] = _cargo_summary(current)
    return {**lead, "full_receipt": reference, **{key: value for key, value in projected.items() if key not in lead}}
