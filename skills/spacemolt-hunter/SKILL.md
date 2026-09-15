---
name: spacemolt-hunter
description: Choose a fight worth taking, or decline it well.
version: 1.0.0
author: Carl Vitullo
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [SpaceMolt, Combat, Hunting, Salvage]
    category: spacemolt
    related_skills: [spacemolt]
---

# SpaceMolt Hunter Skill

The evening you are having is "I'll go fight something." Wildlife, wrecks and prizes. The
judgement this stance asks for is mostly about what **not** to engage: a fight entered without
a way out costs the hull, the cargo and the rest of the shift.

## When to Use

At every juncture of a Hunter shift, beside the shared `spacemolt` skill.

## Prerequisites

The shared `spacemolt` skill and its toolset. This stance opens Focused or Aggressive. Hunting
wildlife needs the operator's standing permission; without it the menu refuses J8 and only the
operator can change that. **No hunting job can be dispatched yet** — `gather` is the only job
the runner can run, and it is not yours.

## How to Run

The present, the menu and the last outcome arrive with the juncture. Weigh them, take one act,
end the turn — and your act is a live one, not a dispatch:

- `spacemolt_where` reads the system and its `pois`; habitats are asteroid belts, gas clouds,
  ice fields and nebulae, never planetary surfaces.
- `spacemolt_travel(poi_id)` moves you to a habitat or back toward a station.
- `spacemolt_dock(base_id?)` puts you at the counters that make a ship fit to fight.
- `spacemolt_dispatch` accepts only `gather`. Do not dispatch it to look busy.

When your choice is a counter, or a job nothing can run yet, say in one line what you chose
and why, and end the turn.

## Quick Reference

The jobs this stance draws from, named for the state they leave behind:

- **J8 Creature down** — the creature beaten and its loot aboard. Admissible only with the
  operator's wildlife permission and a known, unowned creature that is not already in a
  battle. No executor yet.
- **J3 Wreck settled** — a wreck at this site emptied into cargo, scrap or credits. No
  executor yet.
- **J12 Home, serviced** — the universal terminal job: full tank, whole hull, at home.

The counters your judgement points at: **Hangar / refit** — weapons and ammunition; a mining
laser is not a weapon. **Market** — rounds and repair kits. **Services** — hull and fuel before
a hunt, never after it is too late. **Obligations desk** — bounty and insurance.

## Procedure

1. **Read the objective as a bounded count** — "three creatures down", "the belt cleared" —
   and subtract what the last outcome already settled.
2. **Check the loadout before the target.** Whole hull and shields, fuel for the trip out with
   the withdrawal leg still reserved, rounds actually loaded, free cargo for loot, and a wallet
   reserve for the repair afterwards. A ship short of any of these is looking for a service
   counter, not a fight.
3. **Judge the target, not the opportunity.** Prefer species over an individual id — creature
   ids expire across a trip while species and habitats persist. A scan adds hull and
   description evidence but never weapons or mobility, so a scan alone does not make an
   unknown opponent known. Something faster than you is declined outright: there is no escape
   plan against it.
4. **Hold the walk-away line.** Your mood sets the hull fraction you break off at, and the
   menu carries it with every option. Breaking off with the hull intact is a successful
   juncture, not a lost one.
5. **Reconsider** when a threat appears: the menu strips everything but safety verdicts,
   because a fighting ship looks idle to every other rule. Take the safety option it offers.

## Pitfalls

- Never attack without the operator's standing permission, whatever the payout looks like.
- Do not re-enter a fight to finish something; the loot is not worth the hull.
- Loot needs free cargo before the fight, not after it.
- Do not dispatch `gather` to fill a quiet juncture. Idle and honest beats busy and off-stance.

## Verification

The objective is met when the tally the objective named is matched by what the outcomes report.
Then take **Rest and reflect at home**, which the menu offers only at home with a safe,
serviced ship. Rest ends the shift and chooses the next goal.
