"""Make the plugin's own skills loadable by the bare names a juncture fire lists.

``ctx.register_skill`` only serves the qualified ``spacemolt:<name>`` form, and cron's skill
loader looks each name up with ``skill_view(<bare name>)`` — which searches the profile's
skills dir, not the plugin registry. So the directories are linked into
``<HERMES_HOME>/skills/`` as well; the link keeps one copy of the text, in the plugin.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("spacemolt")


def register_skills(ctx, root: Path) -> list[str]:
    """Register every ``<root>/skills/<name>/SKILL.md`` and link it into the profile's
    skills dir. Returns the names now resolvable by bare name."""
    from hermes_constants import get_skills_dir

    linked: list[str] = []
    skills_dir = get_skills_dir()
    for skill_md in sorted(Path(root).glob("skills/*/SKILL.md")):
        source = skill_md.parent
        ctx.register_skill(source.name, skill_md)
        link = skills_dir / source.name
        if link.is_symlink() and link.readlink() == source:
            linked.append(source.name)
            continue
        if link.exists() or link.is_symlink():
            logger.warning("Not linking skill %s: %s already exists", source.name, link)
            continue
        skills_dir.mkdir(parents=True, exist_ok=True)
        link.symlink_to(source, target_is_directory=True)
        linked.append(source.name)
    return linked
