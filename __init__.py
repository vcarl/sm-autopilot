"""Native Hermes plugin for the direct SpaceMolt execution host."""
from __future__ import annotations

from pathlib import Path

from .cli import spacemolt_command, register_cli
from .service import TOOL_DEFINITIONS, close_services

_PROMPT = """SpaceMolt is a live game capability. Its only game tools are spacemolt_observe, spacemolt_plan, spacemolt_assess, spacemolt_prepare, spacemolt_transport, spacemolt_track, spacemolt_hunt, spacemolt_gather, spacemolt_produce, spacemolt_return, spacemolt_reconcile, and spacemolt_stop. Observe before planning; choose stance, mood, objective and home from observations; treat tool receipts as the only proof of success. A plan takes effect in the next session. Tired/stop immediately suspends productive work while scripts own return, servicing, obligations and reconciliation. Never claim money, delivery, safety or cleanup without the returned receipt. The world is shared and realtime: it advances on ten-second server ticks whether or not you act, and other pilots and wildlife act while you think. Travel, combat and production occupy real time, so a tool call can run for minutes; that is the world moving, not a hang. Every observation is a decaying snapshot and IDs in it can expire, so re-observe after any wait instead of reasoning from an earlier reading."""


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
