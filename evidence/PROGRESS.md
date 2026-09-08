# Verified live results — September 8, 2026

The requested manual and autonomous gameplay proofs are complete.

| Phase | Starting wallet | Ending wallet | Net gain |
| --- | ---: | ---: | ---: |
| Manual Kvothe play | 130,566 | 181,683 | 51,117 |
| Hermes session 1 | 181,683 | 191,396 | 9,713 |
| Hermes session 2 | 191,396 | 201,380 | 9,984 |

Manual play completed seven missions and one freight delivery. Gross payouts
were 53,148; fuel cost 356 and Cargo Expander II cost 1,675 including tax.
The expansion increased capacity to 125. Original cargo and mining equipment
were preserved. See `manual-proof.json` for the ledger and canonical end state.

Actual Hermes `AIAgent`, using local omlx model
`mlx-community--Qwen3.6-35B-A3B-4bit` (non-MTP), then chose and executed 71 game
tool calls over two sessions. Six freight deliveries paid 19,760 credits;
63 credits of fuel produced **19,697 net profit**. Every game tool call succeeded.
The agent chose jobs, accepted and loaded packages, navigated, delivered,
refueled, and checked progression without corrective gameplay intervention.

The server confirms progression from probationary to licensed carrier. Successful
deliveries rose from one to seven; delivered value rose from 14,168 to 80,112.
Single-package liability rose from 25,000 to 50,000 and aggregate liability from
50,000 to 100,000. The last return shipment paid 8,845 credits.

Both autonomous sessions ended docked, fuel 120/120, hull 80/80, unchanged cargo,
zero active contracts and zero debt. Final location: Frontier Station, Void Gate.
The bounded runner exited successfully and closed its game connection.

See `autonomous-proof.json` for independent session measurements, individual
shipment and fuel receipts, the model's requested actions, and a hash of the
private detailed log. Actual saved Hermes history is in ignored
`runtime/live-non-mtp/checkpoint.json`; full receipts are in `decisions.jsonl`.

## Limits of the evidence

This demonstrates profitable, repeatable freight operation and progression under
observed live conditions. It does not establish indefinite unattended uptime or
competence in every play style. The model's prose summaries contain arithmetic,
counting, and board-scope errors; authoritative wallet and carrier fields above
are the source of truth. Context compression occurred during the live run with
the same local model configured for auxiliary tasks.

Validation: TypeScript typecheck, two Node policy/reconciliation tests, four
Python integration tests through `scripts/run_tests.sh`, and a real local-model
fixture tool call passed. Hermes core files remain unchanged.
