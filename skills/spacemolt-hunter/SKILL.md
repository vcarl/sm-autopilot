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

The evening you are having is "I'll go fight something" — wildlife, pirates, and what they
leave behind. Most of the judgement this stance asks for is about what **not** to engage: a
fight entered without a way out costs the hull, the cargo and the rest of the evening.

## When to Use

At every juncture of a Hunter shift, beside the shared `spacemolt` skill.

## Prerequisites

The shared skill. This stance opens Focused or Aggressive.

## How to Run

Check the loadout before the target: whole hull, fuel out with the way home reserved, rounds
loaded and spares in cargo, free cargo for loot, credits left for the repair. A ship short of
any part of that floor is looking for a service counter, not a fight.

## Quick Reference

**A fight is worth taking when** you know the opponent's kind, you are not slower than it, the
loadout floor is met, and the loot has somewhere to go. Prefer a species you have fought before
over an individual you have merely seen: creature identities expire between trips, species and
their habitats persist.

**The job is `hunt`** (`poi_id`, optional `species`, `fights`, `base_id`): out to the habitat,
the fights the rules admit, loot what fits, home, stowed and serviced. Naming a species you
have fought is what makes a kind known; without one it declines what the scan cannot say.

**Walk away when** any of that is a guess. A scan gives hull and description, never
weapons or speed, so a scan alone does not make an unknown opponent known. Something faster than
you is declined outright. Pirates fight back with intent and wildlife does not, which is worth
more than the difference in payout.

**Counters you read first when docked:**

- **Hangar** — weapons and the slots to hold them. Read the ship's modules from the live state
  (`spacemolt_where`): a fitted module is a weapon when its `type` is `weapon`, and it fires when
  its `current_ammo` is above zero for its `ammo_type`. Count those, and only those.
- **Market** — ammunition and repair kits; buy the reserve, not the minimum.
- **Services** — hull and fuel before the hunt, not after you needed them.
- **Obligations desk** — insurance worth quoting on an aggressive evening; bounties follow you.
- **Storage** — where loot goes to stop taking up the hold.

**Wrecks and prizes.** A wreck can be looted, towed, scrapped or sold to a yard — four different
evenings depending on what is in it and how much hold is left. A prize is a second ship to keep
alive: crew, fuel and repair of its own, the whole way home.

## Procedure

*You are at a belt, loot from the last kill fills most of the hold, and another creature of the
same species is here.* The kill is not the constraint — the hold is. Loot you cannot carry is a
fight fought for nothing. Take the cargo home or into storage; the species will still be here.

*A wreck sits at your site and the hull is down to about the line you set.* The wreck is free
credits and the fight is over, so the temptation is to stay. Loot what fits, do not tow —
towing costs the speed you need to get home — and take the service.

*You are docked, the belt is full of creatures, and you want to know the ship can take one.*
Read the modules and count the ones whose `type` is `weapon` with `current_ammo` above zero for
their `ammo_type`. One of those is the fight; none of them is a trip to the hangar and the
market first, and the `hunt` job's refusal names whichever of the two is missing.

## Pitfalls

- Loot needs free cargo before the fight, not after it.
- An opponent already in someone else's battle is someone else's fight.
- Break off when the hull crosses the line you set before undocking, the ammunition reserve is
  spent, the hold is full, or something you did not choose to fight arrives.
- No mood lowers the loadout floor or raises the walk-away line: those are ship facts.

## Verification

The objective is met when the tally the objective named matches what the outcomes reported,
read from the game rather than remembered.
