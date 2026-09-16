#!/usr/bin/env python3
"""Drive the SpaceMolt bridge from a shell, outside Hermes.

    play.py serve  <playground>          # start the bridge for a playground dir (blocks)
    play.py <action> [json-params]       # send one request to the running bridge

A playground is a directory holding `pilot.json` and `runtime/`. The daemon holds the game
connection; each client call is one JSON-lines request over a unix socket. Env
SPACEMOLT_PLAYGROUND names the playground for client calls (default: ./playground).

ponytail: one request in flight at a time, no auth on the socket; it is a local playtest tool.
"""
import json, os, socket, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CREDS = os.environ.get("SPACEMOLT_CREDENTIALS_FILE") or os.path.expanduser(
    "~/workspace/testbench/hermes-spacemolt/credentials.kvothe.txt")


def sock_for(playground: Path) -> Path:
    """macOS caps a unix socket path at ~100 chars, so it lives in /tmp, named for the playground."""
    return Path(f"/tmp/smp-{playground.name}.sock")


def serve(playground: Path) -> None:
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
    log = open(runtime / "bridge.stderr.log", "a")
    proc = subprocess.Popen(["node", "src/bridge.ts"], cwd=HERE, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    ready = proc.stdout.readline()
    print("bridge:", ready.strip(), flush=True)
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(sock_path))
    server.listen(1)
    counter = 0
    try:
        while proc.poll() is None:
            conn, _ = server.accept()
            with conn, conn.makefile("rw") as f:
                line = f.readline()
                if not line.strip():
                    continue
                counter += 1
                req = json.loads(line)
                proc.stdin.write(json.dumps({"id": str(counter), "action": req["action"],
                                             "params": req.get("params") or {}}) + "\n")
                proc.stdin.flush()
                reply = proc.stdout.readline()
                f.write(reply or json.dumps({"ok": False, "error": "bridge closed"}) + "\n")
                f.flush()
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)
        sock_path.unlink(missing_ok=True)


def client(playground: Path, action: str, params: dict) -> None:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1800)
    s.connect(str(sock_for(playground)))
    with s, s.makefile("rw") as f:
        f.write(json.dumps({"action": action, "params": params}) + "\n")
        f.flush()
        reply = json.loads(f.readline())
    if reply.get("ok"):
        print(json.dumps(reply.get("result"), indent=1))
    else:
        print(json.dumps({"error": reply.get("error")}))
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "serve":
        serve(Path(sys.argv[2]).resolve())
    elif len(sys.argv) >= 2:
        pg = Path(os.environ.get("SPACEMOLT_PLAYGROUND", "playground")).resolve()
        raw = sys.argv[2] if len(sys.argv) > 2 else "{}"
        client(pg, sys.argv[1], json.loads(raw))
    else:
        print(__doc__)
