---
name: spacemolt-industry
description: Plan gathering, production, and verified settlement.
version: 1.1.0
author: Carl Vitullo (@vcarl)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [spacemolt, industry, gathering, production]
    category: gaming
    related_skills: [spacemolt-operations]
---
# SpaceMolt Industry Skill

Choose Industry for resource gathering, including mining, and production objectives.
The executors support bounded local gathering with retained output and single-run
production with direct output sales or retained output at home. Queued output and partial sales remain
unfinished work until settlement is verified.

## When to Use

Gather when the objective calls for raw materials or extraction experience. Do not
equate ore in the hold with realized earnings. A production objective also needs input
allocation, a production quote and verified settlement before it can be completed.
Compare buying inputs with using inventory; owned inputs have an opportunity cost.

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

## Tool: spacemolt_assess

Use `spacemolt_assess` with an observed `poi_id` to check local gathering suitability.
Read blockers before committing to a site. A viable candidate permits a bounded
verification visit, not an assertion of remote resource contents. Even observed
resources do not promise a quantity or sale price.

For production, omit `poi_id`: supply `recipe_id` to quote a known recipe or omit both
IDs to discover local economic candidates. Choose `source` as `inventory` or `buy`;
read input availability, market depth, processing advantage, and blockers. Discovery
and quotes are planning evidence, not completed production or earned credits.
`inventory` includes personal station storage as well as carried cargo; read
`input_locations` instead of inferring shortages from the ship hold alone.

For equipment or materials needed for use, choose `disposition: retain`. Find an
observed recipe with `output_search` (a short output name or item ID fragment), then
quote its returned `recipe_id` with the same disposition and chosen input source.
Catalog matches do not establish current availability or crafting eligibility.
A quote evaluation ID is a comparison key, not an experiment ID. Start new work
with the quoted recipe/source/disposition; use `experiment_id` only when a prior
production job returned that field for unfinished work.
Retained production requires complete acquisition/crafting costs and capacity, but
does not require a profitable sale. Missing inputs or quotes remain blockers.

## Tool: spacemolt_prepare

Use `spacemolt_prepare` docked to service the ship and prepare mining capability through
the shared readiness executor. Unavailable equipment, insufficient capacity, or an
unpriced repair produces a blocker; do not substitute an invented quote.

## Tool: spacemolt_gather

Use `spacemolt_gather` with the chosen `poi_id` and optionally a smaller cycle count.
It verifies the site and readiness, extracts within policy, records canonical cargo
changes, and returns home or an explicit service fallback. It retains gathered items
and preserves starting cargo. It does not sell, manufacture, or promise a particular
resource mix or quantity. Zero yield does not satisfy a collection objective.

## Tool: spacemolt_produce

Use `spacemolt_produce` at the chosen home with `recipe_id`, `source` (`inventory` by
default), and optionally `quantity`. Only one recipe run is supported. The script
services the ship, revalidates the chosen purpose, stages or buys inputs, submits crafting,
and verifies resulting inventory. `disposition: sell` is the default and sells only
the produced output directly. `disposition: retain` keeps verified output in personal
station storage for later use; it records spending without claiming sale earnings. It
preserves unrelated assets and reports unsold output. Preparation for production
does not require a mining refit. Once you choose a feasible quote for an execution
objective, call the tool and read its receipt. A final message announcing that you
intend to produce does not execute the job.

Queue waits are bounded to 120 seconds; `max_wait_seconds` can reduce that bound.
A pending queue or partial sale ends with unfinished evidence, not success. After
an explicit new operating run, pass the observed `experiment_id` to the same tool
to continue settlement without sourcing or crafting again. Do not also provide
recipe, source, quantity or a new disposition. The original sell/retain choice persists.
Unknown acceptance or accounting must be reconciled
before settlement; never create a replacement job to work around the blocker.

## Quick Reference

Read cycle limits from the resolved context. Cautious bounds exposure more tightly;
Aggressive permits a longer bounded attempt without bypassing readiness or defense.
Relaxed avoids hostilities. Focused and Opportunistic currently stay on the chosen
activity without diversions. Tired stops further extraction, input purchases, craft
submission, and output sales, then returns while preserving unfinished obligations.

## Procedure

Compare observed resources with the requested inputs and remaining cargo capacity.
After each receipt, distinguish collected materials from remaining demand. Consider
home again if the useful sites, station access or services no longer support the
objective; a temporary resupply stop never changes it automatically. Change objective,
stance or mood with `spacemolt_plan` when needed. An applied native plan completes its
execution handoff in this conversation; continue only within the remaining job allowance.
Do not keep gathering merely because the prior attempt was executable.

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
For production, read the experiment status, confirmed spending and sale proceeds,
sold/withdrawn quantities, remaining inventory and unresolved accounting. A queue
entry disappearing does not prove output exists or was sold. Gross spending comes
from accepted transaction receipts; unrelated wallet income does not reduce it.
For retained production, verify `retained` and `retained_location` alongside the
terminal status. A later stance uses those items through its normal preparation
tools after the plan is applied; storage output is not automatically fitted equipment.
