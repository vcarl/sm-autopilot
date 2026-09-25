# exploration — the Scout's evening

"I'll go see what is out there." The first visit to a system is the only thing that trains
exploration; every belt, station and price you see feeds every other career's choices. This is 
the evening to have when the menu keeps offering the same belt.

## Functions

| Function | Promise |
|---|---|
| `exploreNearby({systems?, jumps?, survey?})` | **not built yet — it throws `unimplemented`.** Walk the circuit by hand with `goTo` and `scout`, as the worked example below does |

Until `exploreNearby` is built, this career is `goTo` and `scout` in a loop — both real, both in
the root barrel. `scout(id)` reads a system's POIs, stations and resources; `goTo(id)` flies there
and docks if it is a base. (`survey()` in mining is also not built yet, so hidden deposits are out
of reach for now.)

**This is not `hunt({look})`, and the two are deliberately apart.** `exploreNearby` visits
**systems** you have never been to, docks at each and reads it, and trains exploration by the
first visit. `hunt({look})` walks **POIs inside the system you are already in** and fights what it
finds. They share only a fuel-bounded loop over destinations, which is `goTo` plus a re-quote and
is already in both. Reach for `exploreNearby` to learn the neighbourhood; reach for `hunt({look})`
when you know the neighbourhood and want the prey in it.

## Worked example

```ts
import {orient, scout, goTo, missions, acceptMission, prices, note} from 'play';

export default async function main() {
  const start = await orient();
  const home = start.detail.present.location.docked_at;   // where the circuit returns to

  const board = await missions();
  for (const m of board.detail.board.filter(m => m.fits === 'goTo').slice(0, board.detail.slots_free))
    await acceptMission(m.mission_id);                    // "visit N stations" pays for the trip

  // The neighbours, from the map the orient already read. `goTo` refuses a hop the mood's fuel
  // reserve will not cover, so the circuit stops rather than stranding.
  const here = await scout();
  for (const link of here.detail.connections.slice(0, 2)) {
    const hop = await goTo(link.system_id);
    if (hop.status !== 'done') { note(`stopped at ${link.system_id}: ${hop.why ?? ''}`); break; }
    const seen = await scout();                           // first visit is what trains exploration
    note(`${seen.detail.system.name}: ${seen.detail.pois.length} POIs`);
    const station = seen.detail.pois.find(p => p.base_id);
    if (station) { await goTo(station.base_id!); await prices(); }  // dock and remember the book
  }

  if (home) return goTo(home);
  return here;
}
```

## What a safe circuit looks like

- Three unvisited systems on a loop that ends where it started, inside the fuel reserve with margin.
- At least one station on the loop: a market to read, a board to accept from, fuel to buy.
- `police_level` above 0 on every leg, or an Opportunistic/Aggressive mood that accepts it.

## When to reconsider

- `unvisited` within two jumps is empty: the neighbourhood is known; widen `jumps` or work from a station further out.
- A visited system had a rich belt and a station with storage: that is a base worth working from.

## Pitfalls

- A jump that reports failure has often succeeded. `goTo` reads before it trusts; do not
  re-send jumps by hand.
- Fuel out in a system with no station means a distress signal and an hour's wait. `goTo` refuses a
  hop the mood's fuel reserve will not cover, so check every `hop.status` and stop on the first that
  is not `done` — that refusal is the circuit turning back, and ignoring it is how a ship strands.
