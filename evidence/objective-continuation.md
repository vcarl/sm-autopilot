# Native objective continuation and batch crafting

This repair addresses the Discord gather blocker reported after the original
[rules-engine comparison](rules-engine-comparison.md). That historical comparison
remains the before/after Industry and Logistics report; the checks below exercise
subsequent lifecycle and receipt repairs.

## Changed behavior

| Boundary | Previous behavior | Repaired behavior |
| --- | --- | --- |
| Native job allowance | A known readiness blocker or completed productive attempt latched `one_job` | Objective mode permits the next useful job; explicit non-Tired planning resumes a stopped objective after reconciliation |
| Budget | Each bounded job had its own ownership history | Native objective spending includes prior jobs without resetting allowance on plans, messages or reconnects |
| Equipment | Gathering required the laser already in cargo | Existing assess/prepare discovers owned storage, retrieves and fits the laser, preserves the displaced cabin and cargo, and verifies return/service |
| Travel and gathering | Mood hop/cycle ceilings could block the stated goal | Objective batches use observed routes and requested cycles, with physical reserves and spending checks |
| Crafting | More than one recipe run was rejected; output requests capped at 1000 | Positive safe-integer output requests may span runs; per-run output is aggregated once, and total inputs/costs remain the server quote |
| Native receipts | Large command journals buried the outcome; requested and actual quantities were easy to confuse | Outcome-first summaries name verified output, consumed inputs, remaining cargo, and spending; exact full replies remain private forensic artifacts |

The crafting wait bound is per call, not a production-size limit. Pending work
retains its experiment ID and resumes settlement without re-enqueueing. Uncertain
acceptance still requires reconciliation. Standalone explicit `one_job` behavior
remains available.

## Validation

- Typecheck and 141 Node tests passed: `/tmp/spacemolt-multirun-green.log`.
- The new multi-run invariant failed against the old executor, which returned
  `blocked` instead of `completed`: `/tmp/spacemolt-multirun-red.log`.
- The required Python runner passed 66 tests across 16 files:
  `/tmp/spacemolt-objective-final-python-batch.log`.
- Production invariants cover rounded output requests, aggregate costs and sale
  proceeds, retained output, queued resumption without duplicate crafting, and
  requests above the removed ceiling.

## Configured-model checks

These use Kvothe's actual Hermes model, `custom:omlx` /
`mlx-community--Qwen3.6-35B-A3B-4bit`, through real native registration, Python service,
JSONL bridge, and ExecutionHost against a simulated game and temporary `HERMES_HOME`.
They do not contact the real pilot or deliver Discord messages.

The first model check completed the mechanics but misstated consumed and produced
quantities. Explicit verified accounting in native receipts corrected that defect.
The second check passed the full goal with single-run production. The first batch
check then exposed a separate simulation error: the fixture supplied aggregate
outputs where the server contract supplies per-run outputs. That failed check is
preserved, and its fixture must be corrected before accepting the batch result.

Private model evidence: `/tmp/spacemolt-objective-model-check-first.json`,
`/tmp/spacemolt-objective-model-check-second.json`, and
`/tmp/spacemolt-objective-model-check-third.json`. The corrected fourth run is recorded in
`/tmp/spacemolt-objective-model-check-fourth.json`. It verified an initial two-run
batch: four ore consumed, four metal retained, six crafting credits, and Crafting
level 1 → 2. However, Hermes rewrote the goal from any Industry skill to Mining,
and continued gathering and crafting after the requested threshold was already
met. This fails goal-level stopping acceptance. Repeated new completed experiments
are distinct from replaying an uncertain craft command; the harness's exactly-one
craft gate measures excess work here, not an observed duplicate submission.

## Installation

Installed source commit: `07e5c6f80880f16e1550bd56640597cff1f0e5cc`.
All 179 installed files match Git; pinned Node dependencies installed successfully.
The four existing profile runtime files were unchanged through installation.
Kvothe's existing launchd gateway was restarted and connected to Discord at
20:28:33 local time on September 13. No live game action was performed by this
installation. Verification: `/tmp/spacemolt-objective-install-verification.json`.
The pre-install source backup is `/tmp/spacemolt-pre-objective-install.tar.gz`.

A fresh Discord conversation is required to load changed static schemas and
skills. The live task remains for Hermes; the suggested instruction names Crafting
explicitly to avoid the model's observed narrowing of the broader Industry goal.

## Live handoff and timing limits

The operator trip was stopped at Carl's request. The last authenticated observation
placed Kvothe undocked at Unknown Edge Waystation, out of transit, with 99/120 fuel,
full hull/shields, ten Steel Plate and the fitted passenger cabin. The owned mining
laser was not withdrawn. Hermes will perform the retrieval and objective itself.

Craft assessments expose estimated duration and completion tick. Pending job ETA
is available indirectly in queue custody but is absent from the primary outcome
summary. Travel calls wait synchronously for arrival; they do not stream progress
to Hermes. These are remaining timing-presentation limitations, not proof that a
pending job has completed.
