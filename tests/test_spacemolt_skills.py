"""The four juncture skills resolve through the lookup a cron fire uses, and read as skills.

A fire lists bare names (``spacemolt``, ``spacemolt-<stance>``); cron loads each one with
``skill_view``, which searches the profile's skills dir and not the plugin registry. These
tests pin both halves: the bare-name lookup answers, and the frontmatter meets the authoring
standards in ``skills/AGENTS.md``.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from spacemolt.juncture import job_fields
from spacemolt.skills_register import register_skills

PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "spacemolt"
SKILL_NAMES = ["spacemolt", "spacemolt-industrialist", "spacemolt-carrier", "spacemolt-hunter"]
MARKETING = re.compile(r"\b(powerful|comprehensive|seamless|revolutionary|cutting-edge)\b", re.I)


class _Ctx:
    """Only the one method register_skills uses."""

    def __init__(self):
        self.registered: list[tuple[str, Path]] = []

    def register_skill(self, name, path, description="", frontmatter=None):
        self.registered.append((name, path))


@pytest.fixture
def linked(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    ctx = _Ctx()
    names = register_skills(ctx, PLUGIN_ROOT)
    assert sorted(names) == sorted(SKILL_NAMES)
    assert sorted(n for n, _ in ctx.registered) == sorted(SKILL_NAMES)
    return home


def _frontmatter(name: str) -> dict:
    text = (PLUGIN_ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---"), f"{name}: SKILL.md must open with frontmatter"
    end = re.search(r"\n---\s*\n", text[3:])
    assert end, f"{name}: unclosed frontmatter"
    return yaml.safe_load(text[3:end.start() + 3])


def test_a_fire_lists_names_these_skills_answer_to():
    """job_fields names the shared skill plus the stance's; both must be among the four."""
    fields = job_fields({"stance": "Industrialist"})
    assert fields["skills"] == ["spacemolt", "spacemolt-industrialist"]
    assert set(fields["skills"]) <= set(SKILL_NAMES)


def test_cron_loads_every_skill_by_bare_name(linked):
    """The cron loader itself: every name resolves, and nothing lands in the skipped notice."""
    from cron.scheduler_prompt import _load_cron_skill_parts

    parts = _load_cron_skill_parts({"id": "j1", "name": "spacemolt juncture: test"}, SKILL_NAMES)
    body = "\n".join(parts)
    assert "could not be found" not in body
    for name in SKILL_NAMES:
        assert f'The user has invoked the "{name}" skill' in body
    # The content, not just the header: each skill's own title made it into the prompt.
    assert body.count("## Verification") == len(SKILL_NAMES)


def test_an_unlinked_skill_would_have_been_skipped(tmp_path, monkeypatch):
    """The red half: without register_skills, the same lookup reports the fire's warning."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    from cron.scheduler_prompt import _load_cron_skill_parts

    parts = _load_cron_skill_parts({"id": "j1", "name": "n"}, ["spacemolt"])
    assert "could not be found" in "\n".join(parts)


@pytest.mark.parametrize("name", SKILL_NAMES)
def test_frontmatter_meets_the_authoring_standards(name):
    fm = _frontmatter(name)
    missing = [f for f in ("name", "description", "version", "author", "license", "platforms")
               if f not in fm]
    assert not missing, f"{name}: missing frontmatter fields: {missing}"
    assert fm["name"] == name, f"{name}: frontmatter name {fm['name']!r} != directory"
    description = str(fm["description"])
    assert len(description) <= 60, f"{name}: description is {len(description)} chars (hardline 60)"
    assert description.endswith("."), f"{name}: description must end with a period"
    assert not MARKETING.search(description), f"{name}: marketing word in description"
    hermes = (fm.get("metadata") or {}).get("hermes") or {}
    assert hermes.get("tags"), f"{name}: no metadata.hermes.tags"
    dangling = [r for r in (hermes.get("related_skills") or []) if r not in SKILL_NAMES]
    assert not dangling, f"{name}: dangling related_skills: {dangling}"


@pytest.mark.parametrize("name", SKILL_NAMES)
def test_skill_stays_under_the_size_budget(name):
    size = (PLUGIN_ROOT / "skills" / name / "SKILL.md").stat().st_size
    assert size < 6144, f"{name}: {size} bytes — a preloaded skill stays under 6 KB"
