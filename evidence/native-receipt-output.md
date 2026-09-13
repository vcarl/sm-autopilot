# Native tool receipt repair

The reported blocked gathering reply contained 280,426 bytes. Its mechanical command
journal accounted for 246,584 bytes: thirteen commands each repeated a 13,370-byte
pre-command snapshot, including nearby players and NPCs. Command replies also repeated
station/world data. The top-level error began at character 133,805. A later reconciliation
reply reached 1,199,225 bytes because it returned five complete historical jobs.

The native plugin returned raw bridge replies directly, bypassing the standalone runner's
existing receipt projection. The repair applies a semantic projection at the native handler
boundary. Status, error and stopping reason lead the reply, followed by verified outcomes.
Complete original replies remain in private, content-addressed files under the profile's
`spacemolt/tool-receipts/`, with a path, size and SHA-256 reference inline. Raw service replies
and the executor's durable journal retain their original contracts.

Observation, planning and reconciliation retain the latest historical receipt, latest blocker,
and every unresolved job or command, with counts for other closed history. Historical outcomes
are explicitly labeled. Current observations, candidates and obligations remain inline.
The projection preserves measured yield, partial outcomes, unknown costs, retained output,
custody, command uncertainty, terminal condition and cleanup evidence.

Read-only replay of the user's saved replies measured:

| Reply | Original bytes | Inline bytes | First blocker character |
| --- | ---: | ---: | ---: |
| Blocked gather | 280,426 | 13,495 | 29 |
| Reconciliation | 1,199,225 | 19,077 | 49 |

Inline size varies slightly with the forensic file path. Both saved forensic replies were
independently verified to decode to the complete original object and match their SHA-256.
Private measurements: `/tmp/spacemolt-native-receipts-replay.json`.

Validation passed 60 Python tests across 14 SpaceMolt files using `scripts/run_tests.sh`,
including native handler, bridge/host integration, unchanged service consumers, exact forensic
storage, and bounded growth across 100 closed historical jobs. Log:
`/tmp/spacemolt-native-receipts-tests.log`.

Kvothe's configured Hermes model also ran through the actual native handlers with a simulated
game account. It completed one gathering cycle, reported two ore and five mining XP, distinguished
the nine-credit service cost, and reported the remaining mission obligation and exhausted run.
All nine existing continuation/receipt checks passed with stable prompt and schemas. The model
supplied an invalid assessment `kind: Industry` first, which was rejected; it then gathered
successfully. That model argument error is disclosed and is not repaired by output compaction.
Evidence: `/tmp/spacemolt-native-receipts-model-check.json`.

This model check did not send Discord messages or connect another live pilot. The receipt
repair does not add operating-run renewal or repetition and has not been installed into Kvothe.
