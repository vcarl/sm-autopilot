"""The juncture: one cron job per pilot, and every fire a fresh conversation.

A fire opens a new session carrying the base skill, the stance's career skill when there is a
stance, and the ``spacemolt`` toolset. The agent reads the context, runs one script —
``spacemolt_run`` blocks until the run ends, capped in the bridge — and ends the turn. The next
fire is cron's interval, which cron re-anchors on the fire's completion, so a juncture comes a few
minutes after the last one ended. The only suppression is a run genuinely in flight (the gate).

What happened is in the journal (``runtime/gameplay.jsonl``): each gate decision, each juncture
with the skills it carried and the context it rendered, and the bridge's own run, refusal, boot
and record lines.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hermes_constants import get_hermes_home

from .service import pilot_path, runtime_dir
from .skills_register import SHARED_SKILL, qualified, readme_skills

#: What a fire carries: the job tools plus the reads every client of the runner may make.
#: ``spacemolt_observer`` is deliberately absent — the pilot does not set its own objective.
TOOLSETS = ("spacemolt", "spacemolt_observe")
#: Cron's platform name. A juncture is the only session the context is delivered into; a CLI
#: or chat session is a client of the runner and never opens the game to build a prompt.
JUNCTURE_PLATFORM = "cron"
#: The job's interval. Cron sets the next fire from a fire's completion, so this is the pause
#: between one juncture ending and the next beginning.
IDLE_SCHEDULE = "5m"
#: The six stances (D7), mirrored from ``src/rules-table.ts``: a tool schema cannot read
#: TypeScript.
STANCES = ("Prospector", "Industrialist", "Trader", "Carrier", "Hunter", "Scout")
#: Where the runner's own journal lives. The bridge writes most of it; the lines the runner
#: makes outside the bridge (gate, juncture, reflection, instruction) take the same shape.
JOURNAL_FILE = "gameplay.jsonl"
#: What a pilot with no goal of its own is pointed at.
FIRST_GOAL = "Learn the ship: look around, find what sells, and make the first profit."

JUNCTURE_PROMPT = (
    "A SpaceMolt juncture. You choose the pilot's next run, start it, and say how it went.\n"
    "What to expect:\n"
    "- The context above was read from the game as this juncture began.\n"
    "- A run takes minutes of real time and spacemolt_run waits for it, so its report comes back "
    "to you in this same turn.\n"
    "- A wrong field costs a spacemolt_check, a wrong move costs a run, and looking costs "
    "almost nothing: when a fact you need is missing, a run that only looks (orient(), "
    "scout(), note() the numbers) is a good turn.\n"
    "- Spending, selling and fighting are the moves that stay done; the permissions bound the "
    "money, and who to fight is your judgement.\n"
    "Whose word wins: the instruction carried in, then the objective, then your goal, then the "
    "suggested moves. When the instruction asks for something the library can't do, do the "
    "nearest thing it can and say so.\n"
    "Your turn:\n"
    "1. Pick the move that best serves the instruction or objective, using what the context "
    "shows.\n"
    "2. Write the whole of pilot/index.ts and pass it as `source` to spacemolt_run.\n"
    "3. Read the report: what it cost, what it gained, the skills that moved and where the ship "
    "now stands.\n"
    "4. When the report says the next juncture should pursue something else, call "
    "spacemolt_reflect with a new goal, a stance, or objective_done. Otherwise leave them.\n"
    "5. Answer in one or two lines — what ran, how it ended, what comes next — and end the turn.\n"
    "When a run is already in flight, say so in one line and end the turn.\n"
    'When there is no SpaceMolt context above, say "no context from the runner" and end the '
    "turn."
)

#: Which career folder's README is the stance's skill (``play/<folder>/README.md``).
STANCE_FOLDER = {"Prospector": "mining", "Industrialist": "industry", "Trader": "trading",
                 "Carrier": "hauling", "Hunter": "combat", "Scout": "exploration"}

#: The juncture section's ``max_chars``: core skips a section over it whole, not truncated.
SECTION_LIMIT = 4_000
#: How many of the pilot's own recent runs and reflections the context lists.
RECENT = 5
#: ponytail: the journal tail read for the recent list and the gate log, not the whole file
#: (tens of MB). Entries older than this window are simply not recent.
_TAIL_BYTES = 2 << 20


def journal_tail(max_bytes: int = _TAIL_BYTES) -> list[str]:
    """The journal's last ``max_bytes`` as whole lines, oldest first. Walks from ``gameplay.jsonl``
    back through the ``gameplay.<UTC stamp>.jsonl`` files a bridge boot rotated away (the stamps
    sort as time), so a restart's nearly empty journal does not cost a reader its recent past."""
    runtime = runtime_dir()
    rotated = sorted((p for p in runtime.glob("gameplay.*.jsonl") if p.name != JOURNAL_FILE), reverse=True)
    lines: list[str] = []
    left = max_bytes
    for path in [runtime / JOURNAL_FILE, *rotated]:
        if left <= 0:
            break
        try:
            with path.open("rb") as handle:
                size = path.stat().st_size
                start = max(0, size - left)
                # One byte early, then drop through the first newline: a line the budget cuts
                # in half is left out rather than returned torn.
                handle.seek(max(0, start - 1))
                raw = handle.read()
        except OSError:
            continue
        if start:
            raw = raw[raw.find(b"\n") + 1:] if b"\n" in raw else b""
        left -= size - start
        lines = raw.decode("utf-8", errors="replace").splitlines() + lines
    return lines


def _journal_tail(events: tuple[str, ...]) -> list[dict[str, Any]]:
    """The journal's last few MB, as the entries whose event is one of ``events``."""
    rows = []
    for line in journal_tail():
        if not any(f'"{event}"' in line for event in events):
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("event") in events:
            rows.append(row)
    return rows


def _run_endings() -> list[dict[str, Any]]:
    return [row for row in _journal_tail(("run",)) if row.get("phase") in ("ended", "refused")]


def unproductive_streak(endings: list[dict[str, Any]] | None = None) -> int:
    """How many of the latest runs, back to back, did nothing: refused (at the check or by the
    script), failed, or sent no commands. An interrupted run is skipped, not counted: the bridge
    died under it, which says nothing about the program. Logged by the gate for a reader of the
    journal; nothing acts on it."""
    streak = 0
    for row in reversed(endings if endings is not None else _run_endings()):
        if row.get("outcome") == "interrupted":
            continue
        if not (row.get("phase") == "refused" or str(row.get("outcome")) in {"refused", "failed"}
                or not int(row.get("commands") or 0)):
            break
        streak += 1
    return streak


def juncture_context(session_info: Mapping[str, Any] | None = None) -> str:
    """The present, the menu, and the pilot's own recent runs — delivered, never fetched (N15).

    Core renders this once per new session and freezes the bytes into that conversation's
    system prompt, and again when it rebuilds that prompt (compression) — the same juncture. Rendering reads the game and the record and writes neither; it journals what
    it rendered and which skills the fire carries, for whoever reviews the fire later.
    """
    if (session_info or {}).get("platform") != JUNCTURE_PLATFORM:
        return ""
    from .service import call, source_fingerprint

    began = time.monotonic()
    menu = call("menu")
    record = read_pilot()
    context = _busy(menu) if menu.get("busy") else _situation(menu, _pending_instruction(record))
    skills = job_fields(record, gate=False)["skills"]
    readmes = readme_skills(Path(__file__).parent)
    sizes = {name: path.stat().st_size for name, path in readmes.items()}
    carried = hashlib.sha256()
    for name in skills:
        if (path := readmes.get(name.split(":", 1)[-1])) is not None:
            carried.update(path.read_bytes())
    info = session_info or {}
    session_id = str(info.get("session_id") or "")
    # Cron names a fire's session ``cron_<job_id>_<YYYYmmdd_HHMMSS>``: the join to
    # cron/usage_audit.jsonl (job_id + ts), which is where the fire's tokens and LLM time live.
    job = re.fullmatch(r"cron_(.+)_\d{8}_\d{6}", session_id)
    facts = {"session_id": session_id or None, "code_sha": code_sha(), "sources": source_fingerprint(),
             "skills_sha": carried.hexdigest()[:12], "build_s": round(time.monotonic() - began, 3),
             "stance": record.get("stance"), "busy": bool(menu.get("busy")), "context_chars": len(context),
             "context_sha": hashlib.sha256(context.encode()).hexdigest()[:12], "context": context}
    # Hermes re-renders this when it rebuilds a session's system prompt (context compression,
    # live 2026-09-28 13:37Z). That is the same fire: same juncture, fresh facts, its own event.
    prior = _read_juncture()
    if session_id and prior and prior.get("session_id") == session_id:
        # The model sees the fresh context from here on, so a run started after this rerender
        # must be judged against *this* render time, not the fire's first one — otherwise an
        # instruction written between the two renders is shown again next fire even though this
        # rerender already carried it (live 2026-09-29). `since_juncture_s` (src/run.ts) is
        # derived from the same field and so becomes "since the context was last rendered" too,
        # which is the more useful staleness number for a rerendered fire; the first render time
        # isn't otherwise consumed, so no second field is kept for it. A busy rerender renders
        # `_busy(menu)`, which carries no instruction (only the non-busy branch builds one via
        # `_situation`), so advancing `at` here would let a run started right after silently
        # drop an instruction written before the rerender but never actually shown (live
        # 2026-09-29). `at` only advances when this render could have carried it.
        at = _now_iso()
        new_at = at if not menu.get("busy") else prior.get("at")
        _write_juncture({"juncture_id": prior["juncture_id"], "at": new_at, "session_id": session_id or None})
        journal_event("juncture_rerender", at=at, juncture_id=prior["juncture_id"],
                      reason="the session's system prompt was rebuilt mid-fire", **facts)
        return context
    gate = next(reversed(_journal_tail(("gate",))), {})
    juncture_id = uuid.uuid4().hex
    at = _now_iso()
    _write_juncture({"juncture_id": juncture_id, "at": at, "session_id": session_id or None})
    journal_event("juncture", at=at, juncture_id=juncture_id, gate_id=gate.get("gate_id"), gate_at=gate.get("at"),
                  job_id=job.group(1) if job else None, model=info.get("model") or None,
                  provider=info.get("provider") or None,
                  skills=[{"name": name, "bytes": sizes.get(name.split(":", 1)[-1])} for name in skills], **facts)
    return context


#: The last juncture rendered, for the ``spacemolt_run`` handler to stamp on its run request.
JUNCTURE_FILE = "juncture.json"


def _write_juncture(record: dict[str, Any]) -> None:
    path = runtime_dir() / JUNCTURE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(record))
    temp.replace(path)


def _read_juncture() -> dict[str, Any] | None:
    try:
        record = json.loads((runtime_dir() / JUNCTURE_FILE).read_text())
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and record.get("juncture_id") else None


def last_juncture() -> dict[str, Any] | None:
    """The juncture the latest render left, as a run request carries it, or None. A run started
    outside a fire (a chat window, ``play.py``) still carries the last one; ``since_juncture_s``
    says how stale."""
    record = _read_juncture()
    return {"juncture_id": record["juncture_id"], "at": record.get("at")} if record else None


def code_sha() -> str | None:
    """The plugin checkout's HEAD, or None outside one. A subprocess per juncture, not per request."""
    try:
        done = subprocess.run(["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parent,
                              capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() or None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _pending_instruction(record: dict[str, Any]) -> dict[str, Any] | None:
    """The observer's sentence, until a run starts after it was given. Derived from run.json
    rather than moved aside at render time, so a fire that never got as far as a run still
    leaves it for the next one, and rendering writes nothing."""
    said = record.get("instruction")
    if not isinstance(said, dict) or not said.get("text"):
        return None
    try:
        run = json.loads((runtime_dir() / "run.json").read_text())
    except (OSError, ValueError):
        run = {}
    # The juncture's render time, not when the run started: a run can start seconds after an
    # instruction is written but from a context rendered before it, so the model never saw it
    # (live 2026-09-29: rendered 13:01:42.83Z, instruction 13:01:43.74Z, run 13:01:51Z). Runs
    # from before this field existed have none, so `started` stands in for them.
    rendered = run.get("juncture_at") or run.get("started")
    given, ran = _when(said.get("at")), _when(rendered)
    return said if not (given and ran and ran >= given) else None


def _when(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None


def _stamp(at: datetime | None) -> str:
    return at.astimezone(timezone.utc).strftime("%m-%d %H:%MZ") if at else "unknown time"


def _clock(iso: str | None) -> str:
    at = _when(iso)
    return at.astimezone(timezone.utc).strftime("%m-%d %H:%MZ") if at else "--:--"


_PERMISSION = {"credit_reserve": "keep {:,} credits", "max_liability": "owe at most {:,} on one job"}

#: The rest of the story a free hold of 0 leaves untold (playtest 2026-09-15: three gathers
#: dispatched on a full hold). Undocked, ``sell`` and ``stow`` are both refused, so the one real
#: move out at a belt is a base.
_HOLD_FULL_DOCKED = ("hold full: a gather needs free hold. sell(rows) or stow(rows) here first "
                     "(name the rows from the hold above), then gatherUntil")
_HOLD_FULL_OUT = ("hold full: a gather needs free hold, and neither sell nor stow works out here — "
                  "goTo a base with a market or storage first, then sell(rows) or stow(rows)")


#: What each buffered alert is, in the pilot's words. A type without an entry renders its own
#: name: a frame group newly added to the buffer is still worth a line.
_ALERT_LABEL = {"facility_rent_warning": "rent overdue", "facility_reclaimed": "facilities repossessed",
                "base_destroyed": "base destroyed"}
#: ponytail: four alert lines, the rest a count. The buffer already collapses by base, so four
#: is four bases in trouble at once; raise it if a pilot ever holds that many facilities.
_ALERT_LINES = 4


def _alerts(menu: dict[str, Any]) -> list[str]:
    """The alerts the bridge handed over with this menu, as fact lines. The bridge stamped them
    delivered as it answered, so they appear at exactly one juncture, and they go with the
    facts, above the cuttable material."""
    items = [item for item in (menu.get("alerts") or []) if isinstance(item, dict)]
    if not items:
        return []
    lines = [f"Alerts since your last wake ({len(items)}, shown once):"]
    for item in items[:_ALERT_LINES]:
        body = item.get("body") or {}
        what = _ALERT_LABEL.get(str(item.get("type")), str(item.get("type")))
        bits = []
        if isinstance(body.get("credits_owed"), (int, float)):
            bits.append(f"{body['credits_owed']:,} owed")
        if body.get("missed_cycles") is not None:
            bits.append(f"{body['missed_cycles']} of {body.get('grace_cycles', '?')} missed cycles")
        if body.get("attacker_name"):
            bits.append(f"attacker {body['attacker_name']}")
        if not bits and body.get("message"):
            bits.append(str(body["message"])[:120])
        seen = (f", seen {item['n']}x since {_stamp(_when(item.get('first_at')))}"
                if item.get("n", 1) > 1 else "")
        lines.append(f"  {what} at {body.get('base_name') or item.get('key')}"
                     + (f": {'; '.join(bits)}" if bits else "") + seen + ".")
    if len(items) > _ALERT_LINES:
        lines.append(f"  +{len(items) - _ALERT_LINES} more in the journal.")
    return lines


def _battle(menu: dict[str, Any]) -> str | None:
    """Whether a battle holds the ship, in one line, ahead of every other fact. Live 2026-09-25:
    a pilot woke at hull 3/80 inside a battle and died one second after its first move."""
    fight = menu.get("battle")
    if not isinstance(fight, dict):
        return None
    hull = (menu.get("present") or {}).get("hull")
    at = f", hull {hull}/{(menu.get('present') or {}).get('max_hull')}" if hull is not None else ""
    return (f"IN BATTLE NOW with {fight.get('opponent') or 'an unnamed opponent'} "
            f"(battle tick {fight.get('tick') or '?'}{at}). Nothing moves the ship until it ends: "
            # NOT "fight it with hunt's onTick": `hunt` declines any creature whose `in_combat` is
            # true (hunting.ts:136), which the current opponent is by definition.
            "disengage() breaks off; to keep fighting, hold the stance by hand with "
            "account().commands.spacemolt_battle.stance({id:'brace'}).")


def _recent_line(row: dict[str, Any]) -> str:
    """One of the pilot's own recent acts, as a fact."""
    at = _clock(row.get("at"))
    if row.get("event") == "reflection":
        bits = [f"stance {row['stance']}" if row.get("stance") else "",
                f"goal {row['goal']!r}" if row.get("goal") else "",
                f"objective {row.get('objective')!r} retired" if row.get("objective_done") else ""]
        return f"{at} reflect: {', '.join(bit for bit in bits if bit)}"
    if row.get("phase") == "refused":
        first = str((row.get("errors") or ["no reason recorded"])[0]).splitlines()[0][:160]
        return f"{at} run refused at the check, nothing ran: {first}"
    # Lead with the work done — the top-level calls and what they gained — and put the
    # return value after: a run whose gatherUntil made 2,626 cr should say so before it says
    # how the run ended (live 2026-09-29 mislabelled this, gains buried in the tail).
    calls = [c for c in (row.get("calls") or []) if isinstance(c, dict) and c.get("fn")]
    names = ", ".join(dict.fromkeys(str(c["fn"]) for c in calls)) or "no calls"
    work = row.get("work") if isinstance(row.get("work"), dict) else {}
    gained = [f"+{work['credits']:,} cr" if work.get("credits") else "",
              f"{work['items']} items" if work.get("items") else "",
              f"{work['xp']} xp" if work.get("xp") else ""]
    gained_text = ", ".join(bit for bit in gained if bit) or "nothing gained"
    ret = f"returned {row.get('outcome')}"
    if row.get("reason"):
        ret += f": {str(row['reason'])[:120]}"
    if row.get("why"):
        ret += f": {str(row['why'])[:160]}"
    head = f"{at} {names}: {gained_text}; {ret}"
    return f"{head} ({row.get('commands') or 0} commands)" if row.get("outcome") != "interrupted" else head


def _busy(menu: dict[str, Any]) -> str:
    started = _when(menu.get("started"))
    if isinstance(menu.get("question"), dict):
        return ("SpaceMolt juncture — the run in flight is paused on a question for you.\n"
                + question_text(menu["question"]))
    return (f"SpaceMolt juncture. Run in flight: yes — started {_stamp(started)}, in "
            f"{menu.get('fn') or 'pilot'}, {menu.get('commands') or 0} commands so far.")


def _skill_text(name: str, value: Any) -> str:
    """One skill as a fact: ``piloting 9 (1744/2000 xp)`` when the level, xp and next-level xp
    are all there, else the old bare-number/level rendering unchanged."""
    if isinstance(value, dict) and isinstance(value.get("level"), (int, float)):
        xp, need = value.get("xp"), value.get("next_level_xp")
        if isinstance(xp, (int, float)) and isinstance(need, (int, float)):
            return f"{name} {value['level']} ({xp}/{need} xp)"
        return f"{name} {value['level']}"
    return f"{name} {value}"


def _situation(menu: dict[str, Any], said: dict[str, Any] | None) -> str:
    """The juncture as labelled lines, each fact once, budgeted on the final string.

    Over ``SECTION_LIMIT`` core drops the section whole, so the suggested moves go first, then
    the hold list, then the older recent lines — never a fact line.
    """
    now = _when(menu.get("now")) or datetime.now(timezone.utc)
    p = menu.get("present") or {}
    facts = [line for line in (_battle(menu),) if line]
    facts.append(f"SpaceMolt juncture — {now.strftime('%Y-%m-%d %H:%MZ')}. Run in flight: no.")
    if menu.get("objective"):
        facts.append(f"Objective (carried in): {menu['objective']}")
    if said:
        facts.append(f"Instruction (carried in {_stamp(_when(said.get('at')))}): {said.get('text')}")
    facts += _alerts(menu)
    facts.append(f"Goal: {menu['goal']}" if menu.get("goal")
                 else f"Goal: none set yet; a first one: {FIRST_GOAL}")
    mood = str(menu.get("mood") or "Cautious")
    if menu.get("tired_by"):
        mood += f" ({menu['tired_by']})"
    facts.append(f"Stance: {menu.get('stance') or 'none'}. Mood: {mood}.")
    # Only the keys rendered here: a permission the code no longer knows is one the pilot
    # cannot act on (playtest 2026-09-22: a stale ``wildlife: false`` read as "wildlife False").
    permits = [_PERMISSION[k].format(v) for k, v in (menu.get("permissions") or {}).items()
               if k in _PERMISSION and isinstance(v, (int, float)) and not isinstance(v, bool)]
    if permits:
        facts.append("Permissions: " + "; ".join(permits) + ".")
    system = p.get("system") or "unknown system"
    where = (f"docked at {p['docked_at']} ({system})" if p.get("docked_at")
             else f"in transit ({system})" if p.get("in_transit")
             else f"at {p.get('poi') or 'an unknown point'} ({system})")
    facts.append(f"Present: {where}.")
    ship = (f"  Fuel {p.get('fuel')}/{p.get('max_fuel')}, hull {p.get('hull')}/{p.get('max_hull')}, "
            f"credits {p.get('credits') or 0:,}.")
    hold = [f"{row.get('item_id')} {row.get('quantity')}" for row in p.get("hold") or []]
    free = p.get("cargo_free")
    weapons = ", ".join(f"{w.get('id')}" + (f" ({w['loaded']} loaded)" if "loaded" in w else "")
                        for w in p.get("weapons") or []) or "none"
    # A skill is an object in the library, not a number (playtest 2026-09-22). The bridge is
    # moving skills from a bare level to {level, xp, next_level_xp}; render the progress when
    # it's there and stay correct for the older bare-number/level shape either way.
    skills_map = p.get("skills") or {}
    skills = ", ".join(_skill_text(k, v) for k, v in skills_map.items()) or "none known"
    # Playtest 2026-09-22: the pilot treated skills as bare numbers in its programs. Each is an
    # object ({level, xp, next_level_xp}); say so once here rather than after every skill.
    skills_hint = " (each is {level, xp, next_level_xp}; read .level)" if any(
        isinstance(v, dict) for v in skills_map.values()) else ""
    facts_after = []
    if menu.get("threats"):
        facts_after.append(f"  Fighting here: {', '.join(map(str, menu['threats']))}.")
    facts_after.append(f"  Fitted weapons: {weapons}. Skills: {skills}{skills_hint}.")
    if p.get("walk_away") is not None:
        facts_after.append(f"  Walk-away: break off a fight below hull {p['walk_away']}.")

    recent = [_recent_line(row) for row in
              [row for row in _journal_tail(("run", "reflection"))
               if row.get("event") == "reflection" or row.get("phase") in ("ended", "refused")][-RECENT:]]
    moves = menu.get("text")

    def render(moves: str | None, kept: int, shown_recent: list[str]) -> str:
        shown = hold[:kept] + ([f"+{len(hold) - kept} more"] if kept < len(hold) else [])
        hold_line = (f" Hold: {', '.join(shown) or 'empty'} ({free} free)."
                     + (f" {_HOLD_FULL_DOCKED if p.get('docked_at') else _HOLD_FULL_OUT}."
                        if free == 0 else ""))
        lines = facts + [ship + hold_line] + facts_after
        lines.append("Your recent runs (newest last):\n  " + "\n  ".join(shown_recent)
                     if shown_recent else "Your recent runs: none yet.")
        if moves:
            lines.append("Suggested moves (advice, pasteable into main()):\n  "
                         + moves.replace("\n", "\n  "))
        return "\n".join(lines)

    kept = len(hold)
    text = render(moves, kept, recent)
    if len(text) > SECTION_LIMIT:
        text = render(None, kept, recent)
    while len(text) > SECTION_LIMIT and kept:
        kept = max(0, kept - max(1, (len(text) - SECTION_LIMIT) // 12))
        text = render(None, kept, recent)
    while len(text) > SECTION_LIMIT and len(recent) > 1:
        recent = recent[1:]
        text = render(None, kept, recent)
    return text[:SECTION_LIMIT]


def read_pilot() -> dict[str, Any]:
    """The pilot record, read-only here: the bridge is its one writer (the ``pilot`` request)."""
    path = pilot_path()
    return json.loads(path.read_text()) if path.is_file() else {}


def journal_event(event: str, **fields: Any) -> None:
    """One line in the pilot's journal for something the runner did outside the bridge: a gate
    decision, a juncture rendered, a reflection, an instruction carried in (S45)."""
    path = runtime_dir() / JOURNAL_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {"at": _now_iso(), "event": event, **fields}
    with path.open("a", encoding="utf-8") as journal:
        journal.write(json.dumps(entry, separators=(",", ":")) + "\n")


#: The gate cron runs before it builds a fire's prompt. Cron only runs scripts that resolve
#: inside ``HERMES_HOME/scripts`` (``cron.scheduler_script._resolve_script_path``, symlinks
#: resolved), so the plugin installs a shim there rather than naming a file in its own tree.
GATE_SCRIPT = "spacemolt-juncture-gate.py"
#: The shim is a separate process from the gateway, so it cannot ask the bridge anything — a
#: ``service.call`` would start a second bridge and be refused the controller lock. It reads the
#: run record the bridge keeps instead.
_GATE_SHIM = '''"""Written by spacemolt.juncture: the juncture's wake gate. Do not edit."""
import os, sys
sys.path[:0] = {roots!r}
os.environ["HERMES_HOME"] = {home!r}
from spacemolt.juncture import gate_main
raise SystemExit(gate_main())
'''


def run_in_flight() -> bool:
    """Is a run going on right now? ``run.json`` un-ended. Only a live bridge leaves it so: a
    bridge that dies mid-run has its record closed ``interrupted`` by the next one at boot."""
    try:
        record = json.loads((runtime_dir() / "run.json").read_text())
    except (OSError, ValueError):
        return False
    return record.get("ended", True) is False


def pending_question() -> dict[str, Any] | None:
    """The question the running program is paused on (``ask()``), as ``run.json`` carries it.

    Only a run in flight can be waiting: a record left un-ended by a dead bridge is no question.
    """
    if not run_in_flight():
        return None
    try:
        question = json.loads((runtime_dir() / "run.json").read_text()).get("question")
    except (OSError, ValueError, AttributeError):
        return None
    return question if isinstance(question, dict) and question.get("question") else None


def question_text(question: dict[str, Any]) -> str:
    """A pending question as every reader is handed it: the question, the choices, and the one
    or two calls that move the program on — said outright, never left to be inferred."""
    choices = [str(choice) for choice in question.get("choices") or []]
    lines = [(f"QUESTION from your running program, which is paused until it is answered "
              f"(asked {_stamp(_when(question.get('asked_at')))}):"),
             f"  {question.get('question')}"]
    if choices:
        lines.append(f"  Choices: {' | '.join(choices)} — the answer must be one of these.")
    lines.append("Next: call spacemolt_answer with your answer; the program resumes, and that call "
                 "then waits for the rest of the run exactly as spacemolt_run does. Or call "
                 "spacemolt_stop to end the run instead of answering.")
    return "\n".join(lines)


def gate_main() -> int:
    """The wake gate: a fire that lands on a run in flight ends silently, with no model turn.
    That is the only thing it suppresses.

    Saying nothing is not "wake normally": cron ends a fire whose script printed nothing
    ("script produced no output, skipping AI call"), which suppressed every juncture, live, on
    the first restart. So the wake is always prose. Each decision is journalled with its reason.

    A run paused on ``ask()`` is in flight but waiting on the pilot, so its fire wakes, and the
    question is the output: cron prepends that to the prompt, so the fire reads it first.
    """
    question = pending_question()
    flying = run_in_flight() and not question
    try:
        endings = _run_endings()
        # Its own id: the gate runs in its own process before the juncture exists. The juncture
        # line names the latest gate's id, which is the link between the two.
        journal_event("gate", gate_id=uuid.uuid4().hex, wake=not flying,
                      reason=("a run is paused on a question" if question
                              else "a run is in flight (run.json not ended)" if flying
                              else "no run in flight"),
                      unproductive_streak=unproductive_streak(endings),
                      last_run=(endings[-1].get("outcome") or endings[-1].get("phase")) if endings else None)
    except OSError:
        pass  # the log is never worth the fire
    if question:
        print(question_text(question) + "\nAnswer it before anything else, and do not write a new "
              "pilot/index.ts. When the run returns its report, carry on with the juncture below.")
    else:
        print('{"wakeAgent": false}' if flying else "No run in flight: the pilot is idle.")
    return 0


def install_gate() -> str:
    """Put the shim where cron will run it from, rewritten every time so a moved plugin or a
    changed profile cannot leave a stale one behind. Returns the job's ``script``: the bare
    name, because the tool layer rejects an absolute script and resolves a relative one
    against the very directory written to here."""
    import hermes_constants

    here = Path(__file__).resolve().parent
    roots = list(dict.fromkeys([str(here.parent), str(Path(hermes_constants.__file__).resolve().parent)]))
    path = get_hermes_home() / "scripts" / GATE_SCRIPT
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_GATE_SHIM.format(roots=roots, home=str(get_hermes_home())))
    path.chmod(0o700)
    return GATE_SCRIPT


def job_name(pilot: dict[str, Any]) -> str:
    """One job per pilot, found again by this name so a rewrite never adds a second."""
    return f"spacemolt juncture: {pilot.get('name') or 'pilot'}"


def job_fields(pilot: dict[str, Any], *, gate: bool = True) -> dict[str, Any]:
    """What a fire carries: the juncture prompt, the skills, the tools, the gate.

    The skills are the base README and the stance's career README when there is a stance: the
    stance is how the career text a fire carries is chosen. No ``workdir``, which is what makes
    cron open the conversation with ``skip_context_files=True``.
    """
    folder = STANCE_FOLDER.get(str(pilot.get("stance") or "").strip())
    return {
        "prompt": JUNCTURE_PROMPT,
        # Namespaced plugin skills: registered by the plugin, resolved by cron through the
        # plugin registry, never copied into the profile's skills directory.
        "skills": [qualified(SHARED_SKILL)] + ([qualified(folder)] if folder else []),
        "enabled_toolsets": list(TOOLSETS),
        **({"script": install_gate()} if gate else {}),
    }


#: Set from ``register()`` to the host's ``PluginContext.dispatch_tool``. Absent — a bare
#: ``python -m spacemolt.juncture`` — the tool registry is asked directly, which is all
#: ``dispatch_tool`` does once the parent agent is resolved.
_dispatch_tool = None


def use_dispatch(dispatch) -> None:
    """Take the host's tool dispatcher, so cron is reached through the public tool and never
    through ``cron.*``."""
    global _dispatch_tool
    _dispatch_tool = dispatch


def cron_manage(**args: Any) -> dict[str, Any]:
    """One ``cronjob_manage`` call, raising on failure rather than returning an error dict.

    The gate on that tool (``HERMES_GATEWAY_SESSION``) is a *schema exposure* check:
    ``registry.dispatch`` runs the handler without consulting ``check_fn``, so a plugin and a
    one-shot both reach it.

    The tool's module is imported on both paths: importing it is what registers the tool, and
    gateway startup loads plugins before it loads the core tools, so during ``register()`` the
    host's dispatcher answers "Unknown tool" (live 2026-09-26: a fresh install never got a job).
    """
    import tools.cronjob_tools  # noqa: F401 - registers cronjob_manage; a no-op once loaded
    dispatch = _dispatch_tool
    if dispatch is None:
        from tools.registry import registry
        dispatch = registry.dispatch
    result = dispatch("cronjob_manage", args)
    result = json.loads(result) if isinstance(result, str) else result
    if not result.get("success"):
        raise RuntimeError(f"cronjob_manage {args.get('action')}: {result.get('error') or result}")
    return result


def ensure_juncture_job(schedule: str = IDLE_SCHEDULE) -> dict[str, Any]:
    """Write or rewrite this pilot's one juncture job from the current pilot record, schedule
    included, so a live job picks up an interval change as well as a stance change.

    Returns the tool's own view of the job — ``job_id``/``name``/``schedule``.
    """
    pilot = read_pilot()
    name = job_name(pilot)
    fields = job_fields(pilot)
    existing = next((job for job in cron_manage(action="list")["jobs"]
                     if job.get("name") == name), None)
    if existing is not None:
        return cron_manage(action="update", job_id=existing["job_id"], schedule=schedule, **fields)["job"]
    return cron_manage(action="create", schedule=schedule, name=name, **fields)["job"]


if __name__ == "__main__":  # what the shim calls, runnable by hand: python -m spacemolt.juncture
    raise SystemExit(gate_main())
