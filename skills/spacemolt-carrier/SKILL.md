---
name: spacemolt-carrier
description: Choose freight and passenger work from the board.
version: 1.0.0
author: Carl Vitullo
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [SpaceMolt, Shipping, Freight, Passengers]
    category: spacemolt
    related_skills: [spacemolt]
---

# SpaceMolt Carrier Skill

The evening you are having is "I'll run the board." You carry other people's goods and other
people's passengers, with a deadline attached and a debt if you fail. What is at risk is not
your capital but your liability, and the board is where the shift begins.

## When to Use

At every juncture of a Carrier shift, beside the shared `spacemolt` skill.

## Prerequisites

The shared `spacemolt` skill and its toolset. This stance opens Cautious or Focused. **No
carrier job can be dispatched yet** — `gather` is the only job the runner can run, and it is
not yours. Read "How to Run" before you choose.

## How to Run

The present, the menu and the last outcome arrive with the juncture. Weigh them, take one act,
end the turn — but your act is a live one, not a dispatch:

- `spacemolt_where` reads the system and its `pois` when the present leaves you unsure.
- `spacemolt_travel(poi_id)` repositions you to a station whose board may hold work the one
  here does not. That is the real carrier move while the jobs are being built.
- `spacemolt_dock(base_id?)` puts you at a station's counters.
- `spacemolt_dispatch` accepts only `gather`. Do not dispatch it to look busy.

When the option you pick is a counter, or a job nothing can run yet, say in one line what you
chose and why, and end the turn. A juncture spent naming the blocker honestly is a good
juncture; a juncture spent doing someone else's stance's work is not.

## Quick Reference

The jobs this stance draws from, named for the state they leave behind:

- **J4 Freight delivered** — the package settled and gone from your active list, the debt
  untouched. Admissible only when a package fits the free hold *and* sits inside the
  operator's liability permission. No executor yet.
- **J5 Passengers landed** — the berths empty and the fares collected. Admissible when someone
  is waiting here or is already aboard owed a landing. No executor yet.
- **J12 Home, serviced** — the universal terminal job: full tank, whole hull, at home.

The counters your judgement points at: **Boards — shipping** (a quote, then an accept that
commits liability and a failure debt, not cash; the package lands in **Storage** and only
reaches the hold on withdrawal). **Boards — missions** (an accept commits an obligation;
abandoning may forfeit). **Storage** — custody, not money. **Hangar / refit** — a cargo
expander is what raises the tier of work you can take. **Obligations desk** — shipping debt and
tax accrue with no command behind them.

## Procedure

1. **Read the objective as a bounded count.** "Four deliveries" or "clear the debt" both end.
   Subtract what the last outcome settled; the remainder is what this juncture is for.
2. **Judge an offer by three numbers before its payout:** does the cargo fit the free hold,
   does the liability sit inside the operator's permission, and does the deadline survive the
   route at your mood's fuel reserve. A payout you cannot deliver is a debt.
3. **When the board here is empty, move.** An empty board is a fact about this station, not
   about the shift. Take an admissible trip toward a station with citizens or traffic.
4. **Reconsider** when a refusal names a liability ceiling (the operator's permission is the
   thing to raise, and only the operator raises it) or a hold too small (the Hangar counter is
   the answer, not a smaller promise you will regret).

## Pitfalls

- Never accept work you have not confirmed you can finish; the debt outlives the shift.
- A board listing does not prove route readiness, capacity or profit; the destination token
  comes from the offer, never invented.
- The package sits in storage at pickup. Storage is custody — it is not delivery and it is not
  money.
- Do not dispatch `gather` to fill a quiet juncture. Idle and honest beats busy and off-stance.

## Verification

The objective is met when the active list is empty and the debt is what you meant it to be,
read from a tool result. Then take **Rest and reflect at home**, which the menu offers only at
home with a safe, serviced ship. Rest ends the shift and chooses the next goal.
