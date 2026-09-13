"""Install and preload only guidance supported by a session's immutable grant."""
import json
from pathlib import Path


_NATIVE_TO_JOB_ACTION = {
    "spacemolt_observe": "observe",
    "spacemolt_plan": "plan",
    "spacemolt_assess": "assess",
    "spacemolt_prepare": "prepare",
    "spacemolt_transport": "transport",
    "spacemolt_track": "track",
    "spacemolt_hunt": "hunt",
    "spacemolt_gather": "gather",
    "spacemolt_produce": "produce",
    "spacemolt_return": "return_to_base",
}


def session_skills(context, catalog, home, resume=False):
    from tools.skills_tool import skill_view
    names = ["spacemolt-operations"]
    stance_skill = {"Hunt": "spacemolt-hunt", "Industry": "spacemolt-industry", "Logistics": "spacemolt-logistics"}.get(context["stance"])
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
                    native_name = line.removeprefix("## Tool: ")
                    action = _NATIVE_TO_JOB_ACTION.get(native_name)
                    include = not line.startswith("## Tool: ") or action in catalog
                if include:
                    for native_name, action in _NATIVE_TO_JOB_ACTION.items():
                        line = line.replace(native_name, "job__" + action)
                    lines.append(line)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("\n".join(lines) + "\n")
        result = json.loads(skill_view(name, preprocess=False))
        if not result.get("success"):
            raise RuntimeError(f"Could not preload {name}: {result}")
        loaded.append(result["content"])
    return "\n\n".join(loaded)
