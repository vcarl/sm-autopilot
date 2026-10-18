# Battle Risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pilot fights the fights it is winning, runs only to save the ship, closes range, keeps its magazines full, and chooses fights from an honest per-class record.

**Architecture:** One fixed danger line (30% of max hull) replaces every mood fraction and Tired check inside `battleLoop` (`src/play/combat/hunting.ts`). A flee becomes a state of that loop, not a sub-call, so a blocked or stalled flee can return to `fire`. `combat-memory.ts` keeps the last 10 fights per opponent and reads a short record from them. That record feeds `hunt`'s risk limit, the `Fight` result and the juncture's `prey` block. The run-end guard hands a live battle to the same loop, with "is loss fatal" as its only input.

**Tech Stack:** TypeScript (erasable, no build step) on Node ≥24, Effect, `node --test`, oxlint.

**Spec:** `docs/superpowers/specs/2026-10-17-battle-risk-design.md` (approved; do not edit it). Every implementer reads the spec and this plan.

## Global Constraints

- Work only in the worktree `/Users/vcarl/workspace/sm-autopilot/.claude/worktrees/battle-risk`, on branch `battle/risk`. **Append-only commits; no rebase, reset or amend; other agents commit here concurrently.** No push.
- Stage only the files your task names, by path. Never stage `node_modules` (an untracked symlink on purpose). No `git add -A`/`-u`/directory adds.
- No version bumps, tags or version numbers in commits. Commits are Conventional Commits, scope `play` (or `bridge`/`juncture` where the task says). The body says why and cites the evidence.
- AGENTS.md principles hold. **Observe, don't gate:** no new refusal. A skip or a shortfall is reported as information (a `did` clause, a `skipped` row, a juncture line). **The pilot's context is the game, not our plumbing.**
- The server takes one mutation per battle poll. Every poll sends at most one of stance/target/advance/retreat/reload. Existing tests assert this; keep them green.
- Match the file's density: terse one-line bodies, few blank lines. Keep TypeScript erasable (no enums, namespaces or parameter properties). Use `.ts` on relative imports.
- Every tuned constant carries a `ponytail:` comment naming its ceiling. A comment that cites a live incident says so: `// Live 2026-10-18 (kvothe 02:26Z): …`. A test that pins that behavior carries the same line.
- After any change to an exported type or function signature under `src/play`, run `npm run gen:play` and commit the changed `play.gen/` files with the task. CI diffs it.
- When a tool's behavior changes, update `src/play/combat/README.md` (the Hunter skill the pilot reads) in the same task.
- Verify with `node --test <file>` per task. Before each commit run `npm run typecheck`, `npm run lint` and `npm test`; all must be clean. `pace.tickMs=1` in tests; TestClock for anything ceiling-sized.
- Constants (spec "left to the builder", decided here): `DANGER_LINE=0.30`, `FLEE_STALL=4` polls, `RELOAD_AT=0.25` of `magazine_size`, `LOW_AMMO=2` units in the hold, `PER_CLASS=10` fights, overall `CAP=120` fights, `MIN_SHOTS=5` for a measured band. The class key is the opponent display name (`FightRecord.opponent`, the same as `Prey.name`).

## Review Focus

1. **A battle status with no `combat_state` at all.** Expected: this is not "escape blocked". The loop assumes the baseline `flee_required` of 3, so a line crossing still flees. Test in Task 3.
2. **Our `max_hull` unread (0 or absent) while fighting.** Expected: the rule falls back to our own row's `hull_pct`. It neither flees at once nor never flees. Test in Task 2.
3. **Two or more enemies standing (a pirate pair).** Expected: "enemy closer to dead" compares our hull with the *healthiest* standing enemy, not the focused one. Test in Task 2.
4. **A weapon module with no `magazine_size` (the live wildlife rows and the fake).** Expected: no top-up and no pre-fight reload of a part-full magazine. An empty magazine is still reloaded, as today. Test in Task 7.
5. **The juncture's prey read refused or lost.** Expected: the context renders without `prey`. The menu does not fail and no other block is lost. Test in Task 9.

---

## File map

| File | Change |
|---|---|
| `src/mood-policy.ts` | add `DANGER_LINE`, `dangerLine()` |
| `src/combat-memory.ts` | per-class retention; `RecentRecord`, `recentRecord()`, `covers()`, `recordLine()` |
| `src/play/combat/hunting.ts` | the rule (`shouldRun`, `escapeCost`), the loop's flee state, the range ladder, `bestBand`, reloads, `ammoReport`, risk limit, `preyHereEffect` |
| `src/play/combat/arena.ts` | `lossFatal:false` instead of `floor:0` |
| `src/run.ts` | `closeBattle` fights through `battleEffect` |
| `src/bridge.ts`, `src/context.ts` | `prey`, `danger_line`, ammo in the juncture |
| `src/test-support/battle-script.ts` (new) | a scripted `battle/status` sequence over `bridgeWorld`, for replay tests |
| `src/test-support/bridge-world.ts` | `WildlifeOptions.weapon.magazine_size` |
| tests | `combat-memory.test.ts`, `combat/combat.test.ts`, `combat/hunting.test.ts`, `combat/arena.test.ts`, `run.test.ts`, `bridge.test.ts`, `context.test.ts` |
| `src/play/combat/README.md`, `play.gen/` | docs and declarations, per task |

---

### Task 1: Combat memory keeps ten fights per class and reads a recent record

**Files:**
- Modify: `src/mood-policy.ts` (append)
- Modify: `src/combat-memory.ts` (`CAP` ~line 22, `writeFight` ~128-138; new exports after `statsFor`)
- Test: `src/combat-memory.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `mood-policy.ts`: `export const DANGER_LINE=0.30;` and `export const dangerLine=(max_hull:number):number=>Math.ceil(DANGER_LINE*max_hull);`. 80 → 24, 100 → 30.
  - `combat-memory.ts`: `export const PER_CLASS=10;` and `CAP` becomes `120`, an overall ceiling (pirate names can be per-individual, so retention by class alone is unbounded).
  - `export interface RecentRecord {opponent:string;fights:number;won:number;stalemate:number;lost:number;avg_hull_lost?:number;worst_hull_lost?:number;thin:boolean}`
  - `export function recentRecord(fights:FightRecord[],opponent:string):RecentRecord|undefined`
  - `export function covers(rec:RecentRecord|undefined,ship:{hull:number;max_hull:number}):boolean|undefined`
  - `export function recordLine(rec:RecentRecord|undefined,covered:boolean|undefined):string`

- [ ] **Step 1: Write the failing tests** in `src/combat-memory.test.ts`. Reuse the file's `temp()` and the `record(n,at)` shape from the "bounded" test.

```ts
test('the combat store keeps the last ten fights per opponent, so a rare one is not pushed out by common quarry',()=>{
  const runtime=temp(),now=Date.parse('2026-10-17T12:00:00.000Z');
  const rec=(opponent:string,n:number):FightRecord=>({opponent,ticks:1,by_range:{},dealt:1,taken:1,stances:['fire'],flee_ticks:0,ending:'victory',at:new Date(now+n).toISOString()});
  writeFight(runtime,rec('Slag-Tortoise',0));
  for(let n=1;n<=70;n++)writeFight(runtime,rec('Veil-Ray',n));
  const kept=readCombat(runtime);
  assert.equal(kept.filter(row=>row.opponent==='Veil-Ray').length,PER_CLASS);
  assert.equal(kept.filter(row=>row.opponent==='Slag-Tortoise').length,1,'the rare class keeps its record');
});

test('a recent record counts endings, averages and worst hull lost, and says whether the worst is covered',()=>{
  const at='2026-10-17T12:00:00.000Z';
  const f=(ending:string,from?:number,to?:number):FightRecord=>({opponent:'Veil-Ray',ticks:5,by_range:{},dealt:1,taken:1,stances:[],flee_ticks:0,ending,at,
    ...from===undefined?{}:{hull_pct_from:from},...to===undefined?{}:{hull_pct_to:to}});
  const fights=[f('victory',100,96),f('stalemate',100,100),f('defeat',90,20),f('mutual_destruction',50,0),f('victory')];
  const rec=recentRecord(fights,'Veil-Ray')!;
  assert.deepEqual([rec.fights,rec.won,rec.stalemate,rec.lost],[5,2,1,2]);
  assert.equal(rec.worst_hull_lost,70);
  assert.equal(rec.avg_hull_lost,31,'(4+0+70+50)/4: the four fights that read the hull at both ends');
  assert.equal(rec.thin,false);
  assert.equal(covers(rec,{hull:80,max_hull:80}),false,'100% less 70 is 30, not above the line');
  assert.equal(covers(rec,{hull:81,max_hull:80}),true);
  assert.equal(recentRecord(fights,'Quantum-Moth'),undefined);
  assert.equal(covers(undefined,{hull:80,max_hull:80}),undefined);
  assert.equal(recentRecord(fights.slice(0,2),'Veil-Ray')!.thin,true,'under THIN fights');
  // The window is the last PER_CLASS fights, newest first, as readCombat returns them.
  assert.equal(recentRecord([...Array(12)].map(()=>f('victory',100,99)),'Veil-Ray')!.fights,PER_CLASS);
});

test('the record line says unknown for a class never fought, and names an unread hull loss',()=>{
  assert.equal(recordLine(undefined,undefined),'unknown: never fought');
  const rec={opponent:'Veil-Ray',fights:10,won:8,stalemate:2,lost:0,avg_hull_lost:1.2,worst_hull_lost:11,thin:false};
  assert.equal(recordLine(rec,true),'8 won, 2 stalemate, 0 lost (last 10); hull lost avg 1.2, worst 11 pts; covers');
  assert.equal(recordLine({...rec,worst_hull_lost:undefined,avg_hull_lost:undefined},undefined),'8 won, 2 stalemate, 0 lost (last 10); hull loss unread');
  assert.match(recordLine({...rec,fights:2,won:2,stalemate:0,thin:true},false),/\(last 2\).*; does NOT cover: the worst would take the hull under the danger line; thin sample$/);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `node --test src/combat-memory.test.ts`. Expected: FAIL, `PER_CLASS`/`recentRecord` not exported.

- [ ] **Step 3: Implement.**
  - `writeFight` keeps the new fight first, then drops any row past the `PER_CLASS`-th for its opponent, then slices to `CAP`. The existing "bounded" test must still pass unchanged.
  - `recentRecord` takes the first `PER_CLASS` rows for `opponent`. `won` is `victory`. `lost` is `defeat` or `mutual_destruction`. Everything else is `stalemate`. Hull lost per fight is `max(0, from−to)`, from rows that read both ends. Round the average to one decimal. `thin` is `fights<THIN`.
  - `covers` returns `undefined` when `rec` or `rec.worst_hull_lost` is undefined. Otherwise it returns `100*hull/max_hull - worst > 100*DANGER_LINE`.
  - `recordLine` takes its exact copy from the test. Clauses are joined with `; `. The cover clause is `covers` or `does NOT cover: the worst would take the hull under the danger line`, and is omitted when `covered` is undefined. `thin sample` comes last when thin.
  - Arena fights count in the record like any other. Say so in the doc comment.
  - The `ponytail:` notes on `PER_CLASS`/`CAP` replace the old 60-fight note.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `node --test src/combat-memory.test.ts`. Expected: PASS, the old tests included.

- [ ] **Step 5: Evidence for the line, then commit.** Run this over the live record and paste its output into the commit body:

```bash
jq -r '.fights[]|select(.ending=="victory")|.hull_pct_to' ~/.hermes/profiles/kvothe/spacemolt/runtime/combat.json | sort -n | head -3
```

```bash
git add src/mood-policy.ts src/combat-memory.ts src/combat-memory.test.ts
git commit -m "feat(play): combat memory keeps ten fights per class and reads a recent record"
```

---

### Task 2: The danger line replaces the mood floor and Tired inside a fight

**Files:**
- Create: `src/test-support/battle-script.ts`
- Modify: `src/play/combat/hunting.ts`: `TickView` (84-85), `LoopOpts`/`battleLoop` (303-532), `engage` (535-554), `battleEffect`/`fightBattle` (572-602), `huntEffect`'s `floor` (691), the between-fight check (765), `ended:'hull'` why (860-864), and the `hunt`/`fightBattle` JSDoc
- Modify: `src/play/combat/arena.ts:43`
- Modify: `src/play/combat/README.md` (Functions table row for `fightBattle`; `TickView` table `floor` row; "The bounds you cannot argue with"; "With no callback"; Arena paragraph on floor 0; "The flee rule"; "When to reconsider")
- Test: `src/play/combat/hunting.test.ts`, `src/play/combat/combat.test.ts`, `src/play/combat/arena.test.ts`

**Interfaces:**
- Consumes: `dangerLine(max_hull)` from `src/mood-policy.ts` (Task 1).
- Produces (all in `hunting.ts`, exported):
  - `export interface StayRead {hull_pct:number;opponent_hull_pct:number;loss_fatal:boolean;escape_cost:number;hull:number;line:number}`. Percentages are 0..100. `opponent_hull_pct` is the healthiest standing enemy. `line` is `dangerLine(max_hull)` in hull points, compared with `hull`. When `max_hull` is unread (0), `hull_pct` is our own row's `hull_pct` and the line is compared in percent (`hull_pct < 100*DANGER_LINE`).
  - `export function shouldRun(read:StayRead):{run:boolean;why:string}`. Evaluated in this order:
    1. `!loss_fatal` → stay, `loss is not fatal here`.
    2. Not under the line → stay, `above the danger line`.
    3. `opponent_hull_pct < hull_pct` → stay, `` `the enemy is closer to dead (${o}% against our ${h}%)` ``.
    4. `escape_cost >= hull` → stay, `` `the escape would cost ~${c} hull of the ${hull} left` ``.
    5. Otherwise run, `` `hull ${hull} under the danger line ${line}, the enemy at ${o}%, the escape ~${c} hull` ``.
  - `export function escapeCost(recentLoss:number[],ourZone:string|undefined,fleeRequired:number|undefined):number`. This is our hull lost per poll, averaged over the last 3 entries (0 when none), times (polls to outer + `fleeRequired`). Polls to outer come from `bandOf(zone)`: inner 2, mid 1, outer 0, unknown 2. `fleeRequired` undefined (blocked) returns `Infinity`.
  - `TickView` keeps the field name `floor`. 101 live pilot programs read `view.floor` to disengage, and renaming it would break their checks for no gain. Its value is now `dangerLine(max_hull)` when loss is fatal and `0` when it is not. Add `loss_fatal:boolean`. Rewrite the doc comment.
  - `LoopOpts` drops `floor`/`tired` and gains `lossFatal:boolean`.
  - `battleEffect(opts:{lossFatal?:boolean;boss?:string;ceilingMs?:number;onTick?})`. Default `lossFatal:true`; `floor` is removed.
  - `fightBattle(opts:{lossFatal?:boolean;boss?:string;onTick?})`.
  - `engage(target,onTick?,stats?)`, with no floor.
- `src/test-support/battle-script.ts`:

```ts
/** One logged `battle/status` poll. `theirs` is the quarry's hull_pct; `flee_required: null` omits it (escape blocked);
 * `combat_state: false` omits the whole object. */
export interface ScriptedPoll {hull:number;theirs:number;zone:string;distance:number;reach?:number;shield?:number;
  ourZone?:string;stance?:string;target?:string;flee_counter?:number;flee_required?:number|null;combat_state?:false;
  /** More standing enemies on their side, as [player_id, hull_pct]. */
  others?:[string,number][]}
/** `game.command` with `spacemolt_battle/status` answered from `polls` in order (setting the ship's hull to each `hull`),
 * `no_active_battle` after the last; once a `stance flee` is sent, `onFlee` is played instead when given. `spacemolt/hunt`
 * and `spacemolt/attack` are accepted without starting the world's own battle. Every other call goes to `game.command`.
 * The quarry is `quarry` (default `{id:'c1',name:'Veil-Ray'}`), our row is `player_id:'ship'`. */
export function scriptedBattle(game:ReturnType<typeof bridgeWorld>,polls:ScriptedPoll[],
  opts?:{quarry?:{id:string;name:string};onFlee?:ScriptedPoll[]}):{command:typeof game.command;sent:{action:string;params:any}[]}
```

- [ ] **Step 1: Write the failing rule tests** in `hunting.test.ts`:

```ts
test('the in-fight rule: stay above the line, stay below it while the enemy is closer to dead, run otherwise',()=>{
  const at=(o:Partial<StayRead>):StayRead=>({hull_pct:20,hull:16,line:24,opponent_hull_pct:55,loss_fatal:true,escape_cost:4,...o});
  assert.equal(shouldRun(at({hull_pct:88,hull:70})).run,false,'70/80 is above 24');
  assert.equal(shouldRun(at({opponent_hull_pct:15})).run,false);
  assert.match(shouldRun(at({opponent_hull_pct:15})).why,/closer to dead \(15% against our 20%\)/);
  assert.equal(shouldRun(at({})).run,true);
  assert.equal(shouldRun(at({escape_cost:16})).run,false,'an escape costing all the hull left is not survivable');
  assert.equal(shouldRun(at({loss_fatal:false,hull:1,hull_pct:1})).run,false,'the arena never flees');
});
test('the escape is priced from our recent hull loss, the way out, and flee_required; blocked is unpriceable',()=>{
  assert.equal(escapeCost([2,4,6],'inner',3),20,'mean 4 a poll × (2 to outer + 3)');
  assert.equal(escapeCost([],'mid',3),0);
  assert.equal(escapeCost([4],'engaged',3),20,'engaged is inner');
  assert.equal(escapeCost([0],'outer',undefined),Infinity);
});
```

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/play/combat/hunting.test.ts`. Expected: FAIL, `shouldRun` not exported.

- [ ] **Step 3: Implement `shouldRun`/`escapeCost`, then the loop wiring.**
  - Each poll records `max(0,lastHull-hull)` into a 3-long window.
  - The opponent hull for the rule is the max `hull_pct` among `enemies` (the healthiest standing).
  - Read `flee_required`/`flee_counter`/`can_escape` from `combat_state`: extend the `Status` decoder's `combat_state` struct with `Schema.optionalKey` fields from `Wire.BattleCombatState.fields`. `can_escape===false` counts as blocked. A missing `combat_state` means `flee_required` 3 (Review Focus 1).
  - Replace `hull<floor()||tired` with `shouldRun(...).run`. Keep the override line, reworded: `` `override: onTick asked ${json}, and the danger line ${line} wins: ${why}` ``. The break-off step becomes `` `breaking off: ${why}` ``.
  - When below the line but staying, step `` `under the danger line ${line} at hull ${hull}: fighting on — ${why}` `` once each time `why` changes.
  - The brace rung's `floor()` becomes the danger line. Remove the `tired` path and `pilot().mood` reads inside the loop.
  - In `huntEffect`, the between-fight check becomes `hull<dangerLine(max_hull)` → `ended:'hull'`. The `ended:'hull'` why becomes `` `hull ${hull} under the danger line ${line}` `` (the `unresolved` branch is unchanged). The hunt's Tired stop after a fight (line 807) stays.
  - `resolveWalkAway` leaves `hunting.ts`. `mood-policy.ts`'s `crossed` still uses it to impose Tired.
  - In `arena.ts`, `fightTo` uses `battleEffect({lossFatal:false,…})`.
  - The post-loop and `tapError` `floor()>0` tests become `opts.lossFatal`. The flee stays `breakOff()` here; Task 3 replaces it.

- [ ] **Step 4: Write the replay and focus tests.** Put them in `combat.test.ts`: the world there derives the mood, so Tired lands for real. Write the scripted helper first.

```ts
// Live 2026-10-18 (kvothe 02:26Z): "hull 70/80 under the Focused walk-away line 72" made the pilot Tired, then
// "breaking off: hull 70 under the line 76, and Tired" fled a Veil-Ray at 55%: a 7-point scratch ended a won fight.
test('replay 10-18 02:26Z: Tired mid-fight does not break off a winning fight',async()=>{
  // The logged polls (reach 3), then three invented ones to the kill.
  const polls:ScriptedPoll[]=[[77,100,'outer',6],[77,100,'outer',6],[77,100,'outer',6],[77,100,'mid',4],[76,85,'inner',2],
    [75,70,'inner',2],[74,70,'inner',2],[70,55,'inner',2],[69,40,'inner',2],[68,25,'inner',2],[67,10,'inner',2]]
    .map(([hull,theirs,zone,distance])=>({hull,theirs,zone,distance,reach:3,stance:'fire'}) as ScriptedPoll);
  // world: {mood:'Focused'}, max_hull 80, a Veil-Ray (crt c1) at the POI; command = scriptedBattle(game,polls).command
  …
  const out=await hunt();
  assert.equal(sent.some(call=>call.action==='spacemolt_battle/stance'&&call.params?.id==='flee'),false);
  assert.notEqual(out.detail.fights[0]!.outcome,'broke off');
  assert.equal(f.record().mood,'Tired','Tired still lands; it no longer ends the fight');
});
test('two enemies standing: the healthiest one decides whether the enemy is closer to dead',async()=>{ /* hull 20/80, quarry 10%, others [['c2',90]] → flee sent */ });
test('our max_hull unread: the rule reads our own row\'s hull_pct',async()=>{ /* ship.max_hull=0, our row hull_pct 15, theirs 80 → flee sent; hull_pct 60 → no flee */ });
```

  Add `hull_pct` to `ScriptedPoll` if the max_hull test needs it set apart from `hull`.

- [ ] **Step 5: Rewrite the tests that pinned the old line, keeping their live-incident comments.**
  - In `combat.test.ts`:
    - "hunt breaks off at the walk-away line, which is also what imposes Tired" becomes "Tired mid-fight finishes the fight and stops the next one". Assert: no flee stance, `fights.length===1`, `ended:'tired'`.
    - "the walk-away line follows the mood …" becomes "a mood change mid-hunt does not move the line". Use `worldWithMoodMoved`, and assert no break-off at hull 84.
    - "the walk-away floor overrides a reckless callback" becomes the danger line overriding it. Raise `damage` so the hull crosses 30.
    - "… braces only once the line is in sight" braces within 5% of the danger line.
    - "a hull crossing … while tick_duration is stuck" crosses the danger line.
    - "breaking off at the hull line waits …" gets new hull numbers.
  - In `hunting.test.ts`, the test "a hunt broken off at the hull line holds the flee …" must still flee. With `damage:4,fleeTicks:6` the escape costs 4×(2+7)=36 ≥ the hull left, so the rule stays. Use `damage:2`.
  - In `arena.test.ts`, "arena() fights to the end through the walk-away line" becomes "through the danger line": `damage` large enough to end under 30.

- [ ] **Step 6: Run the combat tests.** Run `node --test src/play/combat/*.test.ts`. Expected: PASS.

- [ ] **Step 7: Docs, declarations, full checks, commit.**
  - In the README, state the rule in the user's words: run only to save the ship; below 30% of max hull, flee unless the enemy is closer to dead or the escape itself would cost the hull left; Tired never ends a fight in progress; `view.floor` is now the danger line and `0` in the arena.
  - Run `npm run gen:play`, then `npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.ts src/play/combat/arena.ts src/play/combat/README.md src/test-support/battle-script.ts \
  src/play/combat/hunting.test.ts src/play/combat/combat.test.ts src/play/combat/arena.test.ts play.gen
git commit -m "feat(play): flee only under the danger line, and Tired no longer ends a fight"
```

---

### Task 3: A flee is a loop state that can be abandoned

**Files:**
- Modify: `src/play/combat/hunting.ts` (`battleLoop`: `breakOff`, the `sent==='disengage'` branch, the ceiling branches, post-loop break-off, `tapError`; `Fight.why` for `broke off`)
- Modify: `src/play/combat/README.md` ("The flee rule" mechanics; `disengage` row in `TickDecision`)
- Test: `src/play/combat/hunting.test.ts`

**Interfaces:**
- Consumes: `shouldRun`, `escapeCost`, `scriptedBattle`/`ScriptedPoll` (Task 2).
- Produces:
  - `export const FLEE_STALL=4;`. ponytail: a flee whose `flee_counter` has not risen for this many polls is abandoned. The live evidence is that 138 of 146 flees ended within 3 polls, the longest took 4, and a flee from inner sits at 0/3 for 2 polls while it retreats.
  - `LoopOpts.boundMs?:number`: a hard bound from the loop's start, after which the loop returns `outcome:'unresolved'` with the battle as it stands. Default `Infinity`. Only the run's close passes it (Task 5).
  - `battleEffect` opts gain `boundMs?:number`.
  - `LoopEnd` gains `why?:string`, the reason for a break-off or abandoned flee, as the step said it.

- [ ] **Step 1: Write the failing tests** with `scriptedBattle` and the file's `clocked` helper:

```ts
// Spec D2 hazard 1: breakOff was disengageEffect(Infinity) — a blocked flee held forever at 0% dealt, 100% taken.
test('a flee whose flee_required goes missing returns to fire and fights on to the end',async()=>{
  // poll 1: hull 20/80, theirs 90%, inner → flee sent; onFlee: two polls with flee_required null, then the kill.
  …
  assert.deepEqual(stanceIds,['flee','fire'],'back to fire once, and not fled again while blocked');
  assert.match(lines,/flee blocked/);
  assert.equal(out.detail.fights[0]!.outcome,'escaped'); // the world lists no wreck; the point is the loop ran to the end
});
test('a flee whose counter has not risen for four polls is abandoned, and the escape is not tried again that fight',async()=>{
  // onFlee: 6 polls at flee_counter 0, flee_required 3, hull still under the line, theirs 90% → one flee, one fire
  …
  assert.equal(stanceIds.filter(id=>id==='flee').length,1);
  assert.match(lines,/flee stalled at 0\/3 for 4 polls: back to fire/);
});
test('brace never follows flee',async()=>{ /* after an abandoned flee, shield 0 and the brace conditions met → no brace sent */ });
test('a status with no combat_state is not a blocked escape: the line still flees',async()=>{ /* combat_state:false → flee sent and held */ });
test('an agent disengage that cannot get away is bounded the same way',async()=>{ /* onTick {disengage:true} on poll 1, onFlee blocked → fire */ });
```

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/play/combat/hunting.test.ts`. Expected: the new tests FAIL. The flee is held, `fire` is never sent.

- [ ] **Step 3: Implement the flee state inside `battleLoop`.**
  - `fleeing?:{why:string;best:number;still:number}`, plus fight-long flags `fled` (it disables brace) and `stalled` (it makes `escapeCost` read `Infinity` for the rest of the fight).
  - Entering a flee: from `shouldRun`, from `{disengage:true}`, or from the ceiling with `lossFatal`. Send `stance flee` once, with `disengageEffect`'s semantics: a refusal is re-sent next poll; a lost reply is held.
  - While fleeing, `onTick` is not asked and no other mutation is sent. Each poll does one of three things:
    - The battle ended: `outcome:'broke off'`, unless the ceiling started the flee, which keeps `'unresolved'`.
    - Blocked (`combat_state` present and `flee_required` absent, or `can_escape===false`): send `stance fire`, step `` `flee blocked (flee_required absent): back to fire, the rule re-applied` ``, clear `fleeing`.
    - `flee_counter` not above `best` for `FLEE_STALL` polls: set `stalled`, send `stance fire`, step `` `flee stalled at ${c}/${r} for ${FLEE_STALL} polls: back to fire` ``.
  - After that, `shouldRun` runs every poll as in Task 2. A blocked escape prices at `Infinity`, so the loop does not re-flee while it stays blocked.
  - The ceiling with `lossFatal` starts the flee and the loop keeps polling. A hunt never hands back a live battle; that is the 10-15 lesson in commit 714b199. With `!lossFatal`, the ceiling ends `unresolved` as today. Reaching `boundMs` ends `unresolved` either way.
  - Delete the post-loop break-off. `tapError` becomes `lossFatal?disengageEffect(FIGHT_CEILING_MS):Effect.void`: bounded, never `Infinity`.
  - `engage`'s `why` for `broke off` is `end.why`.
  - `disengage()`, the exported function, is unchanged.

- [ ] **Step 4: Run the combat tests.** Run `node --test src/play/combat/*.test.ts`. Expected: PASS. The TestClock test "a fight that never ends is given up on at the ceiling" still passes, because the world's flee ends after `fleeTicks:0`.

- [ ] **Step 5: Docs, checks, commit.** In the README, say that a flee that cannot get away returns to fire rather than sitting at 0% dealt, and that `disengage` is bounded the same way inside a fight. Then run `npm run gen:play && npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.ts src/play/combat/README.md src/play/combat/hunting.test.ts play.gen
git commit -m "fix(play): a blocked or stalled flee goes back to fire instead of holding forever"
```

---

### Task 4: Find the user's flee stall and pin it

**Files:**
- Test: `src/play/combat/hunting.test.ts` (one replay test)
- Modify: `src/play/combat/hunting.ts`, only if the root cause is not covered by Task 3

**Interfaces:**
- Consumes: `scriptedBattle`/`ScriptedPoll` (Task 2), `FLEE_STALL` and the flee state (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Search the kvothe journals** (`~/.hermes/profiles/kvothe/spacemolt/runtime/gameplay*.jsonl`, UTC) for each of these:
  - (a) A `flee`/`breaking off` sequence of more than 4 status polls before the battle's end.
  - (b) A `flee N/blocked` line.
  - (c) A flee followed by a `death` event.
  - (d) The pilot's own words about a stuck flee in `~/.hermes/profiles/kvothe/cron/output/*/*.md` (`grep -il "flee"`).

  A quick controller pass found no line matching `/blocked)/` and no run of more than 4 `flee:` lines. A cruder poll count, which may mis-segment, flagged break-offs starting 2026-10-13T14:54Z, 10-12T05:42Z, 10-13T19:00Z and 10-10T21:56Z. Read those first. Deaths are at 10-09 (×4), 10-12 and 10-15T19:21Z.

- [ ] **Step 2: Decide.**
  - Found: write down the polls (hull, theirs, zones, `flee_counter`/`flee_required`, the stance sent) and the cause in one paragraph.
  - Not found: stop. Report the searches and their counts to the controller. Do not invent a fixture.

- [ ] **Step 3: Write the regression test**: `` `replay <date>: <what stalled> no longer stalls` `` in `hunting.test.ts`, with a `// Live …` comment. Assert that the loop either escapes, or goes back to fire within `FLEE_STALL` polls. Run `node --test src/play/combat/hunting.test.ts`. If it fails, the root cause is outside Task 3's flee state. Fix it in `hunting.ts`, with the smallest change at the shared function, and re-run.

- [ ] **Step 4: Checks, commit.** Run `npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.test.ts   # plus src/play/combat/hunting.ts if Step 3 changed it
git commit -m "test(play): replay the <date> flee stall"   # fix(play): … when code changed
```

---

### Task 5: The run's close fights a live battle instead of fleeing it

**Files:**
- Modify: `src/run.ts` (`closeBattle` 200-245, its caller's `why` 377-386, import line 23)
- Test: `src/run.test.ts` (tests at 227, 247, 262, 538, 553, 570)

**Interfaces:**
- Consumes: `battleEffect({lossFatal,ceilingMs,boundMs})` → `Battled` (Tasks 2-3). `outcome:'ended'|'broke off'|'unresolved'`; `'unresolved'` means the battle is still live.
- Produces: `closeBattle(answerBy:number):Promise<{opponent:string;ended:boolean;arena?:string}|null>`. The signature is unchanged.

- [ ] **Step 1: Write the failing tests.** Rewrite the existing ones:
  - Line 227 becomes "a run that hands back with a battle live fights it to its end, and says so" (spec D5 replay). Use `wildlife:{polls:3,damage:0}`. Assert no `flee` stance is sent, the ship can travel afterwards, and `why` matches `/the runtime fought it to its end before the flight closed/`.
  - Line 247 (arena): assert no `flee`. `stance fire` is now allowed. `why` matches `/mid-match in the arena against Ring Levy; the runtime fought it to its end/`.
  - Line 262 (deadline): with `closeMs:300` and a flee that never escapes, `why` matches `/the battle is still live at the close's bound/`, inside the same time bound.
  - Line 538: matches the new wording.
  - Line 553: assert the loop's own read found no battle and nothing is reported held. Drop the "stance sent" assertion.
  - Line 570: the injected bug is still a defect line, and `why` says the battle is still live.

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/run.test.ts`. Expected: the rewritten tests FAIL.

- [ ] **Step 3: Implement.**
  - Keep the battle read and the arena read. `lossFatal=!arena`.
  - Step `` `the flight returned with a battle still live against ${opponent}: fighting it under the danger line${arena?' (an arena match: losing is not fatal)':''}` ``.
  - Run `battleEffect({lossFatal,ceilingMs:Math.floor(bound()/2),boundMs:bound()})` inside `edge(Effect.gen(… build('fight the battle','done',battled)))`. ponytail: half the close's bound fights, the rest flees for a fatal one.
  - `ended` is `outcome!=='unresolved'`.
  - The four `why` texts:
    - Arena, ended: `the flight ended mid-match in the arena against X; the runtime fought it to its end before the flight closed`
    - Arena, live: `the flight ended mid-match in the arena against X; fought to the close's bound and left to finish, because fleeing forfeits it — the ship stays in the battle until it resolves`
    - Fatal, ended: `the flight ended mid-battle against X; the runtime fought it to its end before the flight closed`
    - Fatal, live: `the flight ended mid-fight against X and the battle is still live at the close's bound`
  - Remove the now-unused `disengage` import. Update `closeBattle`'s doc comment: the arena carve-out is now just "loss not fatal".

- [ ] **Step 4: Run the tests.** Run `node --test src/run.test.ts`. Expected: PASS.

- [ ] **Step 5: Checks, commit.** In the README's Arena section, a flight that ends mid-match is now fought to its end at the close, not left alone. Run `npm run typecheck && npm run lint && npm test`.

```bash
git add src/run.ts src/run.test.ts src/play/combat/README.md
git commit -m "fix(play): a flight's close fights a live battle out instead of fleeing or forfeiting it"
```

---

### Task 6: Close range from the first tick; chase only with `pursue`

**Files:**
- Modify: `src/play/combat/hunting.ts` (the default ladder 491-524; `hunt`/`huntEffect`/`engage`/`battleEffect`/`fightBattle` opts; the open's stance/focus)
- Modify: `src/play/combat/README.md` ("With no callback"; the Functions table; the chase sentence in "The flee rule")
- Test: `src/play/combat/combat.test.ts`, `src/play/combat/arena.test.ts`

**Interfaces:**
- Consumes: `CombatStats.accuracy` (`statsFor`), `bandOf` from `combat-memory.ts`, `dangerLine`, `scriptedBattle`.
- Produces:
  - `export const MIN_SHOTS=5;`
  - `export function bestBand(stats:CombatStats|undefined):'inner'|'mid'|'outer'`. It picks the band with the highest `at_them` among `inner`/`mid`/`outer` that have `at_them_shots>=MIN_SHOTS`. A tie goes to the nearer band. With nothing measured it returns `'inner'`.
  - `pursue?:boolean` (default false) on `hunt`, `huntEffect`, `fightBattle`, `battleEffect` and `LoopOpts`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('bestBand picks the measured band we hit best, and inner with nothing measured',()=>{
  assert.equal(bestBand(undefined),'inner');
  assert.equal(bestBand({...stats,accuracy:{inner:{at_them:0.4,at_them_shots:20,at_us_shots:0},mid:{at_them:0.7,at_them_shots:12,at_us_shots:0},outer:{at_them:0.9,at_them_shots:2,at_us_shots:0}}}),'mid','outer is under MIN_SHOTS');
});
// Spec evidence: the first two ticks of every recent fight sat at outer, out of reach.
test('the loop advances on the first poll when the stance and focus are already in force',async()=>{ /* poll 1 outer 6/3, our row stance fire, target c1 → first mutation is advance */ });
// Live 2026-10-16 (kvothe 19:31Z): a Veil-Ray at 10% stepped inner 2 → mid 3 on the last row and escaped.
test('replay 10-16 19:31Z: an escape is a clean stalemate without pursue, and chased on the tick the range opens with it',async()=>{
  // polls (hull 80/80, reach 3): 100 outer 6; 100 mid 4; 100 inner 2; 86,73,60,36,23,23,10 inner 2; 10 mid 3; then the end
  // pursue off: no advance on or after the mid-3 poll; outcome 'escaped'. pursue on: exactly one advance on the mid-3 poll.
});
test('closing stops at the best band, and when an advance no longer shortens the range',async()=>{ /* stats best mid: no advance from mid 3/3 to inner */ });
```

  Rewrite "a quarry that runs is chased" into a pursue-off test and a pursue-on test. Off: no `advance` after the range first opens. On: one `advance` per poll on which the range opened.

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/play/combat/combat.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the ladder.**
  - Before the ladder, take what the server's own row already has in force: `mine.stance==='fire'` sets `stanceNow`, and `mine.target_id===theirs.player_id` sets `focused`, so neither costs the tick.
  - Rung order: open stance → reload an empty magazine → focus → evade exit/enter (kiter, unchanged) → brace (unchanged except never after a flee) → fire again → **close** → **pursue**. Task 7 adds a top-up last.
  - `opened` is `far >` the previous poll's `far` for the same opponent.
  - **Close** advances when `!opened && end.fled===0 && !closeStuck && (far>reach || ring(bandOf(theirs.zone)) > ring(bestBand(stats)))`, where `ring` is the index in `['inner','mid','outer']`. An unknown zone uses only `far>reach`.
  - `closeStuck` is set when the poll after an advance reads `far` no smaller than before it. It clears when `far` changes.
  - **Pursue** advances when `opts.pursue && opened && hull>=line`, with step `` `pursue: ${name} opened the range ${prev}→${far}` ``.
  - Remove the old `end.fled>0&&far>0` chase.
  - In `arena.test.ts`, "fightBattle measures range from the opponent's row … stops advancing once in reach" now asserts the advances stop when the range stops closing. The fake reports every distance ≤2 as `mid`, so count the advances up to `holds`.

- [ ] **Step 4: Run the combat tests.** Run `node --test src/play/combat/*.test.ts`. Expected: PASS.

- [ ] **Step 5: Docs, declarations, checks, commit.** README: the default loop closes from the first tick toward the band memory says we hit best; an escaping quarry is let go unless `pursue:true`. Then run `npm run gen:play && npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.ts src/play/combat/README.md src/play/combat/combat.test.ts src/play/combat/arena.test.ts play.gen
git commit -m "feat(play): close range from the first tick, and chase an escape only with pursue"
```

---

### Task 7: Reload before the magazine runs dry, and say when the hold is low

**Files:**
- Modify: `src/play/combat/hunting.ts` (`loadoutEffect` 166-182; a last ladder rung; `huntEffect`'s final `did`)
- Modify: `src/test-support/bridge-world.ts` (`WildlifeOptions.weapon` gains `magazine_size?:number`)
- Modify: `src/play/combat/README.md` ("What a good fight looks like")
- Test: `src/play/combat/combat.test.ts`, `src/play/combat/arena.test.ts`

**Interfaces:**
- Consumes: the ladder from Task 6.
- Produces:
  - `export const RELOAD_AT=0.25;` and `export const LOW_AMMO=2;`
  - `export function ammoReport(modules:readonly {type?:string;name?:string;ammo_type?:string;current_ammo?:number;magazine_size?:number}[],cargo:readonly {item_id:string;quantity:number}[]):{weapons:{name:string;ammo_type?:string;loaded:number;magazine?:number;hold:number}[];low:string|null}`
  - `low` covers each weapon with an `ammo_type` whose hold quantity is `<LOW_AMMO`, joined with `; `. The clause is `` `low ammo: ${hold} ${ammo_type} in the hold for ${name}` ``, or `` `no ${ammo_type} in the hold for ${name}` `` at 0. `null` when none is low.

- [ ] **Step 1: Write the failing tests.**

```ts
test('before the first shot a part-full magazine is topped up from the hold; one with no magazine_size is left alone',async()=>{
  // weapon {ammo_type:'autocannon',current_ammo:20,magazine_size:50}, cargo autocannon ×3 → one reload before spacemolt/hunt
  // weapon {ammo_type:'autocannon',current_ammo:20} (no magazine_size) → no reload (Review Focus 4)
});
test('in a lull a magazine under a quarter is topped up, once, and never ahead of a rung that is owed',async()=>{ /* current_ammo 10 of 50 */ });
test('ammoReport names a hold running low, and hunt says it in did without refusing',async()=>{
  assert.equal(ammoReport([{type:'weapon',name:'Autocannon I',ammo_type:'autocannon',current_ammo:500}],[{item_id:'autocannon',quantity:1}]).low,
    'low ammo: 1 autocannon in the hold for Autocannon I');
  // hunt() with one box aboard: status 'done', did matches /low ammo: 1 autocannon in the hold/
});
```

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/play/combat/combat.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `loadoutEffect` reloads each weapon whose ammo is in the hold, when `magazine_size` is known and `current_ammo<magazine_size`, or when `current_ammo===0`. That avoids the live `magazine_full` refusal. Its return contract is unchanged; the "no weapon can load at all" refusal stays.
  - The last ladder rung is a top-up. It applies to a weapon with `magazine_size`, `current_ammo < RELOAD_AT*magazine_size`, ammo in the hold, and not in `reloadTried`. Step `` `reload ${name}: ${n}/${m} rounds, topping up in a lull (discards ${n})` ``.
  - `huntEffect` appends `` `; ${low}` `` to every `did` when `ammoReport(...).low` is set.
  - In the fake, `bridge-world.ts` passes `magazine_size` through to the module row, and its reload already sets 50.

- [ ] **Step 4: Run the tests.** Run `node --test src/play/combat/*.test.ts`. Expected: PASS.

- [ ] **Step 5: Docs, declarations, checks, commit.** Run `npm run gen:play && npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.ts src/test-support/bridge-world.ts src/play/combat/README.md src/play/combat/combat.test.ts src/play/combat/arena.test.ts play.gen
git commit -m "feat(play): reload part-full magazines before and during a fight, and name a low hold"
```

---

### Task 8: `hunt` takes a risk limit, reports what it skipped, and carries each fight's record

**Files:**
- Modify: `src/play/combat/hunting.ts` (`Fight`, `Hunted`, `hunt`/`huntEffect` opts and target choice 762-794, the `did`/`nothing here` texts 818-868)
- Modify: `src/play/combat/README.md` (the hunt options; "What memory knows about a species")
- Test: `src/play/combat/combat.test.ts`

**Interfaces:**
- Consumes: `readCombat`, `recentRecord`, `covers`, `recordLine`, `RecentRecord` (Task 1); `runtimeDir()`.
- Produces:
  - `hunt({…,risk?:'covered'|'known'})`. `'covered'` skips a target whose `covers(...)===false`. `'known'` does the same and also skips a class never fought. Unset skips nothing, as today.
  - `Fight.record?:RecentRecord`: the record the target was chosen against.
  - `Hunted.skipped:{name:string;why:string}[]`: always present, deduplicated by name.
  - The why texts:
    - Covered: `` `${name}: the worst of its last ${n} fights cost ${worst} pts of hull, and we have ${above} above the danger line` ``
    - Known: `` `${name}: never fought, and risk 'known' skips the unknown` ``

- [ ] **Step 1: Write the failing tests.** Seed `combat.json` with `writeFight` into the world's runtime dir; use the `world` helper with a `runtime`.

```ts
// Spec D3: the agent chooses the risk; the hunt says what it left alone, never silently.
test('a hunt with a risk limit skips a class whose worst fight it cannot cover, names it, and fights the rest',async()=>{
  // combat.json: 3 × Veil-Ray victories hull 100→40 (worst 60). Ship hull 80/100: 80−60=20 is not above 30 → skip.
  // creatures: Veil-Ray (c1), Quantum-Moth (c2, never fought).
  const out=await hunt({risk:'covered'});
  assert.deepEqual(out.detail.skipped.map(row=>row.name),['Veil-Ray']);
  assert.match(out.detail.skipped[0]!.why,/worst of its last 3 fights cost 60 pts of hull, and we have 50 above the danger line/);
  assert.equal(out.detail.fights[0]!.target.name,'Quantum-Moth');
  assert.equal(out.detail.fights[0]!.record,undefined,'never fought');
  assert.match(out.did,/skipped Veil-Ray/);
  const strict=await hunt({risk:'known'}); // fresh world
  assert.equal(strict.status,'done');
  assert.match(strict.did,/nothing to hunt at .* \(skipped: Veil-Ray: .*; Quantum-Moth: never fought/);
});
test('without a risk limit nothing is skipped, and each fight carries the record it was chosen against',async()=>{ /* skipped [] ; fight.record.fights===3 */ });
test('a record with no hull readings is not skipped under covered',async()=>{ /* covers undefined → fought */ });
```

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/play/combat/combat.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Read `readCombat(runtimeDir())` once per fresh `get_nearby` read.
  - Filter `standing` through the risk skip before all three choice passes: named species, mission quarry and fallback. `decline()` is unchanged.
  - Push the skips into `result.skipped` and step `` `skipped: ${whys}` ``.
  - The fight-result `did` appends `` `; skipped ${names}` `` when any were skipped. The `nothing here`/`nothing found` texts append `` ` (skipped: ${name}: ${why}; …)` ``.
  - `fight.record` is `recentRecord(...)`, read before `engage`.

- [ ] **Step 4: Run the tests.** Run `node --test src/play/combat/*.test.ts`. Expected: PASS.

- [ ] **Step 5: Docs, declarations, checks, commit.** README: `risk` and the record's fields, with `covers` defined against the danger line. Run `npm run gen:play && npm run typecheck && npm run lint && npm test`.

```bash
git add src/play/combat/hunting.ts src/play/combat/README.md src/play/combat/combat.test.ts play.gen
git commit -m "feat(play): hunt takes a risk limit, reports its skips, and carries each fight's record"
```

---

### Task 9: The juncture shows the prey, the danger line and the ammo

**Files:**
- Modify: `src/play/combat/hunting.ts` (new `preyHereEffect`)
- Modify: `src/bridge.ts` (`menuBound` 393-436; the `resolveWalkAway`/`stanceMood` imports if they become unused)
- Modify: `src/context.ts` (366-369, the facts block)
- Test: `src/bridge.test.ts` (line 60), `src/context.test.ts` (line 166, plus new tests)

**Interfaces:**
- Consumes: `recentRecord`, `covers`, `recordLine` (Task 1); `dangerLine` (Task 1); `ammoReport` (Task 7); `decline`/`preyIn`, internal to `hunting.ts`.
- Produces:
  - `export const preyHereEffect=():Effect.Effect<{name:string;kind:'creature'|'pirate';count:number}[],GameError,Game>`. This is one `spacemolt/get_nearby` read, creatures and pirates, legal by `decline(one,[])`, grouped by name. The menu makes no `get_nearby` read today, despite the spec's wording, so this adds the one read, undocked only.
  - Menu keys:
    - `prey?:{name:string;kind:string;count:number;record:string}[]`: at most 5 rows, absent when docked, in transit, none present, or the read failed.
    - `present.danger_line:number` replaces `present.walk_away`.
    - `present.weapons[]` rows gain `magazine?:number` and `hold:number`.
    - `present.ammo_low?:string`.

- [ ] **Step 1: Write the failing tests.**

```ts
// bridge.test.ts — replaces 'names the walk-away line'
test('the menu names the danger line, the prey here with its record, and a low hold', async () => {
  // bridgeWorld({wildlife:{creatures:[{creature_id:'c1',species:'veil_ray',name:'Veil-Ray'},{creature_id:'c2',species:'veil_ray',name:'Veil-Ray'}]}}), undocked at belt
  assert.equal(menu.present.danger_line,30,'0.30 of a 100 hull, whatever the mood');
  assert.deepEqual(menu.prey,[{name:'Veil-Ray',kind:'creature',count:2,record:'unknown: never fought'}]);
  // docked: no prey key; get_nearby refused (Review Focus 5): no prey key, the menu still answers
});
// context.test.ts — replaces 'the walk-away line reads as what it is'
test('the danger line and the prey read as facts under the ship', () => {
  const menu=menuOf(12);
  menu.present.danger_line=24;
  menu.prey=[{name:'Veil-Ray',kind:'creature',count:3,record:'8 won, 2 stalemate, 0 lost (last 10); hull lost avg 1.2, worst 11 pts; covers'}];
  menu.present.ammo_low='low ammo: 1 standard_rounds_box in the hold for Autocannon II';
  const text=render(menu);
  assert.ok(text.includes('  Danger line: a fight is fled only below hull 24, and not while the enemy is closer to dead.'));
  assert.ok(text.includes('  Prey here: Veil-Ray ×3 (creature): 8 won, 2 stalemate, 0 lost (last 10); hull lost avg 1.2, worst 11 pts; covers.'));
  assert.ok(text.includes('  Ammo: low ammo: 1 standard_rounds_box in the hold for Autocannon II.'));
  menu.present.weapons=[];
  assert.ok(!render(menu).includes('Danger line'),'unarmed, there is no fight of its own to flee');
});
```

  Also update the fixture at `context.test.ts:310`: drop `walk_away` and add `danger_line` where it renders.

- [ ] **Step 2: Run and confirm failure.** Run `node --test src/bridge.test.ts src/context.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `bridge.ts`, `menuBound` runs `preyHereEffect()` inside the same `onBinding` generator as `menuEffect`, wrapped in `Effect.result`. A failure leaves `prey` out.
  - Each row gets `recordLine(recentRecord(fights,name),covers(rec,ship))`, with `fights=readCombat(runtime)`.
  - `danger_line` is `dangerLine(ship.max_hull)`.
  - The weapons rows and `ammo_low` come from `ammoReport(modules,cargo)`.
  - In `context.ts`, the lines follow the test's exact copy. Prey rows join with `; ` on one `Prey here:` line, ending in `.`. A weapon renders `` `(${loaded}/${magazine} loaded, ${hold} in the hold)` `` when the magazine is known, otherwise today's form.
  - Remove `walk_away` and its render.

- [ ] **Step 4: Run the tests.** Run `node --test src/bridge.test.ts src/context.test.ts`. Expected: PASS.

- [ ] **Step 5: Docs, checks, commit.**
  - In the README's "What memory knows about a species", say the juncture lists the prey here with this record, and that the pilot decides.
  - Run `npm run gen:play && npm run typecheck && npm run lint && npm test`.
  - Run `uvx ruff@0.16.9 check .` only if Python changed. None should.

```bash
git add src/play/combat/hunting.ts src/bridge.ts src/context.ts src/bridge.test.ts src/context.test.ts src/play/combat/README.md play.gen
git commit -m "feat(juncture): show the prey here with its record, the danger line and a low hold"
```

---

### Task 10: Whole-branch verification

**Files:** none changed, unless a check fails.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Run** `npm run gen:play && git status --short play.gen`. Expected: no diff.
- [ ] **Step 2: Run** `npm run typecheck && npm run lint && npm test`. Expected: clean, all pass.
- [ ] **Step 3: Grep for leftovers.** Run `grep -rn "walk_away\|walk-away\|resolveWalkAway\|tired:true\|floor:0" src --include='*.ts' src/play/combat/README.md`. Expected: only `mood-policy.ts`'s own table and `crossed()`, plus test names that describe the history. Fix anything else in a follow-up commit.
- [ ] **Step 4: Hand back.** Live acceptance, the spec's test strategy item 4 (`arena()` against First Blood and a hunt session on kvothe), needs an install. Installing is the user's release gate, not this plan's. Report the branch head SHA to the controller.

---

## Self-review

1. **Spec coverage.**
   - D1 → Task 1. D2 rule → Task 2. D2 bounded flee and survivable escape → Tasks 2-3. D2 Tired and mood → Task 2.
   - D3 → Task 8. D4 → Task 6. D5 → Task 5. D6 → Task 6. D7 → Task 7.
   - D8.1 → Task 9. D8.2 → Task 2 (`floor` meaning plus `loss_fatal`). D8.3 → Task 8. D9 → Task 3 (honoured, bounded).
   - "Left to the builder" → Global Constraints and Task 4.
   - Test strategy: items 1-2 in Tasks 1-3; the replays are 02:26Z in Task 2, the stalemate in Task 6, the run-end in Task 5, the risk limit in Task 8, and the stall in Task 4. Item 4, live acceptance, is handed back in Task 10.
2. **Spec vs code, resolved here:**
   - The menu makes no `get_nearby` read, so Task 9 adds one.
   - Renaming `TickView.floor` would break 101 live programs, so the name stays with the new meaning, and `loss_fatal` is added.
   - Retention by class alone is unbounded with per-pirate names, so `CAP=120` stays as a ceiling.
   - D6 closing and D4 `pursue` off conflict on an escaping quarry. Closing is suspended once the range opens, and stops when an advance no longer closes.
   - "Re-apply the rule" after a stalled flee could flip back and forth. A stall prices the escape at `Infinity` for the rest of the fight.
   - Bounded flee and "a hunt never hands back a live battle" (714b199) are reconciled by making the flee a loop state, with a hard bound only at the run's close.
   - Today's default already chases on `fled>0`. `pursue` defaulting off changes that, as the spec says.
3. **Types.** `RecentRecord`, `covers`, `recordLine`, `dangerLine`, `shouldRun`/`StayRead`, `escapeCost`, `FLEE_STALL`, `boundMs`, `bestBand`, `pursue`, `ammoReport`, `risk`, `skipped` and `preyHereEffect` are used with the same names and shapes in every task that consumes them.
4. **Review Focus.** Each of its five lines has a test in its owning task: 3, 2, 2, 7 and 9.
