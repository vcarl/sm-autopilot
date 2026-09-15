"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the shared skill, the stance's skill and the
``spacemolt`` toolset; the agent reads the menu, dispatches, and ends the turn. The chain
then runs on in the bridge, which outlives the conversation (N5). The runner rewrites this
job at rest, when the stance changes (N18).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Mapping

from .service import pilot_path, runtime_dir

#: What a fire carries: the job tools plus the reads every client of the runner may make.
#: ``spacemolt_operator`` is deliberately absent — the pilot does not set its own objective.
TOOLSETS = ("spacemolt", "spacemolt_observe")
SHARED_SKILL = "spacemolt"
#: Cron's platform name. A juncture is the only session the menu is delivered into; a CLI
#: or chat session is a client of the runner and never opens the game to build a prompt.
JUNCTURE_PLATFORM = "cron"
#: How long the pilot may sit idle before the runner brings a juncture (N4). A chain that
#: ends raises its own juncture; a fire that lands on a running chain is a no-op.
IDLE_SCHEDULE = "30m"
#: The six stances (D7), mirrored from ``src/rules-table.ts``: a tool schema cannot read
#: TypeScript, and the reflection report carries the same list for the agent to choose from.
STANCES = ("Prospector", "Industrialist", "Trader", "Carrier", "Hunter", "Scout")
#: D2: Relaxed never opens a shift and Tired is imposed, so neither is an initial mood.
JOB_MOODS = ("Cautious", "Focused", "Opportunistic", "Aggressive")
#: Where the runner's own journal lives. The bridge writes most of it; the lines the runner
#: makes outside the bridge (reflection) take the same shape under their own event name.
JOURNAL_FILE = "gameplay.jsonl"

JUNCTURE_PROMPT = (
    "A SpaceMolt juncture: the pilot is between jobs and you choose what it does next.\n"
    "Read the context in front of you — the present, the options and how the last chain "
    "ended. If it says a chain is still running, say so in one line and end the turn.\n"
    "Otherwise end the juncture one of four ways: act on an option yourself, taking as many "
    "calls as the move needs; dispatch one long step and end the turn; hold, starting "
    "nothing; or rest at home when the objective is done.\n"
    "Say in one line which of the four you took and why.\n"
    "Prefer an admissible option. If you go off the menu, quote the refusal you are "
    "overriding and say what has changed since it was written.\n"
    "At rest there is no menu: read the report you were given, reflect once, and end the "
    "turn.\n"
    "If the report says the operator's objective is done, say so and stop.\n"
    "If no context reached you at all, the runner did not answer: say that and end the turn."
)

#: The refusals go first when a menu will not fit; the options are the point of it.
_CONTEXT_BUDGET = 3_500


def juncture_context(session_info: Mapping[str, Any] | None = None) -> str:
    """The present, the menu, and what just happened — delivered, never fetched (N15).

    Core renders this once per new session and freezes the bytes into that conversation's
    system prompt, so the agent reads it before its first move, spends no turn fetching it,
    and nothing mutates mid-conversation to invalidate the cached prefix.
    """
    if (session_info or {}).get("platform") != JUNCTURE_PLATFORM:
        return ""
    from .service import call

    menu = call("menu")
    if menu.get("busy"):
        record = menu.get("record") or {}
        return (f"SpaceMolt juncture: the runner is still working on {menu.get('chain_id')} "
                f"(job {int(record.get('position') or 0) + 1} of {record.get('length')}). "
                "There is nothing to choose: say so in one line and end the turn without "
                "calling a tool.")
    if menu.get("at_rest"):
        return _rest_context(menu)
    _hold_full(menu)
    body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    if len(body) > _CONTEXT_BUDGET:
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    return ("SpaceMolt juncture — the present, each option with the call it would be taken "
            "with, its reason and bounds, what is unavailable and why, and how the last chain "
            "ended:\n" + body)


#: The rest of the story a `cargo_free` of 0 leaves untold. A full hold is not a dead end and
#: it is not a mystery either: it is ore with two places to go and a gather that will return
#: nothing until it does (playtest 2026-09-15: three gathers dispatched on a full hold).
_HOLD_FULL = ("hold full: stow it here if this base has storage, or craft with it at a "
              "workshop; a gather with a full hold returns nothing")


def _hold_full(menu: dict[str, Any]) -> None:
    """Say why the hold being full matters, and name it as the cause of an empty yield.

    Timely surfacing beats making the model remember: the fact sits beside the count it
    explains, and the last outcome carries the cause rather than leaving one to be invented.
    """
    present = menu.get("present")
    if not isinstance(present, dict) or present.get("cargo_free") != 0:
        return
    present["hold_full"] = _HOLD_FULL
    last = menu.get("last")
    jobs = (last or {}).get("jobs") if isinstance(last, dict) else None
    if jobs and not any(job.get("yield") for job in jobs):
        last["cause"] = "the hold was full at departure (cargo_free 0), so the gather mined nothing"


def _rest_context(report: dict[str, Any]) -> str:
    """A fire that lands on a pilot at rest: reflection, not a menu (N7).

    There is no stance, so there is no stance work to offer and nothing to choose between.
    What the agent gets instead is the report rest exists for — needs, holdings, debts, what
    has been seen, what has been done, and where it has been standing still.
    """
    if report.get("objective_done"):
        return ("SpaceMolt wakeup: the pilot is at rest and the operator's bounded objective "
                f"({report.get('objective') or 'unnamed'}) is already done. There is nothing to "
                "choose and no shift to open — say the objective is complete and end the turn "
                "without calling a tool. Only the operator can give the pilot something new.")
    # The choosing is the point: the needs and the stagnation signals outlast the travelogue.
    for drop in (None, "seen", "recent"):
        if drop:
            report.pop(drop, None)
        if len(json.dumps(report, separators=(",", ":"), sort_keys=True)) <= _CONTEXT_BUDGET:
            break
    return ("SpaceMolt rest — the shift is over, the stance and mood are cleared and nothing is "
            "imposed on the pilot. This is what it has, what it owes, what it has seen, what it "
            "has been doing lately and where it has been standing still. Choose one goal that "
            "serves the objective, then the stance and mood that fit it:\n"
            + json.dumps(report, separators=(",", ":"), sort_keys=True))


def read_pilot() -> dict[str, Any]:
    """The runner's pilot record, or an empty one when no shift has been opened."""
    path = pilot_path()
    return json.loads(path.read_text()) if path.is_file() else {}


def write_pilot(record: dict[str, Any]) -> dict[str, Any]:
    """Set objective, stance, mood and home.

    ponytail: a plain file, written by whoever owns rest — for now the operator or a test.
    The runner's own rest path takes it over when there is one; no CLI command until then.
    """
    path = pilot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)
    return record


def journal_event(event: str, **fields: Any) -> None:
    """One line in the pilot's journal for a change the runner made outside the bridge.

    Reflection is the runner's own act and it changes the shift, so it is written down the
    way the bridge writes its own: a setting changed with no record is a mystery to whoever
    reads the journal later (S45).
    """
    path = runtime_dir() / JOURNAL_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {"at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
             "event": event, **fields}
    with path.open("a", encoding="utf-8") as journal:
        journal.write(json.dumps(entry, separators=(",", ":")) + "\n")


def job_name(pilot: dict[str, Any]) -> str:
    """One job per pilot, found again by this name so rest rewrites rather than adds."""
    return f"spacemolt juncture: {pilot.get('name') or 'pilot'}"


def job_fields(pilot: dict[str, Any]) -> dict[str, Any]:
    """What a fire carries: the juncture prompt, the stance's skills, the stance's tools.

    No ``workdir``, which is what makes cron open the conversation with
    ``skip_context_files=True`` — a juncture is the pilot's world, not a project's.
    """
    stance = str(pilot.get("stance") or "").strip().lower()
    return {
        "prompt": JUNCTURE_PROMPT,
        "skills": [SHARED_SKILL] + ([f"{SHARED_SKILL}-{stance}"] if stance else []),
        "enabled_toolsets": list(TOOLSETS),
    }


def ensure_juncture_job(schedule: str = IDLE_SCHEDULE) -> dict[str, Any]:
    """Write or rewrite this pilot's one juncture job from the current pilot record."""
    from cron.jobs import create_job, load_jobs, update_job

    pilot = read_pilot()
    name = job_name(pilot)
    fields = job_fields(pilot)
    existing = next((job for job in load_jobs() if job.get("name") == name), None)
    if existing is not None:
        return update_job(existing["id"], fields)
    return create_job(schedule=schedule, name=name, **fields)
