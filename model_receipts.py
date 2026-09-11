"""Inline planning evidence for sessions without a general file-reading tool."""
from collections import Counter
from copy import deepcopy
import json


def _journal_projection(value):
    if isinstance(value, list):
        return [_journal_projection(item) for item in value]
    if not isinstance(value, dict):
        return value
    is_job = all(key in value for key in ("id", "action", "status", "actions"))
    result = {key: _journal_projection(item) for key, item in value.items()
              if not (is_job and key == "actions")}
    if is_job:
        result["unresolved_commands"] = [
            {key: deepcopy(entry[key]) for key in ("action", "params", "status", "result", "accepted_result") if key in entry}
            for entry in value["actions"] if entry.get("status") in {"pending", "uncertain"}
        ]
        result["journal_note"] = "Full mechanical command journal retained by the executor; outcomes and unfinished commands are included here."
    assessments = value.get("assessments")
    if (isinstance(assessments, list) and assessments
            and all(isinstance(row, dict) and isinstance(row.get("id"), str)
                    and isinstance(row.get("decision"), str) for row in assessments)):
        result["assessment_summary"] = {
            "recorded_decisions": dict(Counter(row["decision"] for row in assessments)),
            "recorded_engage_candidate_ids": [row["id"] for row in assessments if row["decision"] == "engage"],
            "note": "Scan success does not override these recorded decisions. Missing intelligence requires a new evidenced assessment before engagement.",
        }
    return result


def _historical_endpoint(snapshot):
    result = {key: deepcopy(value) for key, value in snapshot.items()
              if key not in {"skills", "modules", "missions"}}
    if isinstance(result.get("location"), dict):
        result["location"] = {key: value for key, value in result["location"].items()
                              if not key.startswith("nearby_")}
    return result


def _historical_projection(value):
    if isinstance(value, list):
        return [_historical_projection(item) for item in value]
    if not isinstance(value, dict):
        return value
    historical = (isinstance(value.get("before"), dict)
                  and isinstance(value.get("after"), dict) and "ship" in value["after"])
    result = {key: (_historical_endpoint(item) if historical and key == "after"
                    else _historical_projection(item))
              for key, item in value.items() if not (historical and key == "before")}
    # Fitting and progression changes remain evidence even when a workflow has
    # not provided its own explicit outcome fields. Unchanged snapshots add none.
    if historical:
        changes = {key: {"before": deepcopy(value["before"].get(key)),
                         "after": deepcopy(value["after"].get(key))}
                   for key in ("modules",)
                   if value["before"].get(key) != value["after"].get(key)}
        for section in ("skills", "ship"):
            before, after = value["before"].get(section), value["after"].get(section)
            if isinstance(before, dict) and isinstance(after, dict):
                changed = {key: {"before": deepcopy(before.get(key)), "after": deepcopy(after.get(key))}
                           for key in before.keys() | after.keys() if before.get(key) != after.get(key)}
                if changed:
                    changes[section] = changed
        if changes:
            result["observed_state_changes"] = changes
    return result


def _tables(value, field=None):
    if isinstance(value, dict):
        return {key: _tables(item, key) for key, item in value.items()}
    if not isinstance(value, list):
        return value
    # Candidate decisions stay directly readable. Repeated contact/creature
    # records use ordinary named columns rather than repeating every field name.
    if (field not in {"assessments", "candidates", "receipts", "unresolved_commands"}
            and len(value) >= 3 and all(isinstance(item, dict) for item in value)
            and value[0] and all(item.keys() == value[0].keys() for item in value)):
        columns = list(value[0])
        return {"columns": columns, "rows": [[_tables(item[key], key) for key in columns] for item in value]}
    return [_tables(item) for item in value]


def _mission_versions(value):
    """Repeated mission snapshots mostly differ only in their countdown."""
    missions = {}

    def visit(item):
        if isinstance(item, list):
            return [visit(child) for child in item]
        if not isinstance(item, dict):
            return item
        identifier = item.get("mission_id")
        if isinstance(identifier, str) and "objectives" in item:
            baseline = missions.setdefault(identifier, deepcopy(item))
            if baseline.keys() == item.keys():
                return {"mission_ref": identifier,
                        "overrides": {key: deepcopy(child) for key, child in item.items() if child != baseline[key]}}
        return {key: visit(child) for key, child in item.items()}

    result = visit(value)
    if missions:
        result["mission_evidence"] = missions
    return result


def _shared_evidence(value):
    counts = Counter()

    def signature(item):
        return json.dumps(item, sort_keys=True, separators=(",", ":"))

    def count(item):
        if not isinstance(item, (dict, list)):
            return
        key = signature(item)
        if len(key) >= 40:
            counts[key] += 1
        for child in (item.values() if isinstance(item, dict) else item):
            count(child)

    count(value)
    references, evidence = {}, {}

    def encode(item, share=True):
        if not isinstance(item, (dict, list)):
            return item
        key = signature(item)
        if share and counts[key] > 1:
            if key not in references:
                name = str(len(references) + 1)
                references[key] = name
                evidence[name] = encode(item, False)
            return {"ref": int(references[key])}
        if isinstance(item, dict):
            return {name: encode(child) for name, child in item.items()}
        return [encode(child) for child in item]

    result = encode(value)
    result["shared_evidence"] = evidence
    result["reading_note"] = (
        "An object containing only ref uses that numbered entry in shared_evidence, included here. "
        "mission_ref uses mission_evidence at that mission ID, with overrides replacing the listed fields. "
        "Tables pair each row with its named columns; no rows or candidates are omitted. "
        "Historical before snapshots and unchanged loadout/skill snapshots are omitted; historical after retains "
        "ship condition, location and cargo. Explicit outcomes, changed loadout/skills, obligations, scans, "
        "assessment uncertainty and unresolved commands remain. Current state is unchanged."
    )
    return result


def compact_response(response):
    projected = _journal_projection(response)
    def subsumes(richer, smaller):
        if isinstance(smaller, dict) and isinstance(richer, dict):
            return all(key in richer and subsumes(richer[key], item) for key, item in smaller.items())
        return richer == smaller

    result = projected.get("result")
    if (isinstance(result, dict) and isinstance(result.get("state"), dict)
            and isinstance(projected.get("state"), dict)
            and subsumes(result["state"], projected["state"])):
        del projected["state"]
    if len(json.dumps(projected)) <= 16000:
        return projected
    compact = _shared_evidence(_tables(_mission_versions(_historical_projection(projected))))
    return compact if len(json.dumps(compact)) < len(json.dumps(projected)) else projected
