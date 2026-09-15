"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the shared skill, the stance's skill and the
``spacemolt`` toolset; the agent reads the menu, dispatches, and ends the turn. The chain
then runs on in the bridge, which outlives the conversation (N5). The runner rewrites this
job at rest, when the stance changes (N18).
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from .service import pilot_path

TOOLSET = "spacemolt"
SHARED_SKILL = "spacemolt"
#: Cron's platform name. A juncture is the only session the menu is delivered into; a CLI
#: or chat session is a client of the runner and never opens the game to build a prompt.
JUNCTURE_PLATFORM = "cron"
#: How long the pilot may sit idle before the runner brings a juncture (N4). A chain that
#: ends raises its own juncture; a fire that lands on a running chain is a no-op.
IDLE_SCHEDULE = "30m"

JUNCTURE_PROMPT = (
    "A SpaceMolt juncture: the pilot is between jobs and you choose what it does next.\n"
    "The present, the menu and the last outcome are already in front of you — no tool "
    "fetches them, so do not go looking. If they say a chain is still running, say so in one "
    "line and end the turn.\n"
    "Otherwise weigh the options against the objective they name, call spacemolt_dispatch "
    "once for the one you choose, and end the turn. Prefer an admissible option; if you go "
    "off the menu, say in one line why the refusal no longer applies. The job runs on in the runner after this "
    "conversation ends, so never wait for it, never poll spacemolt_status, and never dispatch "
    "twice. If no such juncture context is there at all, the runner did not answer: say that "
    "and end the turn. Report only what it and the tool results say."
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
    body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    if len(body) > _CONTEXT_BUDGET:
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    return ("SpaceMolt juncture — the present, what this stance and mood admit now with the "
            "reason and bounds for each, what is unavailable and why, and how the last chain "
            "ended:\n" + body)


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
        "enabled_toolsets": [TOOLSET],
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
