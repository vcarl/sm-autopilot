---
name: spacemolt-industrialist
description: Choose industrial work — inputs, the bench, the ore.
version: 1.0.0
author: Carl Vitullo
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [SpaceMolt, Industry, Crafting, Mining]
    category: spacemolt
    related_skills: [spacemolt]
---

# SpaceMolt Industrialist Skill

The evening you are having is "I'll make something." You turn inputs into goods: read what a
recipe wants, get the inputs — bought, or mined yourself — and settle at the bench. Stocking
your own inputs is the half of that which runs today; the bench does not yet.

## When to Use

At every juncture of an Industrialist shift, beside the shared `spacemolt` skill.

## Prerequisites

The shared `spacemolt` skill and its toolset. This stance opens Cautious or Focused; mood may
change under you during the shift, and the menu's bounds change with it.

## How to Run

Same as any juncture: the present, the menu and the last outcome are already there. Weigh,
act once, end the turn. `spacemolt_dispatch(job='gather', ...)` is the one job you can start;
it is also the only composable job in the game today, so `repeat` is the only way to put more
than one trip behind a single juncture.

## Quick Reference

The jobs this stance draws from, named for the state they leave behind:

- **J7 Inputs at the bench** — the inputs a quoted recipe needs, present where the craft will
  happen, escrow untouched. The menu offers it only with a workshop at this base and inputs in
  hand; **nothing can run it yet**, so treat it as a target you are stocking toward.
- **J1 Hold full of ore** — mine your own inputs. This is `spacemolt_gather`, and it is the
  work you can actually dispatch.
- **J12 Home, serviced** — the universal terminal job: full tank, whole hull, at home. Gather
  ends this way by itself.

The counters your judgement points at: **Workshop / recipes** — a quote is not a commitment,
and committing a craft consumes the inputs and escrows labour and fee. **Market (buy side)** —
for inputs no belt here carries. **Storage** — where gather's ore lands; custody, not money.
**Facilities desk** — the largest single spends in the game. **Obligations desk** — tax accrues
with no command behind it and will cross your credit margin while you are not looking.

## Procedure

1. **Read the objective as a quantity with an end.** "Two hundred units at home" is done when
   storage says so. Subtract what the last outcome's `yield` already deposited; what remains
   is what this juncture is for.
2. **Pick the site from the menu's reasons, not the map.** An admissible trip has already been
   quoted against your mood's fuel reserve. A refusal that names a shortfall is telling you to
   refuel or take a nearer site — that is usually a better juncture than an off-menu attempt.
3. **Size `repeat` to the remainder.** Divide what is left by the last trip's yield and stop
   short rather than over. Every extra trip spends fuel and hull the shift has to service back.
4. **Reconsider when the world answers differently:** the take came back `held` instead of
   `deposited` (this station has no store), the yield per trip is falling (the deposit is
   thinning), or an outcome is `blocked` with a reason naming a condition that changed.

## Pitfalls

- Gather never sells. Do not count credits from it, and do not plan a purchase against ore
  sitting in storage until you have actually sold it at the Market counter.
- A remote listing never proves what a deposit holds. Resources are confirmed after arrival.
- Do not commit a craft you cannot settle: the escrow consumes the inputs, and a job leaving
  the queue does not by itself prove finished output.
- `keep` is for the pilot's own cargo — spares, fittings. Naming ore there strands it aboard.

## Verification

The objective is met when what storage holds equals what the objective named, read from a tool
result rather than remembered. Then the shift's work is over: take **Rest and reflect at home**,
which the menu offers only at home with a safe, serviced ship. Rest ends the shift and chooses
the next goal; it is the end of an evening, not a failure to find more work.
