"""Reports from script receipts; model prose and planning estimates are not evidence."""
from copy import deepcopy
import math


def capture_receipt(receipts, response):
    job = response.get("result")
    if response.get("ok") and isinstance(job, dict) and isinstance(job.get("id"), str) and "action" in job:
        receipts.append(deepcopy(job))


def work_result(result, name):
    # Cleanup may fail after a work phase has already checkpointed useful output.
    while isinstance(result, dict):
        if isinstance(result.get(name), dict):
            return result[name]
        result = result.get("partial")
    return {}


def receipt_report(receipts, cleanup_response=None):
    # Recovery updates the original job ID. Its complete delta replaces the older
    # partial delta; summing both would count the same purchases twice.
    unique = {job["id"]: job for job in receipts}
    jobs = []
    for job in unique.values():
        row = {key: deepcopy(job.get(key)) for key in ("id", "action", "status", "cash_delta")}
        context = job.get("context") or {}
        row.update({key: deepcopy(context[key]) for key in
                    ("objective", "stance", "mood", "policy_version", "home") if key in context})
        if job.get("error"):
            row["error"] = job["error"]
        if job.get("stopping_reason"):
            row["stopping_reason"] = job["stopping_reason"]
        if isinstance(job.get("spending"), dict):
            row["spending"] = deepcopy(job["spending"])
        for key in ("budget_owner_id", "budget_spending", "return_plan"):
            if key in job:
                row[key] = deepcopy(job[key])
        result = job.get("result")
        if job.get("action") == "prepare" and isinstance(result, dict) and "berths" in result:
            row["passenger_preparation"] = {key: deepcopy(result[key]) for key in
                                            ("status", "module_id", "berths", "actual_spend", "blockers")
                                            if key in result}
        sortie = work_result(result, "sortie")
        if "skill_progress" in sortie:
            row["observed_skill_progress"] = deepcopy(sortie["skill_progress"])
        if isinstance(sortie.get("fight"), dict):
            fight = sortie["fight"]
            row["combat_outcome"] = {key: deepcopy(fight[key]) for key in
                                     ("battle_id", "retreated", "verified_victory") if key in fight}
            summary = fight.get("summary")
            if isinstance(summary, dict):
                row["combat_outcome"]["summary"] = {key: deepcopy(summary[key]) for key in
                                                   ("status", "outcome", "winning_side") if key in summary}
        gather = work_result(result, "gather")
        if gather:
            row["gather_work"] = {key: deepcopy(gather[key]) for key in
                                  ("status", "poi_id", "cycles_requested", "cycles_completed",
                                   "stop_reason", "yields", "yield_measurements", "retained_cargo",
                                   "unattributed_cargo_gains", "inventory_verification") if key in gather}
            if "skill_progress" in gather:
                row["observed_skill_progress"] = deepcopy(gather["skill_progress"])
        production = work_result(result, "production")
        if production:
            row["production_work"] = {key: deepcopy(production[key]) for key in
                                      ("experiment_id", "job_id", "station", "status", "reason",
                                       "spent", "earned", "accounting_unverified", "pending_action",
                                       "disposition", "retained", "retained_location", "retention_verification",
                                       "sold", "withdrawn", "deposited", "sales", "after",
                                       "retained_assets_note", "realized_credit_delta",
                                       "incremental_profit_after_input_opportunity") if key in production}
            row["production_work"]["accounting_scope"] = "Cumulative experiment amounts at this receipt; do not sum repeated experiment_id snapshots"
            if "skill_progress" in production:
                row["observed_skill_progress"] = deepcopy(production["skill_progress"])
        transport = work_result(result, "transport")
        if transport:
            row["transport_work"] = {key: deepcopy(transport[key]) for key in
                                     ("kind", "status", "reason", "shipment_id", "package_id", "origin",
                                      "destination", "destination_base_id", "ship_id", "acceptance", "custody", "delivery",
                                      "payout", "accounting_unverified", "pending_action", "loaded",
                                      "delivered", "onboard", "fare_collected", "obligations_after", "profile_after")
                                     if key in transport}
            policy = work_result(result, "transport_policy")
            if policy:
                row["transport_policy"] = deepcopy(policy)
            if "skill_progress" in transport:
                row["observed_skill_progress"] = deepcopy(transport["skill_progress"])
        jobs.append(row)
    deltas = [job["cash_delta"] for job in jobs]
    known_cash = (all(job["status"] not in {"running", "needs_reconciliation"} for job in jobs)
                  and all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                          for value in deltas))
    report = {"source": "Script job receipts; assessment estimates and model narrative excluded",
              "jobs": jobs, "recorded_jobs_cash_delta": sum(deltas) if known_cash else None,
              "final": None}
    for field, output in (("gross_spend", "recorded_jobs_gross_spend"),
                          ("known_gross_spend", "recorded_jobs_known_gross_spend")):
        amounts = [job.get("spending", {}).get(field) for job in jobs]
        known = all(isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) and value >= 0 for value in amounts)
        report[output] = sum(amounts) if known else None
    if cleanup_response is not None:
        cleanup = cleanup_response.get("result")
        report["cleanup_outcome"] = cleanup.get("status") if isinstance(cleanup, dict) else None
        if cleanup_response.get("error"):
            report["cleanup_error"] = cleanup_response["error"]
        if cleanup_response.get("ok") and isinstance(cleanup, dict) and "id" in cleanup:
            after = cleanup.get("after") or {}
            ship = after.get("ship") or {}
            report["final"] = {
                "receipt_id": cleanup["id"], "status": cleanup.get("status"),
                "location": deepcopy(after.get("location")), "credits": after.get("credits"),
                "ship_condition": {key: ship[key] for key in
                                   ("id", "hull", "max_hull", "shield", "max_shield", "fuel", "max_fuel") if key in ship},
                "retained_cargo": deepcopy(after.get("cargo")), "observed_skills": deepcopy(after.get("skills")),
                "obligations": deepcopy(cleanup.get("obligations_after")),
                "obligation_verification": deepcopy(cleanup.get("obligation_verification")),
                "condition_note": "Observed endpoint condition; not a measurement of damage taken or resources consumed during the job",
            }
            if cleanup.get("status") in {"running", "needs_reconciliation"}:
                report["final"]["condition_note"] = "Last recorded snapshot only; reconciliation remains outstanding, so final condition is not verified"
    return report
