"""Cache-safe Hermes sessions for the bounded job interface."""
import json
import uuid
import threading


def run_execution(args, bridge, agent_class, registry, base_url, api_key, write_json,
                  tool_schema, model_response):
    if args.new_run and args.resume:
        raise ValueError("Use a fresh runtime for an explicit new run")
    checkpoint = args.runtime / "checkpoint.json"
    prior = json.loads(checkpoint.read_text()) if args.resume and checkpoint.exists() else {}
    if prior and prior.get("mode") != "execution":
        raise ValueError("Use a new runtime for the job interface; legacy history has different tools")
    context = prior.get("context") or {"stance": args.stance or "Hunt", "mood": args.mood or "Cautious",
                                       "objective": args.objective}
    if prior and (prior.get("model") != args.model or
                  (args.stance and args.stance != context["stance"]) or
                  (args.mood and args.mood != context["mood"])):
        raise ValueError("Resume must retain model and policy; use a new runtime for a host transition")
    authority = context.get("authority", {})
    grant = bridge.request("execution/configure", {
        **context, "wildlife": args.allow_wildlife or args.combat, "new_run": args.new_run,
        "lock_stance": bool(args.stance or authority.get("stance")),
        "lock_mood": bool(args.mood or authority.get("mood")),
    })
    if not grant.get("ok"):
        raise RuntimeError(grant.get("error", "Execution configuration failed"))
    recovery = bridge.request("execution/reconcile")
    if not recovery.get("ok") or recovery.get("result", {}).get("status") != "no_unfinished_job":
        write_json(args.runtime / "recovery-receipt.json", recovery)
        return 0 if recovery.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
    if prior and prior.get("context") != grant["result"]["context"]:
        raise ValueError("Persisted home or grant changed; start a new runtime to preserve cached context")
    monitor_done = threading.Event()
    def monitor():
        control = args.runtime / "stop.json"
        while not monitor_done.wait(0.25):
            if control.exists():
                bridge.signal_stop("Tired")
                return
    threading.Thread(target=monitor, daemon=True).start()
    try:
        history = prior.get("messages", [])
        session_id = prior.get("session_id") or "spacemolt-" + uuid.uuid4().hex
        for cycle in range(args.cycles + 8):
            context, catalog = grant["result"]["context"], grant["result"]["catalog"]
            toolset = "spacemolt_" + uuid.uuid4().hex
            from spacemolt.session_skills import session_skills
            from toolsets import TOOLSETS
            guidance = session_skills(context, catalog, args.runtime / "hermes-home", resume=bool(history))
            TOOLSETS["spacemolt_skill_read"] = {"description": "Native skill reading", "tools": ["skill_view"], "includes": []}
            handoff, schemas = [], []
            for action, metadata in catalog.items():
                schema = tool_schema("job/" + action, metadata)
                schemas.append(schema)
                def handler(arguments, _action=action, **kwargs):
                    response = bridge.request("job/" + _action, arguments)
                    if response.get("result", {}).get("status") == "handoff_required":
                        handoff.append(response["result"])
                        agent.interrupt()
                    if response.get("result", {}).get("status") == "needs_reconciliation":
                        agent.interrupt()
                    return json.dumps(model_response(response))
                registry.register(name=schema["name"], toolset="spacemolt_execution", schema=schema, handler=handler)
            TOOLSETS[toolset] = {"description": "Immutable session job grant", "tools": [s["name"] for s in schemas], "includes": []}
            agent = agent_class(provider="custom", api_mode="chat_completions", base_url=base_url,
                                api_key=api_key, model=args.model, enabled_toolsets=[toolset, "spacemolt_skill_read"],
                                skip_context_files=True, skip_memory=True, skip_background_review=True,
                                session_id=session_id, max_iterations=args.iterations, max_tokens=args.max_tokens,
                                run_budget_seconds=args.seconds_per_cycle, quiet_mode=True)
            if agent.valid_tool_names != {schema["name"] for schema in schemas} | {"skill_view"}:
                raise RuntimeError("Hermes grant differs from resolved job catalog")
            observation = bridge.request("job/observe")
            result = agent.run_conversation(context["objective"] + "\n" + json.dumps(model_response(observation)),
                                            system_message=guidance + "\nResolved context: " + json.dumps(context, sort_keys=True),
                                            conversation_history=history)
            history = result["messages"]
            saved = {"mode": "execution", "model": args.model, "session_id": session_id,
                     "context": context, "messages": history, "report": result.get("final_response")}
            write_json(checkpoint, saved)
            if handoff:
                write_json(args.runtime / (session_id + ".json"), saved)
                grant = bridge.request("execution/handoff")
                if not grant.get("ok"):
                    raise RuntimeError(grant.get("error", "Handoff failed"))
                history = []
                session_id = "spacemolt-" + uuid.uuid4().hex
                write_json(checkpoint, {**saved, "session_id": session_id, "messages": [],
                                        "context": grant["result"]["context"]})
            else:
                receipt = finish_execution(bridge)
                write_json(args.runtime / "return-receipt.json", receipt)
                print(json.dumps({"report": result.get("final_response"), "return_receipt": receipt}), flush=True)
                return 0 if receipt.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
        receipt = finish_execution(bridge)
        write_json(args.runtime / "return-receipt.json", receipt)
        return 0 if receipt.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
    finally:
        monitor_done.set()


def finish_execution(bridge):
    recovery = bridge.request("execution/reconcile")
    if not recovery.get("ok") or recovery.get("result", {}).get("status") != "no_unfinished_job":
        return recovery
    receipt = bridge.request("job/return_to_base")
    if receipt.get("result", {}).get("status") == "needs_reconciliation":
        return bridge.request("execution/reconcile")
    return receipt
