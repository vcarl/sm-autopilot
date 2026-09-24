"""The other half of a shift: a fire that lands on a pilot at rest reflects instead of choosing.

Rest is the bridge's act and is proved in ``spacemolt/src/rest.test.ts``. What is proved here
is the runner's half of reflection (N7, N8, N12): the fire's context is the report and not the
menu, the choice writes the record and hands the new stance its own conversation, the choice is
refused while a stance is held, and every reflection that writes anything leaves a goal and a
stance behind — a finished operator objective is retired by one, never waited out.
"""
from __future__ import annotations

import json
import sys

import pytest

import spacemolt
from spacemolt import juncture, service

# A bridge that answers the two reads a resting fire makes. Nothing here writes the pilot
# record: at rest that is the runner's own job, in Python, beside the cron job it rewrites.
FAKE_BRIDGE = '''
import json, os, sys
from pathlib import Path

PILOT = Path(os.environ["SPACEMOLT_RUNTIME_DIR"]).parent / "pilot.json"

def pilot():
    try:
        return json.loads(PILOT.read_text())
    except Exception:
        return {}

REFLECT = {"at_rest": True, "objective": "reach a trusted carrier tier",
           "skills": [{"name": "gunnery", "level": 1, "max_level": 5},
                      {"name": "weapons", "level": 3, "max_level": 5, "was": 1,
                       "since": "2026-09-22T10:00:00Z"}],
           "ship": {"fuel": 120, "max_fuel": 120, "hull": 100, "max_hull": 100,
                    "cargo_capacity": 12, "modules": ["mining_laser"]},
           "holdings": {"credits": 4000, "storage": [{"base_id": "sol_base", "items": 2, "ships": 1}]},
           "owes": {"tax_due": 40, "shipping_debt": 0},
           "seen": {"systems_and_pois": ["sol/belt"], "bases": ["sol_base"]},
           "recent": [{"chain_id": "chain-7", "outcome": "done"}],
           "stagnation": ["every job in the journal's span was gather (7 of them)",
                          "stances never chosen: Trader, Scout"],
           "stances": [{"name": "Carrier", "initial_moods": ["Cautious", "Focused"]}],
           "missing": []}
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    action = request["action"]
    if action in ("menu", "reflect"):
        # No stance in the record, so the menu the fire asks for is the reflection — and the
        # report carries the operator's objective and whether it has been declared done.
        who = pilot()
        result = {**REFLECT, **{key: who[key] for key in ("objective", "objective_done") if key in who}}
    else:
        result = {"unexpected": action}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
'''


@pytest.fixture
def bridged(tmp_path, monkeypatch):
    stub = tmp_path / "fake_bridge.py"
    stub.write_text(FAKE_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    yield
    service.close_bridge()


def test_a_fire_at_rest_reflects_and_the_choice_opens_the_next_stances_own_conversation(bridged):
    from cron import jobs as cron_jobs

    juncture.write_pilot({"name": "kvothe", "home": "sol_base", "permissions": {"wildlife": False},
                          "objective": "reach a trusted carrier tier"})
    juncture.ensure_juncture_job()

    # No stance, so no menu: the fire is given what rest exists to think about.
    context = juncture.juncture_context({"platform": "cron"})
    assert "stances never chosen" in context, "the stagnation signals reach reflection (N9)"
    assert "reach a trusted carrier tier" in context, "reflection is subordinate to the objective"
    assert "J1 Hold full of ore" not in context, "a resting pilot is offered no stance work"
    assert len(context) < 4000, "the report fits the fire's own context budget"

    answer = spacemolt._reflect({"goal": "run freight until the tier moves",
                                 "stance": "Carrier", "mood": "Cautious"})
    assert "Carrier" in answer and "Cautious" in answer

    # The record carries the shift, and keeps what was never the pilot's to change.
    record = juncture.read_pilot()
    assert (record["stance"], record["mood"]) == ("Carrier", "Cautious")
    assert record["goal"] == "run freight until the tier moves"
    assert record["objective"] == "reach a trusted carrier tier"
    assert record["permissions"] == {"wildlife": False}

    # A stance change is a handoff (N12): the one job now carries the new stance's skills and
    # is due on the next tick, so the shift starts in a conversation this one never touches.
    jobs = cron_jobs.load_jobs()
    assert len(jobs) == 1, "one cron job per pilot; reflection rewrites it, never adds one"
    assert jobs[0]["skills"] == ["spacemolt", "spacemolt-hauling"]
    assert jobs[0]["enabled_toolsets"] == ["spacemolt", "spacemolt_observe"], "the toolset is fixed"
    assert cron_jobs.get_job(jobs[0]["id"]).get("manual_run_at"), \
        "the new stance's first juncture is due on the next tick, not waited out"

    # And the reflection is written down, as every change the runner makes to itself is.
    entries = [json.loads(line) for line in
               (service.runtime_dir() / juncture.JOURNAL_FILE).read_text().splitlines() if line.strip()]
    assert {"event": "reflection", "goal": "run freight until the tier moves",
            "stance": "Carrier", "mood": "Cautious"}.items() <= entries[-1].items()


def test_a_stance_already_held_refuses_the_choice(bridged):
    juncture.write_pilot({"name": "kvothe", "home": "sol_base", "stance": "Prospector",
                          "mood": "Focused", "goal": "three loads of ore"})

    refused = spacemolt._reflect({"goal": "something else", "stance": "Hunter", "mood": "Aggressive"})
    assert "Prospector" in refused and "rest" in refused
    # Nothing moved: a stance is changed by resting first, never by choosing over the top of one.
    assert juncture.read_pilot()["stance"] == "Prospector"
    assert juncture.read_pilot()["goal"] == "three loads of ore"


def test_a_reflection_that_names_no_goal_or_stance_writes_nothing(bridged):
    """The live deadlock (2026-09-24): ``objective_done`` on its own was accepted, the record kept
    ``goal: null`` and ``stance: null``, and every juncture after it read the same finished
    objective and did the same nothing. There is no reflection that ends uncommitted."""
    juncture.write_pilot({"name": "kvothe", "objective": "pay off the debt"})

    refused = spacemolt._reflect({"objective_done": True})
    assert "Nothing written" in refused
    record = juncture.read_pilot()
    assert "goal" not in record and "stance" not in record
    assert record["objective"] == "pay off the debt", "an unresolved objective is not retired"
    assert "objective_done" not in record, "no flag survives a reflection that wrote nothing"


def test_a_finished_objective_is_retired_by_the_reflection_that_opens_the_next_shift(bridged):
    """Fault 2: ``objective_done`` used to be recorded beside the objective it finished, so every
    juncture re-reported the same completion. It is resolved exactly once, by the shift that
    replaces it, and the pilot needs no operator to get there."""
    juncture.write_pilot({"name": "kvothe", "objective": "pay off the debt"})

    # A pilot whose objective is done still leaves rest holding a shift of its own.
    answer = spacemolt._reflect({"goal": "raise gunnery two levels", "stance": "Hunter",
                                "mood": "Focused", "objective_done": True})
    assert "pay off the debt" in answer and "retired" in answer
    record = juncture.read_pilot()
    assert (record["goal"], record["stance"], record["mood"]) == \
        ("raise gunnery two levels", "Hunter", "Focused")
    assert "objective" not in record and "objective_done" not in record, \
        "the finished objective cannot be reported a second time: it is gone"
    assert record["objective_completed"] == "pay off the debt", "what was finished is kept"

    entries = [json.loads(line) for line in
               (service.runtime_dir() / juncture.JOURNAL_FILE).read_text().splitlines() if line.strip()]
    assert {"event": "reflection", "objective_done": True, "objective": "pay off the debt",
            "stance": "Hunter"}.items() <= entries[-1].items()


def test_a_stale_flag_and_a_repeated_one_both_clear_on_the_same_write(bridged):
    """`or` short-circuits: a pilot that passes ``objective_done`` while the record already
    carries it must not leave the stale one behind, or the next wakeup hands the pilot its own
    completion back beside an objective that is already gone."""
    juncture.write_pilot({"name": "kvothe", "objective": "pay off the debt",
                          "objective_done": True})

    spacemolt._reflect({"goal": "raise gunnery two levels", "stance": "Hunter",
                        "mood": "Focused", "objective_done": True})

    record = juncture.read_pilot()
    assert "objective_done" not in record, \
        "the flag the pilot repeated cannot outlive the objective it named"
    assert "objective" not in record and record["objective_completed"] == "pay off the debt"


def test_a_record_left_carrying_objective_done_reflects_instead_of_waiting(bridged):
    """The live record itself: ``objective_done`` already true beside the objective it finished.
    The wakeup asks for a shift rather than telling the pilot to wait for a human, and the next
    reflection retires the objective whether or not the pilot repeats the flag."""
    juncture.write_pilot({"name": "kvothe", "objective": "pay off the debt",
                          "objective_done": True})

    context = juncture.juncture_context({"platform": "cron"})
    assert "spacemolt_reflect" in context and "stagnation" in context, \
        "a finished objective still gets the report a choice is made from"
    assert "The operator sets the next one" not in context, "nothing here waits for the operator"
    assert "objective_done beside the goal" in context

    spacemolt._reflect({"goal": "learn the near systems", "stance": "Scout", "mood": "Cautious"})
    record = juncture.read_pilot()
    assert record["stance"] == "Scout"
    assert "objective" not in record and "objective_done" not in record
    assert record["objective_completed"] == "pay off the debt"


def test_a_rest_fire_carries_the_numbers_the_objective_is_judged_against(bridged):
    """A movement objective ("by 2 levels") is unjudgeable from a level alone. The fire carries each
    skill's level beside what it was, and tells the pilot to read them rather than its memory — the
    live claim of completion was made at weapons 2 of a target of 3, against nothing."""
    juncture.write_pilot({"name": "kvothe", "objective": "raise the lowest by 2 levels"})

    context = juncture.juncture_context({"platform": "cron"})
    assert '"was":1' in context and '"level":3' in context, "the baseline reaches the fire"
    assert "Judge the operator's objective against the numbers" in context
    assert "objective_done beside them if the numbers say" in context
