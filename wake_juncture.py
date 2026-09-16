"""Raise the pilot's next juncture from outside the gateway (N4).

A run ends in the Node bridge, and the juncture that follows is a cron job marked due. The
jobs file is held by a cross-process lock that only ``cron.jobs`` takes, so the bridge asks
for the mark by spawning this one-shot rather than editing the file itself. It runs as
``python -m spacemolt.wake_juncture`` or by path with the plugin's parent and the Hermes
tree on ``PYTHONPATH`` — the argv and the environment ``service.wake_argv`` /
``service.wake_env`` hand the bridge.
"""
from __future__ import annotations

import sys


def main() -> int:
    from spacemolt.juncture import ensure_juncture_job
    from spacemolt.service import pilot_path

    if not pilot_path().is_file():
        print(f"no pilot record at {pilot_path()}: there is no one to wake", file=sys.stderr)
        return 1
    from cron.jobs import trigger_job

    job = ensure_juncture_job()
    trigger_job(job["id"])
    print(f"juncture due: {job['name']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - the reason is the whole point of the exit code
        print(f"juncture wake failed: {error}", file=sys.stderr)
        raise SystemExit(1)
