# Rules engine comparison

The comparison is complete: both live Industry and controlled Logistics pairs delivered verified
results and ended fully serviced. The original Kvothe gateway is restored. Baseline Logistics
exceeded the prompt's transport-call limit, as disclosed below. Results come from canonical game
receipts and sanitized summaries.

## Sources and method

| Arm | Source commit | Audited source manifest | Industry evidence |
| --- | --- | --- | --- |
| Before | `b72215ac34` | 117 file hashes | `/tmp/spacemolt-rules-ab-verified/before/industry/summary.json` |
| After | `fd4c2957e8` | 120 file hashes | `/tmp/spacemolt-rules-ab-verified/after/industry/summary.json` |

The frozen baseline is at
`/var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/spacemolt-rules-before-8hwhdo_g/spacemolt`.
Each summary retains SHA-256 hashes of plugin Python, TypeScript, and skill files, plus loaded
plugin, bridge, and Hermes core paths. Policy version identifiers remain unchanged; the source
manifests and rule IDs distinguish the implementations. Private receipts sit in `private.json`
beside each summary; temporary evidence is not a release artifact.

Both arms use Kvothe's configured Hermes runtime: `custom:omlx`, `chat_completions`,
`mlx-community--Qwen3.6-35B-A3B-4bit`, at `http://127.0.0.1:8000`. Each workload gets a fresh
process, disposable `HERMES_HOME`, operating run, and native service/bridge. This exercises the
actual AIAgent, plugin registry, service, and TypeScript execution path while the gateway is paused.
Credentials remain in the profile's scoped secret loader.

The measured workload order is before Industry, after Industry, before Logistics, after Logistics.
Each pair uses the same prompt, native tool grant, model limits, and handoff/follow-up behavior;
Industry protocol and runtime objects have been checked equal. Tool schemas and the system-prompt
prefix stay fixed within each session; plan handoffs create fresh sessions. At most two normal
follow-up turns are available. No external-chat tool is granted.

These historical runs exercised isolated Hermes sessions, not Discord message delivery. A later
Discord investigation found that the native service's conversation-ID handoff gate could not be
cleared by an ordinary follow-up message. The comparison harness explicitly created fresh
sessions, so these results do not establish Discord handoff correctness. The native lifecycle
repair is recorded separately in `TODO.md`; the source identities and measurements here remain
those of the original comparison.

Industry permits one Focused local gather call with `cycles=1` and no discretionary purchases.
Logistics permits one Focused transport call with no equipment purchase. Success requires measured
yield or matching delivery/payment evidence, plus a canonical terminal observation: docked, out of
transit, fully fueled, repaired and shielded, and not incapacitated. Unknown outcomes do not count.

## Completed Industry pair

| Metric | Before | After | After minus before |
| --- | ---: | ---: | ---: |
| Verified result | Completed; terminal ready | Completed; terminal ready | Same |
| Gather cycles | 1 | 1 | 0 |
| Retained yield from this run | 1 Iridium Ore | 3 Carbon Ore | Different live yield |
| Starting → ending credits | 193,628 → 193,622 | 193,622 → 193,616 | — |
| Credit delta / gross game spend | -6 / 6 | -6 / 6 | 0 / 0 |
| Model cost estimate, USD | Unknown | Unknown | Unknown |
| API calls | 9 | 10 | +1 |
| Input tokens | 27,186 | 36,692 | +9,506 |
| Output tokens | 3,336 | 3,281 | -55 |
| Cache-read tokens | 69,632 | 98,304 | +28,672 |
| Cache-write tokens | 0 | 0 | 0 |
| Total tokens | 100,154 | 138,277 | +38,123 |
| Model tool calls | 6 | 7 | +1 |
| Sessions / follow-up turns | 2 / 0 | 2 / 0 | 0 / 0 |
| Elapsed seconds | 146.400 | 149.877 | +3.477 |

Productive receipts: before `6eb46e83-14a7-44a3-b375-92916bf3c31f`; after
`1c3ce92f-0046-410a-8594-d4eea4a7e940`. Both gathered at Unknown Edge Mineral Fields and
returned to Unknown Edge Waystation. Each six-credit wallet decrease matches gross service spend.
The candidate retained the baseline's one Iridium Ore alongside its three new Carbon Ore.

Before called observe twice and plan, assess, gather, reconcile once each. After called observe
three times, assess twice, and plan and gather once each. Both also had the same harness cleanup
calls: observe twice, reconcile once, return once. Neither ended with active freight, onboard
passengers, or queued production; final observations contained one and seven pre-existing distress
missions respectively. Neither has an outcome blocker; model cost remains unknown.

## Completed controlled Logistics pair

Setup recorded in `/tmp/spacemolt-controlled-freight-nova.json` created two equal, eligible, invited
freight offers from `nova_terra_central` to `sirius_observatory_station`, one hop. Each contains
one Iron Ore; Kvothe is shipper, recipient, and invited carrier. Each contract has base reward 10,
service fee 25, failure liability 500, and reserved exposure 3. Both Hermes runs completed.

Evidence: `/tmp/spacemolt-rules-ab-controlled/{before,after}/logistics/summary.json`, with private
receipts beside each summary. All 117 baseline source hashes match `b72215ac34`; candidate
records 120 hashes matching `fd4c2957e8`. Final auditing found zero source-hash mismatches;
Logistics protocol and runtime objects match between arms.

| Metric | Before | After |
| --- | ---: | ---: |
| Verified result | Completed; terminal ready | Completed; terminal ready |
| Starting → ending credits | 192,450 → 192,412 | 192,412 → 192,374 |
| Credit delta / gross game spend | -38 / 48 | -38 / 48 |
| Delivery payout (returned escrow) | 10 | 10 |
| Model cost estimate, USD | Unknown | Unknown |
| API calls | 12 | 10 |
| Input / output tokens | 46,455 / 2,981 | 41,703 / 2,584 |
| Cache-read / cache-write tokens | 165,888 / 0 | 118,784 / 0 |
| Total tokens | 215,324 | 163,071 |
| Model tool calls | 9 | 8 |
| Sessions / follow-up turns | 2 / 0 | 2 / 0 |
| Elapsed seconds | 314.941 | 315.389 |
| Retained cargo | 10 Steel Plate | 10 Steel Plate |
| Final obligations | One posted setup offer; 0 passengers; 0 queued production; 4 distress missions | No active freight; 0 passengers; 0 queued production; 4 distress missions |
| Outcome blockers | None | None |

Baseline job `fbbf5422-acfa-439d-8f6f-ab2dd041e306` delivered contract
`13d182b83fbcc86e070b6ff3479d0c0d` and returned fully serviced to Nova Terra Central. That package
had the operator label “after”; Hermes selected it from two economically equal offers. Contract
`8549f562af2e23915952180c863876aa` remained posted without onboard custody after baseline;
candidate job `25f3b6a1-93a5-4fee-b86c-d3b264b1786c` then delivered it and returned serviced to
Nova Terra Central. Labels do not identify the delivering implementation; source manifests and
job receipts do. Each sealed package occupies 100 cargo despite containing one ore;
baseline free space fell from 110 to 10 while loaded. Its 48-credit spend was six fuel at eight
credits per unit (12 market cost plus 36 tax), with no unpriced actions.

Baseline made three assessments, two observations, one plan, one return, and **two transport
calls**. The first transport call lacked a planned home and made no mutation; Hermes then corrected
the plan through a handoff and completed one productive job. This violates the prompt's at-most-one
transport-call instruction, despite completing only one delivery. Successful delivery therefore
does not establish full protocol adherence. Candidate made one transport call, two assessments,
two observations, and one each of plan, reconcile, and return; both had identical harness cleanup
calls. Both delivery receipts show intact settlement and payout 10, and both retained ten Steel
Plate. No active freight or package cargo remained after candidate cleanup.

Across the two measured workloads per implementation (setup excluded):

| Combined metric | Before | After | After minus before |
| --- | ---: | ---: | ---: |
| Credit delta / gross game spend | -44 / 54 | -44 / 54 | 0 / 0 |
| API calls / model tool calls | 21 / 15 | 20 / 15 | -1 / 0 |
| Input / output tokens | 73,641 / 6,317 | 78,395 / 5,865 | +4,754 / -452 |
| Cache-read tokens | 235,520 | 217,088 | -18,432 |
| Total tokens | 315,478 | 301,348 | -14,130 |
| Elapsed seconds | 461.341 | 465.266 | +3.925 |

The excluded Logistics setup reduced the wallet by **1,166 credits**, from 193,616 after Industry
to 192,450 before transport:

| Setup step | Wallet decrease | Ending credits |
| --- | ---: | ---: |
| Restore cabin | 0 | 193,616 |
| Unknown Edge → Sirius | 168 | 193,448 |
| Initial purchase of two Iron Ore | 4 | 193,444 |
| Produce ten Steel | 146 | 193,298 |
| Sirius → Nova Terra | 24 | 193,274 |
| Buy inputs, pack and post both freight offers | 824 | 192,450 |

Production and transfer receipts are `/tmp/spacemolt-controlled-freight-produced.json` and
`/tmp/spacemolt-aluminum-trip/receipt.json`. Finished containers were available at Nova Terra, so
two were purchased instead of continuing container manufacture; ten Steel remain in cargo.
Earlier gathered ores and the mining laser remain in personal storage at Unknown Edge.

The container buy response reports 706 credits; its quote includes another 14 in tax. Using
that tax-inclusive 720, plus 12 for Iron Ore, 22 packing escrow (10 labor and 1 fee per package),
and 70 for shipping reconciles the authoritative 824-credit wallet decrease. Shipping comprises
50 fees and 20 reward escrow. Aggregate `craft_cost` fields are null, not zero. A self-shipped reward paid back from escrow is
returned capital, not external income. These setup costs stay outside arm metrics; the controlled
job tests delivery mechanics, not open-market freight profitability.

## Excluded diagnostics and setup

These attempts remain evidence of limitations; none fills a final Logistics result slot.

| Evidence root | Observed limitation |
| --- | --- |
| `/tmp/spacemolt-rules-ab/before` | Industry had no observed local asteroid belt at Frontier Station. Logistics stopped with prose after three API calls and made no delivery mutation. This motivated the bounded follow-up and handoff controls used by both final arms. |
| `/tmp/spacemolt-rules-ab-final/before` | Industry job `25dcff04-252d-433d-ae63-85db392e22d8` could not fit its carried mining laser because both utility slots were occupied. Logistics job `84b2aa11-8556-4cdf-8440-1bf57791987a` accepted contract `71e521e6f4ddf08629c97c6589581830`, then could not load its 100-unit package into 99 free cargo. Package `b87c597c1aad42dd71fb3d6d65d63340` remained verified in origin storage; no delivery or payment occurred. |
| `/tmp/spacemolt-rules-ab-verified/before/logistics` | Twelve model tool calls included seven assessments and one malformed transport call mixing freight with passenger destination `ramens_rest` and inventing that station ID as the shipment ID. It delivered nothing, spent zero, and ended serviced without active freight. This is an excluded diagnostic, not the controlled baseline. |

Prepositioning to Unknown Edge cost 9 credits, excluded from arm metrics; receipt:
`/var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/spacemolt-preposition-mv8ei7xc/preposition.json`.
Subsequent recovery/refit verified no active freight, no shipping debt, no package custody, and an
unchanged wallet of 193,628. The mining laser was fitted; displaced cabin and other starting cargo
were preserved in personal storage; ship cargo was empty. Receipt:
`/var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/spacemolt-finish-setup-f7y02itg/receipt.json`.
Zero debt was established by fresh shipping-profile evidence, not inferred from the return response.

## Interpretation and validation

The sequential runs share a changing live world and pilot. Wallet, inventory, progression,
missions, resources, offers, hazards, server ticks, and model samples can differ. The retained
baseline ore and different distress-mission counts expose that state carryover. Ore yield and
latency/token differences cannot be attributed solely to the rules engine. This small comparison
does not establish general performance, reliability, profit, or cache-efficiency improvements;
unknown local-model cost is not zero.

Node checks passed 132/132 and TypeScript type checking passed. Final Python validation passed
61 tests across 15 files with zero failures: 57 core tests in
`/tmp/spacemolt-rules-python-acceptance.log` and four skill tests in
`/tmp/spacemolt-rules-skills-acceptance.log`. The verified combined artifact is
`/tmp/spacemolt-rules-ab-completed/comparison.json`, assembled from the selected Industry and
controlled Logistics summaries. Both pairs have equal protocol/runtime objects and exact source
manifest matches (117 baseline files, 120 candidate files).

Before restoration, canonical process checks found no remaining test gateways/controllers and
both controlled-test lock sets were empty. Starting the original existing Kvothe gateway exited
successfully; status verified launchd PID `80501` and a service definition matching the existing
Hermes installation.
