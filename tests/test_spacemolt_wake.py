"""The runner raises the next juncture when a run ends (N4).

The bridge is Node and the cron jobs file is held by a cross-process lock only Python takes,
so the wake is a Python one-shot the bridge spawns. This exercises the real path: the argv
and the environment ``service.py`` hands the bridge, run as its own process against a temp
``HERMES_HOME``.
"""
from __future__ import annotations

import os
import subprocess

from cron import jobs as cron_jobs
from spacemolt import juncture, service


def _wake() -> subprocess.CompletedProcess[str]:
    return subprocess.run(service.wake_argv(), env={**os.environ, **service.wake_env()},
                          capture_output=True, text=True, timeout=120)


def test_the_wake_marks_the_pilots_juncture_due():
    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused"})
    done = _wake()
    assert done.returncode == 0, done.stderr
    job, = cron_jobs.load_jobs()
    assert job["name"] == juncture.job_name(juncture.read_pilot())
    assert job["next_run_at"] is not None and job["state"] == "scheduled"
    assert juncture.JUNCTURE_PROMPT in job["prompt"]


def test_a_wake_with_no_pilot_record_says_so_and_writes_no_job():
    assert cron_jobs.load_jobs() == []
    done = _wake()
    assert done.returncode != 0
    assert "no pilot record" in done.stderr
    assert cron_jobs.load_jobs() == [], "nothing to wake is not a pilot to invent"
