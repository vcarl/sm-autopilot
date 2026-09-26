"""Make the play library's READMEs loadable as skills, by the names a juncture fire lists.

The root ``src/play/README.md`` is ``spacemolt:play`` — the base skill every stance loads, and
what the library itself is — and each career folder's README is ``spacemolt:<folder>``
(``spacemolt:mining`` …), the one a stance's fire carries. ``ctx.register_skill`` puts each
under the plugin's own namespace, and cron resolves a namespaced name through the plugin
registry, so nothing is copied or linked into the profile's skills directory: one copy of the
text, in the plugin, beside the code it documents.
"""
from __future__ import annotations

from pathlib import Path

#: The namespace ``ctx.register_skill`` puts these under: the plugin's name, which is this
#: package's name. ``plugin.yaml`` sets no ``skill_namespace``, so the manifest name is it.
NAMESPACE = __package__ or "spacemolt"
#: The base skill's name. Not ``spacemolt``: under the namespace that reads ``spacemolt:spacemolt``,
#: and what the README documents is the play library, which is how the pilot plays.
SHARED_SKILL = "play"


def qualified(name: str) -> str:
    """The name a cron job lists, which is how a plugin skill is looked up."""
    return f"{NAMESPACE}:{name}"


def readme_skills(root: Path) -> dict[str, Path]:
    """Skill name → README path, for the library root and every career folder that has one."""
    play = Path(root) / "src" / "play"
    skills = {SHARED_SKILL: play / "README.md"}
    for readme in sorted(play.glob("*/README.md")):
        skills[readme.parent.name] = readme
    return {name: path for name, path in skills.items() if path.is_file()}


def register_skills(ctx, root: Path) -> list[str]:
    """Register every README skill. Returns the namespaced names a fire can name."""
    names = []
    for name, readme in readme_skills(root).items():
        ctx.register_skill(name, readme)
        names.append(qualified(name))
    return names
