# hauling — the Carrier's evening

"I'll carry something for someone." Freight builds a carrier tier that nothing else builds;
passengers pay the best fares in the game and the only cheap reputation. Both are trips you
plan by deadline, not by cargo value, and both punish a trip you cannot finish.

## Functions

| Function | Promise |
|---|---|
| `freightBoard()` | the board here with a route quote per listing, your profile, your active contracts |
| `haul(shipmentId)` | accept, withdraw the package, fly, deliver; resumes per leg |
| `carryPassengers(destination?)` | load everyone bound for a base, fly, land them; never strands |

## Worked example

```ts
import {orient, freightBoard, haul, carryPassengers, service, note} from 'play';

export default async function main() {
  await orient();
  const board = await freightBoard();
  const pick = board.detail.listings
    .filter(l => l.eligible && l.fits && l.reachable)
    .sort((a, b) => b.contract.base_reward / b.fuel - a.contract.base_reward / a.fuel)[0];
  if (!pick) { note('nothing eligible here; try passengers'); return carryPassengers(); }

  const trip = await haul(pick.contract.id);
  if (trip.status !== 'done') return trip;            // partial: package aboard, service and haul again
  return service();
}
```

## What a good contract looks like

- `eligible: true` (tier allows it) and liability under `permissions.max_liability`.
- Reward per fuel unit is the ranking. A 148 cr package one jump away beats 1,295 cr four jumps
  away only if you were going there anyway.
- The deadline is reachable at your mood's fuel reserve: `reachable: true`.
- The package fits: an early package occupied 100 cargo of a 125 hold.

## The tier ladder

| Tier | Deliveries | Per package | Aggregate |
|---|---:|---:|---:|
| Probationary | 0 | 5,000 | 10,000 |
| Licensed | 5 | 50,000 | 100,000 |
| Trusted | 20 | 500,000 | 1,000,000 |
| Prime | 50 | unlimited | unlimited |

Read `profile` live; the numbers move. Self-shipping earns no tier progress.

## When to reconsider

- Five deliveries done and the tier moved: the board just got bigger; look again.
- Passengers waiting with `fare_surge > 1.5`: a surge is worth more than a routine package.
- No berths on the hull: passengers are a hull decision (`shipsForSale`), not a script one.

## Pitfalls

- Failure debt blocks all future acceptance. `haul` never accepts what it cannot finish; do not
  accept by hand on `account()` either.
- `unload_passenger` with `all` at an intermediate stop strands everyone. `carryPassengers`
  only ever lands a passenger at their own destination; the validator refuses the raw call.
- A stale board: the listing can be gone when you accept. `haul` reads it again first.
