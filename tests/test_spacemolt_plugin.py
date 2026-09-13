"""Direct native-plugin contracts for the SpaceMolt Hermes boundary."""
from __future__ import annotations

import json
from pathlib import Path
import shutil


def test_native_plan_applies_handoff_and_continues_in_the_same_conversation(monkeypatch, tmp_path):
    from spacemolt import service as service_mod
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from model_tools import get_tool_definitions, handle_function_call
    from spacemolt import register
    from spacemolt.runner import BridgeClient

    source = Path(__file__).parents[1] / "spacemolt" / "src"
    fixture = tmp_path / "native-handoff-host.ts"
    fixture.write_text(
        "import {createInterface} from 'node:readline';\n"
        f"import {{gatherFixture}} from {json.dumps((source / 'gather-fixture.ts').as_uri())};\n"
        f"import {{ExecutionHost}} from {json.dumps((source / 'execution-host.ts').as_uri())};\n"
        "const cleanup=[];const f=gatherFixture({after:fn=>cleanup.push(fn)});\n"
        "const host=new ExecutionHost(f.account,f.directory,f.execution.deps);\n"
        "console.log(JSON.stringify({event:'ready'}));\n"
        "for await(const line of createInterface({input:process.stdin})) {\n"
        " const r=JSON.parse(line);\n"
        " if(r.action==='control/stop')continue;\n"
        " try {console.log(JSON.stringify({id:r.id,ok:true,result:await host.dispatch(r.action,r.params)}));}\n"
        " catch(error){console.log(JSON.stringify({id:r.id,ok:false,error:error.message,policy_decision:error.decision}));}\n"
        "}\n"
        "for(const fn of cleanup)fn();\n"
    )

    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service_mod.shutil, "which", lambda name: "/node" if name == "node" else None)
    monkeypatch.setattr(service_mod, "BridgeClient", lambda **kwargs: BridgeClient(["node", str(fixture)], timeout=10))
    service = service_mod.SpaceMoltService(tmp_path / "profile")
    monkeypatch.setattr(service_mod, "service", lambda: service)
    manager = PluginManager()
    register(PluginContext(PluginManifest(name="spacemolt"), manager))
    definitions = get_tool_definitions(enabled_toolsets=["spacemolt"], quiet_mode=True,
                                       skip_tool_search_assembly=True)
    prompt = manager._system_prompt_sections["spacemolt.operations"].content

    def call(name, arguments):
        schema = next(entry["function"]["parameters"] for entry in definitions
                      if entry["function"]["name"] == name)
        assert arguments.keys() <= schema["properties"].keys()
        return json.loads(handle_function_call(name, arguments, session_id="discord-thread",
                                               enabled_toolsets=["spacemolt"]))

    try:
        planned = call("spacemolt_plan", {"stance": "Industry", "objective": "Gather one local ore cycle",
                                           "home_base_id": "base", "home_rationale": "Nearby services and storage"})
        assessed = call("spacemolt_assess", {"poi_id": "belt"})
        gathered = call("spacemolt_gather", {"poi_id": "belt", "cycles": 1})
        changed = call("spacemolt_plan", {"objective": "Gather another local ore cycle"})
        repeated = call("spacemolt_gather", {"poi_id": "belt", "cycles": 1})

        assert planned["status"] == "applied"
        assert planned["plan"]["status"] == "applied"
        assert planned["execution_handoff"] == {"status": "completed", "continuation": "current_conversation"}
        assert planned["context"]["stance"] == "Industry"
        assert "next_session_required" not in planned
        assert assessed["status"] == "ready_to_verify_resources"
        assert gathered["status"] == "completed"
        assert gathered["result"]["gather"]["cycles_completed"] == 1
        assert gathered["result"]["gather"]["yields"] == {"ore": 2}
        assert sum(action["action"] == "spacemolt/mine" for action in gathered["actions"]) == 1
        assert changed["status"] == "denied"
        assert repeated["status"] == "denied"
        assert repeated["policy_decision"]["allowed"] is False
        assert any(reason["denied"] for reason in repeated["policy_decision"]["reasons"])
        assert json.loads((service.runtime / "service-context.json").read_text())["stance"] == "Industry"
        assert get_tool_definitions(enabled_toolsets=["spacemolt"], quiet_mode=True,
                                    skip_tool_search_assembly=True) == definitions
        assert manager._system_prompt_sections["spacemolt.operations"].content == prompt
    finally:
        service.close()


def test_legacy_pending_handoff_resumes_persisted_context_without_starting_a_new_run(monkeypatch, tmp_path):
    from spacemolt import service as service_mod

    calls = []

    class Bridge:
        def __init__(self, **kwargs):
            self.process = type("Process", (), {"pid": 42})()

        def request(self, action, arguments):
            calls.append((action, arguments))
            results = {
                "execution/configure": {"context": arguments},
                "job/assess": {"status": "assessed"},
                "job/gather": {"status": "completed"},
            }
            return {"ok": True, "result": results[action]}

    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: fixture\nPassword: fixture\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service_mod.shutil, "which", lambda name: "/node" if name == "node" else None)
    monkeypatch.setattr(service_mod, "BridgeClient", Bridge)
    runtime = tmp_path / "profile" / "spacemolt"
    runtime.mkdir(parents=True)
    context = {"stance": "Industry", "mood": "Focused", "objective": "one job", "stop_condition": "one_job"}
    (runtime / "service-context.json").write_text(json.dumps(context))
    pending = runtime / "pending-handoff.json"
    pending.write_text(json.dumps({"session_id": "discord-thread"}))

    resumed = service_mod.SpaceMoltService(tmp_path / "profile")
    assessed = resumed.call("assess", {"kind": "gathering"}, session_id="discord-thread")
    gathered = resumed.call("gather", {"poi_id": "belt"}, session_id="discord-thread")

    assert assessed["status"] == "assessed"
    assert gathered["status"] == "completed"
    assert calls[0][0] == "execution/configure"
    assert calls[0][1]["objective"] == "one job"
    assert calls[0][1]["stop_condition"] == "one_job"
    assert "new_run" not in calls[0][1]
    assert not pending.exists()


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
