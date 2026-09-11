"""Cache-safe Hermes sessions for the bounded job interface."""
import json
import uuid
import threading
from datetime import datetime, timezone
from spacemolt.receipts import capture_receipt, receipt_report


def run_execution(args, bridge, agent_class, registry, base_url, api_key, write_json,
                  tool_schema, model_response):
    lifecycle = {"configured": False, "cleanup_attempted": False, "receipts": []}
    try:
        return _run_execution(args, bridge, agent_class, registry, base_url, api_key,
                              write_json, tool_schema, model_response, lifecycle)
    except BaseException as error:
        if lifecycle["configured"]:
            evidence = {"exception": {"type": type(error).__name__, "message": str(error)}}
            if not lifecycle["cleanup_attempted"]:
                lifecycle["cleanup_attempted"] = True
                try:
                    lifecycle["receipt"] = finish_execution(bridge)
                except BaseException as cleanup_error:
                    evidence["cleanup_error"] = str(cleanup_error)
                    error.add_note("SpaceMolt exception cleanup failed: " + str(cleanup_error))
            if "receipt" in lifecycle:
                evidence["cleanup_receipt"] = lifecycle["receipt"]
                capture_receipt(lifecycle["receipts"], lifecycle["receipt"])
            elif "cleanup_error" not in evidence:
                evidence["cleanup_error"] = "Cleanup was already attempted but produced no receipt"
            try:
                write_json(args.runtime / "exception-receipt.json", evidence)
                write_json(args.runtime / "verified-report.json", receipt_report(lifecycle["receipts"], lifecycle.get("receipt")))
            except BaseException as persistence_error:
                error.add_note("Could not persist SpaceMolt exception receipt: " + str(persistence_error))
        raise


def _run_execution(args, bridge, agent_class, registry, base_url, api_key, write_json,
                   tool_schema, model_response, lifecycle):
    if args.new_run and args.resume:
        raise ValueError("Use a fresh runtime for an explicit new run")
    checkpoint = args.runtime / "checkpoint.json"
    if args.resume and not checkpoint.exists():
        raise ValueError("Resume requires an existing checkpoint; use a fresh runtime without --resume")
    prior = json.loads(checkpoint.read_text()) if args.resume else {}
    if args.resume and (not isinstance(prior, dict) or not prior.get("context") or not prior.get("session_id")):
        raise ValueError("Resume requires a saved context and session identity; use a fresh runtime for a new session")
    lifecycle["receipts"] = prior.get("job_receipts", [])
    if prior and prior.get("mode") != "execution":
        raise ValueError("Use a new runtime for the job interface; legacy history has different tools")
    context = prior.get("context") or {"stance": args.stance or "Hunt", "mood": args.mood or "Cautious",
                                       "objective": args.objective}
    max_spend = getattr(args, "max_spend", None)
    if max_spend is not None:
        if isinstance(max_spend, bool) or not isinstance(max_spend, (int, float)) or not 0 <= max_spend <= 10000:
            raise ValueError("max_spend must be finite and between 0 and 10000 credits")
        if prior:
            if context.get("limits", {}).get("max_spend") != max_spend:
                raise ValueError("Resume must retain max_spend; use a fresh runtime for a new host allocation")
        else:
            context = {**context, "limits": {"max_spend": max_spend}}
    if prior and (prior.get("model") != args.model or
                  (args.stance and args.stance != context["stance"]) or
                  (args.mood and args.mood != context["mood"])):
        raise ValueError("Resume must retain model and policy; use a new runtime for a host transition")
    authority = context.get("authority", {})
    requested_wildlife = args.allow_wildlife or args.combat
    wildlife = context.get("permissions", {}).get("wildlife", False) if prior else requested_wildlife
    if prior and requested_wildlife and not wildlife:
        raise ValueError("Resume cannot expand wildlife permission; start a fresh runtime for a new grant")
    # Resume flags assert the saved choice; only a fresh session can establish locks.
    lock_stance = bool(authority.get("stance")) if prior else bool(args.stance)
    lock_mood = bool(authority.get("mood")) if prior else bool(args.mood)
    grant = bridge.request("execution/configure", {
        **context, "wildlife": wildlife, "new_run": args.new_run,
        "lock_stance": lock_stance, "lock_mood": lock_mood,
    })
    if not grant.get("ok"):
        raise RuntimeError(grant.get("error", "Execution configuration failed"))
    lifecycle["configured"] = True
    recovery = bridge.request("execution/reconcile")
    recovered_state = recovery.get("result") or {}
    for job in recovered_state.get("receipts", []):
        capture_receipt(lifecycle["receipts"], {"ok": True, "result": job})
    if not recovery.get("ok") or recovery.get("result", {}).get("status") != "no_unfinished_job":
        lifecycle.update(cleanup_attempted=True, receipt=recovery)
        capture_receipt(lifecycle["receipts"], recovery)
        write_json(args.runtime / "recovery-receipt.json", recovery)
        write_json(args.runtime / "verified-report.json", receipt_report(lifecycle["receipts"], recovery))
        return 0 if recovery.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
    if recovered_state.get("stopping_reason"):
        lifecycle["cleanup_attempted"] = True
        receipt = finish_execution(bridge)
        lifecycle["receipt"] = receipt
        capture_receipt(lifecycle["receipts"], receipt)
        write_json(args.runtime / "return-receipt.json", receipt)
        report = receipt_report(lifecycle["receipts"], receipt)
        write_json(args.runtime / "verified-report.json", report)
        print(json.dumps({"report": report}))
        return 0 if receipt.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
    if prior and prior.get("context") != grant["result"]["context"]:
        raise ValueError("Persisted home or grant changed; start a new runtime to preserve cached context")
    monitor_done = threading.Event()
    stop_requested = threading.Event()
    planner = {"active": None}
    def monitor():
        control = args.runtime / "stop.json"
        while not monitor_done.wait(0.25):
            if control.exists():
                stop_requested.set()
                bridge.signal_stop("Tired")
                active = planner["active"]
                if active is not None:
                    active.interrupt()
                return
    monitor_thread = threading.Thread(target=monitor, daemon=True)
    try:
        monitor_thread.start()
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
                    capture_receipt(lifecycle["receipts"], response)
                    if _action in {"observe", "assess"}:
                        write_json(args.runtime / "observations" / (uuid.uuid4().hex + ".json"), {
                            "observed_at": datetime.now(timezone.utc).isoformat(),
                            "session_id": session_id, "action": _action,
                            "arguments": arguments, "response": response,
                        })
                    if response.get("result", {}).get("status") == "handoff_required":
                        handoff.append(response["result"])
                        agent.interrupt()
                    outcome = response.get("result", {})
                    if outcome.get("stopping_reason"):
                        stop_requested.set()
                    if outcome.get("status") == "needs_reconciliation" or stop_requested.is_set():
                        agent.interrupt()
                    return json.dumps(model_response(response), separators=(",", ":"))
                registry.register(name=schema["name"], toolset="spacemolt_execution", schema=schema, handler=handler)
            TOOLSETS[toolset] = {"description": "Immutable session job grant", "tools": [s["name"] for s in schemas], "includes": []}
            agent = agent_class(provider="custom", api_mode="chat_completions", base_url=base_url,
                                api_key=api_key, model=args.model, enabled_toolsets=[toolset, "spacemolt_skill_read"],
                                skip_context_files=True, skip_memory=True, skip_background_review=True,
                                session_id=session_id, max_iterations=args.iterations, max_tokens=args.max_tokens,
                                run_budget_seconds=args.seconds_per_cycle, quiet_mode=True)
            if agent.valid_tool_names != {schema["name"] for schema in schemas} | {"skill_view"}:
                raise RuntimeError("Hermes grant differs from resolved job catalog")
            planner["active"] = agent
            observation = bridge.request("job/observe")
            if stop_requested.is_set():
                result = {"messages": history, "final_response": ""}
            else:
                result = agent.run_conversation(context["objective"] + "\n" + json.dumps(model_response(observation)),
                                            system_message=guidance + "\nResolved context: " + json.dumps(context, sort_keys=True),
                                            conversation_history=history)
            planner["active"] = None
            history = result["messages"]
            saved = {"mode": "execution", "model": args.model, "session_id": session_id,
                     "context": context, "messages": history, "model_report": result.get("final_response"),
                     "job_receipts": lifecycle["receipts"], "report": receipt_report(lifecycle["receipts"])}
            write_json(checkpoint, saved)
            if handoff and not stop_requested.is_set():
                write_json(args.runtime / (session_id + ".json"), saved)
                grant = bridge.request("execution/handoff")
                if not grant.get("ok"):
                    raise RuntimeError(grant.get("error", "Handoff failed"))
                history = []
                session_id = "spacemolt-" + uuid.uuid4().hex
                write_json(checkpoint, {**saved, "session_id": session_id, "messages": [],
                                        "context": grant["result"]["context"]})
            else:
                monitor_done.set()
                lifecycle["cleanup_attempted"] = True
                receipt = finish_execution(bridge)
                lifecycle["receipt"] = receipt
                capture_receipt(lifecycle["receipts"], receipt)
                write_json(args.runtime / "return-receipt.json", receipt)
                report = receipt_report(lifecycle["receipts"], receipt)
                write_json(args.runtime / "verified-report.json", report)
                write_json(checkpoint, {**saved, "report": report})
                print(json.dumps({"report": report, "return_receipt": receipt}), flush=True)
                return 0 if receipt.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
        monitor_done.set()
        lifecycle["cleanup_attempted"] = True
        receipt = finish_execution(bridge)
        lifecycle["receipt"] = receipt
        capture_receipt(lifecycle["receipts"], receipt)
        write_json(args.runtime / "return-receipt.json", receipt)
        report = receipt_report(lifecycle["receipts"], receipt)
        write_json(args.runtime / "verified-report.json", report)
        write_json(checkpoint, {**json.loads(checkpoint.read_text()), "job_receipts": lifecycle["receipts"], "report": report})
        return 0 if receipt.get("result", {}).get("status") in {"interrupted", "returned_to_base"} else 1
    finally:
        monitor_done.set()
        if monitor_thread.ident is not None:
            monitor_thread.join()


def finish_execution(bridge):
    recovery = bridge.request("execution/reconcile")
    if not recovery.get("ok") or recovery.get("result", {}).get("status") != "no_unfinished_job":
        return recovery
    receipt = bridge.request("job/return_to_base")
    if receipt.get("result", {}).get("status") == "needs_reconciliation":
        return bridge.request("execution/reconcile")
    return receipt
