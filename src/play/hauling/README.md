# hauling — the Carrier's evening

"I'll carry something for someone." Freight builds a carrier tier that nothing else builds;
passengers pay the best fares in the game and the only cheap reputation. Both are trips you
plan by deadline, not by cargo value, and both punish a trip you cannot finish.

## Functions

| Function | Promise |
|---|---|
| `freightBoard({destination?, limit?}?)` | the board here, filtered to what you may take, each with a route quote, sorted by net reward per fuel |
| `haul(shipmentId)` | accept, withdraw the package, fly, deliver; re-entered per leg from the live world |
| `carryPassengers(destination?)` | load everyone waiting for a base, fly, land only the ones whose stop it is |

## Worked example

```ts
import {orient, freightBoard, haul, carryPassengers, service, note} from 'play';

export default async function main() {
  await orient();
  const board = await freightBoard();                 // already filtered and already sorted
  const pick = board.detail.listings.find(l => l.fits && l.reachable);
  if (!pick) { note('nothing here fits the hold; try passengers'); return carryPassengers(); }

  const trip = await haul(pick.contract.id);          // accept → withdraw → fly → deliver
  if (trip.status !== 'done') return trip;            // partial: the contract is still active
  await carryPassengers();                            // the return leg, best-paying destination
  return service();
}
```

`haul` is safe to run twice with the same id: an active contract skips the accept, a package
already in the hold skips the withdraw, and standing at the destination skips the flight. That
is how a `partial` resumes — `service()`, then `haul` the same id again.

## What a good contract looks like

- It is on `freightBoard().detail.listings` at all. Anything your tier, your remaining
  aggregate liability or `permissions.max_liability` refuses is dropped from that list, so the
  rows you see are the rows you may take. `liability` on each row is the `reserved_exposure`
  it puts against the allowance.
- `fits: true`. A sealed package occupies exactly **100 cargo**, whatever is inside — an early
  package filled 100 of a 125 hold. Nothing fits in a starter hull.
- `reachable: true` — the tank covers the quoted `fuel`. Arriving under your mood's fuel reserve makes you Tired.
- `net` is `base_reward` less the fuel bill at this base's `fuel_price_all_in`, and the list is
  sorted by `net / fuel`. A 148 cr package one jump away beats 1,295 cr four jumps away unless
  you were going there anyway.
- The deadline is **not** checked for you. `deadline_ticks` is in ticks and the route is in
  jumps, and the lib publishes no tick cost per jump; read it and judge.

## The tier ladder

| Tier | Deliveries | Delivered value | Per package | Aggregate |
|---|---:|---:|---:|---:|
| Probationary | 0 | 0 | 5,000 | 10,000 |
| Licensed | 5 | 250 | 50,000 | 100,000 |
| Trusted | 20 | 250,000 | 500,000 | 1,000,000 |
| Prime | 50 | — | unlimited | unlimited |

Read `detail.profile.capacity` live; the numbers move, and a live probationary carrier has been
seen at 25,000 / 50,000. Self-shipping earns no tier progress.

## Passengers

`carryPassengers(destination)` boards everyone waiting here for that base, flies, and puts off
**only** the passengers whose destination is this stop. With no argument it takes the
destination with the highest total estimated fare on the board.

- Berths are a hull decision: a liner's built-in berths or a passenger cabin module in a utility
  slot. No berths is `refused`, not a script problem — `shipsForSale()` or `refit`.
- `load_passenger` boards by *destination*, not by name, so the class ordering inside one call
  is the server's — the guide says its loader seats the pickiest traveller first. `loaded`
  reports the `berth_class` it assigned, first class first.
- First-class deliveries pay +1 standing with the passenger's empire, which is why each
  passenger is unloaded by their own id rather than in bulk.
- Somebody still aboard bound elsewhere makes the Outcome `partial`, with `next` naming their
  destination and the ticks left on their guarantee.

## Pitfalls

- Failure debt blocks all future acceptance. `haul` refuses on `debt_blocks_acceptance` and
  never accepts what it cannot finish; do not accept by hand on `account()` either.
- An accepted package lands in your **personal storage at the origin**, not in the hold. Check
  the origin has a storage counter before accepting; a mission board alone does not guarantee
  one. `haul` withdraws `package:<id>` and confirms it is aboard before leaving.
- `unload_passenger` with `all` at an intermediate stop strands everyone at −1 standing each.
  `carryPassengers` only ever lands a passenger at their own stop; the flight computer refuses the
  literal on `account()`.
- A stale board: the listing can be gone when you accept. `haul` re-reads the contract first.

## When to reconsider

- Five deliveries done and the tier moved: the board just got bigger; look again.
- `fare_surge > 1.5` on the passenger board: a surge beats a routine package.
- Every row `fits: false`: the constraint is the hold, not the board.
