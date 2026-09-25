# fleet — more than one hull

Five different things get called "fleet". Keep them apart:

1. **Owning several ships** (this folder). One character flies one; the others are parked,
   safe from your death, and swapped at a shipyard. A fleet is a set of tools at chosen nodes:
   a hauler at the market hub, a miner at the belt, a fighter at home.
2. **`spacemolt_fleet`**: a party of separate players for coordinated travel and combat. Not
   wrapped here.
3. **Crew and marines**: a supply-chain problem from tier-2 scale-3 hulls up (`minimum_crew`
   50+). `buyShip` recruits to minimum; nothing else here manages crew yet.
4. **Alts**: several characters under one Clerk key, each its own account, is the only way
   several ships fly at once. That is a runtime with one process per account and one
   `pilot.json` each; nothing in this library changes for it.
5. **Factions**: a shared garage and treasury. Advanced stage; not wrapped.

## Functions

| Function | Promise |
|---|---|
| `ships()` | **not built yet — it throws `unimplemented`.** `account().commands.spacemolt_ship.list_ships()` |
| `switchShip(id)` | **not built yet — it throws `unimplemented`.** `account().commands.spacemolt_ship.switch_ship({id})`, and stow and service by hand first |

## Worked example

```ts
import {orient, ships, goTo, switchShip, gatherUntil} from 'play';

export default async function main() {
  await orient();
  const mine = await ships();
  const miner = mine.detail.parked.find(s => s.class_id === 'archimedes' && s.shipyard);
  if (!miner) return mine;                                   // nothing to switch to
  await goTo(miner.base_id);
  const sw = await switchShip(miner.ship_id);
  if (sw.status !== 'done') return sw;
  return gatherUntil({poi: 'unknown_edge_mineral_fields'});
}
```

## When this pays off

Not before a second hull is worth more than the fuel to reach it. Concretely: a hauler for
freight days and a miner for belt days, parked where each is used. Before that, one hull and
`refit` is the whole fleet.

## Room left for later

`park(shipId, baseId)` (fly a hull somewhere and leave it), `garage()` (a faction's pooled
ships), and per-account runners are the next functions here; none is needed in the first
three stages.
