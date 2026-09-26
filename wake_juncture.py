"""Raise the pilot's next juncture from outside the gateway (N4).

A run ends in the Node bridge, and the juncture that follows is a cron job marked due. The
jobs file is held by a cross-process lock that only ``cron.jobs`` takes, so the bridge asks
for the mark by spawning this one-shot rather than editing the file itself. It runs as
``python -m spacemolt.wake_juncture`` or by path with the plugin's parent and the Hermes
tree on ``PYTHONPATH`` — the argv and the environment ``service.wake_argv`` /
``service.wake_env`` hand the bridge.

Writing the job goes through the ``cronjob_manage`` tool like every other path; marking it due
goes through ``juncture.mark_due``, which says why the tool cannot.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _bind_plugin() -> None:
    """Make this file's own directory importable as ``spacemolt``.

    Installed, the plugin directory *is* named ``spacemolt`` and its parent is on
    ``PYTHONPATH``, so the import below resolves by itself. A clone of this repository
    is named after the clone, and the package name the plugin is imported under is not
    negotiable — so bind the directory to that name rather than spell it two ways.
    """
    if importlib.util.find_spec("spacemolt") is not None:
        return
    root = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "spacemolt", root / "__init__.py", submodule_search_locations=[str(root)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["spacemolt"] = module
    spec.loader.exec_module(module)


def main() -> int:
    _bind_plugin()
    from spacemolt.juncture import raise_juncture
    from spacemolt.service import pilot_path

    if not pilot_path().is_file():
        print(f"no pilot record at {pilot_path()}: there is no one to wake", file=sys.stderr)
        return 1
    print(f"juncture due: {raise_juncture()['name']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - the reason is the whole point of the exit code
        print(f"juncture wake failed: {error}", file=sys.stderr)
        raise SystemExit(1)
