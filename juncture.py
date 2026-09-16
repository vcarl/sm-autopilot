"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the shared skill, the stance's skill and the
``spacemolt`` toolset; the agent reads the menu, dispatches, and ends the turn. The script
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
#: How long the pilot may sit idle before the runner brings a juncture (N4). A script that
#: ends raises its own juncture; a fire that lands on a running script is a no-op.
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
    "A SpaceMolt juncture: the pilot is between runs and you choose what it does next.\n"
    "Read the context in front of you — the present and how the last run ended. If it says "
    "a run is still in flight, say so in one line and end the turn.\n"
    "Otherwise end the juncture one of three ways: play, by writing pilot/index.ts with "
    "spacemolt_run (pass `source`; spacemolt_check first when unsure) and reading the report "
    "it returns; hold, starting nothing; or rest at home when the objective is done.\n"
    "Your skill is the play library's README: every function it lists, with literal arguments "
    "from the present; `account()` is the whole game when nothing there fits. Keep helpers "
    "you want again in pilot/<name>.ts and import them from './<name>.ts'.\n"
    "Say in one line which of the three you took and why.\n"
    "An instruction from the operator is outside direction: it outranks the objective for "
    "this juncture.\n"
    "At rest you are given a report instead of the present. Read it; review pilot/index.ts "
    "against how its runs ended and rewrite it if it would have served better; then pick the "
    "goal, the stance and the mood, reflect once, and end the turn.\n"
    "If the report says the operator's objective is done, say so and stop.\n"
    "If no context reached you at all, the runner did not answer: say that and end the turn."
)

#: Which career folder's README is the stance's skill (``play/<folder>/README.md``).
STANCE_FOLDER = {"Prospector": "mining", "Industrialist": "industry", "Trader": "trading",
                 "Carrier": "hauling", "Hunter": "combat", "Scout": "exploration"}

#: The refusals go first when a menu will not fit; the options are the point of it.
_CONTEXT_BUDGET = 3_500
#: Carl, 2026-09-16: the menu is off for a while to see how the pilot chooses without one. Off,
#: the juncture still carries the present, the instruction, the objective and the last run;
#: the options and refusals the rules computed are dropped before delivery. Flip to True to
#: restore; nothing else changes.
MENU_ENABLED = False


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
        step = menu.get("fn") or "its first move"
        return (f"SpaceMolt juncture: a run is still in flight (on {step}, "
                f"{menu.get('elapsed_s', '?')} s, {menu.get('commands', '?')} commands). "
                "Say in one line that the run is in flight and end the turn.")
    _instruction(menu)
    if menu.get("at_rest"):
        return _rest_context(menu)
    _hold_full(menu)
    if not MENU_ENABLED:
        menu.pop("options", None)
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
        return "SpaceMolt juncture — the present and how the last script ended:\n" + body
    body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    if len(body) > _CONTEXT_BUDGET:
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    return ("SpaceMolt juncture — the present, each option with the call it would be taken "
            "with, its reason and bounds, what is unavailable and why, and how the last script "
            "ended:\n" + body)


def _instruction(menu: dict[str, Any]) -> None:
    """What the operator said, with when they said it, beside the present it applies to.

    The runner builds the menu from the pilot's stance and place; the instruction is the
    operator's own field of the same record, so it travels with the consultation rather than
    waiting for a tool call the juncture would have to think to make.
    """
    said = read_pilot().get("instruction")
    if said:
        menu["instruction"] = said


#: The rest of the story a `cargo_free` of 0 leaves untold. A full hold is not a dead end and
#: it is not a mystery either: it is ore with two places to go and a gather that will return
#: nothing until it does (playtest 2026-09-15: three gathers dispatched on a full hold).
_HOLD_FULL = ("hold full: a gather needs free hold. sell(rows) or stow(rows) here first "
              "(name the rows from present.hold), then gatherUntil")


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
    if isinstance(last, dict) and not (last.get("gained") or {}).get("items"):
        last["cause"] = "the hold was full (cargo_free 0), so a gather would have mined nothing"


def _rest_context(report: dict[str, Any]) -> str:
    """A fire that lands on a pilot at rest: reflection, not a menu (N7).

    There is no stance, so there is no stance work to offer and nothing to choose between.
    What the agent gets instead is the report rest exists for — needs, holdings, debts, what
    has been seen, what has been done, and where it has been standing still.
    """
    if report.get("objective_done"):
        return ("SpaceMolt wakeup: the pilot is at rest and the operator's bounded objective "
                f"({report.get('objective') or 'unnamed'}) is already done. Say the objective is "
                "complete and end the turn. The operator sets the next one.")
    # The choosing is the point: the needs and the stagnation signals outlast the travelogue.
    for drop in (None, "seen", "recent"):
        if drop:
            report.pop(drop, None)
        if len(json.dumps(report, separators=(",", ":"), sort_keys=True)) <= _CONTEXT_BUDGET:
            break
    return ("SpaceMolt rest — the shift is over, the stance and mood are cleared and nothing is "
            "imposed on the pilot. This is what it has, what it owes, what it has seen, what it "
            "has been doing lately and where it has been standing still.\n"
            "`scripts` is the pilot's own code beside how it ran: each pilot/*.ts with its size "
            "and how the last runs ended. Read the ones whose runs ended refused or failed, and "
            "write a better version (spacemolt_check with `source`) — the next shift is flown "
            "with the file this review leaves behind.\n"
            "Choose one goal that serves the objective, then the stance and mood that fit it:\n"
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
    folder = STANCE_FOLDER.get(str(pilot.get("stance") or "").strip())
    return {
        "prompt": JUNCTURE_PROMPT,
        "skills": [SHARED_SKILL] + ([f"{SHARED_SKILL}-{folder}"] if folder else []),
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
