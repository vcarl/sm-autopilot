"""The play READMEs resolve as skills through the lookup a cron fire uses.

A fire lists bare names (``spacemolt``, ``spacemolt-<folder>``); cron loads each one with
``skill_view``, which searches the profile's skills dir and not the plugin registry.
"""
from __future__ import annotations

from pathlib import Path

from spacemolt.juncture import STANCE_FOLDER, job_fields
from spacemolt.skills_register import readme_skills, register_skills

PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "spacemolt"


class _Ctx:
    """Only the one method register_skills uses."""

    def __init__(self):
        self.registered: list[tuple[str, Path]] = []

    def register_skill(self, name, path, description="", frontmatter=None):
        self.registered.append((name, path))


def _home(tmp_path, monkeypatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def test_every_stance_fire_names_skills_that_exist():
    names = set(readme_skills(PLUGIN_ROOT))
    for stance in STANCE_FOLDER:
        assert set(job_fields({"stance": stance})["skills"]) <= names, stance


def test_cron_loads_every_readme_skill_by_bare_name(tmp_path, monkeypatch):
    _home(tmp_path, monkeypatch)
    names = register_skills(_Ctx(), PLUGIN_ROOT)
    assert sorted(names) == sorted(readme_skills(PLUGIN_ROOT))
    from cron.scheduler_prompt import _load_cron_skill_parts

    body = "\n".join(_load_cron_skill_parts({"id": "j1", "name": "n"}, names))
    assert "could not be found" not in body
    for name, readme in readme_skills(PLUGIN_ROOT).items():
        assert readme.read_text(encoding="utf-8").splitlines()[0] in body, name


def test_a_dangling_link_from_the_old_layout_is_replaced(tmp_path, monkeypatch):
    """A profile whose skills/spacemolt linked into a deleted directory still registers."""
    home = _home(tmp_path, monkeypatch)
    (home / "skills").mkdir()
    (home / "skills" / "spacemolt").symlink_to(tmp_path / "deleted" / "spacemolt")
    assert "spacemolt" in register_skills(_Ctx(), PLUGIN_ROOT)
    assert (home / "skills" / "spacemolt" / "SKILL.md").is_file()


def test_an_unlinked_skill_would_have_been_skipped(tmp_path, monkeypatch):
    """The red half: without register_skills, the same lookup reports the fire's warning."""
    _home(tmp_path, monkeypatch)
    from cron.scheduler_prompt import _load_cron_skill_parts

    parts = _load_cron_skill_parts({"id": "j1", "name": "n"}, ["spacemolt"])
    assert "could not be found" in "\n".join(parts)
