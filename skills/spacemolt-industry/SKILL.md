---
name: spacemolt-industry
description: Plan resource gathering and account for retained output.
version: 1.0.0
author: Carl Vitullo (@vcarl)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [spacemolt, industry, gathering]
    category: gaming
    related_skills: [spacemolt-operations]
---
# SpaceMolt Industry Skill

Choose Industry for resource gathering, including mining, and production objectives.
The current executor supports bounded local gathering with retained output; production
and selling that output remain separate unfinished capabilities.

## When to Use

Gather when the objective calls for raw materials or extraction experience. Do not
equate ore in the hold with realized earnings. A production objective also needs input
allocation, a production quote and verified settlement before it can be completed.

## Prerequisites

Choose a home from observed stations using the shared operations workflow. Gathering
currently stays in the home's system, starts docked, and requires verified mining
capability, cargo capacity, ship condition and return reserves. Existing transport
commitments can block new extraction; their cargo and deadlines remain obligations.

## How to Run

Use observed local resource-site candidates to choose a verification visit. The
current system directory identifies candidate POIs but does not reveal their resource
contents remotely. Scripts inspect resources after arrival before admitting extraction;
an empty site can therefore end the job without yield.

## Tool: job__assess

Use `job__assess` with an observed `poi_id` to check local gathering suitability.
Read blockers before committing to a site. A viable candidate permits a bounded
verification visit, not an assertion of remote resource contents. Even observed
resources do not promise a quantity or sale price.

## Tool: job__prepare

Use `job__prepare` docked to service the ship and prepare mining capability through
the shared readiness executor. Unavailable equipment, insufficient capacity, or an
unpriced repair produces a blocker; do not substitute an invented quote.

## Tool: job__gather

Use `job__gather` with the chosen `poi_id` and optionally a smaller cycle count.
It verifies the site and readiness, extracts within policy, records canonical cargo
changes, and returns home or an explicit service fallback. It retains gathered items
and preserves starting cargo. It does not sell, manufacture, or promise a particular
resource mix or quantity. Zero yield does not satisfy a collection objective.

## Quick Reference

Read cycle limits from the resolved context. Cautious bounds exposure more tightly;
Aggressive permits a longer bounded attempt without bypassing readiness or defense.
Relaxed avoids hostilities. Focused and Opportunistic currently stay on the chosen
collection objective without diversions. Tired stops further extraction and returns.

## Procedure

Compare observed resources with the requested inputs and remaining cargo capacity.
After each receipt, distinguish collected materials from remaining demand. Consider
home again if the useful sites, station access or services no longer support the
objective; a temporary resupply stop never changes it automatically. Change objective,
stance or mood through the normal session handoff when additional capabilities are
needed. Do not keep gathering merely because the prior attempt was executable.

## Pitfalls

Mixed yields must be counted by actual item quantities, not by the requested resource
name. Scripts match server extraction receipts to canonical cargo changes; unrelated
cargo gains do not become mining yield. Full cargo, depletion, danger and Tired can
end a collection attempt early.
An uncertain extraction response must be reconciled before any replay or disposal;
apparent cargo changes alone do not prove which command was accepted.

## Verification

Read completed cycles, measured yield, retained new inventory, progression and stop
reason together with the terminal job status, return/service outcome and obligations.
Partial yield remains useful evidence even if cleanup fails. A safe return is distinct
from achieving the requested collection objective, and retained materials are not cash.
