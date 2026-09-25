"""A juncture: a cron fire opens a fresh conversation, reads the present, and plays or holds.

What a fire depends on: the busy fire that must change nothing (N4), the job definition that
carries the stance through the cron toolset clamp (N18/N20), and the contract the juncture
prompt states. The dispatch-era tests (a `script`/`params` tool that returned while the run
went on) are gone with that design: spacemolt_run now writes and runs pilot/index.ts and
blocks until it ends.
"""
from __future__ import annotations

import copy
import json
import os

import spacemolt
from spacemolt import juncture, service


def test_a_fire_while_a_script_runs_changes_nothing(monkeypatch, capsys):
    """N4: a fire that lands mid-run is a true no-op — cron's wake gate ends it before a prompt
    is built, so there is no model turn at all. The gate reads the run record the bridge keeps,
    because the shim runs outside the gateway and cannot ask the bridge anything."""
    from cron.scheduler_prompt import _parse_wake_gate

    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    lock = runtime / "controller-deadbeef.lock"
    lock.write_text(json.dumps({"pid": os.getpid()}))

    def gate_line() -> str:
        """The last stdout line, which is the only one cron reads. Never judged through
        _parse_wake_gate alone: that answers True to no output at all, and no output is what
        cron ends a fire on (live 2026-09-17) — it would hide the very bug it looks for."""
        assert juncture.gate_main() == 0
        printed = capsys.readouterr().out
        assert printed.strip(), "an empty stdout ends the fire as surely as wakeAgent=false"
        return printed.splitlines()[-1]

    # Nothing running: no record at all, then one that ended. The fire wakes, and what the gate
    # said reaches its prompt as the script's output.
    from cron.scheduler_prompt import _build_job_prompt
    idle = gate_line()
    assert _parse_wake_gate(idle) is True
    assert idle in _build_job_prompt({"prompt": juncture.JUNCTURE_PROMPT, "script": "gate"},
                                     prerun_script=(True, idle))
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": True}))
    assert gate_line() == idle

    # A run in flight, and a live bridge holding the controller lock: the fire is skipped.
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": False}))
    assert juncture.run_in_flight() is True
    line = gate_line()
    assert line == '{"wakeAgent": false}' and _parse_wake_gate(line) is False

    # The same record with no live bridge is a gateway that died mid-run, not a run in flight:
    # the pilot is woken rather than silenced for good.
    lock.unlink()
    assert juncture.run_in_flight() is False
    assert gate_line() == idle


def test_the_juncture_job_carries_the_stance_and_passes_the_cron_toolset_clamp(tmp_path):
    from cron import jobs as cron_jobs
    from cron.scheduler import (_CronAgentSetup, _construct_cron_agent,
                                _resolve_cron_disabled_toolsets, _resolve_cron_enabled_toolsets)

    # `home` is a key the library dropped; a live record still carries it, and nothing reads it.
    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
                          "objective": "fill the hold", "home": "sol_base"})
    job = juncture.ensure_juncture_job()

    stored = cron_jobs.get_job(job["id"])
    # The wake gate cron runs before it builds the prompt, installed where cron will run it from.
    assert stored["script"].endswith(juncture.GATE_SCRIPT)
    from cron.scheduler_script import _resolve_script_path
    assert _resolve_script_path(stored["script"])[0] is not None, "cron must accept the path"
    # The stance's skill is its career folder's README (STANCE_FOLDER), not the stance name.
    assert stored["skills"] == ["spacemolt", "spacemolt-mining"]
    # The job tools and the reads; never the observer's toolset — a pilot does not direct itself.
    assert stored["enabled_toolsets"] == ["spacemolt", "spacemolt_observe"]
    assert "spacemolt_observer" not in stored["enabled_toolsets"]
    # The stance's own tools survive both halves of the cron clamp.
    enabled = _resolve_cron_enabled_toolsets(stored, {})
    assert {"spacemolt", "spacemolt_observe"} <= set(enabled)
    assert not {"spacemolt", "spacemolt_observe"} & set(_resolve_cron_disabled_toolsets({}))

    # A fire builds a fresh conversation: its own session, the plugin toolset, no project
    # context files and no background review fork.
    seen: dict = {}

    class RecordingAgent:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    _construct_cron_agent(RecordingAgent, stored, {}, _CronAgentSetup(model="m", runtime={}),
                          workdir=None, session_id="fire-1", session_db=None)
    assert "spacemolt" in seen["enabled_toolsets"]
    assert seen["session_id"] == "fire-1"
    assert seen["skip_context_files"] is True
    assert seen["skip_background_review"] is True

    # One cron job per pilot: rest rewrites it, never adds a second.
    juncture.write_pilot({"name": "kvothe", "stance": "Hunter", "mood": "Aggressive"})
    again = juncture.ensure_juncture_job()
    assert again["id"] == job["id"]
    assert cron_jobs.get_job(again["id"])["skills"] == ["spacemolt", "spacemolt-combat"]
    assert len(cron_jobs.load_jobs()) == 1


# What the bridge's `menu` answers, in its own shape: the record's fields, the present, the
# rendered moves and the last run. What these pin is what the context does with it.
def _menu(cargo_free: int, *, last: dict | None, hold: list | None = None) -> dict:
    return {"now": "2026-09-23T14:05:00.000Z", "stance": "Hunter", "mood": "Aggressive",
            "objective": "raise gunnery by 2 hunting fauna", "home": "unknown_edge_waystation",
            "permissions": {"credit_reserve": 5000, "max_liability": 100000},
            "present": {"system": "first_step", "docked_at": "first_step_station",
                        "fuel": 66, "max_fuel": 120, "hull": 105, "max_hull": 105,
                        "credits": 236373, "cargo_free": cargo_free,
                        "hold": hold if hold is not None else [{"item_id": "ore", "quantity": 12}],
                        "weapons": [{"id": "autocannon_i", "loaded": 500}],
                        "skills": {"weapons": 3, "gunnery": 1, "tactics": 2}},
            "moves": [], "not_now": [],
            "text": "Menu:\n  - `hunt()` — trains gunnery (level 1, the lowest) [skill]",
            "last": last}


LAST = {"sha": "f90d4bf12d9d", "started": "2026-09-16T00:10:00Z",
        "ended_at": "2026-09-16T00:40:00Z", "ended": True, "status": "done",
        "did": "gathered", "prose": "Done: mined 12 ore.\nGained: 12 ore."}
#: A run record from before the sha was carried: another schema, not this pilot's last run.
PRE_MERGE = {"script": "source:f90d4bf12d9d", "outcome": "done", "jobs": [],
             "reason": "Home set to frontier_station"}

FACT_LINES = ("SpaceMolt juncture", "Objective (carried in):", "Permissions:", "Present:",
              "  Fuel ", "  Fitted weapons:", "Last run")


def _rendered(monkeypatch, menu: dict) -> str:
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    return juncture.juncture_context({"platform": "cron"})


def test_the_situation_is_labelled_lines_with_the_last_runs_age(monkeypatch):
    context = _rendered(monkeypatch, _menu(12, last=LAST))
    for label in FACT_LINES + ("Suggested moves",):
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)
    assert "Last run (ended 09-16 00:40Z, 7 days ago):" in context
    assert "hold full" not in context, "room in the hold leaves the full-hold note off"

    # A full hold says what it costs, and names itself as the cause of an empty gather.
    empty = dict(LAST, prose="Done: gathered nothing.")
    full = _rendered(monkeypatch, _menu(0, last=empty))
    assert "hold full: a gather needs free hold" in full and "sell(rows) or stow(rows)" in full
    assert "The hold was full (0 free)" in full


def test_a_full_hold_out_in_the_open_is_offered_the_move_that_works(monkeypatch):
    """`sell` and `stow` are station counters, and a belt is not a station.

    The full-hold note offered both whatever the ship was standing on. Out at a belt — the
    commonest way to fill a hold — `sell` is refused ("not docked; a market is a station counter")
    and `stow` needs a storage service, so every offer on that line was dead and the one real move,
    flying to a base, was not on it.
    """
    empty = dict(LAST, prose="Done: gathered nothing.")
    undocked = _menu(0, last=empty)
    undocked["present"]["docked_at"] = None
    out = _rendered(monkeypatch, undocked)
    assert "hold full" in out
    assert "goTo a base" in out, f"no runnable move on a full hold in the open: {out}"
    assert "sell(rows) or stow(rows) here first" not in out, (
        "a counter offered where there is no counter")

    # Docked, both really are available, so the original note stands.
    docked = _rendered(monkeypatch, _menu(0, last=empty))
    assert "sell(rows) or stow(rows) here first" in docked


def test_the_in_battle_line_names_a_call_that_can_actually_be_made(monkeypatch):
    """`hunt` cannot fight the battle already holding the ship.

    It declines any creature whose `in_combat` is true, which the current opponent is by
    definition, so "fight it with hunt's onTick" sent the pilot to look, decline and spend the
    juncture. `onTick` only exists on fights `hunt` itself opens.
    """
    menu = _menu(12, last=LAST)
    menu["battle"] = {"opponent": "Hollow Pilgrim", "tick": 4}
    context = _rendered(monkeypatch, menu)
    assert "IN BATTLE NOW with Hollow Pilgrim" in context
    assert "disengage()" in context
    assert "hunt" not in context.split("IN BATTLE NOW")[1].split(".")[0] + \
        context.split("IN BATTLE NOW")[1].split("\n")[0], (
        f"the battle line still sends the pilot to hunt: {context}")


def test_the_situation_renders_only_the_permissions_the_code_knows(monkeypatch):
    """A key the code dropped is still in the record, and rendering it raw read as "wildlife
    False": the pilot spent its first turn weighing whether it could hunt (playtest 2026-09-22).

    The filter is an allowlist, so every permission the library has since dropped —
    `wildlife`, `may_attack`, and now `max_spend` and `no_go` — stays inert in a live record
    rather than rendering as a bound the pilot cannot act on. `home` went the same way: the
    key survives in live records and the present line no longer looks for it.
    """
    menu = _menu(12, last=LAST)
    menu["permissions"] = {"credit_reserve": 5000, "wildlife": False,
                           "no_go": ["deep_range"], "max_spend": 1000}
    context = _rendered(monkeypatch, menu)
    assert "Permissions: keep 5,000 credits." in context
    assert "Present: docked at first_step_station (first_step)." in context
    for gone in ("wildlife", "deep_range", "no_go", "max_spend",
                 "Home", "unknown_edge_waystation"):
        assert gone not in context, gone


def test_a_skill_reads_as_the_object_it_is(monkeypatch):
    """A bare number is branched on as a number: the level is named as the field it came from."""
    context = _rendered(monkeypatch, _menu(12, last=LAST))
    assert "Skills: weapons 3 (.level), gunnery 1 (.level), tactics 2 (.level)." in context


def test_the_walk_away_line_is_told_rather_than_guessed(monkeypatch):
    """The mood already computes the hull a fight is broken off at; left out of the context the
    pilot guessed 74% where the Aggressive line is 80% (hull 84)."""
    menu = _menu(12, last=LAST)
    menu["present"]["walk_away"] = 84
    assert "  Walk-away: break off a fight below hull 84." in _rendered(monkeypatch, menu)
    # And no line at all where the menu carries no number: an older bridge sends none.
    assert "Walk-away" not in _rendered(monkeypatch, _menu(12, last=LAST))


def test_a_pre_merge_run_record_is_no_last_run(monkeypatch):
    context = _rendered(monkeypatch, _menu(12, last=PRE_MERGE))
    assert "Last run: none yet." in context
    assert "frontier_station" not in context


def test_an_instruction_reaches_one_juncture_and_not_the_next(monkeypatch):
    """The observer's sentence is for the next juncture only: once rendered, it is delivered."""
    juncture.write_pilot({"name": "kvothe", "stance": "Hunter", "mood": "Aggressive",
                          "instruction": {"text": "stay in Sol tonight",
                                          "at": "2026-09-23T03:21:00Z"}})
    first = _rendered(monkeypatch, _menu(12, last=LAST))
    assert "Instruction (carried in, 09-23 03:21Z, this juncture only): stay in Sol tonight" in first
    second = _rendered(monkeypatch, _menu(12, last=LAST))
    assert "stay in Sol tonight" not in second
    assert juncture.read_pilot()["instruction_delivered"]["text"] == "stay in Sol tonight"


ALERTS = [{"type": "facility_rent_warning", "key": "base:hera_outpost",
           "at": "2026-09-23T13:55:00Z", "first_at": "2026-09-23T11:40:00Z", "n": 3,
           "body": {"base_id": "hera_outpost", "base_name": "Hera Outpost", "credits_owed": 4200,
                    "missed_cycles": 2, "grace_cycles": 4, "message": "Rent is overdue."},
           "delivered_at": None},
          {"type": "base_destroyed", "key": "base:far_reach", "at": "2026-09-23T14:01:00Z",
           "first_at": "2026-09-23T14:01:00Z", "n": 1,
           "body": {"base_id": "far_reach", "base_name": "Far Reach", "attacker_name": "Vex"},
           "delivered_at": None}]


def test_the_alerts_the_bridge_buffered_reach_the_pilot_as_fact_lines(monkeypatch):
    """What happened while the pilot was not looking, with the deadline that makes it a decision."""
    menu = _menu(12, last=LAST)
    menu["alerts"] = ALERTS
    context = _rendered(monkeypatch, menu)
    assert "Alerts since your last wake (2, shown once):" in context
    assert ("  rent overdue at Hera Outpost: 4,200 owed; 2 of 4 missed cycles, "
            "seen 3x since 09-23 11:40Z." in context), context
    assert "  base destroyed at Far Reach: attacker Vex." in context
    # An alert line is a fact line: it survives the budget that cuts the moves and the hold.
    big = _menu(12, last=dict(LAST, prose="x" * 6_000))
    big["alerts"] = ALERTS
    assert "rent overdue at Hera Outpost" in _rendered(monkeypatch, big)
    # No alerts is no section at all, not an empty heading.
    assert "Alerts since" not in _rendered(monkeypatch, _menu(12, last=LAST))
    # A rest lands on the same menu call, so the alerts cannot be swallowed by it.
    assert "rent overdue at Hera Outpost" in juncture._rest_context({}, None, juncture._alerts(menu))


def test_an_oversized_situation_fits_the_section_with_every_fact_line(monkeypatch):
    """Over the limit core drops the section whole, so the moves and the hold list give way."""
    hold = [{"item_id": f"salvaged_component_{i}", "quantity": i} for i in range(400)]
    menu = _menu(12, last=dict(LAST, prose="Done: a long run.\n" + "  - hunt done fought\n" * 80),
                 hold=hold)
    menu["text"] = "Menu:\n" + "  - `hunt()` — trains gunnery [skill]\n" * 200
    context = _rendered(monkeypatch, menu)
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    for label in FACT_LINES:
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)


def test_the_cron_prompt_leaves_the_tools_to_their_own_descriptions():
    """The turn contract only: nothing about which tool does what (playtest 2026-09-15).

    The exception is how a juncture plays: the turn is write, run, judge, put the shift down, so
    the prompt names the three tools that are the contract itself — the check before the run, the
    run, and the reflection that ends the shift and opens the next. Reflecting joined that list when
    the turn gained its fourth step; before that the prompt said "one run per juncture is the whole
    job" and the pilot duly stopped after the run, which is why a shift was never put down.
    Everything else is left to its own description.
    """
    named = sorted(definition["name"] for definition in spacemolt.TOOL_DEFINITIONS
                   if definition["name"] in juncture.JUNCTURE_PROMPT)
    assert named == ["spacemolt_check", "spacemolt_reflect", "spacemolt_run"], \
        f"the prompt names tools the descriptions own: {named}"
    # The job a fire runs carries the turn contract as its whole prompt.
    assert juncture.job_fields({"stance": "Hunter"})["prompt"] == juncture.JUNCTURE_PROMPT


def test_the_rest_context_carries_the_scripts_the_review_reads(monkeypatch):
    """A resting fire is handed the pilot's own code beside how it ran (N7)."""
    report = {"at_rest": True, "objective": "buy a combat ship",
              "stagnation": ["stances never chosen: Hunter"],
              "scripts": [{"name": "buy-hull", "saved": True, "bytes": 812, "runs": 2,
                           "params": {"type": "object", "properties": {}},
                           "last": [{"outcome": "blocked", "reason": "credits short"},
                                    {"outcome": "failed", "reason": "no shipyard here"}]},
                          {"name": "gather", "runs": 9}]}
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(report))
    context = juncture.juncture_context({"platform": "cron"})
    assert "buy-hull" in context and "no shipyard here" in context
    # The rest context carries the whole rest turn: the review, then one reflection.
    assert "spacemolt_check" in context and "spacemolt_reflect" in context
    # A travelogue too long for the section is cut before the section is: over the limit, core
    # would drop the whole of it, the rest turn included.
    report["seen"] = ["a system seen on the way " * 4] * 200
    context = juncture.juncture_context({"platform": "cron"})
    assert len(context) <= juncture.SECTION_LIMIT and "spacemolt_reflect" in context


def test_loading_the_plugin_wakes_an_idle_pilot_once_and_leaves_a_running_one_alone(monkeypatch):
    from cron import jobs as cron_jobs
    from spacemolt import service
    runtime = service.runtime_dir(); runtime.mkdir(parents=True, exist_ok=True)
    assert cron_jobs.load_jobs() == []
    spacemolt.wake_on_load()  # no pilot record: no one to wake
    assert cron_jobs.load_jobs() == []
    juncture.write_pilot({"name": "kvothe", "stance": "Industrialist", "mood": "Cautious"})
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": False}))
    spacemolt.wake_on_load()  # a run in flight raises its own juncture at its end, but the job is rewritten
    job, = cron_jobs.load_jobs()
    assert juncture.JUNCTURE_PROMPT in job["prompt"] and job.get("manual_run_at") is None
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": True}))
    spacemolt.wake_on_load()
    job, = cron_jobs.load_jobs()
    assert job["next_run_at"] is not None and job["state"] == "scheduled"


def test_a_live_battle_is_the_first_line_of_the_context(monkeypatch):
    """Live 2026-09-25: a pilot woke at hull 3/80 inside a battle left over from the previous
    shift and died one second after its first move, because nothing it read said it was in a
    fight. A live battle also refuses every travel, jump and undock, so it goes above the head
    line — mid-shift and at rest alike."""
    menu = _menu(12, last=LAST)
    menu["battle"] = {"opponent": "Slag-Tortoise", "tick": 7}
    menu["present"]["hull"] = 3
    menu["present"]["max_hull"] = 80
    first = _rendered(monkeypatch, menu).splitlines()[0]
    assert first.startswith("IN BATTLE NOW with Slag-Tortoise (battle tick 7, hull 3/80)."), first
    assert "disengage()" in first
    # No battle, no line: the fact costs the budget nothing when there is no fight.
    assert "IN BATTLE" not in _rendered(monkeypatch, _menu(12, last=LAST))
    # And a fire that lands at rest is told the same thing, before the rest turn.
    resting = {"at_rest": True, "rest": {"at_rest": True}, "battle": menu["battle"],
               "present": menu["present"]}
    monkeypatch.setattr(service, "call",
                        lambda action, params=None: copy.deepcopy(resting if action == "menu" else {"at_rest": True}))
    assert juncture.juncture_context({"platform": "cron"}).splitlines()[0].startswith("IN BATTLE NOW with Slag-Tortoise")


def test_the_turn_is_run_then_rest_and_reflect_then_end():
    """The prompt owns the turn's shape, and its old shape is why nothing reflected.

    `JUNCTURE_PROMPT` said "One run per juncture is the whole job" and "You choose the pilot's next
    run, start it, and end the turn". The pilot ended its turn after the run because that is what it
    was told to do, so a shift never got put down and the next juncture found the same open shift.
    That was ours, not the model's.

    `spacemolt_run` blocks, so when it returns the model is in a turn holding the report — the one
    moment that is both well-informed and able to reason about what the next shift should be.
    """
    prompt = juncture.JUNCTURE_PROMPT
    assert "One run per juncture is the whole job" not in prompt, (
        "the sentence that told the pilot to stop after the run is still there")
    assert "spacemolt_reflect" in prompt, "the turn never names the call that ends the shift"
    # And it has to say what the choice is judged against, not merely that a choice is due.
    assert "before" in prompt.lower() or "report" in prompt.lower(), prompt


def test_reflect_rests_the_pilot_itself_and_opens_the_next_shift(tmp_path, monkeypatch):
    """Post-run the pilot is on shift, which is exactly when it must rest and reflect.

    `_reflect` refused outright while a stance was set — "Reflection happens at rest" — because rest
    used to be a separate act the pilot had to perform first. Under the new shape it does the resting
    itself, in one bridge request, so the record never passes through the stanceless state.
    """
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    juncture.write_pilot({"name": "kvothe", "objective": "fill the hold",
                          "stance": "Prospector", "mood": "Focused", "goal": "three loads"})
    asked: list[tuple[str, dict]] = []

    def fake_call(action, params=None, on_line=None):
        asked.append((action, params or {}))
        if action == "rest":
            # What the bridge answers: it has already written the record.
            record = juncture.read_pilot()
            record.pop("goal", None)
            record.update(goal=params["goal"], stance=params["stance"], mood=params["mood"])
            juncture.write_pilot(record)
            return {"rested": True, "shift_ended": True,
                    "opened": {k: params[k] for k in ("goal", "stance", "mood")}}
        return {}

    monkeypatch.setattr(spacemolt, "call", fake_call)
    monkeypatch.setattr(spacemolt, "ensure_juncture_job", lambda: {"id": "job-1"})
    monkeypatch.setattr("cron.jobs.trigger_job", lambda _id: None)

    said = spacemolt._reflect({"goal": "walk a price circuit", "stance": "Scout", "mood": "Cautious"})

    assert any(action == "rest" for action, _ in asked), (
        f"reflection never rested the pilot: {asked}")
    assert "Nothing written" not in said, said
    assert juncture.read_pilot()["stance"] == "Scout"
    assert juncture.read_pilot()["mood"] == "Cautious"
    assert juncture.read_pilot()["objective"] == "fill the hold", "the objective was lost with the shift"


def test_a_run_that_ends_adrift_cannot_rest_and_the_shift_carries(tmp_path, monkeypatch):
    """Rest needs a base, and that is a normal outcome rather than a fault.

    A run that ends in open space cannot put the evening down, so the stance carries and the next
    juncture continues the shift. The pilot has to be told that in those terms — a silent refusal
    reads as something it did wrong, and it would try again instead of getting on with the shift.
    """
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    juncture.write_pilot({"name": "kvothe", "objective": "fill the hold",
                          "stance": "Prospector", "mood": "Focused", "goal": "three loads"})
    monkeypatch.setattr(spacemolt, "call", lambda action, params=None, on_line=None: {
        "rested": False, "reason": "rest happens docked at a base; dock to end the shift"})
    monkeypatch.setattr(spacemolt, "ensure_juncture_job", lambda: {"id": "job-1"})

    said = spacemolt._reflect({"goal": "walk a price circuit", "stance": "Scout", "mood": "Cautious"})

    assert juncture.read_pilot()["stance"] == "Prospector", "the shift was ended without resting"
    assert juncture.read_pilot()["goal"] == "three loads"
    assert "dock" in said.lower(), said
    # Said as a continuation, not as an error the pilot should retry.
    assert "carries" in said.lower() or "continues" in said.lower(), (
        f"the refusal does not tell the pilot the shift simply carries on: {said}")
