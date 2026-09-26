#!/usr/bin/env python3
"""Drive the SpaceMolt bridge from a shell, outside Hermes.

    play.py serve  <playground>          # start the bridge for a playground dir (blocks)
    play.py <action> [json-params]       # send one request to the running bridge
    play.py run [path/to/index.ts]       # run pilot/index.ts (copying the file there first)

A playground is a directory holding `pilot.json` and `runtime/` (with `runtime/pilot/index.ts`,
the file you play by editing). The daemon holds the game connection; each client call is one
JSON-lines request over a unix socket, answered with any streamed lines then the result. Env
SPACEMOLT_PLAYGROUND names the playground for client calls (default: ./playground).

ponytail: no auth on the socket; it is a local playtest tool.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
CREDS = os.environ.get("SPACEMOLT_CREDENTIALS_FILE")


def sock_for(playground: Path) -> Path:
    """macOS caps a unix socket path at ~100 chars, so it lives in /tmp, named for the playground."""
    return Path(f"/tmp/smp-{playground.name}.sock")


def serve(playground: Path) -> None:
    if not CREDS or not Path(CREDS).expanduser().is_file():
        raise SystemExit("SPACEMOLT_CREDENTIALS_FILE must point at a readable SpaceMolt credentials "
                         f"file{f' (got {CREDS!r})' if CREDS else ''}. See README.md.")
    runtime = playground / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    if not (playground / "pilot.json").exists():
        (playground / "pilot.json").write_text(json.dumps(
            {"name": "kvothe", "mood": "Cautious", "permissions": {}}, indent=2))
    sock_path = sock_for(playground)
    if sock_path.exists():
        sock_path.unlink()
    env = {**os.environ, "SPACEMOLT_CREDENTIALS_FILE": CREDS, "SPACEMOLT_RUNTIME_DIR": str(runtime)}
    env.pop("SPACEMOLT_JOURNAL_WEBHOOK", None)  # a playtest never posts to Discord
    log = open(runtime / "bridge.stderr.log", "a")  # noqa: SIM115 - held open for the bridge's lifetime
    proc = subprocess.Popen(["node", "src/bridge.ts"], cwd=HERE, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    ready = proc.stdout.readline()
    print("bridge:", ready.strip(), flush=True)
    # Replies are routed by id to the client that asked, so a `run` streams for minutes while
    # `status` and `stop` still answer on their own connections.
    waiting: dict[str, object] = {}
    lock = threading.Lock()

    def pump() -> None:
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            with lock:
                conn = waiting.get(str(message.get("id")))
            if conn is None:
                continue
            try:
                conn.sendall(line.encode())
                if message.get("event") != "line":
                    with lock:
                        waiting.pop(str(message.get("id")), None)
                    conn.close()
            except OSError:
                pass
        for conn in list(waiting.values()):
            try:
                conn.sendall(json.dumps({"ok": False, "error": "bridge closed"}).encode() + b"\n")
                conn.close()
            except OSError:
                pass
    threading.Thread(target=pump, daemon=True).start()
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(sock_path))
    server.listen(4)
    counter = 0
    try:
        while proc.poll() is None:
            conn, _ = server.accept()
            line = conn.makefile("r").readline()
            if not line.strip():
                conn.close()
                continue
            counter += 1
            req = json.loads(line)
            with lock:
                waiting[str(counter)] = conn
            proc.stdin.write(json.dumps({"id": str(counter), "action": req["action"],
                                         "params": req.get("params") or {}}) + "\n")
            proc.stdin.flush()
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)
        sock_path.unlink(missing_ok=True)


def client(playground: Path, action: str, params: dict) -> None:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(None)
    s.connect(str(sock_for(playground)))
    with s, s.makefile("rw") as f:
        f.write(json.dumps({"action": action, "params": params}) + "\n")
        f.flush()
        for line in f:
            reply = json.loads(line)
            if reply.get("event") == "line":
                print(reply.get("text", ""), flush=True)
                continue
            if reply.get("ok"):
                result = reply.get("result")
                if action == "run" and isinstance(result, dict) and result.get("accepted"):
                    print(f"-- {result.get('status')}: {result.get('reason')}")
                else:
                    print(json.dumps(result, indent=1))
                return
            print(json.dumps({"error": reply.get("error")}))
            sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "serve":
        serve(Path(sys.argv[2]).resolve())
    elif len(sys.argv) >= 2:
        pg = Path(os.environ.get("SPACEMOLT_PLAYGROUND", "playground")).resolve()
        raw = sys.argv[2] if len(sys.argv) > 2 else "{}"
        if sys.argv[1] == "run" and raw.endswith(".ts"):
            target = pg / "runtime" / "pilot" / "index.ts"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(raw, target)
            raw = "{}"
        client(pg, sys.argv[1], json.loads(raw))
    else:
        print(__doc__)
