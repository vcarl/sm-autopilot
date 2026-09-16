# combat — the Hunter's evening

"I'll go fight something." Wildlife is legal everywhere and does not fight back with intent;
pirates pay bounties and are the only safe way to train shields and armor, which train by
being hit. Most of the judgement is about what not to engage.

## Functions

| Function | Promise |
|---|---|
| `hunt({poi, fights?, species?, target?, base?})` | out, up to N fights, loot, home, stow, service; nothing there is `done` with zero fights |
| `salvage()` | loot every wreck here into the hold, your own first; never tows |
| [`bounties/`](bounties/README.md) | pirate contracts and sweeps (intermediate+) |

## Worked example

```ts
import {orient, scout, hunt, salvage, sell, note} from 'play';

export default async function main() {
  await orient();                                           // hunt checks the loadout itself; no pre-check by hand
  const here = await scout();
  const habitat = here.detail.pois.find(p => p.type === 'asteroid_belt');   // creatures live at belts and fields
  if (!habitat) { note('no habitat in this system'); return here; }

  const h = await hunt({poi: habitat.id, fights: 2});
  if (h.detail.ended === 'nothing here') { note('quiet belt; scout a neighbour next run'); return h; }
  if (h.status !== 'done') return h;
  return sell(h.detail.stowed, {from: 'store'});           // molt goods and loot, by name
}
```

## What a good fight looks like

- The loadout floor: a weapon fitted with rounds loaded and spares in the hold, hull full,
  fuel out with the way home reserved, free cargo for loot, credits for the repair after.
- You know the kind: a species you have fought (`species`) or a creature slower than you.
- The system's `police_level` is above 20 unless you mean to meet pirates.
- Insurance is current for anything you would mind losing. `service({insure: true})`.

## When to reconsider

- `ended: 'hull'` twice in a row: the walk-away line is doing its job; the hull or the mood is
  wrong for this habitat, not the script.
- Loot keeps hitting `hold full`: the constraint is cargo, not the fight. Stow between fights
  or bring a bigger hold.
- Gunnery and weapons are climbing but shields and armor are 0: nothing but pirates or the
  arena trains them. See `bounties/`.

## Pitfalls

- It's a crime to attack anything whose name carries `[POLICE]` or a player outside a declared 
  war: that means a bounty and police drones in response..
- Tow costs the speed home. `salvage` never tows; if a wreck is worth it, that is its own trip.
- Death loses the hull and what is on it, nothing else. Keep value in storage.
