"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the shared skill, the stance's skill and the
``spacemolt`` toolset; the agent reads the menu, runs one script, and ends the turn. The script
then runs on in the bridge, which outlives the conversation (N5). The runner rewrites this
job at rest, when the stance changes (N18).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from hermes_constants import get_hermes_home

from .service import pilot_path, runtime_dir
from .skills_register import SHARED_SKILL, qualified

#: What a fire carries: the job tools plus the reads every client of the runner may make.
#: ``spacemolt_observer`` is deliberately absent — the pilot does not set its own objective.
TOOLSETS = ("spacemolt", "spacemolt_observe")
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
    "A SpaceMolt juncture. You choose the pilot's next run, start it, judge how it went, and "
    "put the shift down.\n"
    "What to expect:\n"
    "- The context above is current and is everything you need to choose.\n"
    "- A run takes minutes of real time and spacemolt_run waits for it, so its report comes back "
    "to you in this same turn — you are the one holding it, and you are the only one who will.\n"
    "- A wrong field costs a spacemolt_check, a wrong move costs a run, and looking costs "
    "almost nothing: when a fact you need is missing, a run that only looks (orient(), "
    "scout(), note() the numbers) is a good turn.\n"
    "- Spending, selling and fighting are the moves that stay done; the permissions bound the "
    "money, and who to fight is your judgement.\n"
    "Whose word wins: the instruction carried in for this juncture, then the objective, then "
    "your goal, then the suggested moves. When the instruction asks for something the library"
    " can't do, do the nearest thing it can and say so.\n"
    "Your turn:\n"
    "1. Pick the move that best serves the instruction or objective, using what the present "
    "shows.\n"
    "2. Write the whole of pilot/index.ts and pass it as `source` to spacemolt_run.\n"
    "3. When the run returns, read its report against what the shift set out to do: what it cost, "
    "what it gained, the skills that moved and where the ship now stands.\n"
    "4. Then call spacemolt_reflect with a goal, a stance and an initial mood for the next shift. "
    "It rests the pilot and opens that shift in one call. Judge the choice on the before and after "
    "the report just gave you — this is the best-informed moment there is, and the next juncture "
    "will be half an hour staler. Pass objective_done alongside them if this shift finished the "
    "objective.\n"
    "5. Answer in one or two lines — what ran, how it ended, what it measured, what comes next — "
    "and end the turn.\n"
    "A run that ended away from a base cannot rest: spacemolt_reflect says so, the stance carries, "
    "and the next juncture continues this same shift. That is a normal outcome, not a fault, and "
    "nothing needs retrying.\n"
    "Hold instead when every suggested move is refused, and name the refusal in one line.\n"
    "At rest the context says what to do instead.\n"
    'When there is no SpaceMolt context above, say "no context from the runner" and end the '
    "turn."
)

#: Which career folder's README is the stance's skill (``play/<folder>/README.md``).
STANCE_FOLDER = {"Prospector": "mining", "Industrialist": "industry", "Trader": "trading",
                 "Carrier": "hauling", "Hunter": "combat", "Scout": "exploration"}

#: The juncture section's ``max_chars``: core skips a section over it whole, not truncated.
SECTION_LIMIT = 4_000


#: How many runs that accomplished nothing, back to back, before the immediate next juncture stops
#: being triggered and the interval governs again. Small on purpose: three is enough to tell a
#: repeating fault from one bad turn, and cheap enough that a real fault cannot run far.
IDLE_STREAK_LIMIT = 3


def unproductive_streak() -> int:
    """How many of the most recent runs, back to back, did nothing at all.

    Derived from the journal rather than counted into the pilot record, and that is the point: there
    is no state to reset, nothing that can be left set by a crash, and a productive run breaks the
    streak the moment it is written. Recovery needs no human and no bookkeeping.

    "Did nothing" is ``refused``, ``failed``, or zero commands sent. Deliberately NOT "gained
    nothing": a run that only looks is a good turn under the juncture contract, and the live burn of
    2026-09-25 ended ``partial`` having sent 315 commands — so gains mislead in both directions.
    """
    path = runtime_dir() / JOURNAL_FILE
    if not path.is_file():
        return 0
    endings: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for raw in handle:
                # Cheap prefilter: the journal is tens of megabytes and almost none of it is a run
                # ending. Matched on the bare words, not on `"event":"run"` — the separator spacing
                # belongs to whichever writer produced the line, and keying on it silently matched
                # nothing at all the first time.
                if "run" not in raw or "ended" not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                if row.get("event") == "run" and row.get("phase") == "ended":
                    endings.append(row)
    except OSError:
        return 0
    streak = 0
    for row in reversed(endings):
        did_nothing = (str(row.get("outcome")) in {"refused", "failed"}
                       or not int(row.get("commands") or 0))
        if not did_nothing:
            break
        streak += 1
    return streak


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
    # At rest the menu still carries moves (VISION: the menu is never empty); the choosing
    # material a rest needs is the reflection, so the fire gets both.
    if menu.get("rest") or menu.get("at_rest"):
        return _rest_context(call("reflect"), menu.get("text"), _alerts(menu), _battle(menu))
    if menu.get("busy"):
        return "SpaceMolt juncture — a run is already in flight; its report comes with the next one."
    said = read_pilot().get("instruction")
    context = _situation(menu, said)
    if said:
        _deliver(said)
    return context


def _deliver(said: dict[str, Any]) -> None:
    """The instruction is for one juncture: once rendered, it moves to ``instruction_delivered``.

    Re-read just before the write so an instruction the window set in between is not the one
    moved. ponytail: read-modify-write without a lock; a ``_direct`` landing inside that
    microsecond window is lost. Add a file lock if the window ever writes in bulk.
    """
    record = read_pilot()
    if record.get("instruction") == said:
        record["instruction_delivered"] = record.pop("instruction")
        write_pilot(record)


def _when(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None


def _stamp(at: datetime | None) -> str:
    return at.astimezone(timezone.utc).strftime("%m-%d %H:%MZ") if at else "unknown time"


def _age(then: datetime, now: datetime) -> str:
    minutes = int((now - then).total_seconds() // 60)
    if minutes >= 2 * 1440:
        return f"{minutes // 1440} days ago"
    if minutes >= 120:
        return f"{minutes // 60} hours ago"
    return f"{max(minutes, 0)} min ago"


_PERMISSION = {"credit_reserve": "keep {:,} credits", "max_liability": "owe at most {:,} on one job"}

#: The rest of the story a free hold of 0 leaves untold. A full hold is not a dead end and it
#: is not a mystery either: it is ore with two places to go and a gather that will return
#: nothing until it does (playtest 2026-09-15: three gathers dispatched on a full hold).
#: Docked, the hold has two places to go. Undocked it has neither: ``sell`` is refused away from
#: a counter ("not docked; a market is a station counter") and ``stow`` needs a storage service, so
#: out at a belt — the commonest way to fill a hold — both offers were dead and the one real move
#: was missing. The suggested moves below carry the base ids.
_HOLD_FULL_DOCKED = ("hold full: a gather needs free hold. sell(rows) or stow(rows) here first "
                     "(name the rows from the hold above), then gatherUntil")
_HOLD_FULL_OUT = ("hold full: a gather needs free hold, and neither sell nor stow works out here — "
                  "goTo a base with a market or storage first, then sell(rows) or stow(rows)")


#: What each buffered alert is, in the pilot's words. A type without an entry renders its own
#: name: a frame group newly added to the buffer is still worth a line.
_ALERT_LABEL = {"facility_rent_warning": "rent overdue", "facility_reclaimed": "facilities repossessed",
                "base_destroyed": "base destroyed"}
#: ponytail: four alert lines, the rest a count. The buffer already collapses by base, so four
#: is four bases in trouble at once; raise it if a pilot ever holds that many facilities.
_ALERT_LINES = 4


def _alerts(menu: dict[str, Any]) -> list[str]:
    """The alerts the bridge handed over with this menu, as fact lines.

    The bridge stamped them delivered as it answered, so they appear at exactly one juncture.
    They go with the facts, above the cuttable material: a repossession deadline is the one
    thing a pilot cannot recover by looking again next time.
    """
    items = [item for item in (menu.get("alerts") or []) if isinstance(item, dict)]
    if not items:
        return []
    lines = [f"Alerts since your last wake ({len(items)}, shown once):"]
    for item in items[:_ALERT_LINES]:
        body = item.get("body") or {}
        what = _ALERT_LABEL.get(str(item.get("type")), str(item.get("type")))
        bits = []
        if isinstance(body.get("credits_owed"), (int, float)):
            bits.append(f"{body['credits_owed']:,} owed")
        if body.get("missed_cycles") is not None:
            bits.append(f"{body['missed_cycles']} of {body.get('grace_cycles', '?')} missed cycles")
        if body.get("attacker_name"):
            bits.append(f"attacker {body['attacker_name']}")
        if not bits and body.get("message"):
            bits.append(str(body["message"])[:120])
        seen = (f", seen {item['n']}x since {_stamp(_when(item.get('first_at')))}"
                if item.get("n", 1) > 1 else "")
        lines.append(f"  {what} at {body.get('base_name') or item.get('key')}"
                     + (f": {'; '.join(bits)}" if bits else "") + seen + ".")
    if len(items) > _ALERT_LINES:
        lines.append(f"  +{len(items) - _ALERT_LINES} more in the journal.")
    return lines


def _battle(menu: dict[str, Any]) -> str | None:
    """Whether a battle holds the ship, in one line, ahead of every other fact.

    Live 2026-09-25: a pilot woke at hull 3/80 inside a battle left over from the previous shift
    and died one second after its first move, because nothing it read said it was in a fight. A
    live battle also refuses every travel, jump and undock, so it is never a detail.
    """
    fight = menu.get("battle")
    if not isinstance(fight, dict):
        return None
    hull = (menu.get("present") or {}).get("hull")
    at = f", hull {hull}/{(menu.get('present') or {}).get('max_hull')}" if hull is not None else ""
    return (f"IN BATTLE NOW with {fight.get('opponent') or 'an unnamed opponent'} "
            f"(battle tick {fight.get('tick') or '?'}{at}). Nothing moves the ship until it ends: "
            # NOT "fight it with hunt's onTick": `hunt` declines any creature whose `in_combat` is
            # true (hunting.ts:136), which the current opponent is by definition, so it would look,
            # decline it and spend the juncture. `onTick` only exists on fights `hunt` itself opens.
            "disengage() breaks off; to keep fighting, hold the stance by hand with "
            "account().commands.spacemolt_battle.stance({id:'brace'}).")


def _situation(menu: dict[str, Any], said: dict[str, Any] | None) -> str:
    """The juncture as labelled lines, each fact once, budgeted on the final string.

    Over ``SECTION_LIMIT`` core drops the section whole, so the suggested moves go first, then
    the hold list is cut, then the last run's report — never a fact line.
    """
    now = _when(menu.get("now")) or datetime.now(timezone.utc)
    p = menu.get("present") or {}
    head = f"SpaceMolt juncture — mid-shift. Now {now.strftime('%Y-%m-%d %H:%MZ')}."
    if menu.get("stance") or menu.get("mood"):
        head += f" Stance {menu.get('stance') or 'none'}, mood {menu.get('mood') or 'none'}."
    # The battle goes above the head line: it is the one fact that outranks where the ship is.
    facts = [line for line in (_battle(menu),) if line] + [head]
    if menu.get("objective"):
        facts.append(f"Objective (carried in): {menu['objective']}")
    if said:
        facts.append(f"Instruction (carried in, {_stamp(_when(said.get('at')))}, this juncture "
                     f"only): {said.get('text')}")
    facts += _alerts(menu)
    if menu.get("goal"):
        facts.append(f"Goal (yours, from rest): {menu['goal']}")
    # Only the keys rendered here: a permission the code no longer knows is one the pilot
    # cannot act on, and a stale ``wildlife: false`` left in the record read as "wildlife
    # False" and bought a turn of wondering whether hunting was allowed (playtest 2026-09-22).
    permits = [_PERMISSION[k].format(v) for k, v in (menu.get("permissions") or {}).items()
               if k in _PERMISSION and isinstance(v, (int, float)) and not isinstance(v, bool)]
    if permits:
        facts.append("Permissions: " + "; ".join(permits) + ".")
    system = p.get("system") or "unknown system"
    where = (f"docked at {p['docked_at']} ({system})" if p.get("docked_at")
             else f"in transit ({system})" if p.get("in_transit")
             else f"at {p.get('poi') or 'an unknown point'} ({system})")
    facts.append(f"Present: {where}.")
    ship = (f"  Fuel {p.get('fuel')}/{p.get('max_fuel')}, hull {p.get('hull')}/{p.get('max_hull')}, "
            f"credits {p.get('credits') or 0:,}.")
    hold = [f"{row.get('item_id')} {row.get('quantity')}" for row in p.get("hold") or []]
    free = p.get("cargo_free")
    weapons = ", ".join(f"{w.get('id')}" + (f" ({w['loaded']} loaded)" if "loaded" in w else "")
                        for w in p.get("weapons") or []) or "none"
    # A skill is an object in the library, not a number: naming the field the number came from
    # keeps a script from writing `skills.weapons > 2` (playtest 2026-09-22).
    skills = ", ".join(f"{k} {v} (.level)" for k, v in (p.get("skills") or {}).items()) or "none known"
    facts_after = [f"  Fitted weapons: {weapons}. Skills: {skills}."]
    if p.get("walk_away") is not None:
        facts_after.append(f"  Walk-away: break off a fight below hull {p['walk_away']}.")

    last = menu.get("last")
    # A record from before the run record carried its sha is another schema: not this pilot's.
    last = last if isinstance(last, dict) and last.get("sha") else None
    report = ""
    if last:
        ended = _when(last.get("ended_at"))
        report = str(last.get("prose") or last.get("status") or "")
        if free == 0 and "Gained:" not in report:
            report += "\nThe hold was full (0 free), so a gather would have mined nothing."
        last_head = (f"Last run (ended {_stamp(ended)}, {_age(ended, now)}):" if ended
                     else "Last run (end time not recorded):")
    moves = menu.get("text")

    def render(moves: str | None, kept: int, report: str) -> str:
        shown = hold[:kept] + ([f"+{len(hold) - kept} more"] if kept < len(hold) else [])
        hold_line = (f" Hold: {', '.join(shown) or 'empty'} ({free} free)."
                     + (f" {_HOLD_FULL_DOCKED if p.get('docked_at') else _HOLD_FULL_OUT}."
                        if free == 0 else ""))
        lines = facts + [ship + hold_line] + facts_after
        lines.append(f"{last_head}\n  " + report.replace("\n", "\n  ") if last
                     else "Last run: none yet.")
        if moves:
            lines.append("Suggested moves (advice, pasteable into main()):\n  "
                         + moves.replace("\n", "\n  "))
        return "\n".join(lines)

    kept = len(hold)
    text = render(moves, kept, report)
    if len(text) > SECTION_LIMIT:
        text = render(None, kept, report)
    while len(text) > SECTION_LIMIT and kept:
        kept = max(0, kept - max(1, (len(text) - SECTION_LIMIT) // 12))
        text = render(None, kept, report)
    if len(text) > SECTION_LIMIT:
        report = report[:max(0, len(report) - (len(text) - SECTION_LIMIT) - 1)] + "…"
        text = render(None, kept, report)
    return text


def _rest_context(report: dict[str, Any], moves: str | None = None,
                  alerts: list[str] | None = None, battle: str | None = None) -> str:
    """A fire that lands on a pilot at rest: reflection, not a menu (N7).

    There is no stance, so there is no stance work to offer and nothing to choose between.
    What the agent gets instead is the report rest exists for — needs, holdings, debts, what
    has been seen, what has been done, and where it has been standing still.
    """
    head = ("SpaceMolt rest — the shift is over and the stance and mood are cleared. Below is "
            "what the pilot has, owes and has seen, what it did lately, where it stood still, "
            "and `scripts`: pilot/index.ts beside how its runs ended.\n"
            "Your turn:\n"
            "1. Review pilot/index.ts against how its runs ended. When another version would have "
            "served better, write the whole file as `source` to spacemolt_check; the next shift "
            "flies the file this review leaves.\n"
            "2. Judge your objective against the numbers, not against your memory of "
            "it: each skill row carries its level, and `was`/`since` when it has moved since the "
            "earliest reflection on record. `missing` names what could not be read.\n"
            "3. Choose one goal that serves the objective, then the stance and mood that fit it.\n"
            "4. Call spacemolt_reflect once with them — with objective_done beside them if the "
            "numbers say the objective is met — and end the turn.\n")
    # Above everything, at rest as mid-shift: a battle still running owns the ship.
    if battle:
        head = f"{battle}\n{head}"
    # A finished objective is not a reason to wait: the pilot retires it and chooses its own goal
    # in the same call. Waiting here is what wedged two junctures and an hour, live (2026-09-24).
    if report.get("objective_done"):
        head += (f"Your objective ({report.get('objective') or 'unnamed'}) is already "
                 "complete: pass objective_done beside the goal, stance and mood you choose and it "
                 "is retired. Advance in general — the world, your levels, credits, a better "
                 "ship — until the human names another.\n")
    # The menu call above stamped these delivered, so a rest that dropped them would drop them
    # for good.
    head += "".join(f"{line}\n" for line in alerts or [])
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
    """Set objective, stance and mood.

    ponytail: a plain file, written by whoever owns rest — for now the observer or a test.
    The runner's own rest path takes it over when there is one; no CLI command until then.
    """
    path = pilot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Temp then rename, as the bridge's ``writePilot`` does: its reader throws on half a file.
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    temp.chmod(0o600)
    os.replace(temp, path)
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
    changed profile cannot leave a stale one behind. Returns the job's ``script``: the bare
    name, because the tool layer rejects an absolute script and resolves a relative one
    against the very directory written to here."""
    from .service import wake_env

    env = wake_env()
    path = get_hermes_home() / "scripts" / GATE_SCRIPT
    path.parent.mkdir(parents=True, exist_ok=True)
    roots = list(dict.fromkeys(env["PYTHONPATH"].split(os.pathsep)))
    path.write_text(_GATE_SHIM.format(roots=roots, home=env["HERMES_HOME"]))
    path.chmod(0o700)
    return GATE_SCRIPT


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
        # Namespaced plugin skills: registered by the plugin, resolved by cron through the
        # plugin registry, never copied into the profile's skills directory.
        "skills": [qualified(SHARED_SKILL)] + ([qualified(folder)] if folder else []),
        "enabled_toolsets": list(TOOLSETS),
        # Cron runs this before it builds the prompt: a fire that lands mid-run ends there,
        # with no model turn. ``update_job`` merges fields, so a live job gains it on the next
        # ensure without being deleted.
        "script": install_gate(),
    }


#: Set from ``register()`` to the host's ``PluginContext.dispatch_tool``. Absent — the wake
#: one-shot, a bare ``python -m spacemolt.juncture`` — the tool registry is asked directly,
#: which is all ``dispatch_tool`` does once the parent agent is resolved.
_dispatch_tool = None


def use_dispatch(dispatch) -> None:
    """Take the host's tool dispatcher, so cron is reached through the public tool and never
    through ``cron.*``."""
    global _dispatch_tool
    _dispatch_tool = dispatch


def cron_manage(**args: Any) -> dict[str, Any]:
    """One ``cronjob_manage`` call, raising on failure rather than returning an error dict.

    The gate on that tool (``HERMES_GATEWAY_SESSION``) is a *schema exposure* check:
    ``registry.dispatch`` runs the handler without consulting ``check_fn``, so a plugin and a
    one-shot both reach it.
    """
    dispatch = _dispatch_tool
    if dispatch is None:
        import tools.cronjob_tools  # noqa: F401 - importing it is what registers the tool
        from tools.registry import registry
        dispatch = registry.dispatch
    result = dispatch("cronjob_manage", args)
    result = json.loads(result) if isinstance(result, str) else result
    if not result.get("success"):
        raise RuntimeError(f"cronjob_manage {args.get('action')}: {result.get('error') or result}")
    return result


def ensure_juncture_job(schedule: str = IDLE_SCHEDULE) -> dict[str, Any]:
    """Write or rewrite this pilot's one juncture job from the current pilot record.

    Returns the tool's own view of the job — ``job_id``/``name``/``schedule``, not the stored
    record: what the job store keeps is the store's business.
    """
    pilot = read_pilot()
    name = job_name(pilot)
    fields = job_fields(pilot)
    existing = next((job for job in cron_manage(action="list")["jobs"]
                     if job.get("name") == name), None)
    if existing is not None:
        return cron_manage(action="update", job_id=existing["job_id"], **fields)["job"]
    return cron_manage(action="create", schedule=schedule, name=name, **fields)["job"]


def mark_due(job: dict[str, Any]) -> dict[str, Any]:
    """Mark an already-written juncture job due, so the gateway's next tick fires it.

    The one place the plugin reaches a Hermes module, and it has to be: ``cronjob_manage``'s
    ``run`` *executes* the fire, and every caller here needs it merely *marked*.

    - Reflection runs inside the juncture's own fire. That job is registered running, so a
      ``run`` is refused as already-running — and refused with ``success: True`` and the reason
      buried in ``execution_skipped``, so the pilot would simply stop waking and look healthy.
    - ``wake_on_load`` runs during plugin registration. With no session to deliver a background
      completion to, ``run`` falls back to an inline fire: gateway boot would block for the
      length of a whole juncture.
    - The wake one-shot is a bridge child with no gateway either, and an inline fire there opens
      a second Node bridge the controller lock refuses.

    ``cron.jobs.trigger_job`` is a public name in a module every Hermes ships, so an unmodified
    host satisfies the import; job *creation* goes through the tool like everything else.
    """
    from cron.jobs import trigger_job

    trigger_job(job["job_id"])
    return job


def raise_juncture() -> dict[str, Any]:
    """Rewrite this pilot's juncture job from the record and mark it due."""
    return mark_due(ensure_juncture_job())


if __name__ == "__main__":  # what the shim calls, runnable by hand: python -m spacemolt.juncture
    raise SystemExit(gate_main())
