---
name: spacemolt-logistics
description: Plan freight and passenger delivery with verified receipts.
version: 1.0.0
author: Carl Vitullo (@vcarl)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [spacemolt, logistics, freight, passengers]
    category: gaming
    related_skills: [spacemolt-operations]
---
# SpaceMolt Logistics Skill

Choose Logistics to carry a freight contract or passengers for one destination.
Scripts verify custody, travel, delivery and payment, then return and service.
An accepted contract or boarded passenger is a commitment, not completed work.

## When to Use

Use this stance for delivery objectives, fares or carrier payouts. Compare those
receipts with service costs and contingent freight liability. Do not treat carried
packages or passengers as income before verified delivery.

## Prerequisites

Consider home using observed locations. Begin docked with an existing serviceable
ship and sufficient cargo or passenger berth capacity. Transport jobs do not buy
ships or install passenger cabins. Unrelated commitments can block new work; their
identities and deadlines remain visible on return.

## How to Run

Read observed contract IDs and passenger destinations. Select a destination from
the observed offers, never an invented ID. Scripts resolve public directory IDs to
canonical stations while preserving passenger identity. Missing, ambiguous, wrecked
or out-of-policy destinations remain blocked. Assess capacity, route fuel, existing
obligations, carrier eligibility, and deadlines before committing. Read cargo size
uncertainty explicitly: accepting freight can create liability before pickup succeeds.

## Tool: job__assess

Use `job__assess` without parameters to compare freight and passenger opportunities.
Choose `kind` as `freight` with a `shipment_id`, or `passengers` with the exact
`destination` token from a waiting passenger offer, for focused assessment. A board listing alone does not prove route readiness
or guarantee a fare. Passenger deadlines are observed after boarding; no route
estimate guarantees punctuality.

If economy berths are missing, use `kind: passenger_fit` to assess cabin preparation.
Compare the live quote and fitting blockers before committing. Catalog value is not
a purchase quote, and cabin capital cost is not delivery profit. A fitting allocation
comes from the host; the model cannot raise its spending limit.

## Tool: job__prepare

Use `job__prepare` without parameters for shared servicing. With `kind: passengers`,
it prepares an economy cabin using owned stock or a freshly quoted purchase within
the host budget. If utility slots are full, it may replace an observed mining laser,
preserving that equipment in cargo. Other equipment remains fitted. Read the verified
berth result before selecting passengers; blocked fitting is not usable capacity.
Unavailable services or unverified repair prices remain explicit blockers.

## Tool: job__transport

Use `job__transport` with `kind` and the assessed `shipment_id` or `destination`.
Once a feasible delivery is selected, execute the tool and read its receipt rather
than ending with an intention to carry it. The worker tracks the exact package or
boarded citizen IDs. Boarding loads available passengers for one destination up to
actual berth capacity; there is no requested passenger-count parameter.

Docking can deliver passengers automatically. Scripts inspect the docking receipt
before unloading remaining selected passengers. They never unload unrelated
passengers or declare missing passengers delivered without evidence.

For a verified interrupted transport in a later operating run, pass only its
`resume_job_id`. The job retains its original spending owner. Unknown acceptance,
delivery or payment evidence must be reconciled first; do not accept another contract
or board replacement passengers to conceal the incomplete job.

## Quick Reference

Relaxed and Cautious allow at most one normal jump per route; Focused, Opportunistic
and Aggressive allow two. Freight failure-liability allocations are separate from
spending: 500 credits for Relaxed/Cautious, 1,000 for Focused/Opportunistic, and 2,000
for Aggressive, subject to carrier eligibility. Mood does not grant additional funds
or cancel commitments. This first slice does not divert for unrelated opportunities.
Tired admits no transport and stops further acceptance or boarding; it preserves
unfinished obligations while returning and servicing.

## Procedure

Compare delivery compensation, route/service costs, capacity and potential failure
debt. Prefer a simple achievable commitment that supports the objective. Reconsider
home deliberately if destination coverage or services no longer support repeated
work. Temporary service stops never silently change the chosen home.

## Pitfalls

A sealed package identifier is not proof of physical custody. A successful command
response is not proof of cargo movement, delivery or payment. Empty active lists
cannot establish where a lost package or passenger went. Missing monetary fields
remain unknown; unrelated wallet income is not a carrier payout or passenger fare.

## Verification

Read terminal job status, package or passenger identities, delivery evidence, payout
or fare, final obligations and servicing together. Safe return does not establish
completed delivery. Partial custody remains a liability, and an unknown outcome
requires reconciliation without replaying the uncertain action.
