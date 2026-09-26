"""The play READMEs resolve as skills through the lookup a cron fire uses.

A fire lists namespaced names (``spacemolt:play``, ``spacemolt:<folder>``); the plugin registers
them and cron loads each one with ``skill_view``, which dispatches a ``plugin:skill`` name to the
plugin registry. Nothing is linked into the profile's skills directory.

What this has to prove is not that nothing raised. A skill cron cannot resolve is *skipped* with
a log warning — the fire still runs, and the pilot flies with no career knowledge while looking
perfectly healthy. So the assertion is that the README's own text reaches the prompt.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from spacemolt.juncture import STANCE_FOLDER, job_fields
from spacemolt.skills_register import qualified, readme_skills, register_skills

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _private(module: str, *names):
    """Skip rather than fail when a Hermes internal these tests assert *through* has moved.

    ``COMPAT_MANIFEST.md`` is explicit that cron's private names were never a plugin surface, so
    their disappearance is Hermes news, not a SpaceMolt bug — and a red suite that means "the
    host refactored" teaches nothing.
    """
    module_ref = pytest.importorskip(module)
    found = [getattr(module_ref, name, None) for name in names]
    if any(item is None for item in found):
        pytest.skip(f"{module} no longer exposes {', '.join(names)}")
    return found[0] if len(found) == 1 else found


def _cron(name: str):
    """A cron-internal function by name, from whichever module this Hermes keeps it in: newer
    trees split ``cron.scheduler_prompt`` out of ``cron.scheduler``. Skips when neither has it."""
    import importlib
    for module in ("cron.scheduler_prompt", "cron.scheduler", "cron.scheduler_script", "cron.lifecycle_guard"):
        try:
            found = getattr(importlib.import_module(module), name, None)
        except ImportError:
            continue
        if found is not None:
            return found
    pytest.skip(f"no cron module exposes {name}")


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    """A real ``PluginContext`` on a fresh manager: the registration path, not a stand-in, because
    what is under test is that cron's lookup finds what the plugin registered."""
    from hermes_cli import plugins as plugins_mod

    manager = plugins_mod.PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", manager)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    manifest = plugins_mod.PluginManifest(name="spacemolt", version="0.1.0", source="user")
    return plugins_mod.PluginContext(manifest, manager)


def test_every_stance_fire_names_skills_that_exist():
    names = {qualified(name) for name in readme_skills(PLUGIN_ROOT)}
    for stance in STANCE_FOLDER:
        assert set(job_fields({"stance": stance})["skills"]) <= names, stance
    # And the names carry the namespace exactly once: `spacemolt:mining`, never `spacemolt:spacemolt-mining`.
    assert all(name.startswith("spacemolt:") and name.count(":") == 1 for name in names), names


def test_cron_loads_every_readme_skill_by_its_namespaced_name(ctx):
    load = _private("cron.scheduler_prompt", "_load_cron_skill_parts")
    names = register_skills(ctx, PLUGIN_ROOT)
    assert sorted(names) == sorted(qualified(name) for name in readme_skills(PLUGIN_ROOT))

    body = "\n".join(load({"id": "j1", "name": "n"}, names))
    # The text itself, not merely a clean run: a skipped skill is silent and the fire still fires.
    # (No substring check for cron's warning wording — the READMEs contain those words themselves.)
    for name, readme in readme_skills(PLUGIN_ROOT).items():
        assert readme.read_text(encoding="utf-8").splitlines()[0] in body, name


def test_an_unregistered_skill_would_have_been_skipped(ctx):
    """The red half: the same lookup, with nothing registered, reports the fire's own warning —
    which is all a live fire would do, while still running."""
    load = _private("cron.scheduler_prompt", "_load_cron_skill_parts")
    parts = load({"id": "j1", "name": "n"}, [qualified("play")])
    assert "could not be found" in "\n".join(parts) or parts == []


def test_a_fire_carries_the_stances_readme_and_the_base_one_or_the_base_alone(ctx):
    """The stance is how a fire's career text is chosen: its README reaches the prompt cron
    builds, beside the base README; with no stance the base README does. Asserted on the text,
    because cron skips a skill it cannot resolve and fires anyway."""
    build = _cron("_build_job_prompt")
    register_skills(ctx, PLUGIN_ROOT)
    readmes = readme_skills(PLUGIN_ROOT)
    first = lambda name: readmes[name].read_text(encoding="utf-8").splitlines()[0]
    prompt = lambda pilot: build({"id": "j1", "name": "n", **job_fields(pilot, gate=False)},
                                 prerun_script=(True, "No run in flight: the pilot is idle."))
    body = prompt({"stance": "Trader"})
    assert first("play") in body and first("trading") in body
    alone = prompt({})
    assert first("play") in alone and first("trading") not in alone
