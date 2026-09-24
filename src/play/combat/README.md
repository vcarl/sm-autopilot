# combat — the Hunter's evening

"I'll go fight something." Wildlife is legal everywhere; pirates pay bounties and are the only
safe way to train shields and armor, which train by being hit. Neither needs a permission —
what to engage is your judgement, and most of the judgement is about what not to engage.

## Functions

| Function | Promise |
|---|---|
| `hunt({poi?, fights?, species?, target?})` | up to N fights where you stand (or at `poi`, flown to first), each wreck looted; nothing there is `done` with zero fights |
| `salvage({tow?})` | loot every wreck here into the hold, your own first; `tow: '<wreck id>'` tows that one instead |

`hunt` fights and loots, and nothing else. A fight runs on the battle's own tick — ten seconds
of real time, one status read, one decision and at most one command each, because the server
takes one mutation a tick: it sets the `fire` stance and focuses the quarry at the open (ships
fire by themselves under their stance; there is no fire command), then closes the range while
the quarry is out of reach or running. A journal line a tick carries the tick number and the
quarry's hull and zone, so the record answers "how often did we act" directly. The trip around
it is yours: `goTo` out, `hunt`, `goTo` back, `stow`, `service`. That is the point — the same `hunt` call works whether you
flew there this run or are standing at the belt already.

## Worked example

```ts
import {orient, scout, goTo, hunt, stow, service, note} from 'play';

export default async function main() {
  const start = await orient();                            // hunt checks the loadout itself
  const dock = start.detail.present.location.docked_at;    // the station to bring the take back to
  if (!dock) return start;                                 // `docked_at` is null when undocked
  const here = await scout();
  const habitat = here.detail.pois.find(p => /belt|field|cloud/.test(p.type));  // creatures live at belts and fields
  // (scout only counts creatures at the POI you are standing at, in detail.here.nearby)
  if (!habitat) { note('no habitat in this system'); return here; }

  const out = await goTo(habitat.id);
  if (out.status !== 'done') return out;

  const first = await hunt();                              // one fight where you now stand
  if (first.detail.ended === 'nothing here') { note('quiet belt; scout a neighbour next run'); return first; }
  const second = await hunt();                             // and another
  if (second.status === 'refused') return second;          // no rounds left, or the rules said no

  await goTo(dock);                                        // back to the station you launched from
  const took = [...first.gained.items, ...second.gained.items];
  await stow(took);                                        // by name; nothing stows by default
  return service();
}
```

## Where the fauna are

- Creatures are only visible from the POI you are standing at: `get_nearby` (and `scout`'s
  `detail.here.nearby`) counts what is here, and nothing reads a POI you have not flown to.
- Habitat decides the species (`docs/wildlife`): ore-eating grazers at **asteroid belts**, cloud
  fauna and pilot-whale pods in **gas clouds**, cold-adapted species in **ice fields**, exotics
  in **nebulae**. Busy, heavily-mined hubs are largely barren; quiet resource-rich systems carry
  the healthiest herds.
- A belt with nothing on it is a `done` hunt with zero fights, not a broken game. Scout the
  system's nebula, cloud and field POIs and `goTo` one of those before concluding anything.

## What a good fight looks like

- The loadout floor: a weapon fitted with rounds loaded, hull full, fuel out with the way home
  reserved, free cargo for loot, credits for the repair after. `hunt` checks the weapon itself,
  and reloads an empty magazine from the hold when the rounds are aboard; with no rounds
  anywhere it is `refused` before anything is sent.
- You know the kind: `species: 'molt_grazer'` narrows to one you have fought before. Without it
  `hunt` takes the first creature the world does not decline.
- The system's `police_level` is above 20 unless you mean to meet pirates.
- Insurance is current for anything you would mind losing. `service({insure: true})`.

## What trains what

- Every fight: weapons, gunnery, tactics.
- Shields and armor train by being hit, so only something that shoots back trains them —
  pirates or the arena, never fauna.
- Creatures train xenobiology; pirates train bounty_hunting.
- Looting a wreck, here or through `salvage`, trains salvaging.

The numbers are measured, not claimed: `gained.xp` is the per-skill delta the runtime read
before and after, and `gained.items` is the cargo delta — a `loot` reply over-states quantity.

## Who is legal

- **Fauna, always.** The only creatures declined are one already `in_combat` in someone else's
  battle, and a `branded` one, which is someone's livestock rather than wildlife.
- **Pirates, your call.** `target: 'pirate'` needs no permission — any pirate, any crew, is
  yours to engage or leave, and the judgement is yours. Anything whose name carries `[POLICE]`
  is declined outright: attacking it is the crime, not the hunt.
- Players outside a declared war are never engaged here at all.

## The flee rule

Every mood has a walk-away fraction of max hull (Cautious 0.95, Focused and Relaxed 0.90,
Aggressive 0.80). `hunt` reads the hull each round and `battle/retreat`s the moment it crosses
that line. A ship that escapes at 30% hull keeps everything.

The quarry flees too, and that is the other half of the rule. A creature whose hull stops
falling while its `zone_distance` grows is running, not being missed: `hunt` chases it with
`advance`, one a tick, for as long as the range keeps opening. If the battle ends anyway with
no wreck, the fight is `escaped` and `fight.why` says what was seen — "hull flat at 25% for 6
tick(s) while it opened the range 2→8" — rather than leaving a bare `escaped` to be guessed at.

That same line is what imposes **Tired**, so the two arrive together: the round in flight
finishes, the fight breaks off, no new fight starts, and the Outcome is `partial` with
`ended: 'tired'`. `goTo` a base and `service()` clears it.

## The loot flow

1. The fight ends. `salvage/wrecks` is read; a wreck whose `victim_id` is the target is the
   only evidence the fight was won — `outcome` is upgraded from `escaped` to `down` on it.
2. `salvage/loot` empties it: modules first (each is a slot and most of the value), then cargo,
   row by row, checking the hold's room before each send and the hold's contents after it.
3. What does not fit stays in the wreck and is reported in `detail.left` (`salvage`) — it is
   still there for a second trip until the wreck expires.
4. Selling and scrapping are the market's. `salvage` never sells, never scraps, and only tows
   the wreck you name.

## When to reconsider

- `ended: 'hull'` or `'tired'` twice in a row: the walk-away line is doing its job; the hull or
  the mood is wrong for this habitat, not the script.
- `ended: 'hold full'`: the constraint is cargo, not the fight. Stow between hunts or bring a
  bigger hold.
- Gunnery and weapons climbing while shields and armor stay 0: nothing but pirates or the
  arena trains them.

## Pitfalls

- A tow costs the speed the way home needs, so `salvage({tow})` is its own trip, not a
  postscript to a hunt.
- Death loses the hull and what is on it, nothing else. Keep value in storage.
- Your own wreck holds ~70% of your modules and half your cargo: `goTo` where you died and
  `salvage()` — it loots your own wreck first.
