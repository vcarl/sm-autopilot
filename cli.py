"""`hermes spacemolt` setup and gateway-owner inspection commands."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess

from .service import persisted_status, request_stop, service


def register_cli(parser: argparse.ArgumentParser) -> None:
    commands = parser.add_subparsers(dest="spacemolt_command")
    commands.add_parser("setup", help="Check credentials, Node, and direct-player prerequisites")
    install = commands.add_parser("install", help="Install pinned SpaceMolt Node dependencies")
    install.add_argument("--yes", action="store_true", help="Run npm ci without a confirmation prompt")
    commands.add_parser("status", help="Show this gateway process's SpaceMolt bridge status")
    stop = commands.add_parser("stop", help="Request Tired from the gateway-owned controller")
    stop.add_argument("--reason", default="Tired")
    parser.set_defaults(func=spacemolt_command)


def spacemolt_command(args: argparse.Namespace) -> int:
    command = args.spacemolt_command
    if command == "setup":
        result = service().status()
        result["npm_available"] = shutil.which("npm") is not None
        print(json.dumps(result, indent=2))
        return 0 if result["credentials_configured"] and result["node_available"] and result["npm_available"] else 1
    if command == "install":
        if not args.yes:
            try:
                if input("Run npm ci for pinned @spacemolt/lib dependencies? [y/N] ").strip().lower() not in {"y", "yes"}:
                    return 1
            except EOFError:
                return 1
        if shutil.which("npm") is None:
            print("npm is required; install Node.js 22 or later first")
            return 1
        return subprocess.run(["npm", "ci"], cwd=Path(__file__).resolve().parent, check=False).returncode
    if command == "status":
        print(json.dumps(persisted_status(), indent=2))
        return 0
    if command == "stop":
        print(json.dumps(request_stop(args.reason), indent=2))
        return 0
    print("usage: hermes spacemolt {setup,install,status,stop}")
    return 2
