# Industry experiments

The shared `--stance Industry` interface now composes these production mechanics
through `job__produce` and the durable pilot job lifecycle. It supports one recipe
run at the chosen home, with input sourcing, output sales, return/service, and
explicit later settlement by `experiment_id`. Shared queue waits are at most
120 seconds and check urgent control at most two seconds apart. The legacy tool
names and longer wait bounds below describe `--industry`, not the shared catalog.

Accepted receipt fields establish gross spending and direct-sale proceeds; net
wallet changes may include unrelated activity. Craft escrow with missing labor or
fee leaves accounting unresolved. Queue disappearance alone cannot establish
finished output, and a serviced return does not establish completed settlement.

The local Hermes agent can compare recipes, input sources, stations, and live
markets, then run bounded production or mining experiments. The model selects
the experiment; the industry tools execute and record its mechanical steps.
Start by reading the current state and history. A previous profitable recipe or
station is evidence to investigate again, not a standing promise of demand.
The primary objective is discovering more profitable paths across materials,
recipes, and locations. Repeat established work when it funds that search;
repeating an easy recipe alone does not satisfy the discovery objective.

## Run

From this directory, after the setup checks in [README](README.md), with no other
client controlling the same player:

```sh
../../hermes-agent/.venv/bin/python runner.py \
  --industry \
  --runtime runtime/industry-local \
  --cycles 1 --iterations 60 --seconds-per-cycle 3600 \
  --objective 'Discover more profitable industrial paths beyond the already tested iron loop, without delivery contracts. Read industry history and recommendations. Use industry discover for a bounded diverse scan and dry-run quotes at the current station. Use locations to choose nearby stations and industry survey to compare their opportunities within travel reserves. Choose a promising new material or recipe, distinguish current income from learning potential, then run and settle one bounded experiment. Record actual skill progress; use an explicit learning_goal and max_learning_loss only when intentionally funding training, and never extrapolate a beginner quote into mature profit. Repeat established profitable work only when needed to fund further discovery. Preserve 150000 credits. Start with a 1000-credit exploration allowance and reinvest 25 percent of verified positive economic profits; pass the remaining recommended allowance as each experiment max_spend. Account for travel and restoring fuel. Return docked and report new findings, measured profits, rejected hypotheses, retained stock, and unresolved liabilities.'
```

The default is `mlx-community--Qwen3.6-35B-A3B-4bit`, the non-MTP model served by
local omlx. No model override is needed. Add `--resume` with the same `--runtime`
to continue its conversation. The underlying industry ledgers are shared across
conversation runtimes for this integration, so a fresh conversation still sees
earlier experiments.

The optional `--industry` flag exposes the higher-level industry workflows and
lightweight ship/storage support to the model. It reduces the large raw market
and facility responses that previously caused repeated Qwen context compression.
The underlying scripts retain the full primitive command capability. Manual
navigation tools are not exposed to the model in this mode; `survey` handles
station visits and `mine` handles its bounded sortie movement.

## Experiment workflow

| Tool | Purpose |
| --- | --- |
| `industry/history` | Review production jobs, realized outcomes, mining measurements, and station observations. |
| `industry/recommend` | Calculate exploration allowance and identify unquoted screened opportunities, untried quotes, and observed profitable loops. |
| `industry/locations` | Discover nearby stations, services, and minimum jump counts from public directory/map data before choosing travel. |
| `industry/discover` | Scan the current station and dry-run quote a bounded, diverse set of recipes, ranking economic returns and reporting blocked hypotheses; no trades. |
| `industry/survey` | Visit selected nearby public stations, run discovery at each, and return to the origin by default; no trades or refueling. |
| `industry/recipes` | Discover catalog recipes; optionally filter by an input or output `item_id`. |
| `industry/screen` | Compare recipes against the current station's order books, inventory, and observed facilities. |
| `industry/quote` | Quote a particular `recipe_id`, output `quantity`, and `source` (`buy` or `inventory`). |
| `industry/produce` | Revalidate, purchase if requested, queue once, verify finished storage, and sell the produced output. |
| `industry/settle` | Continue an existing experiment by `experiment_id` or `job_id`, without buying inputs or requeuing. |
| `industry/prepare_mining` | Inspect readiness; `execute: true` can refit owned equipment without buying gear. |
| `industry/mine` | Measure a bounded local or nearby-system mining sortie, returning to its starting station; sell or retain only newly mined resources. |

The model receives these tool names with `/` rendered as `__`, for example
`industry__quote`. Recipe discovery and production require docking at the
station being evaluated. The model selects a bounded `industry/survey`
itinerary for station comparisons. Without `--industry`, the regular navigation
tools are also available.

Prefer `discover` for the initial comparison. It evaluates the complete visible,
non-package recipe catalog locally against one market/storage/facility snapshot,
then live-quotes at most six finalists by default (`limit`: 1–12). Presentation
limits do not truncate the catalog before evaluation. Known missing supply,
output demand, explicit skill gates, and unavailable facilities stay as local
future hypotheses without consuming live quotes. Supplied learning candidates
must fit the requested `max_learning_loss` before unquoted fees. Missing skill
metadata is unknown, not an invented requirement or proof of eligibility.

Discovery reuses the station snapshot across its quotes. Production starts a
separate fresh evaluation and retains its spending and transaction checks.
Unchanged skill/facility quote failures have a bounded five-minute in-process
cache, invalidated by changed observations. Rate/busy errors stop further quotes.
The response reports catalog freshness, recipes evaluated, actual live quote
count, local hypotheses, and cache reuse. Full hypotheses remain in the ledger;
the model receives a bounded view.

The bulk catalog is stored in ignored `runtime/catalog-cache.json`, including
ETag, fetch time, and retry time. A shared process lock prevents simultaneous
refreshes; fresh data is reused for one hour and revalidated conditionally.
HTTP errors persist a shared cooldown, respecting `Retry-After` when provided.
Switching tools or restarting cannot bypass that cooldown. Existing stale
catalog data remains usable for explicitly labeled exploration; production
waits for successful revalidation. If no catalog is cached, tools report the
retry time and issue no game queries. The first successful download is still
required; an already rate-limited cold start must wait.

For a market survey, select one to three public base or POI IDs from `locations`
and pass them as `station_ids`. Each leg permits at most two normal jumps; the
total cap, including the return, defaults to six and cannot exceed eight.
`return_to_origin` defaults to true. The survey checks travel reserves and
records fuel consumption but buys no fuel, so its results retain that service
liability until it is independently settled.

Screening margins omit unknown labor and taxes. Quote promising candidates
before spending. `quantity` means desired output count, rounded to whole recipe
runs. Production consumes station storage; the `buy` source purchases fresh inputs
directly into it. The `inventory` source counts storage plus carried inputs,
then deposits only the recipe shortfall from cargo, verifying both balances.
Income experiments must beat selling that stock raw; an explicit learning
allowance can fund a measured exception.

Execution currently permits only one production run per experiment. Live quotes
for multiple runs have ambiguous per-run versus total output quantities, so the
executor rejects them until that behavior is verified. Choose an output quantity
no greater than one recipe run produces; larger batches are not supported yet.

Change one or more observed variables deliberately: recipe, source, quantity,
production venue, station sale depth, or mining POI. Compare actual receipts to
the prediction. Revisit profitable combinations with fresh quotes, and use the
resulting earnings to support investigating untried combinations and locations.

## Income and skill development

Assess two outcomes separately: the income a path produces with the pilot's
current skills and equipment, and the skill progress or new capability it helps
develop. A weak beginner quote does not establish a path's mature earning
potential. Conversely, a promising unlock is not evidence of future profit.

Skills develop through activity and can unlock recipes and equipment. The
official guide describes mining yield and refining efficiency bonuses, crafting
bonus-output chances, and deeper market analysis as skills rise. Workshop speed
also depends on crafting/refining skill. These are reasons to investigate a
progression path and re-quote after advancement; they do not justify multiplying
today's profit into an invented high-level forecast.
[Skills and XP](https://spacemolt.com/docs/skills) ·
[Crafting and Industry](https://spacemolt.com/docs/crafting)

Use recorded before/after skill state to establish what an experiment actually
trained. Compare XP gained, elapsed time, net credits, and input opportunity
cost together. If a venue produces no observed XP change, report that observation
instead of assuming either that every craft trains the same skill or that the
venue can never train it. A profitable income loop can fund separate, explicitly
bounded learning experiments.

Production exposes `skill_context` for current crafting, refining, trading, and
recipe-required skill counters. Its `skill_progress` compares before/after levels
and XP. `verified_xp_gain` is reported only when the counters are comparable at
the same level; level changes are reported separately, and missing or reset
counters do not become invented XP totals.

For an intentional learning experiment, supply a concrete `learning_goal` and a
positive `max_learning_loss` to `industry/produce`. Together they permit a
predicted economic margin down to the negative of that allowance. A missing or
blank goal cannot authorize a positive loss allowance; a goal alone or a zero
allowance keeps the usual income threshold. Spending and wallet reserves,
single-run limits, supply availability, and output demand checks still apply.
The saved `learning_policy` records the planned allowance. Actual loss can
differ as markets change, so verify receipts and skill progress before repeating.

## Accounting and exploration allowance

Production reports `realized_credit_delta` as actual proceeds minus recorded
spending. For inventory processing,
`incremental_profit_after_input_opportunity` also subtracts what the consumed
inputs could have fetched at the observed raw-material buy orders. Turning
valuable starting inventory into cash does not make all that cash new profit.
The opportunity value is an observed alternative, not a completed raw sale.

Recommendations calculate:

```text
exploration fund = max(0, initial allowance
                         + reinvest fraction * verified positive economic profits
                         - realized economic losses)
available = min(exploration fund, max(0, wallet - credit reserve))
next experiment cap = min(available, configured per-experiment cap)
```

Defaults are a 1,000-credit initial allowance, 25% reinvestment, a 150,000-credit
reserve, and a 1,000-credit per-experiment cap. Repeated ledger snapshots count
once. Pending or unverified outcomes do not replenish the allowance. Quote ages
are exposed; quotes over 60 seconds old or without a known age are marked stale.
Every recommendation requires revalidation even when its quote is recent.

This is a **recommendation policy**, not an automatically enforced cumulative
spending account. The model must pass the remaining recommended cap into each
execution call. `industry/produce` separately checks its `max_spend`,
`credit_reserve`, and minimum predicted profit, with the explicit bounded
learning exception described above. Costs of separately chosen navigation or
manual game actions are not automatically charged to this exploration ledger.

Mining records cargo changes, sale receipts, elapsed time, and service costs.
Provide `refuel_unit_quote` only from an observed return-station fuel price
including tax, with a suitable `max_service_spend`. If fuel or hull has not been
restored, the result retains a liability and does not claim fully serviced
profit. Mixed-resource sortie costs are shared; they are not independently
attributed to each ore. Unsold new resources are reported separately.

Set `target_system_id` for mining in another system, at most two normal jumps
from the return station. The executor checks route structure and a conservative
round-trip fuel allowance before leaving, then revalidates the return route at
the destination. Wormhole routes are excluded. Travel time and fuel use are
recorded separately, so a valuable ore can be assessed against the cost of
reaching it rather than only its sale price.

For a mining-to-production chain, pass `retain_items` with the item IDs to keep
to `industry/mine`. The tool deposits those newly mined resources into the
return station's storage instead of selling them. Quote the next recipe with
`source: "inventory"`, then produce and settle it normally. Retained ore is
inventory, not realized earnings. Reconcile the chain's actual cash change as
the mining cash delta plus the production cash delta, including service costs;
continue using processing advantage to decide whether refining beats selling
the ore raw. There is no automatic whole-chain provenance aggregation yet:
associate the mining and production ledger entries explicitly, and retain any
unsold stock or service liabilities in the final accounting.

## Measured discovery

A manual Horizon phase-drift sample produced one phase crystal, four iron ore,
and four copper ore in nine mining attempts. Returning to First Step and selling
the new resources yielded 544 credits; restoring fuel cost 15, for **529 net
credits**. The recorded wall time was 880.088 seconds, including research, so it
is not a clean automated-loop throughput measurement. See the
[phase discovery receipt](evidence/phase-discovery.json).

Phase-matrix processing had no observed output bid, so that sample favored
selling the crystal raw. Starfall uranium and lithium remain directions to
investigate from public station information, not verified profitable loops.

Two subsequent completed autonomous non-MTP Qwen cycles each bought eight
hydrogen gas for 80 credits, compressed it into three liquid hydrogen, and sold
those for 210: **130 net credits and 5 Crafting XP per run**. Both finished
docked with full fuel and hull. This demonstrates repeatable income and training
at the observed prices, not unlimited market capacity. Including two failed
development purchases and later recovery of their retained inputs, all hydrogen
trials netted 520 credits.

A separate autonomous Frontier experiment selected argon purification with a
25-credit learning allowance. It spent 20, sold the output for 6, and earned
**5 Crafting XP plus 5 Refining XP at a 14-credit loss**. No future skill multiplier
is assumed. The model overlooked station-stored carbon in its final discussion
of an alternative circuit recipe; that reported blocker is not authoritative.

An automated survey visited Void Gate Outpost and Frontier Station, quoting six
candidates at each. One jump and local travel consumed four fuel units; restoring
fuel cost 12 credits. These bounded comparisons are not an exhaustive market
search. The final player state was 202654 credits, docked at Frontier Station,
with fuel 120/120 and hull 80/80. See the reviewed
[industry proof](evidence/industry-proof.json) for trials, skill counters, costs,
and limitations.

The earlier local-model Starfall trial did not establish a profitable strategy.
It made 28 tool calls and underwent three context compressions before being
stopped while docked. Its three-attempt mining probe found one carbon, one lead,
and one tungsten ore, with seven credits of gross sales and two fuel units still
unrestored. Large catalog and history responses made the investigation
inefficient. The bounded `discover` and `survey` tools reduce that mechanical
work. The subsequent completed hydrogen and argon trials above provide the
separate live execution evidence. Including the approach and later refueling,
the earlier Starfall mining trial lost 14 credits.

## Settlement and limits

Crafting is asynchronous. A pending response is an existing job, not a reason to
produce again. Call `industry/settle` with its saved identifier; `max_wait_seconds`
is bounded to 0–600 seconds. Partial sales retain the remaining output for later
settlement. If a mutation's outcome is unknown, inspect the game action log,
queue, cargo, and storage before further work; automatic replay is disabled.

Order depth and quotes can change before execution. Station service APIs do not
offer an atomic maximum-price guarantee, so actual service spending is verified
afterward. Production evaluation covers processing at the current station;
cross-system travel costs and risks need separate evidence. Workshop jobs pause
while undocked. Facility availability, skill gates, and storage/cargo capacity
can prevent an otherwise attractive calculation from executing.

Private receipts live in `runtime/industry.jsonl`,
`runtime/mining-experiments.jsonl`, and `runtime/gameplay.jsonl`. Conversation
decisions and summaries live under the selected runner runtime. Use those
receipts to establish repeated outcomes; model prose and a positive quote alone
do not prove a self-sustaining strategy.
