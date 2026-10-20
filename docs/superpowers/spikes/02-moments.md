# Moment scorer: the event catalogue and dry runs (2026-10-17)

**Question.** Which events can a picture be about, and does a scored "most exciting span" pick the right one?

**Method.**
- A catalogue of every event the game can send, from `@spacemolt/lib` 15.2.0, `src/wire.gen.ts` and the public WebSocket
  docs: 59 push types (plus 43 sub-variants of `ok`, `fleet` and unsolicited `action_result`), 197 eventful command
  replies, 99 read-only queries excluded, 12 categories. No scores.
- `src/picture/moments.ts`, run by `scripts/moments.ts` over seven of Kvothe's junctures from the journal (no frame log
  existed for those flights), before and after five fixes: a half line from the scope's median to its peak, a 12-minute
  span cap, typical size per (type, field), the scope from the previous picture to this run's end, and half the rarity
  term for a dull event. A `stranded` line scores as a hazard.

**Findings.**
- The lib's `onReceive` sees every inbound frame, push or reply, once and in order, before correlation: the tap point for
  a raw frame log. `pushJournal` sees only its 14 allowlisted types and never a reply.
- `exchange_fill` starts muted for every pilot and never arrives; `market_update` and `observation_update` need a
  subscription we never make.
- After the fixes, moments are short and local (the longest winner 6.3 min), so a steady hunting shift splits into
  hundreds of near-equal moments (506 in one six-hour scope), decided by tenths of a point.
- Big sales max out the change term on the data's word: a 3,120 cr sale is 6–9x Kvothe's median sale.
- A thin scope gives a thin picture: 44 minutes holding two `accept_mission`s pictures a job handed over.
- The journal loses opponents (`combat.json` keeps 60 fights), and a failed hunt (`action_error`, filed under system)
  scores nothing.

**Verdict.** Score from the raw frame log, not the journal.

**Kept:** the scorer with the five fixes, the catalogue as `src/picture/catalogue.ts`, the frame log as the source
(`frames.jsonl`, read 72 h back). **Added after:** the majority rule (the category of most of the pilot's own commands,
unless a fight, a death or a first find overrides), because the best-scoring moment alone drew one argon deposit for five
hours of gas harvesting; and a distinct second moment (`oracle.ts` `secondMoment`).
