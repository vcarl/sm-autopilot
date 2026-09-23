"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the shared skill, the stance's skill and the
``spacemolt`` toolset; the agent reads the menu, dispatches, and ends the turn. The script
then runs on in the bridge, which outlives the conversation (N5). The runner rewrites this
job at rest, when the stance changes (N18).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Mapping

from hermes_constants import get_hermes_home

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
    "A SpaceMolt juncture. You choose the pilot's next run, start it, and end the turn.\n"
    "What to expect:\n"
    "- The context above is current and is everything you need to choose.\n"
    "- A run takes minutes of real time; when it ends, the next juncture comes on its own "
    "with its report as the last run. One run per juncture is the whole job.\n"
    "- A wrong field costs a spacemolt_check, a wrong move costs a run, and looking costs "
    "almost nothing: when a fact you need is missing, a run that only looks (orient(), "
    "scout(), note() the numbers) is a good turn.\n"
    "- Spending, selling and fighting are the moves that stay done; the permissions bound "
    "them.\n"
    "Whose word wins: the operator's instruction for this juncture, then the objective, then "
    "your goal, then the suggested moves. When the instruction asks for something the library"
    " can't do, do the nearest thing it can and say so.\n"
    "Your turn:\n"
    "1. Pick the move that best serves the instruction or objective, using what the present "
    "shows.\n"
    "2. Write the whole of pilot/index.ts and pass it as `source` to spacemolt_run.\n"
    "3. When the run returns, answer in one or two lines — what ran, how it ended, what it "
    "measured — and end the turn.\n"
    "Hold instead when every suggested move is refused, and name the refusal in one line.\n"
    "At rest the context says what to do instead.\n"
    'When there is no SpaceMolt context above, say "no context from the runner" and end the '
    "turn."
)

#: Which career folder's README is the stance's skill (``play/<folder>/README.md``).
STANCE_FOLDER = {"Prospector": "mining", "Industrialist": "industry", "Trader": "trading",
                 "Carrier": "hauling", "Hunter": "combat", "Scout": "exploration"}

#: The refusals go first when a menu will not fit; the options are the point of it.
_CONTEXT_BUDGET = 3_500
#: The juncture section's ``max_chars``: core skips a section over it whole, not truncated.
SECTION_LIMIT = 4_000
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
    _instruction(menu)
    # At rest the menu still carries moves (VISION: the menu is never empty); the choosing
    # material a rest needs is the reflection, so the fire gets both.
    if menu.get("rest") or menu.get("at_rest"):
        return _rest_context(call("reflect"), menu.get("text"))
    _hold_full(menu)
    # The menu v2: the rendered moves travel as text under the JSON, so a fire reads calls it
    # can paste, not a structure it has to decode.
    text = menu.pop("text", None)
    tail = ("\n" + text) if text else ""
    if not MENU_ENABLED:
        menu.pop("options", None)
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
        return "SpaceMolt juncture — the present and how the last script ended:\n" + body + tail
    body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    if len(body) > _CONTEXT_BUDGET:
        menu.pop("unavailable", None)
        body = json.dumps(menu, separators=(",", ":"), sort_keys=True)
    return ("SpaceMolt juncture — the present, each option with the call it would be taken "
            "with, its reason and bounds, what is unavailable and why, and how the last script "
            "ended:\n" + body + tail)


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
    # The last run is the trimmed record now: its prose is where the gains are said.
    if isinstance(last, dict) and "Gained:" not in (last.get("prose") or ""):
        last["cause"] = "the hold was full (cargo_free 0), so a gather would have mined nothing"


def _rest_context(report: dict[str, Any], moves: str | None = None) -> str:
    """A fire that lands on a pilot at rest: reflection, not a menu (N7).

    There is no stance, so there is no stance work to offer and nothing to choose between.
    What the agent gets instead is the report rest exists for — needs, holdings, debts, what
    has been seen, what has been done, and where it has been standing still.
    """
    if report.get("objective_done"):
        return ("SpaceMolt wakeup: the pilot is at rest and the operator's bounded objective "
                f"({report.get('objective') or 'unnamed'}) is already done. Say the objective is "
                "complete and end the turn. The operator sets the next one.")
    head = ("SpaceMolt rest — the shift is over and the stance and mood are cleared. Below is "
            "what the pilot has, owes and has seen, what it did lately, where it stood still, "
            "and `scripts`: pilot/index.ts beside how its runs ended.\n"
            "Your turn:\n"
            "1. Review pilot/index.ts against how its runs ended. When another version would have "
            "served better, write the whole file as `source` to spacemolt_check; the next shift "
            "flies the file this review leaves.\n"
            "2. Choose one goal that serves the objective, then the stance and mood that fit it.\n"
            "3. Call spacemolt_reflect once with them, and end the turn.\n")
    render = lambda: (head + json.dumps(report, separators=(",", ":"), sort_keys=True)
                      + (("\n" + moves) if moves else ""))
    # Over the section limit core skips the whole section, so the suggested moves go first and
    # then the travelogue: the needs and the stagnation signals are the choosing.
    for drop in (None, "moves", "seen", "recent"):
        if drop == "moves":
            moves = None
        elif drop:
            report.pop(drop, None)
        if len(render()) <= SECTION_LIMIT:
            break
    return render()


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


#: The gate cron runs before it builds a fire's prompt. Cron only runs scripts that resolve
#: inside ``HERMES_HOME/scripts`` (``cron.scheduler_script._resolve_script_path``, symlinks
#: resolved), so the plugin installs a shim there rather than naming a file in its own tree.
GATE_SCRIPT = "spacemolt-juncture-gate.py"
#: The shim is a separate process from the gateway, so it cannot ask the bridge anything — a
#: ``service.call`` would start a *second* bridge and be refused the controller lock. It reads
#: the same durable signal ``wake_on_load`` reads instead: the run record the bridge keeps.
_GATE_SHIM = '''"""Written by spacemolt.juncture: the juncture's wake gate. Do not edit."""
import os, sys
sys.path[:0] = {roots!r}
os.environ["HERMES_HOME"] = {home!r}
from spacemolt.juncture import gate_main
raise SystemExit(gate_main())
'''


def run_in_flight() -> bool:
    """Is a run going on right now, as a process outside the gateway can tell?

    The bridge keeps ``running`` in memory, so the only account of it another process can read
    is ``run.json``: a record that has not ended. A gateway that died mid-run leaves that
    record un-ended forever, and a gate that believed it would silence the pilot for good — so
    the controller lock, which a live bridge holds for as long as it runs, has the last word.
    """
    runtime = runtime_dir()
    try:
        record = json.loads((runtime / "run.json").read_text())
    except (OSError, ValueError):
        return False
    if record.get("ended", True):
        return False
    return any(_lock_held(lock) for lock in runtime.glob("controller-*.lock"))


def _lock_held(lock: Any) -> bool:
    """Is the bridge that wrote this lock still alive? ``controller-lock.ts`` reads it the same
    way: the pid alone, with EPERM meaning alive but not ours."""
    try:
        os.kill(int(json.loads(lock.read_text())["pid"]), 0)
    except PermissionError:
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return True


def gate_main() -> int:
    """The wake gate: a fire that lands on a run in flight ends silently, with no model turn.

    The gate always says which it is. Saying nothing is not "wake normally": a script job whose
    script printed nothing has no prompt to build, and cron ends that fire silently too
    (``scheduler.py``: "script produced no output, skipping AI call") — which suppressed every
    juncture, live, on the first restart. A runner that is not up is not in flight: the fire
    wakes and the tools say so themselves. Idle, the line is prose: cron wakes on any output
    that is not ``{"wakeAgent": false}`` and hands it to the fire as its script output.
    """
    print('{"wakeAgent": false}' if run_in_flight() else "No run in flight: the pilot is idle.")
    return 0


def install_gate() -> str:
    """Put the shim where cron will run it from, rewritten every time so a moved plugin or a
    changed profile cannot leave a stale one behind. Returns the path for the job's ``script``."""
    from .service import wake_env

    env = wake_env()
    path = get_hermes_home() / "scripts" / GATE_SCRIPT
    path.parent.mkdir(parents=True, exist_ok=True)
    roots = list(dict.fromkeys(env["PYTHONPATH"].split(os.pathsep)))
    path.write_text(_GATE_SHIM.format(roots=roots, home=env["HERMES_HOME"]))
    path.chmod(0o700)
    return str(path)


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
        # Cron runs this before it builds the prompt: a fire that lands mid-run ends there,
        # with no model turn. ``update_job`` merges fields, so a live job gains it on the next
        # ensure without being deleted.
        "script": install_gate(),
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


if __name__ == "__main__":  # what the shim calls, runnable by hand: python -m spacemolt.juncture
    raise SystemExit(gate_main())
