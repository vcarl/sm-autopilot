# combat — the Hunter's evening

"I'll go fight something." Wildlife is legal everywhere; pirates pay bounties and are the only
safe way to train shields and armor, which train by being hit. Neither needs a permission —
what to engage is your judgement, and most of the judgement is about what not to engage.

## Functions

| Function | Promise |
|---|---|
| `hunt({species?, strict?, look?, poi?, fights?, target?, pursue?, risk?, onTick?})` | hunt a prey across a range of places: `look` is POI ids tried in order, and the fight happens where the prey actually is. `poi` is the one-place shorthand; naming neither hunts where you stand. `species` is one id or a list — any of them counts; by default it is a *preference*, and `strict: true` makes it a requirement (**Who is legal**). Up to N fights in total, each wreck looted; finding nothing is `done` with zero fights. `pursue: true` chases a quarry that opens the range (default off: an escape is let go, a clean stalemate). `risk: 'covered'` skips a class whose worst recent fight we cannot cover; `risk: 'known'` also skips a class never fought; unset skips nothing (**What memory knows about a species**). Each skip is in `detail.skipped` and the `did`. `onTick` is your own hand on the stance — see **Fighting with your own hand on the stance** |
| `disengage()` | break off whatever battle holds the ship (`stance flee`, held) and wait until the battle has actually ended; true when it has. The one call to make when a move is refused `in_battle` |
| `fightBattle({lossFatal?, boss?, pursue?, onTick?})` | fight the battle the ship is **already in** — a pirate's ambush, an arena match — to its end, with no opening attack. `hunt`'s own per-tick loop on whoever the other side fields: focus on `boss` (by name) or the lowest hull, range read from the opponent's row, an empty magazine reloaded, the range closed from the first tick, `evade` against an opponent that holds out of reach while hitting you, a chase only under `pursue: true`. It runs only to save the ship (**The flee rule**); `lossFatal: false` says losing costs nothing (the arena) and fights to the end |
| `arena({challenge?})` | fight an NPC arena challenge to its end and score it — see **Arena** |
| `duel({player, max_side_size?, waitMs?})` | challenge a player in the arena, wait (bounded) for the accept, and fight it the same way |
| `salvage({tow?})` | loot every wreck here into the hold, your own first; `tow: '<wreck id>'` tows that one instead |

## You cannot know where the prey is before you get there

This is the fact the whole shape of `hunt` follows from. A POI row carries `id, name, type,
class, position, has_base, online, fuel_reserve` — **no fauna field**. `get_nearby` tells you what
is here, and only here; there is no per-species query and no way to enumerate another system's
POIs. So nothing you can read before you fly tells you which POI holds your quarry. The nearest is
raw `account().commands.spacemolt.survey_system()` with survey power fitted: its `wildlife` is a
census of the system you stand in (species, estimate), never the POI.

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
  // preference here (the default): a Belt-Grazer is fought if one turns up, and the first legal
  // creature of any kind otherwise — a habitat with something else in it still earns two fights.
  const out = await hunt({species: 'belt_grazer', look: habitats, fights: 2});

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
| `floor` | `number` | the danger line in hull points, 30% of `max_hull`; `0` in the arena. Under it the loop runs unless the enemy is closer to dead or the escape would cost the hull left, and nothing you return stops that |
| `loss_fatal` | `boolean` | whether losing loses the ship; false in the arena, where the danger line does not apply |
| `stats` | `CombatStats \| undefined` | what memory remembers of this opponent, or undefined the first time it is met |

### `TickDecision` — what you may ask for

Applied in this order, one a tick; the rest is asked again next tick if you ask again.

| Field | Type | What it does |
|---|---|---|
| `disengage` | `true` | break off: `stance flee` until the battle ends. A flee that cannot get away (blocked, or its count stalled) goes back to `fire`, as the flee rule's does. Asked while the escape reads blocked that poll, or after it stalled that fight, no flee is started: the step says `onTick asked to disengage; the escape is blocked this fight: fighting on` (or `stalled`) once, and the default loop takes the tick. Ask again once the escape opens. **The only exit.** |
| `stance` | `'fire' \| 'evade' \| 'brace' \| 'flee'` | the stance to hold from this tick on. `'flee'` is read as `disengage: true` |
| `move` | `'closeIn' \| 'backOff'` | a **range maneuver, not an exit**. `closeIn` shortens the range, `backOff` opens it. Neither leaves the battle |
| `focus` | `string` | focus fire on that participant id |

`backOff` is `battle/retreat` under the covers, and the server answers "Retreating from the
enemy." while the battle carries on — that is why it is named for what it does. A move read as an
exit is how a ship was lost on 2026-09-24. Leaving is `disengage`, and nothing else.

### The bounds you cannot argue with

- **The danger line wins.** When the flee rule says run — under `view.floor`, the enemy no closer
  to dead than you, the escape survivable — the fight breaks off whatever you asked for. Above
  the line, and wherever the rule says fight on, the stance is yours.
- **A throw is caught** and the default loop carries on. A bug in your tactics never strands the ship mid-fight.
- **One mutation a tick.** Return two fields and only the first in the order above is sent.

### With no callback

The default: `stance fire` and the focus at the open (neither is sent when our own row already
holds it, so the first tick can go to the range), then `advance` from the first tick until the
quarry is in reach **and** in the band memory says you hit it best (`stats.accuracy` `at_them`,
a band counting from 5 shots; nothing measured closes to `inner`). The close stops when an
advance no longer shortens the range, and never chases a quarry opening it — that is `pursue: true`
alone. Plus **one** `brace`, once a fight, and only when the
shield is flat, the quarry's hull is above ours, and the danger line is within 5% of max hull.
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
| `taken_per_tick`, `dealt_per_tick` | the server's own fight damage totals over its own `duration` — **shield and hull together**, and on the live server it is mostly shield. Never compare it against the danger line, and never against `view.damage_taken` below, which is hull alone |
| `hull_pct_lost` | percentage points of max hull an average fight with this opponent cost. **This** is the number the danger line turns on, because the line is a fraction of max hull |
| `accuracy[band].at_us`, `.at_them` | `hit_success` on every shot, bound to the range band the battle published for that same tick. `at_us_shots` / `at_them_shots` is the sample each rests on |
| `win_chance` | wins over fights — **absent below three fights.** Below that there is `won` and `fights` and no rate, because one fight is a count, not a rate |

`stats.thin` is true while the sample is under three fights, and then every number above is an
anecdote. `newest_ticks_old` says how old the freshest of them is. `ship_classes` is the hulls
those fights were flown in: a win rate across two hulls is two questions answered as one.

`hunt` reads the same memory once per look as a **recent record** of each class (its display name), the last ten
fights against it, and each `fight.record` is the one that fight's target was chosen against (absent: never fought):

| Field | Meaning |
|---|---|
| `won`, `stalemate`, `lost`, `fights` | endings over the last ten fights; `thin` while under three |
| `avg_hull_lost`, `worst_hull_lost` | percentage points of max hull those fights cost, average and worst — absent when no fight's hull was read |

**Covers** means our hull now, in percent of max, less `worst_hull_lost`, stays above the danger line (30%): at hull
80/100 a worst of 60 does not cover (80 − 60 = 20). Under `risk: 'covered'` a class that does not cover is skipped,
and `detail.skipped` says so: `Veil-Ray: the worst of its last 3 fights cost 60 pts of hull, and we have 50 above the
danger line`. A record with no hull read is never skipped, nor is anything while our `max_hull` is unread. A class never
fought is skipped only under `risk: 'known'`.

The juncture lists the prey here (undocked only) with this record beside each, a `Prey here:` line, and names the danger
line and a low hold of ammunition. It is information for you; you decide whether to fight, and nothing is refused on it.

## Arena

Consequence-free combat at an arena POI: the match runs on the normal battle engine and your ship and crew are
restored after it — only ammo and fuel are spent. It is the safe way to train shields and armor against something
that shoots back, and the one fight where losing costs nothing.

**Fleeing forfeits the match.** So the danger line and every bail-out you would write for a hunt protect nothing
here — they only turn a fight you might win into a loss. Live, 12 of 13 matches ended with our own ship fleeing.
`arena()` fights with loss not fatal (`view.floor` is `0`, `view.loss_fatal` false), and a flight that ends mid-match
is fought to its end at the close, not fled and not left alone (the report says so; if the close's bound runs out first, the ship stays in the battle until it resolves).

The seven real actions, `account().commands.spacemolt_arena.<action>`. There are no others — `list`, `info`, `rules`,
`enter`, `join`, `duel`, `start` are all refused:

| Action | Params | What it does |
|---|---|---|
| `challenges()` | — | every NPC challenge: `challenge_id`, `name`, `rules`, `objective`, `enemies` (with `is_boss`), `waves`, `locked`, `at_this_arena`, `wins` |
| `fight({id})` | the challenge id | start an NPC challenge (undocked at its arena POI). Answers `battle_id`, `enemies`, `objective` |
| `status()` | — | lifetime `arena_wins`/`arena_losses`, `battle_id` of the match you are in, live `match` objective, `incoming`/`outgoing` duel challenges |
| `challenge({id, max_side_size?})` | player name or id | challenge a player; `max_side_size: 1` is a solo duel |
| `accept()` / `decline()` | — | answer the challenge waiting for you |
| `cancel()` | — | withdraw the challenge you sent |

**NPC challenges** (`fight`) start at once. Each carries **rules** every ship on your side must pass —
`max_ship_tier`/`min_ship_tier`, side size, banned modules, damage types, no ammo weapons, empty hold… — and a ship
that breaks one refuses the whole side with a `rule_*` error. A `locked` challenge needs the ones in its `requires`
won first. The **objective** is how it is won beyond knocking out every enemy: `survive_ticks`, `time_limit_ticks`,
`no_enemy_escape`. **Player duels** (`challenge`) wait for the other pilot's `accept`; `status().outgoing` is your
challenge still pending, and `status().battle_id` appearing is the accept.

Inside the match it is an ordinary battle: there is **no `attack`** (ships fire on their own under `stance fire`),
range is `advance`/`retreat`, focus is `target`, and **`spacemolt_battle.reload({id: <weapon module id>})`** refills an
empty magazine from the hold — matches have opened with empty magazines. `arena()` and `fightBattle()` do all of that
for you, one command a tick.

No `battle_ended` push arrives for an arena battle, so `arena()` scores the match from `status()`: `result` is
`win`/`loss` from the lifetime record after against before (`neither` when both stood still). Every match goes into
combat memory beside your hunts, marked with its challenge.

### Fit for the fight

Range decides it before the stance does. `combat_state.max_weapon_reach` is how far your weapons fire against your
target, and the target's own `zone_distance` is how far away it is — compare those two, never your own row's
distance. Look up each weapon's `reach` in the catalog (`account().commands.spacemolt.inspect({id: <weapon type id>})`)
and the challenge's enemy hulls (`enemies[].ship_class`) before you go: **two reach-2 autocannons lose to a ship that
holds range 3**, because it never comes into reach and they never fire. Live: an enemy held distance 3 against reach 2
for the whole match, its shield went 14→100, and its hull stayed at 98%. Bring a weapon that out-reaches what the
challenge fields — inside the rules, which may cap the tier or ban the module.

```ts
import {orient, arena, note} from 'play';

export default async function main() {
  await orient();
  // The first unlocked challenge held here that is not yet won; arena({challenge: '<id>'}) names one.
  const out = await arena();
  if (out.status === 'refused') return out;    // a rule this hull breaks, or no challenge held where you stand
  const match = out.detail;
  note(`${match.name}: ${match.result}, ${match.battle.polls} rounds, dealt ${match.battle.dealt ?? '?'}, taken ${match.battle.taken ?? '?'}`);
  return out;
}
```

## Hearing pirate radio

Only a ship with a `pirate_radio_scanner` in a utility slot hears pirate radio. Without one you hear
nothing, and nothing says so. Craft it at a base with `crafting`: `craft('build_pirate_radio_scanner')`
(2 `circuit_board` + 3 `copper_wiring`; `recipes('pirate_radio')` prices it), then `refit({install: ['pirate_radio_scanner']})`.
It arrives in chat as channel `pirate_radio`, read with `messages()` like any other.

- Ordinary pirate chatter carries **3 jumps**. Raid traffic carries **at least 7**: a stronghold
  raids stations up to 6 jumps out, and its radio reaches one jump past that.
- A raid warns in three stages over about an hour: a rumour, then the target station named
  (about 30 minutes in), then imminent with the fleet size (about 48 minutes in). Then it launches.
- The fleet is 4–12 warships, 2 salvagers and 2 haulers. It sits about 4 minutes in each system on
  the way: that is where you meet it.
- **Shoot the haulers.** They carry the fleet's ammunition; a fleet out of ammunition gives up and goes
  home. A raider killed while you defend an empire's station also raises your standing with that empire.

## Bounties and contracts

A pirate pays its bounty to whoever lands the killing blow, at once: `scout`, `salvager` and `tanker`
50–150 cr, `hauler` 100–250, `raider` 200–500, `raid_fleet` 400–900, `raider_elite` 500–1,500
(more with bounty_hunting). The kill also drops your standing with that pirate's crew, and its
stronghold docks you only at a non-negative standing.

Contracts pay on top. A board row that asks for pirate kills has `fits: 'hunt'`; fly it with
`hunt({target: 'pirate', look})` in low-police space, then `completeMissions()` at the giver.

| Contract | Where | Kills | Pays |
|---|---|---|---|
| Pirate Bounty / Pirate Sweep / Raider Bounty | any station, at weapons 1 / 2 / 3 | 1 any / 3 any / 2 `raider` | 2,000 / 5,000 / 6,000 |
| A capital's security chain | each empire capital | 1 `scout`, then 3 any, then 2 `raider` | 2,000, 4,000, 6,000 |
| Trade Convoy Protection, Starfall Prospector Defense | `cargo_lanes_freight_depot`, `starfall_salvage_station` | 5 `scout` | 5,000 |
| Rampart Border Patrol | `the_rampart_checkpoint` | 3 `raider` | 8,000 |

- Each in the table pays **once** per pilot; none repeats. Each has a 48–120 hour limit.
- A tier is strict: a `raider` contract does not count scouts.
- "Convoy" and "escort" contracts are kill counts. There is no convoy to escort.

## What a good fight looks like

- The loadout floor: a weapon fitted with rounds loaded, hull full, fuel out with the way home
  reserved, free cargo for loot, credits for the repair after. `hunt` checks the weapon itself,
  and reloads an empty magazine from the hold when the rounds are aboard; with no rounds
  anywhere it is `refused` before anything is sent.
  Stock rounds with `buy(weapon.ammo_type, qty)` at a market, not a raw reload command.
  A part-full magazine is topped up before the first shot when the game reports its `magazine_size`;
  in a fight, one under a quarter is topped up in a lull, after the stance, focus and range are
  settled (a reload discards the rounds left). Without a `magazine_size` only an empty one is reloaded.
  When the hold runs low on a weapon's rounds (under 2) the hunt's `did` says so, e.g. `low ammo: 1
  autocannon in the hold for Autocannon I`; it refuses nothing.
- You know the kind: `species: 'belt_grazer'` (or `species: ['belt_grazer', 'patina_grazer']`)
  prefers one you have fought before. Without it, or when the named one is not here, `hunt`
  takes the first creature the world does not decline. Only `strict: true` makes a name a
  requirement rather than a preference — reach for it when a second species would not do, e.g.
  a mission that counts kills of one species and nothing else. A whole evening was once lost to
  a species that was never present and a `hunt` that refused everything else standing there —
  that is the failure `strict`'s default of `false` exists to stop.
- The system's `police_level` is above 20 unless you mean to meet pirates.
- Cover before the fight: `service({insure: true})`, docked. The quote is in
  `detail.insurance.quote`; not bought (refused quote, short wallet) is `partial` with the reason.

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

Run only to save the ship. The danger line is 30% of max hull (`view.floor`). Above it the fight
is fought to its end. Below it, the ship flees unless the enemy is closer to dead than we are (the
healthiest enemy standing, as a percent, against our own) or the escape itself would cost the hull
left — the worst of the last three polls' hull loss, each at full damage (a braced poll's loss ×4,
an evading one's ×2: the flee holds neither), times the polls to the outer ring and
`flee_required` there; an escape that reads blocked is never worth it. Fighting on under the line
says why, once for each kind of reason. Where losing costs nothing (the arena) the line does not apply at all. A
ship that escapes at 30% hull keeps everything.

**Tired never ends a fight in progress.** The mood's walk-away line still imposes Tired, but the
fight carries on to its end; Tired only keeps the next fight from starting.

`battle/retreat` is not the way out: it is a range maneuver (`backOff`), and the server takes
it while the battle carries on for ticks afterwards — during which every `travel`, `jump` and
`undock` is refused `in_battle`. The exit is `stance flee`, which auto-retreats to the outer
ring and escapes after `combat_state.flee_required` consecutive flee ticks there (3 at baseline,
more against a faster ship). It takes 100% of the incoming damage, and the count resets the
moment the stance changes — so a flee that is getting away is held until the battle ends. `brace` is
no way out: a creature's battle does not end on its own, and live a 26-tick brace ended with the
ship lost; brace is never sent after a flee in the same fight.

A flee that cannot get away goes back to `fire` rather than sitting at 0% dealt and 100% taken.
Blocked is `combat_state` read without `flee_required`, or `can_escape: false` (a status with no
`combat_state` at all is not blocked: the baseline 3 is assumed). Stalled is `flee_counter` not
rising for 4 polls (`FLEE_STALL`); a stalled escape is not tried again that fight. Either way the
line says so — `flee blocked (flee_required absent): back to fire, the rule re-applied` or `flee
stalled at 0/3 for 4 polls: back to fire` — and the flee rule applies again each poll: a blocked
escape is never worth it, so it is not re-fled until it opens. A `{disengage: true}` from
`onTick` is bounded the same way, and is not started at all while the escape reads blocked that
poll or has stalled that fight: it is said once, and the fight goes on under the default loop.
`disengage()` is that sequence, and it is what a pilot calls when a move comes back `in_battle`.
A refused move is never worth re-issuing until the battle has ended — that loop is how ships are
lost.

`hunt` (and `fightBattle` where loss is fatal) never hands back a live battle: the fight polls on
until the battle ends. A fight left unresolved — the five-minute ceiling, a crew that cannot fly —
starts the flee once and keeps polling; a command refused mid-fight is broken off with
`disengage`'s five-minute bound before the call returns. Each flee tick is said with the server's own count,
`(flee 2/4)`, or `blocked` when the escape is disrupted or intercepted.

The quarry flees too, and that is the other half of the rule. A creature whose hull stops
falling while its `zone_distance` grows is running, not being missed. By default it is let go:
an escape is a clean stalemate. With `pursue: true`, `hunt` chases it with `advance` on every
tick the range opens, while above the danger line. If the battle ends anyway with
no wreck, the fight is `escaped` and `fight.why` says what was seen — "hull flat at 25% for 6
tick(s) while it opened the range 2→8" — rather than leaving a bare `escaped` to be guessed at.

A hunt that goes Tired mid-fight finishes that fight, starts no new one, and the Outcome is
`partial` with `ended: 'tired'`. Between fights, hull under the danger line ends it `ended: 'hull'`.
`goTo` a base and `service()` clears both.

## The loot flow

1. The fight ends. `salvage/wrecks` is read; a wreck whose `victim_id` is the target is the
   only evidence the fight was won — `outcome` is upgraded from `escaped` to `down` on it.
2. `salvage/loot` empties it: modules first (each is a slot and most of the value), then cargo,
   row by row, checking the hold's room before each send and the hold's contents after it.
3. What does not fit stays in the wreck and is reported in `detail.left` (`salvage`) — it is
   still there for a second trip; a ship's wreck stays until someone salvages it.
4. `salvage` never sells or scraps, and only tows the wreck you name. To sell one: `salvage({tow})`,
   go to a base with a salvage yard, then `account().commands.spacemolt_salvage.sell({})` (no params;
   it sells the wreck in tow).

## When to reconsider

- `ended: 'hull'` twice in a row: the danger line is doing its job; the hull is wrong for this
  habitat, not the script. `'tired'` is the ship asking for service, not a lost fight.
- `ended: 'hold full'`: the constraint is cargo, not the fight. Stow between hunts or bring a
  bigger hold.
- Gunnery and weapons climbing while shields and armor stay 0: nothing but pirates or the
  arena trains them.

## Pitfalls

- A tow costs the speed the way home needs, so `salvage({tow})` is its own trip, not a
  postscript to a hunt.
- Your own wreck holds what survived your death: `goTo` where you died and `salvage()` — it loots
  your own wreck first.
