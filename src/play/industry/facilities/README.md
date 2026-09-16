# industry/facilities — owning production (advanced)

Not before the advanced stage: 500,000+ credits, corporation_management climbing, a home base
you will keep. A facility earns passive corporation_management xp and lets you rent capacity
to others, and it bills rent every 100 ticks (~17 min) from your wallet. 260 unpaid cycles
(~3 days) and the station repossesses it; production facilities are never returned.

| Function | Promise |
|---|---|
| `facilities()` | what you own, the rent bill, the runway, and what is buildable here |
| `buildFacility(type)` | build one here, quarters first; refuses without three days of rent in hand |
| `queueJob(facility, recipe, qty)` | a production job from this base's store |

```ts
import {facilities, buildFacility, queueJob, note} from 'play';

export default async function main() {
  const f = await facilities();
  if (f.detail.owned.some(x => x.runway_cycles < 260)) { note('rent runway under 3 days; earn first'); return f; }
  if (!f.detail.owned.length) return buildFacility('crew_bunk');     // quarters: the prerequisite
  return queueJob(f.detail.owned[0].id, 'steel_plate', 50);
}
```

Rule of thumb: a 100 cr/cycle facility is 8,600 cr/day. Keep a float. `facilities()` names
the runway in `next` every time.
