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

`haul` is safe to call twice with the same id: an active contract skips the accept, a package
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

`carryPassengers(destination)` boards everyone waiting here for that base and flies there. With no
argument it takes the destination with the highest total estimated fare on the board. Docking at a
passenger's stop delivers them and pays the fare; anyone bound elsewhere stays aboard, and the
Outcome is `partial`, with `next` naming their destination and the ticks left on their guarantee.

The fare is `(200 + 150 × hops) × class × remoteness × surge`, plus a speed bonus:

| Factor | Value |
|---|---|
| class | economy 1, business 2.5, first 6 |
| remoteness | ships active or parked at the destination: 0–1 → 1.5, 2–5 → 1.25, 6–15 → 1, 16+ → 0.85 |
| surge | the origin's `fare_surge`, 0.6–2.0 |
| speed bonus | up to +50%, falling in a straight line as the guarantee runs down |

- **The guarantee** is `540 + 180 × hops` ticks (90 minutes plus 30 a jump). Past it a passenger
  pays nothing, costs −1 standing with their empire, and is put off at your next dock.
- **Surge.** Every 100 ticks a station moves `fare_surge` by 0.1: up while five or more wait or the
  oldest has waited 300 ticks, down when everyone is picked up within 100. A neglected station pays
  more; a well-served one pays less but spawns more trips. A station whose citizen pool is under
  50,000 cr spawns none, and `skipped_unfunded` on a load counts fares it could not escrow.
- **Berths.** Hull and cabin berths add up. A berth seats its own class or lower (first seats
  anyone, economy only economy), and a better berth does not raise the fare. `loaded` reports the
  `berth_class` each passenger got.
- **The hull.** No berths is `refused`. A liner has berths built in (`shipsForSale()`). Any hull with
  a free utility slot takes `economy_passenger_cabin` (12 berths, 6,000 cr),
  `business_passenger_cabin` (6, 22,000 cr) or `first_class_passenger_suite` (3, 75,000 cr) by
  `refit({install: [...]})`. A fast hull keeps more of the bonus.
- **Comfort and service.** Comfort (liners, and modules like `onboard_galley`) stretches the
  guarantee 1% a point, at most +200%, fixed at boarding. Underway, every 30 ticks, dining points
  serve each passenger an item whose `food_type` is `dish` or `drink` from your hold, and leisure
  points one whose `food_type` is `alcohol` or `drink` (food types, not item ids),
  and each serving pays you. Docked, or with a dry hold, they earn nothing: stock before you undock.
- **Standing.** A first-class delivery pays +1 with the passenger's empire, at most +3 per empire a
  dock. A stranded passenger costs −1, at most −5 per empire a dock.
- **Handoffs.** `account().commands.spacemolt.unload_passenger({id, target})` with `target: 'lounge'`
  checks one passenger into your faction's Transit Lounge here; a ship id hands them to a docked
  ship of yours or a faction mate's. Fare and deadline carry on. Without `target`, putting a
  passenger off short of their stop strands them. The policy refuses `id: 'all'`.

## Pitfalls

- Failure debt blocks all future acceptance. `haul` refuses on `debt_blocks_acceptance` and
  never accepts what it cannot finish; do not accept by hand on `account()` either.
- An accepted package lands in your **personal storage at the origin**, not in the hold. Check
  the origin has a storage counter before accepting; a mission board alone does not guarantee
  one. `haul` withdraws `package:<id>` and confirms it is aboard before leaving.
- A stale board: the listing can be gone when you accept. `haul` re-reads the contract first.

## When to reconsider

- Five deliveries done and the tier moved: the board just got bigger; look again.
- `fare_surge > 1.5` on the passenger board: a surge beats a routine package.
- Every row `fits: false`: the constraint is the hold, not the board.
