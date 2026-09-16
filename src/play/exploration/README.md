# exploration — the Scout's evening

"I'll go see what is out there." The first visit to a system is the only thing that trains
exploration; every belt, station and price you see feeds every other career's choices. This is 
the evening to have when the menu keeps offering the same belt.

## Functions

| Function | Promise |
|---|---|
| `exploreNearby({systems?, jumps?, survey?})` | visit unvisited systems within reach, dock and read each, come home |

With `scout(id)` (root) for the map before you go and `survey()` (mining) for hidden deposits.

## Worked example

```ts
import {orient, missions, acceptMission, exploreNearby, note} from 'play';

export default async function main() {
  await orient();
  const board = await missions();
  for (const m of board.detail.board.filter(m => m.fits === 'goTo').slice(0, 2))
    await acceptMission(m.mission_id);                  // "visit N stations" pays for the trip
  const trip = await exploreNearby({systems: 3, jumps: 2, survey: true});
  note(`saw ${trip.detail.visited.map(v => v.name).join(', ')}`);
  return trip;
}
```

## What a safe circuit looks like

- Three unvisited systems on a loop that ends at home, inside the fuel reserve with margin.
- At least one station on the loop: a market to read, a board to accept from, fuel to buy.
- `police_level` above 0 on every leg, or an Opportunistic/Aggressive mood that accepts it.

## When to reconsider

- `unvisited` within two jumps is empty: the neighbourhood is known; widen `jumps` or move home.
- A visited system had a rich belt and a station with storage: that is a home candidate. Say
  so in `note()`; the operator sets home.

## Pitfalls

- A jump that reports failure has often succeeded. `goTo` reads before it trusts; do not
  re-send jumps by hand.
- Fuel out in a system with no station means a distress signal and an hour's wait.
  `exploreNearby` turns back at the reserve.
