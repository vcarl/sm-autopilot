# Wildlife hunting

The default runner now uses the job interface described in [README](README.md).
The controller/tool names below document the preserved internal hunting foundation;
model-facing equivalents are `job__assess`, `job__prepare`, `job__track` and
`job__hunt`. The new wrapper adds home, policy, durable receipts and cleanup.
Use a fresh runtime rather than resuming a historical primitive-tool conversation.

From the repository root:

```sh
../hermes-agent/.venv/bin/python spacemolt/runner.py --combat \
  --runtime spacemolt/runtime/combat --iterations 30 --seconds-per-cycle 1800
```

This uses the local Qwen model and the real Hermes loop. The default combat
objective is to prepare, discover an assessable creature, complete one hunt and
return docked. Use a separate runtime for each playstyle; `--resume` continues
the same saved playstyle. Stop any other controller for this pilot first.

The model chooses preparation, destinations and quarry. `combat/hunt` owns the
fight's tactical loop, so inference latency does not prevent a timely withdrawal.
It submits `hunt` once, observes battle status every two seconds, and paces maneuvers at ten-second intervals, with immediate
withdrawal when a safety threshold is crossed. It closes to point blank for accuracy, then fires.

For the fitted pilot at Void Gate Outpost, the verified destination is Horizon's
Phase Drift. Add this objective to the command above to use that discovery:

```sh
--objective 'Hunt one phase_lurker at horizon_phase_drift in horizon using the granted hunt job, then return serviced.'
```

Species and habitat identifiers are reusable; individual creature IDs are not.
The live controller uses elapsed time for maneuver pacing because the server's
`tick_duration` field stayed unchanged across multiple actual combat ticks.

## Threat assessment

`combat/assess` reads current ship state and nearby contacts without moving or
attacking. Omit `target_ids` to compare individual candidates; pass a list to
assess that group as one encounter. A group result is not a sequence of independent
duel approvals. `combat/hunt` still starts one wildlife fight; it does not initiate
multiple attacks or enable PvP.

The pure evaluator in `src/threat-assessment.ts` accepts combatant capability
estimates independently of species, role, or entity kind. It compares effective
durability and outgoing damage with aggregate incoming damage, regeneration,
ammunition, fight duration, escape time, speed and the hull withdrawal reserve.
Every selected, hostile or potentially hostile contact contributes throughout
the estimated encounter. Passive bystanders contribute nothing; neither do
hypothetical friendly reinforcements. Faster opponents are rejected because this
controller has no established escape plan against them.

Results are `engage`, `avoid`, or `need_intelligence`, with the inputs, evidence,
assumptions, estimates and reasons. The initial policy uses 80% outgoing accuracy,
125% incoming damage, three approach ticks, three escape ticks, and the existing
80% hull withdrawal threshold. These are planning margins, not game constants or
victory probabilities. The point-blank tactic still determines approach time;
this is not a range-optimizing combat simulator.

The live adapter in `src/combat-assessment.ts` uses canonical fitted weapon stats
for ourselves. Enemy data is incomplete in the game API, so reviewed intelligence
is required. The initial Phase-Lurker profile is scoped to the observed hull size,
autocannon weapon type and at least the observed armor. Its damage and durability
come from our recorded fights; speed 2 is an explicit planning assumption. Those
observations are not guaranteed upper bounds. Other species/loadouts need more
intelligence; a grazer label alone no longer grants an attack. Predator roles
alone do not prohibit an assessed fight. Unknown predators and pirates are treated
as possible threats; passive fauna and unrelated players are bystanders. An
unknown cloaked signature blocks commitment. Actual battle participants supersede
those participation assumptions. Unknown empire/arena combat capabilities are
not inferred from names or affiliations; unrelated NPCs are not credited as allies.

The hunt records candidate assessments, scans, refreshes nearby contacts, and
reassesses immediately before commitment. It then reassesses actual battle
participants and remaining time at each poll; a newly unfavorable estimate
latches withdrawal. A successful scan currently adds hull/description evidence,
not the missing numeric weapons and mobility data, so scanning alone does not
clear `need_intelligence`.

## Tools

- `combat/assess`: assess ourselves against a target or aggregate group at the
  current location; observation only.

- `combat/prepare`: inspect exact module requirements and quote a fit, then use
  `execute: true` to apply it. It preserves fitted modules and checks skills,
  CPU, power, cargo, slots and purchase budgets. It supports ammo-free weapons
  and autocannons with large magazines. Autocannons use matching ammo from cargo,
  storage or live market supply; preparation carries two boxes before loading.
- `combat/scout`: visit up to three habitats in the selected system, record
  creatures, scan a candidate, and return to the departure station.
- `combat/hunt`: travel from a docked station to a selected habitat,
  choose a fresh individual of the requested `species`, scan it, fight, collect identifiable carcass cargo on a
  verified victory, and return docked.
- `combat/history`: recent fitting, observation and sortie receipts.

Navigation and `industry/locations` remain available for moving between systems
and finding stations. Both sorties accept `target_system_id` for a destination
up to two normal jumps away and return to their departure station. This allows
hunting in stationless systems. Return routes and fuel are checked again before
coming home; the outbound budget includes a margin for carrying loot back.
Wildlife habitats are asteroid belts, gas clouds, ice fields and nebulae, rather
than planetary surfaces. A mining laser is not a weapon.

Prefer `species` to a saved `creature_id`: the live trials showed that entire
groups could have new individual IDs by the return trip. An explicitly requested
individual is never silently substituted. With neither filter, the controller
chooses an eligible creature with the lowest estimated fight time at the selected habitat.

## Readiness and engagement limits

There is no grazer-only rule or global target hull cap. Ownership and an existing
unrelated battle remain execution constraints: only unowned creatures available
for a new hunt can be selected. No
player, pirate, station, prize or predator attacks are exposed to the model.
Starts require full hull and shields, at least 30 fuel, ten free cargo units,
a supported weapon and a 150,000-credit reserve. Automatically received distress
missions do not block hunting or replace its objective.
Autocannons must have at least 100 rounds loaded before departure.

The offensive budget defaults to 24 ticks and can be lowered. Withdrawal
latches at 80% hull (or a higher caller-selected threshold), low fuel, an empty
magazine, an unfavorable reassessment of participants, missing tactical information or the time
budget. Flee stance continues until participation ends; a budget is not a
reason to disconnect in combat. An unexpected battle during scouting also
triggers withdrawal. Escape is not guaranteed by these thresholds.

Transport uncertainty stops further commands and is recorded as an interrupted
sortie. Inspect live battle/state and the receipts before resuming; do not
blindly replay the hunt. Known normal battle-end races are reconciled against
fresh status. The controller does not yet recover autonomously from a lost
connection during a fight.

## Accounting and supply

Private receipts are in `runtime/combat.jsonl` and `runtime/gameplay.jsonl`;
model choices and checkpoints are under the selected runtime. Victory requires
the battle summary to confirm our winning side. Disappearing wildlife alone
does not count as a kill. Carcass loot stays in cargo, and is not cash profit.
Restore fuel and hull after returning; sorties record outstanding liabilities.
Equipment purchases and consumed ammunition are separate costs.

If ammunition is unavailable, `inspect standard_rounds_box` identifies its
current recipe. During the initial setup, `manufacture_standard_rounds` converted
one steel plate into five boxes in personal station storage. The combat mode
does not automatically craft missing equipment or ammunition.

Contracts and tactics were checked against the installed library and the
[wildlife](https://spacemolt.com/docs/wildlife) and
[combat](https://spacemolt.com/docs/combat) guides on September 9, 2026. Query
current state and prices; historical availability is not a standing offer.

## Live result — September 9, 2026

The actual Hermes agent killed a 55-hull Phase-Lurker in Horizon Phase Drift
in seven ticks, collected one creature carapace and one phase pearl, and
returned to Void Gate Outpost without hull damage. It consumed six rounds.
A separate Hermes service run restored ten fuel for 30 credits after the
hunting session exhausted its model iteration budget. Final wallet: 197,923;
hull 105/105, shields 35/35, fuel 120/120, magazine 489/500.

Setup cost 4,485 credits; total development spending including exploratory
travel and the earlier stalemate was 4,731 credits. Loot remains unsold.
This proves one guided destination-to-victory sortie, not reliable unguided
discovery, profitability, or connection recovery. See
[the reviewed receipt](evidence/combat-proof.json) for measured progression,
accounting and the limitations of this trial.


## Assessment validation

The generic assessment has unit coverage for aggregate pressure, stronger ships,
large targets, unknown contacts, insufficient ammunition and damaged hulls. The
sortie test exercises the real command boundary and refuses a new threat that
appears after scanning. Reassessment accounts for remaining approach distance
rather than repeatedly charging the full approach after closing range.

A replay of recorded live contact/ship data approves one Phase-Lurker with an
estimated four-point reserve margin and rejects two simultaneous Phase-Lurkers.
See [the replay receipt](evidence/threat-assessment.json). The new `combat/assess`
bridge path was also exercised read-only at Frontier Station. No new live fight
has been run under this revised policy; the five historical fights validate the
previous controller and provide intelligence, not proof of this new policy.
