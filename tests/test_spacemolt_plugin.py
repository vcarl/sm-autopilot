"""Direct native-plugin contracts for the SpaceMolt Hermes boundary."""
from __future__ import annotations

import json
from pathlib import Path
import shutil


def test_service_owns_one_bridge_and_handoffs_plans_to_the_next_session(monkeypatch, tmp_path):
    from spacemolt import service as service_mod

    calls, created = [], []

    class Bridge:
        def __init__(self, **kwargs):
            created.append(kwargs)
            self.process = type("Process", (), {"pid": 42})()

        def request(self, action, arguments):
            calls.append((action, arguments))
            responses = {
                "execution/configure": {"context": {"stance": "Logistics", "mood": "Focused", "objective": "one job"}},
                "job/observe": {"state": {"credits": 10}},
                "job/plan": {"status": "handoff_required"},
                "execution/handoff": {"context": {"stance": "Industry", "mood": "Focused", "objective": "one job"}},
                "job/assess": {"status": "assessed"},
            }
            return {"ok": True, "result": responses[action]}

        def signal_stop(self, reason):
            calls.append(("control/stop", {"reason": reason}))

        def close(self):
            calls.append(("close", {}))

    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service_mod.shutil, "which", lambda name: "/node" if name == "node" else None)
    monkeypatch.setattr(service_mod, "BridgeClient", Bridge)
    service = service_mod.SpaceMoltService(tmp_path / "profile")

    planned = service.call("plan", {"stance": "Industry", "objective": "one job"}, session_id="old")
    blocked = service.call("assess", {"kind": "freight"}, session_id="old")
    resumed = service_mod.SpaceMoltService(service.home)
    assert resumed.call("assess", {"kind": "freight"}, session_id="old")["status"] == "handoff_required"
    assessed = service.call("assess", {"kind": "freight"}, session_id="new")
    stopped = service.call("stop", {"reason": "Tired"}, session_id="old")

    assert planned["next_session_required"] is True
    assert planned["observed"]["state"]["credits"] == 10
    assert blocked["status"] == "handoff_required"
    assert assessed["status"] == "assessed"
    assert stopped == {"status": "stop_requested", "reason": "Tired"}
    assert len(created) == 1
    assert [action for action, _ in calls] == [
        "execution/configure", "job/observe", "job/plan", "execution/handoff", "job/assess", "control/stop",
    ]
    assert json.loads((service.runtime / "service-context.json").read_text())["stance"] == "Industry"
    assert len(created) == 1


def test_native_plugin_registers_static_high_level_tools_through_real_registry(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from model_tools import get_tool_definitions
    from spacemolt import register

    manager = PluginManager()
    register(PluginContext(PluginManifest(name="spacemolt"), manager))
    definitions = get_tool_definitions(enabled_toolsets=["spacemolt"], quiet_mode=True,
                                      skip_tool_search_assembly=True)
    names = {entry["function"]["name"] for entry in definitions}

    assert {"spacemolt_observe", "spacemolt_plan", "spacemolt_transport", "spacemolt_hunt", "spacemolt_gather", "spacemolt_stop"} <= names
    plan = next(entry["function"] for entry in definitions if entry["function"]["name"] == "spacemolt_plan")
    assert set(plan["parameters"]["properties"]) >= {"stance", "mood", "objective", "home_base_id"}
    prompt = manager._system_prompt_sections["spacemolt.operations"].content
    assert all(name in prompt for name in names)


def test_profile_plugin_discovery_loads_the_packaged_direct_toolset(monkeypatch, tmp_path):
    import yaml
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginManager
    from model_tools import get_tool_definitions

    home = tmp_path / "hermes-home"
    packaged = home / "plugins" / "spacemolt"
    shutil.copytree(Path(__file__).parents[1] / "spacemolt", packaged,
                    ignore=shutil.ignore_patterns("node_modules", "runtime", "__pycache__"))
    home.mkdir(exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump({"plugins": {"enabled": ["spacemolt"]}}))
    monkeypatch.setenv("HERMES_HOME", str(home))
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setattr(plugins_mod, "get_bundled_plugins_dir", lambda: bundled)

    manager = PluginManager()
    manager.discover_and_load()
    definitions = get_tool_definitions(enabled_toolsets=["spacemolt"], quiet_mode=True,
                                      skip_tool_search_assembly=True)

    assert manager._plugins["spacemolt"].enabled is True
    assert {entry["function"]["name"] for entry in definitions} >= {"spacemolt_observe", "spacemolt_reconcile"}


def test_chat_is_gated_and_surfaced_exactly_like_its_sibling_game_tools(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from model_tools import get_tool_definitions
    from spacemolt import register
    from spacemolt.service import TOOL_DEFINITIONS

    by_name = {entry["name"]: entry for entry in TOOL_DEFINITIONS}
    chat, sibling = by_name["spacemolt_chat"], by_name["spacemolt_observe"]

    assert chat["toolset"] == sibling["toolset"]
    assert chat["requires_env"] == sibling["requires_env"]
    assert chat["check_fn"]() == sibling["check_fn"]()

    manager = PluginManager()
    register(PluginContext(PluginManifest(name="spacemolt"), manager))
    names = {entry["function"]["name"] for entry in get_tool_definitions(
        enabled_toolsets=["spacemolt"], quiet_mode=True, skip_tool_search_assembly=True)}

    assert ("spacemolt_chat" in names) == ("spacemolt_observe" in names)
    assert "spacemolt_chat" in manager._system_prompt_sections["spacemolt.operations"].content


def test_chat_routes_to_inbox_without_content_and_to_send_with_content(monkeypatch, tmp_path):
    from spacemolt import service as service_mod

    calls = []

    class Bridge:
        def __init__(self, **kwargs):
            self.process = type("Process", (), {"pid": 42})()

        def request(self, action, arguments):
            calls.append((action, arguments))
            return {"ok": True, "result": {"messages": []} if action == "social/inbox" else {"sent": True}}

        def close(self):
            pass

    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service_mod.shutil, "which", lambda name: "/node" if name == "node" else None)
    monkeypatch.setattr(service_mod, "BridgeClient", Bridge)
    service = service_mod.SpaceMoltService(tmp_path / "profile")

    read = service.call("chat", {"target": "local", "limit": 5})
    sent = service.call("chat", {"target": "private", "target_id": "pilot-1", "content": "docking in five"})

    assert read == {"messages": []}
    assert sent == {"sent": True}
    assert [action for action, _ in calls if action.startswith("social/")] == ["social/inbox", "social/send"]


def test_cross_process_stop_writes_control_without_creating_a_bridge(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    from spacemolt.service import persisted_status, request_stop

    result = request_stop("Wind down")

    assert result["status"] == "stop_requested"
    assert json.loads((tmp_path / "hermes-home" / "spacemolt" / "control.json").read_text()) == {"reason": "Wind down"}
    assert persisted_status()["connected"] is False


def test_multiplexed_service_uses_only_the_active_profile_credential(monkeypatch, tmp_path):
    from agent.secret_scope import reset_secret_scope, set_multiplex_active, set_secret_scope
    from spacemolt import service as service_mod

    inherited = tmp_path / "inherited.txt"
    scoped = tmp_path / "scoped.txt"
    inherited.write_text("Username: inherited\nPassword: inherited\n")
    scoped.write_text("Username: scoped\nPassword: scoped\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(inherited))
    captured = []

    class Bridge:
        def __init__(self, **kwargs):
            captured.append(kwargs["env"]["SPACEMOLT_CREDENTIALS_FILE"])
            self.process = type("Process", (), {"pid": 42})()

        def request(self, action, arguments):
            return {"ok": True, "result": {"state": {}}}

        def close(self):
            pass

    monkeypatch.setattr(service_mod, "BridgeClient", Bridge)
    monkeypatch.setattr(service_mod.shutil, "which", lambda name: "/node" if name == "node" else None)
    set_multiplex_active(True)
    try:
        assert service_mod.credentials_configured() is False
        token = set_secret_scope({"SPACEMOLT_CREDENTIALS_FILE": str(scoped)})
        try:
            result = service_mod.SpaceMoltService(tmp_path / "profile").call("observe", {})
        finally:
            reset_secret_scope(token)
        assert result == {"state": {}}
        assert captured == [str(scoped)]
    finally:
        set_multiplex_active(False)
