"""The other half of a shift: a fire that lands on a pilot at rest reflects instead of choosing.

Rest is the bridge's act and is proved in ``spacemolt/src/rest.test.ts``. What is proved here
is the runner's half of reflection (N7, N8, N12): the fire's context is the report and not the
menu, the choice writes the record and hands the new stance its own conversation, the choice is
refused while a stance is held, and a bounded objective already done offers nothing at all.
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
    assert jobs[0]["skills"] == ["spacemolt", "spacemolt-carrier"]
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


def test_a_bounded_objective_already_done_offers_nothing_and_waits_for_the_operator(bridged):
    juncture.write_pilot({"name": "kvothe", "home": "sol_base", "objective": "pay off the debt"})
    spacemolt._reflect({"objective_done": True})
    assert juncture.read_pilot()["objective_done"] is True

    context = juncture.juncture_context({"platform": "cron"})
    assert "pay off the debt" in context and "done" in context
    assert "stagnation" not in context, "a finished objective is not reflected on again"
    assert "end the turn" in context

    # The operator naming a new objective is what wakes it; nothing else does.
    spacemolt._direct({"objective": "reach a trusted carrier tier"})
    assert "objective_done" not in juncture.read_pilot()
