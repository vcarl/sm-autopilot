"""Native Hermes plugin for the direct SpaceMolt execution host."""
from __future__ import annotations

from pathlib import Path

from .cli import spacemolt_command, register_cli
from .service import TOOL_DEFINITIONS, close_services

_PROMPT = """SpaceMolt is a live game capability. Use its high-level tools only: observe before planning; choose stance, mood, objective and home from observations; treat tool receipts as the only proof of success. A plan takes effect in the next session. Tired/stop immediately suspends productive work while scripts own return, servicing, obligations and reconciliation. Never claim money, delivery, safety or cleanup without the returned receipt."""


def register(ctx) -> None:
    """Register stable high-level tools; game mechanics remain in the bridge scripts."""
    for definition in TOOL_DEFINITIONS:
        ctx.register_tool(**definition)
    root = Path(__file__).resolve().parent
    for skill in ("spacemolt-operations", "spacemolt-hunt", "spacemolt-industry", "spacemolt-logistics"):
        path = root / "skills" / skill / "SKILL.md"
        if path.exists():
            ctx.register_skill(skill, path, description=f"SpaceMolt {skill.removeprefix('spacemolt-')} guidance")
    ctx.register_system_prompt_section("spacemolt.operations", _PROMPT, position="after_memory", max_chars=1200)
    ctx.register_cli_command(
        name="spacemolt", help="Configure and manage the direct SpaceMolt player",
        setup_fn=register_cli, handler_fn=spacemolt_command,
        description="Install Node dependencies, inspect the gateway-owned SpaceMolt controller, or request Tired.",
    )
    ctx.register_command("spacemolt", lambda raw: "Use the spacemolt tools for game work, or `hermes spacemolt status` for controller status.", description="Show SpaceMolt control guidance")
    ctx.on_unload(close_services)
