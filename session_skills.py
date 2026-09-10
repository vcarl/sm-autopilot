"""Install and preload only guidance supported by a session's immutable grant."""
import json
from pathlib import Path


def session_skills(context, catalog, home, resume=False):
    from tools.skills_tool import skill_view
    names = ["spacemolt-operations"]
    stance_skill = {"Hunt": "spacemolt-hunt", "Industry": "spacemolt-industry"}.get(context["stance"])
    if stance_skill:
        names.append(stance_skill)
    loaded = []
    for name in names:
        destination = home / "skills" / name / "SKILL.md"
        if not resume or not destination.exists():
            source = (Path(__file__).parent / "skills" / name / "SKILL.md").read_text()
            lines, include = [], True
            for line in source.splitlines():
                if line.startswith("## "):
                    include = not line.startswith("## Tool: ") or line.removeprefix("## Tool: job__") in catalog
                if include:
                    lines.append(line)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("\n".join(lines) + "\n")
        result = json.loads(skill_view(name, preprocess=False))
        if not result.get("success"):
            raise RuntimeError(f"Could not preload {name}: {result}")
        loaded.append(result["content"])
    return "\n\n".join(loaded)
