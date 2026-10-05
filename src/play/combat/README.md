# combat — the Hunter's evening

"I'll go fight something." Wildlife is legal everywhere; pirates pay bounties and are the only
safe way to train shields and armor, which train by being hit. Neither needs a permission —
what to engage is your judgement, and most of the judgement is about what not to engage.

## Functions

| Function | Promise |
|---|---|
| `hunt({species?, strict?, look?, poi?, fights?, target?, onTick?})` | hunt a prey across a range of places: `look` is POI ids tried in order, and the fight happens where the prey actually is. `poi` is the one-place shorthand; naming neither hunts where you stand. `species` is one id or a list — any of them counts; by default it is a *preference*, and `strict: true` makes it a requirement (**Who is legal**). Up to N fights in total, each wreck looted; finding nothing is `done` with zero fights. `onTick` is your own hand on the stance — see **Fighting with your own hand on the stance** |
| `disengage()` | break off whatever battle holds the ship (`stance flee`, then `brace` if it cannot get away) and wait until the battle has actually ended; true when it has. The one call to make when a move is refused `in_battle` |
| `salvage({tow?})` | loot every wreck here into the hold, your own first; `tow: '<wreck id>'` tows that one instead |

## You cannot know where the prey is before you get there

This is the fact the whole shape of `hunt` follows from. A POI row carries `id, name, type,
class, position, has_base, online, fuel_reserve` — **no fauna field**. `get_nearby` tells you what
is here, and only here; there is no per-species query and no way to enumerate another system's
POIs. So nothing you can read before you fly tells you which POI holds your quarry.

**And do not filter by POI type.** Habitat *suggests* a species — grazers at belts, cloud fauna in
gas clouds, exotics in nebulae — but it does not tell you where the animals are today. Live
2026-09-25: the only fauna in a whole region was in a **nebula**, found after a belt and five
planets came back empty; four hours earlier that same belt had been the only place with fauna in it.
Fauna is transient and it is not confined to the types we happen to have named, so prefer the
likely types and **look everywhere**. (Mining is the opposite: a gather needs ore, so belts and
fields really are the only places worth flying to.)

That is why `hunt` takes a prey and a list of places rather than a destination:

```ts
import {orient, scout, goTo, hunt, stow, service, note} from 'play';

export default async function main() {
  const start = await orient();
  const dock = start.detail.present.location.docked_at;
  const here = await scout();
  // Every POI in this system, the types fauna is known for first, then the rest — a preference,
  // not a filter, because fauna turns up in places no list of ours predicted.
  const likely = /nebula|cloud|belt|field|asteroid/;
  const habitats = [...here.detail.pois]
    .sort((a, b) => (likely.test(a.type) ? 0 : 1) - (likely.test(b.type) ? 0 : 1))
    .map(p => p.id);
  if (!habitats.length) { note('no POIs in this system at all'); return here; }

  // One call looks at each in turn and fights at the first that holds the prey. `species` is a
  // preference here (the default): a Molt Grazer is fought if one turns up, and the first legal
  // creature of any kind otherwise — a habitat with something else in it still earns two fights.
  const out = await hunt({species: 'molt_grazer', look: habitats, fights: 2});

  // What it looked at and what was in each, whether or not it fought.
  for (const stop of out.detail.looked)
    note(`${stop.poi_id}: ${stop.saw} seen, ${stop.legal} legal${stop.flew ? ' (flew there)' : ''}`);

  if (out.detail.ended === 'nothing found') {      // every place looked at, none held it
    note('that list is empty; pick another system next flight');
    return out;
  }
  if (out.detail.ended === 'fuel') return out;     // the tank cannot cover the next hop; go refuel

  if (dock) { await goTo(dock); await stow(out.gained.items); return service(); }
  return out;
}
```

Three things to know about it:

- **The looking is bounded by fuel.** Every hop is re-quoted and checked against the tank, and a
  hop the tank cannot cover **ends** the search with `ended: 'fuel'` naming the place — if you
  cannot afford the next POI you cannot afford the one after it. A hop that takes fuel under your
  mood's reserve makes you Tired, and the search ends there with `ended: 'tired'`: go service.
- **Every look is remembered, the empty ones included.** An empty belt is the more useful of the
  two facts: it is what stops you paying for the same dead rock next shift. A remembered look
  reports its own age, and an absence expires sooner than a sighting, because believing "nothing
  there" too long means skipping a belt that has since filled up.
- **Finding nothing is `done`, not `refused`.** The looking was the job. One place looked at is
  `ended: 'nothing here'`; a real search is `ended: 'nothing found'`, with `detail.looked` naming
  each place and what was in it.

`hunt` searches, fights and loots, and nothing else. A fight runs on the battle's own tick — ten seconds
of real time, one status read, one decision and at most one command each, because the server
takes one mutation a tick: it sets the `fire` stance and focuses the quarry at the open (ships
fire by themselves under their stance; there is no fire command), then closes the range while
the quarry is out of reach or running. The trip around
it is yours: `goTo` out, `hunt`, `goTo` back, `stow`, `service`. That is the point — the same `hunt` call works whether you
flew there this flight or are standing at the belt already.

## Worked example

```ts
import {orient, scout, goTo, hunt, stow, service, note} from 'play';

export default async function main() {
  const start = await orient();                            // hunt checks the loadout itself
  const dock = start.detail.present.location.docked_at;    // the station to bring the take back to
  if (!dock) return start;                                 // `docked_at` is null when undocked
  const here = await scout();
  // A belt is a good first guess, but only a guess: `hunt({look})` above is the better shape.
  const habitat = here.detail.pois.find(p => /belt|field|cloud|nebula/.test(p.type)) ?? here.detail.pois[0];
  // (scout only counts creatures at the POI you are standing at, in detail.here.nearby)
  if (!habitat) { note('no habitat in this system'); return here; }

  const out = await goTo(habitat.id);
  if (out.status !== 'done') return out;

  const first = await hunt();                              // one fight where you now stand
  if (first.detail.ended === 'nothing here') { note('quiet belt; hunt({look}) a list next flight'); return first; }
  const second = await hunt();                             // and another
  if (second.status === 'refused') return second;          // no rounds left, or the rules said no

  await goTo(dock);                                        // back to the station you launched from
  const took = [...first.gained.items, ...second.gained.items];
  await stow(took);                                        // by name; nothing stows by default
  return service();
}
```

## Fighting with your own hand on the stance

`hunt({onTick})` hands you the fight, one tick at a time. It is **synchronous** on purpose: a
tick is ten seconds, too short to think in, so the tactics have to be
written down in advance and carried out inside the fight, not decided while it happens.

The callback never sends a command. It is handed a `TickView` and returns a `TickDecision`, or
`undefined` for "no change" — which is how "decide every third tick" is written without the
library baking in a cadence. `hunt` applies one field a tick (the server takes one mutation a
tick) and validates it.

### The stances

| `stance` | damage dealt | damage taken | also |
|---|---|---|---|
| `fire` | 100% | 100% | the default the loop opens with |
| `evade` | 0% | 50% | costs fuel every tick |
| `brace` | 0% | 25% | shields regenerate at 2× |
| `flee` | 0% | 100% | auto-retreats until it escapes |

`board` is not in the union: it needs marines and suppresses your own weapons, so it is a
boarding party's business, not a tactical one, and asking for it will not compile.

### `TickView` — what you are told

| Field | Type | What it is |
|---|---|---|
| `tick` | `number` | the battle's own tick, 1 up. NOT the global engine tick, and on the live server it can sit on one number for minutes |
| `hull` | `number` | our hull now |
| `max_hull` | `number` | our hull when whole |
| `shield_pct` | `number` | our shield, percent of max; 0 when the status published none |
| `opponent` | `string` | the quarry's display name |
| `opponent_hull` | `number` | its hull as a **fraction** of max, 0..1 |
| `range` | `string` | the range band: `inner`, `mid` or `outer` on the live server |
| `distance` | `number` | distance to the quarry, the game's own units |
| `reach` | `number` | the reach of our longest weapon; `distance > reach` is out of range |
| `damage_taken` | `number` | hull lost since the previous tick — and on the first tick, since the fight opened |
| `stance` | `CombatStance \| undefined` | the stance in force, or undefined before one is set |
| `floor` | `number` | the mood's walk-away hull. Nothing you return can cross it |
| `stats` | `CombatStats \| undefined` | what memory remembers of this opponent, or undefined the first time it is met |

### `TickDecision` — what you may ask for

Applied in this order, one a tick; the rest is asked again next tick if you ask again.

| Field | Type | What it does |
|---|---|---|
| `disengage` | `true` | break off: `stance flee` until the battle ends, bracing if the flee cannot get away. **The only exit.** |
| `stance` | `'fire' \| 'evade' \| 'brace' \| 'flee'` | the stance to hold from this tick on |
| `move` | `'closeIn' \| 'backOff'` | a **range maneuver, not an exit**. `closeIn` shortens the range, `backOff` opens it. Neither leaves the battle |
| `focus` | `string` | focus fire on that participant id |

`backOff` is `battle/retreat` under the covers, and the server answers "Retreating from the
enemy." while the battle carries on — that is why it is named for what it does. A move read as an
exit is how a ship was lost on 2026-09-24. Leaving is `disengage`, and nothing else.

### The bounds you cannot argue with

- **The walk-away floor wins.** Ask to keep firing below `view.floor` and the floor breaks the
  fight off anyway. The mood's margin is not yours to move, like `credit_reserve`.
- **A throw is caught** and the default loop carries on. A bug in your tactics never strands the ship mid-fight.
- **One mutation a tick.** Return two fields and only the first in the order above is sent.

### With no callback

The default is what it always was: `stance fire` and the focus at the open, then `advance` while
the quarry is out of reach or running — plus **one** `brace`, once a fight, and only when the
shield is flat, the quarry's hull is above ours, and the walk-away line is within 5% of max hull.
That one tick of 25% damage taken with shields regenerating at 2× buys the hull to keep firing to
the line instead of reaching it now; the tick after, the stance goes back to `fire`.

### Worked example: a fight loop with a callback

```ts
import {orient, goTo, hunt, note, type TickView, type TickDecision} from 'play';

/** The tactics, written down before the fight: no awaits, no commands, just a decision. */
function tactics(view: TickView): TickDecision | undefined {
  // Their measured accuracy against us at this range, when memory has met one before.
  const band = view.stats?.accuracy[view.range];
  const theyHitUs = band && band.at_us_shots >= 8 ? band.at_us : undefined;

  if (view.opponent_hull > 0.8 && view.hull < view.floor + 10) return {disengage: true};
  if (view.distance > view.reach) return {move: 'closeIn'};    // out of reach: nothing else matters
  // Shields gone and still being hit hard: brace a tick and let them come back at 2x.
  if (view.shield_pct === 0 && view.damage_taken > 3) return {stance: 'brace'};
  // They shoot straighter than us up close: open the range and keep firing from there.
  if (theyHitUs !== undefined && theyHitUs > 0.6 && view.range === 'inner') return {move: 'backOff'};
  if (view.stance !== 'fire') return {stance: 'fire'};
  return undefined;                                        // no change; the default loop decides
}

export default async function main() {
  const start = await orient();
  const here = start.detail.present.location.poi_id;
  if (!here) return start;

  const out = await hunt({fights: 2, onTick: tactics});
  for (const fight of out.detail.fights)
    note(`${fight.target.name}: ${fight.outcome}, hull ${fight.hull_before} to ${fight.hull_after}`);
  return goTo(here);
}
```

## What memory knows about a species

Every fight is folded into memory — one record per fight, about a
dozen numbers, never a transcript. Three things come off it, and they reach you in two places:
what you see when you take stock, beside the creature's name, and `view.stats` inside the fight.

| Number | How it is measured |
|---|---|
| `taken_per_tick`, `dealt_per_tick` | the server's own fight damage totals over its own `duration` — **shield and hull together**, and on the live server it is mostly shield. Never compare it against the walk-away line, and never against `view.damage_taken` below, which is hull alone |
| `hull_pct_lost` | percentage points of max hull an average fight with this opponent cost. **This** is the number the walk-away decision turns on, because the mood's line is a fraction of max hull |
| `accuracy[band].at_us`, `.at_them` | `hit_success` on every shot, bound to the range band the battle published for that same tick. `at_us_shots` / `at_them_shots` is the sample each rests on |
| `win_chance` | wins over fights — **absent below three fights.** Below that there is `won` and `fights` and no rate, because one fight is a count, not a rate |

`stats.thin` is true while the sample is under three fights, and then every number above is an
anecdote. `newest_ticks_old` says how old the freshest of them is. `ship_classes` is the hulls
those fights were flown in: a win rate across two hulls is two questions answered as one.

## Where the fauna are

- Creatures are only visible from the POI you are standing at: `get_nearby` (and `scout`'s
  `detail.here.nearby`) counts what is here, and nothing reads a POI you have not flown to.
- Habitat decides the species (`docs/wildlife`): ore-eating grazers at **asteroid belts**, cloud
  fauna and pilot-whale pods in **gas clouds**, cold-adapted species in **ice fields**, exotics
  in **nebulae**. Busy, heavily-mined hubs are largely barren; quiet resource-rich systems carry
  the healthiest herds.
- A belt with nothing on it is a `done` hunt with zero fights, not a broken game — and it may have
  been full this morning. Hand `hunt` a `look` list of the whole system rather than concluding
  anything from one POI.

## What a good fight looks like

- The loadout floor: a weapon fitted with rounds loaded, hull full, fuel out with the way home
  reserved, free cargo for loot, credits for the repair after. `hunt` checks the weapon itself,
  and reloads an empty magazine from the hold when the rounds are aboard; with no rounds
  anywhere it is `refused` before anything is sent.
- You know the kind: `species: 'molt_grazer'` (or `species: ['molt_grazer', 'belt_grazer']`)
  prefers one you have fought before. Without it, or when the named one is not here, `hunt`
  takes the first creature the world does not decline. Only `strict: true` makes a name a
  requirement rather than a preference — reach for it when a second species would not do, e.g.
  a mission that counts kills of one species and nothing else. A whole evening was once lost to
  a species that was never present and a `hunt` that refused everything else standing there —
  that is the failure `strict`'s default of `false` exists to stop.
- The system's `police_level` is above 20 unless you mean to meet pirates.
- There is no insurance to fall back on. `service({insure: true})` accepts the flag and does
  nothing — it reports `insure: not implemented yet` and buys no cover — so a hull lost is lost
  with everything in the hold. The hull line and `disengage()` are the whole of the protection.

## What trains what

- Every fight: weapons, gunnery, tactics.
- Shields and armor train by being hit, so only something that shoots back trains them —
  pirates or the arena, never fauna.
- Creatures train xenobiology; pirates train bounty_hunting.
- Looting a wreck, here or through `salvage`, trains salvaging.

The numbers are measured, not claimed: `gained.xp` is the per-skill delta read
before and after, and `gained.items` is the cargo delta — a `loot` reply over-states quantity.

## Who is legal

- **Fauna, always.** The only creatures declined are one already `in_combat` in someone else's
  battle, and a `branded` one, which is someone's livestock rather than wildlife.
- **Pirates, your call.** `target: 'pirate'` needs no permission — any pirate, any crew, is
  yours to engage or leave, and the judgement is yours. Anything whose name carries `[POLICE]`
  is declined outright: attacking it is the crime, not the hunt.
- **`species` is a preference by default, `strict: true` makes it a rule.** Left loose (the
  default), a creature of a species you did not name is never declined for that — it is fought
  when none of your named ones stand here. Under `strict: true`, a mismatch is declined with the
  same wording as `in_combat`/`branded`: "X is <species>, not <named species>". Pirates ignore
  both — `species`/`strict` are wildlife-only.
- Players outside a declared war are never engaged here at all.

## The flee rule

Every mood has a walk-away fraction of max hull (Cautious 0.95, Focused 0.90, Aggressive 0.80);
a Hunter flies Focused, so it is 0.90. `hunt` reads the hull each round and breaks off the moment it crosses that
line. A ship that escapes at 30% hull keeps everything.

`battle/retreat` is not the way out: it is a range maneuver (`backOff`), and the server takes
it while the battle carries on for ticks afterwards — during which every `travel`, `jump` and
`undock` is refused `in_battle`. The exit is `stance flee`, which auto-retreats to escape. It
takes 100% of the incoming damage and the escape can fail outright, because an equal or faster
opponent kites the flee movement, so breaking off is bounded: three ticks under `flee`, and if
that has not got the ship away, the fight is waited out under `brace` (25% taken, shields regen
2×) until it ends — every battle observed ended on its own inside 22 ticks. `disengage()` is
that whole sequence, and it is what a pilot calls when a move comes back `in_battle`. A refused
move is never worth re-issuing until the battle has ended — that loop is how ships are lost.

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
4. `salvage` never sells or scraps, and only tows the wreck you name. To sell one: `salvage({tow})`,
   go to a base with a salvage yard, then `account().commands.spacemolt_salvage.sell({})` (no params;
   it sells the wreck in tow).

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
