"""Make the play library's READMEs loadable as skills by the bare names a juncture fire lists.

The root ``src/play/README.md`` is the shared skill ``spacemolt``; each career folder's README
is ``spacemolt-<folder>`` (``spacemolt-mining`` …), the one a stance's fire carries. Cron's skill
loader looks each name up with ``skill_view(<bare name>)`` in the profile's skills dir, so a
directory per skill is made there with ``SKILL.md`` linked to the README: one copy of the
text, in the plugin, beside the code it documents.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("spacemolt")


def readme_skills(root: Path) -> dict[str, Path]:
    """Skill name → README path, for the root and every career folder that has one."""
    play = Path(root) / "src" / "play"
    skills = {"spacemolt": play / "README.md"}
    for readme in sorted(play.glob("*/README.md")):
        skills[f"spacemolt-{readme.parent.name}"] = readme
    return {name: path for name, path in skills.items() if path.is_file()}


def register_skills(ctx, root: Path) -> list[str]:
    """Register every README skill and link it into the profile's skills dir. Returns the
    names now resolvable by bare name."""
    from hermes_constants import get_skills_dir

    linked: list[str] = []
    skills_dir = get_skills_dir()
    for name, readme in readme_skills(root).items():
        ctx.register_skill(name, readme)
        home = skills_dir / name
        link = home / "SKILL.md"
        if link.is_symlink() and link.readlink() == readme:
            linked.append(name)
            continue
        if link.exists() or link.is_symlink():
            logger.warning("Not linking skill %s: %s already exists", name, link)
            continue
        # The SKILL.md-era layout linked the whole directory into the plugin; once that target
        # was deleted, mkdir on the dangling link raised and took every registration with it.
        if home.is_symlink() and not home.exists():
            home.unlink()
        home.mkdir(parents=True, exist_ok=True)
        link.symlink_to(readme)
        linked.append(name)
    return linked
