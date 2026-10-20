# Activity Map Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clean-room TypeScript module, `src/picture/`, that turns a profile's runtime directory into the 800x600 activity map PNG described in the design report, plus a dev script to render it. Nothing in the bridge imports it yet: this is a proposal for inclusion.

**Architecture:** Pure functions over the journal and sidecar files build one model (window → activity and presence → epochs and levels → layout). Two SVG documents (art, labels) are rendered from the model and rasterised with `@resvg/resvg-wasm`; compositing is done by embedding PNGs in a third SVG so no pixel library is needed. Every rule with a number in the report is a named constant in one file.

**Tech Stack:** TypeScript (Node 24 type stripping, no build), `effect` Schema for decoding files, `@resvg/resvg-wasm` for rasterising, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-16-activity-map-design.md` (the map); `docs/superpowers/specs/2026-10-16-pilot-pictures-design.md` (context). Reference renders: `experiments/map-spike/vV1.png`, `vV2.png`.

## Global Constraints

- Branch `picture/activity-map`; append-only commits; never touch `main`. Conventional commits, scope `picture`: `feat(picture): …`, `test(picture): …`.
- Nothing under `src/bridge.ts`, `src/play/`, `__init__.py`, `service.py` or `plugin.yaml` changes. No `gen:play` rerun needed.
- Imports carry `.ts` extensions; no enums, namespaces or parameter properties (`erasableSyntaxOnly`); `exactOptionalPropertyTypes` is on, spread optionals conditionally.
- Match the repo's terse style (see `src/failures.ts`); file readers are sync `readFileSync` in `try/catch` returning empty on failure; a comment says why; a shortcut with a known ceiling carries a `ponytail:` comment.
- Tests sit beside source as `*.test.ts`; `npm test` must include `src/picture/*.test.ts`; `npm run typecheck` and `npm run lint` must be clean. No test may touch `~/.hermes`; every test uses its own `mkdtemp` directory.
- New dependency: `@resvg/resvg-wasm` only, added to `package.json` and `package-lock.json` via `npm install` (the bridge runs `npm ci` from the lockfile).
- Output is 800x600; the art layer is additionally renderable at 1024x768. Constants from the report: `GAP=24`, `PITCH_MAX=17`, lane bottom pad 6, dense when pitch < 9, small font when pitch < 12, epoch rule `LONG_STAY_MIN=25`, min epoch share `1/8`, bucket `20` minutes, palette `#2EC4B6 #F4A261 #B388EB #E76F8A #8BC34A #6FA8DC`, donut radius floor 7 cap 22, window `RUNS=28`.

## Review Focus

- Empty runtime (no journal, no sidecars): `renderMap` still returns a PNG with title and empty map, no throw. → Task 8.
- A window whose runs never jump (one system, one interval): one epoch, one level, lane shows a flat line, no division by zero in the axis. → Task 4.
- Systems in the journal that the galaxy map does not know (new or renamed ids): drawn at a fallback position off the fitted bounds and counted in `model.unknownSystems`, never dropped silently. → Task 5.
- Journal lines out of order or missing `at` (rotated files concatenated, a clock step): intervals are sorted by time before epoching and a line without `at` is skipped. → Task 3.
- Fonts missing on the host: rasterisation falls back through the font list and, with none, renders text-less rather than failing; the script prints which font it used. → Task 8.

---

### Task 1: Scaffold, dependency, test wiring

**Files:**
- Modify: `package.json` (scripts.test, dependencies)
- Modify: `package-lock.json` (via `npm install`)
- Create: `src/picture/constants.ts`
- Test: `src/picture/constants.test.ts`

**Interfaces:**
- Produces: `src/picture/constants.ts` exporting
  `export const SIZE={width:800,height:600} as const;`
  `export const ART_SIZE={width:1024,height:768} as const;`
  `export const RUNS=28; export const GAP=24; export const PITCH_MAX=17; export const LANE_PAD=6; export const DENSE_PITCH=9; export const SMALL_FONT_PITCH=12; export const LONG_STAY_MIN=25; export const MIN_EPOCH_SHARE=1/8; export const BUCKET_MIN=20;`
  `export const DONUT={floor:7,cap:22,scale:1.6} as const;`
  `export const EPOCH_HUES=['#2EC4B6','#F4A261','#B388EB','#E76F8A','#8BC34A','#6FA8DC'] as const;`
  `export const KINDS=['fights','docked','traded','fuel','creatures'] as const; export type Kind=typeof KINDS[number];`
  `export const KIND_COLOURS:Record<Kind,string>={fights:'#E8554E',docked:'#4A90E2',traded:'#4CAF50',fuel:'#F2B134',creatures:'#A66BBE'};`
  `export const hueOf=(epochIndex:number)=>EPOCH_HUES[epochIndex%EPOCH_HUES.length]!;`

- [ ] **Step 1: Add the dependency and the test glob**

Run: `npm install @resvg/resvg-wasm@^2.6.2`
Then edit `package.json` `scripts.test` to append ` src/picture/*.test.ts` to the existing glob list.
Expected: `package-lock.json` gains `@resvg/resvg-wasm`; `node_modules/@resvg/resvg-wasm/index_bg.wasm` exists.

- [ ] **Step 2: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {EPOCH_HUES,GAP,hueOf,KINDS} from './constants.ts';
test('constants match the design report',()=>{
  assert.equal(GAP,24);
  assert.deepEqual([...KINDS],['fights','docked','traded','fuel','creatures']);
  assert.equal(hueOf(0),'#2EC4B6');
  assert.equal(hueOf(EPOCH_HUES.length),'#2EC4B6');
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test src/picture/constants.test.ts`
Expected: FAIL, cannot find module `./constants.ts`.

- [ ] **Step 4: Create `src/picture/constants.ts` with the exports above**

- [ ] **Step 5: Run the test, typecheck, lint**

Run: `node --test src/picture/constants.test.ts && npm run typecheck && npm run lint`
Expected: PASS, clean, clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/picture/constants.ts src/picture/constants.test.ts
git commit -m "feat(picture): scaffold the activity map module and its constants"
```

---

### Task 2: The window — the last N runs from the journal

**Files:**
- Create: `src/picture/window.ts`
- Test: `src/picture/window.test.ts`

**Interfaces:**
- Consumes: `readJournal(runtime:string,limit:number):JournalLine[]` from `src/run-record.ts:116` (oldest-first, parsed objects with `at?`, `event?`, rest); `journalRun(runtime,entry,event?)` from the same file to write test lines; `isRecord` from `src/run-record.ts:14`.
- Produces:
  `export interface Window {runs:RunRef[];lines:JournalLine[];start:Date;end:Date;}`
  `export interface RunRef {run_id:string;started:Date;ended?:Date;start_state?:Record<string,unknown>;end_state?:Record<string,unknown>;work?:Record<string,unknown>;}`
  `export function readWindow(runtime:string,runs=RUNS):Window`
  Semantics: walk `readJournal(runtime, limit)` with a growing limit (start 2000, double, stop at 200_000 or when the file set is exhausted) until at least `runs` distinct `run_id`s with a `run` `started` line are present; keep the newest `runs` run ids; `lines` are every line whose `run_id` is in that set plus `run` lines themselves, oldest-first; `start` is the earliest `started`, `end` is the latest `at` seen. With no runs, `runs=[]`, `lines=[]`, `start=end=new Date(0)`.

- [ ] **Step 1: Write the failing test**

```ts
test('readWindow keeps the newest N runs and their lines',()=>{
  const dir=runtime();
  try{
    for(const i of [1,2,3]){
      journalRun(dir,{phase:'started',run_id:`r${i}`,started:`2026-10-16T0${i}:00:00.000Z`,start_state:{system:'a'}},'run');
      journalRun(dir,{run_id:`r${i}`,tool:'spacemolt',action:'jump',params:{id:'b'},ok:true,summary:'x'},'command');
      journalRun(dir,{phase:'ended',run_id:`r${i}`,started:`2026-10-16T0${i}:00:00.000Z`,outcome:'done',end_state:{system:'b'}},'run');
    }
    const w=readWindow(dir,2);
    assert.deepEqual(w.runs.map(r=>r.run_id),['r2','r3']);
    assert.equal(w.lines.filter(l=>l.event==='command').length,2);
    assert.equal(w.start.toISOString(),'2026-10-16T02:00:00.000Z');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('readWindow on an empty directory is empty, not an error',()=>{
  const dir=runtime();
  try{const w=readWindow(dir);assert.deepEqual(w.runs,[]);assert.deepEqual(w.lines,[]);}
  finally{rmSync(dir,{recursive:true,force:true});}
});
```

Note: `journalRun` stamps `run_id` only inside a bound run; in tests pass `run_id` explicitly in the entry as above (the `refused` line at `src/run.ts:300` does the same).

- [ ] **Step 2: Run to see it fail**

Run: `node --test src/picture/window.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `readWindow` in `src/picture/window.ts`**

One note: `readJournal` reads whole files and returns the last `limit` lines; the doubling loop stops when a call returns fewer than `limit` lines (the files are exhausted). Carry a `ponytail:` comment naming the 200_000 ceiling.

- [ ] **Step 4: Run tests** — `node --test src/picture/window.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/picture/window.ts src/picture/window.test.ts && git commit -m "feat(picture): read the last N runs as a window"`

---

### Task 3: Activity and presence — replaying the window

**Files:**
- Create: `src/picture/activity.ts`
- Test: `src/picture/activity.test.ts`

**Interfaces:**
- Consumes: `Window`, `RunRef` (Task 2); `readPlaces(runtime):Record<string,string>` and `readNames(runtime):Record<string,string>` from `src/play/places.ts`; `readSightings(dir):Sighting[]` from `src/sighting-memory.ts`; `KINDS`, `Kind` (Task 1).
- Produces:
  `export interface Interval {system:string;start:Date;end:Date;}`
  `export interface Visit {system:string;order:number;counts:Record<Kind,number>;}`  (order is 1-based first-visit order)
  `export interface Leg {a:string;b:string;trips:number;}`  (a<b, undirected)
  `export interface Activity {visits:Visit[];intervals:Interval[];legs:Leg[];heaviest?:Leg;events:ActivityEvent[];current:{system?:string;poi?:string;docked_at?:string};}`
  `export interface ActivityEvent {at:Date;system:string;kind:Kind;count:number;}`
  `export function replay(w:Window,runtime:string):Activity`
  Rules: the current system starts at each run's `start_state.system`; a `command` with `action==='jump'`, `ok===true` and string `params.id` moves to that system at the line's `at`; the interval open since the previous position closes there. Counting, attributed to the system current at the line's `at`: `docked` += 1 per `command` `dock` ok and per `trade` with `side:'service'` and `service:'repair'`; `fuel` += 1 per `trade` with `service:'refuel'`; `traded` += 1 per `trade` with side `buy` or `sell`; `fights` += 1 per `push` line with `push:'battle_ended'`; `creatures` = for the current window's visited systems, the sum of `count` over sightings whose `poi_id` maps to that system (POI → system learned from `travel` commands: a `travel` to `params.id` while in system S records poi→S; plus `places.json` for base ids), newest per `poi_id`+`species`, taken from `readSightings`. `legs` count ok jumps between consecutive systems (undirected); `heaviest` is the max. Lines without a parseable `at` are skipped; intervals are sorted by `start` before returning; a window with no jumps yields exactly one interval per run (merged when consecutive runs share the system). `current` is the last run's `end_state` system/poi/docked_at when present.

- [ ] **Step 1: Write the failing tests**

```ts
test('replay attributes counts to the system current at the time',()=>{ /* two systems, one jump, a dock before and a battle_ended after; expect visits a:{docked:1}, b:{fights:1}; intervals [a,b]; legs [{a,b,trips:1}] */ });
test('replay sorts intervals and skips lines without at',()=>{ /* write a line with at:'' between valid ones; expect it ignored and intervals ascending */ });
test('replay with no jumps yields one interval per run, merged when the system repeats',()=>{ /* two runs both in a; expect intervals.length===1 */ });
test('creatures come from sightings mapped through travel-learned POIs',()=>{ /* travel to poi p while in a; sightings.json {sightings:[{poi_id:'p',species:'veil_ray',count:3,legal:3,at}]}; expect visits a.counts.creatures===3 */ });
```

Write them in full with the line shapes from Task 2's example; `sightings.json` is written with `writeFileSync(join(dir,'sightings.json'),JSON.stringify({sightings:[...]}))`.

- [ ] **Step 2: Run to see them fail** — `node --test src/picture/activity.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `replay` in `src/picture/activity.ts`**

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): replay a window into visits, intervals and legs"`

---

### Task 4: Epochs and levels

**Files:**
- Create: `src/picture/epochs.ts`
- Test: `src/picture/epochs.test.ts`

**Interfaces:**
- Consumes: `Interval` (Task 3); `LONG_STAY_MIN`, `MIN_EPOCH_SHARE`, `PITCH_MAX`, `LANE_PAD`, `DENSE_PITCH`, `hueOf` (Task 1).
- Produces:
  `export interface Epoch {index:number;start:Date;end:Date;systems:string[];intervals:Interval[];levels:Record<string,number>;pitch:number;dense:boolean;hue:string;}`
  `export function makeEpochs(intervals:Interval[],span:{start:Date;end:Date}):Epoch[]`  (rule + merge, no levels yet: `levels={}`, `pitch=0`)
  `export function assignLevels(epochs:Epoch[],laneHeight:number):Epoch[]`
  Epoch rule: walk intervals in time order; a new epoch starts at an interval of at least `LONG_STAY_MIN` minutes whose system differs from the last long-stay system, provided the current epoch's duration is at least `MIN_EPOCH_SHARE` of the span; the first interval starts epoch 0. Then merge adjacent epochs whose system sets are equal. `index` and `hue=hueOf(index)` are assigned after merging. Levels: rank systems by total presence minutes within the epoch (most → level 0); a system present in the previous epoch keeps its previous level when that level is below `k` and not yet taken; others take the lowest free level in rank order. `pitch=Math.min(PITCH_MAX,(laneHeight-LANE_PAD)/k)`; `dense=pitch<DENSE_PITCH`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a long stay in a new system opens an epoch once the current one is long enough',()=>{ /* intervals: a 0-60min, b 60-100min, a 100-130, c 130-200 (span 200): expect epochs [{a,b,a}] then [c] when 1/8 share satisfied; assert systems sets */ });
test('adjacent epochs with equal system sets merge',()=>{ /* craft a split that produces {a,b} then {a,b}; expect one epoch */ });
test('levels rank by presence and keep previous level for carried systems',()=>{ /* epoch 1 {a:0,b:1}; epoch 2 has b with more time than a: expect b keeps 1, a keeps 0 */ });
test('a single-system window yields one epoch, one level, pitch capped',()=>{ assert.equal(e[0]!.pitch,17); });
test('dense flag flips below the pitch threshold',()=>{ /* 32 systems in a 128 px lane: pitch=(128-6)/32<9 → dense */ });
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL.

- [ ] **Step 3: Implement `makeEpochs` and `assignLevels` in `src/picture/epochs.ts`**

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): epochs, merging and level assignment"`

---

### Task 5: The galaxy — cached public map and fitting

**Files:**
- Create: `src/picture/galaxy.ts`
- Test: `src/picture/galaxy.test.ts`

**Interfaces:**
- Consumes: `fetchMap(httpBaseUrl:string):Promise<GalaxyMap>` from `@spacemolt/lib` (dist/data/map.d.ts) where `GalaxyMap={empires:Record<string,string>;systems:MapDataSystem[]}` and `MapDataSystem={id:string;name:string;x:number;y:number;connections:string[];…}`; `keepJson(dir,file,value)` from `src/play/places.ts:25` for the atomic write.
- Produces:
  `export interface Galaxy {fetched_at:string;systems:Record<string,{id:string;name:string;x:number;y:number;connections:string[]}>;}`
  `export async function loadGalaxy(runtime:string,opts?:{maxAgeMs?:number;fetch?:(base:string)=>Promise<GalaxyMap>;base?:string}):Promise<Galaxy>`
  Reads `runtime/galaxy.json`; refetches when missing or older than `maxAgeMs` (default 24 h) via `fetch` (default `fetchMap`, base `https://game.spacemolt.com`); on fetch failure returns the stale copy if any, else `{fetched_at:'1970-01-01T00:00:00.000Z',systems:{}}`. Never throws.
  `export interface Placed {id:string;x:number;y:number;known:boolean;}`
  `export function fit(ids:string[],galaxy:Galaxy,rect:{x:number;y:number;w:number;h:number},margin=24):{placed:Record<string,Placed>;unknown:string[]}`
  Preserves aspect ratio; unknown ids (not in `galaxy.systems`) are placed in a row along the rect's bottom edge, `known:false`, and listed in `unknown`.
  `export function neighbours(ids:string[],galaxy:Galaxy):string[]` — ids connected to any visited id, excluding the visited ones.

- [ ] **Step 1: Write the failing tests**

```ts
test('loadGalaxy caches to galaxy.json and reuses it inside maxAge',async()=>{ /* fake fetch counts calls; two loads → 1 call; file exists */ });
test('loadGalaxy returns the stale copy when fetch fails',async()=>{ /* write a copy with old fetched_at; fetch rejects; expect copy's systems */ });
test('fit preserves aspect ratio and lists unknown ids',()=>{ /* three known at (0,0),(100,0),(100,50) into 400x400 → spread equals in x, y scaled by same factor; unknown 'zz' placed with known:false */ });
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL.

- [ ] **Step 3: Implement `src/picture/galaxy.ts`**

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): cached public galaxy map and fitting"`

---

### Task 6: Layout — the piecewise time axis, label fitting, buckets, donut radius

**Files:**
- Create: `src/picture/layout.ts`
- Test: `src/picture/layout.test.ts`

**Interfaces:**
- Consumes: `Epoch` (Task 4); `ActivityEvent`, `Visit` (Task 3); `GAP`, `BUCKET_MIN`, `DONUT`, `SMALL_FONT_PITCH`, `KINDS` (Task 1).
- Produces:
  `export interface Axis {spans:{epoch:number;gapX:number;x0:number;x1:number}[];toX:(t:Date)=>number;}`
  `export function timeAxis(epochs:Epoch[],x0:number,width:number,gap=GAP):Axis` — each epoch gets `gap` of dead space then a share of `width - gap*epochs.length` proportional to its duration; `toX` maps a time inside epoch i linearly into `[x0_i,x1_i]`, and a time in no epoch to the nearest edge.
  `export interface LevelLabel {system:string;level:number;y:number;shown:boolean;font:number;}`
  `export function fitLabels(epoch:Epoch,laneTop:number,laneBottom:number):LevelLabel[]` — y from pitch and level; font 10 when `pitch>=SMALL_FONT_PITCH` else 8; when `!dense` all shown; when dense, walk levels from the bottom and show a label only if its box (font height) does not overlap the last shown one.
  `export interface Bucket {t0:Date;t1:Date;counts:Record<Kind,number>;}`
  `export function buckets(events:ActivityEvent[],start:Date,end:Date,minutes=BUCKET_MIN):Bucket[]`
  `export function donutRadius(total:number):number` — `Math.min(DONUT.cap, DONUT.floor+DONUT.scale*Math.sqrt(total))`.
  `export function columnHeight(total:number,max:number,barHeight:number):number` — `4+(barHeight-4)*Math.sqrt(total/max)`, 0 when total is 0.

- [ ] **Step 1: Write the failing tests**

```ts
test('timeAxis gives every epoch a gap and a duration-proportional share',()=>{ /* two epochs 1h and 3h, x0=0, width=724, gap=24 → spans widths 169 and 507 (±1), gapX 0 and 193 */ });
test('fitLabels shows all levels when not dense and skips overlaps when dense',()=>{ /* non-dense 4 levels → 4 shown; dense pitch 3.8 with 8px font → every ~3rd shown, none overlapping */ });
test('buckets are 20 minutes and sum kinds',()=>{ /* three events in one bucket, one in the next */ });
test('donutRadius and columnHeight follow the formulas with floor and cap',()=>{ assert.equal(donutRadius(0),7); assert.equal(donutRadius(10_000),22); assert.equal(columnHeight(0,10,36),0); assert.equal(columnHeight(10,10,36),36); });
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL.

- [ ] **Step 3: Implement `src/picture/layout.ts`**

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): piecewise time axis, label fitting, buckets"`

---

### Task 7: The model and the two SVG layers

**Files:**
- Create: `src/picture/model.ts`
- Create: `src/picture/svg.ts`
- Test: `src/picture/model.test.ts`, `src/picture/svg.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  `export interface MapModel {title:string;window:Window;activity:Activity;epochs:Epoch[];galaxy:Galaxy;placed:Record<string,Placed>;neighbours:string[];unknownSystems:string[];axis:Axis;labels:LevelLabel[][];buckets:Bucket[];badgeHue:Record<string,string>;rects:{map:Rect;legend:Rect;lane:Rect;bar:Rect};}` with `type Rect={x:number;y:number;w:number;h:number}`.
  `export async function buildModel(runtime:string,opts?:{runs?:number;pilot?:string;galaxy?:Galaxy}):Promise<MapModel>` — composes Tasks 2–6. Rects at 800x600: title baseline y=22; legend `{x:650,y:36,w:140,h:…}`; map `{x:16,y:36,w:614,h:364}`; lane `{x:40,y:421,w:740,h:128}`; bar `{x:40,y:552,w:740,h:36}`; hour labels at y=590. `badgeHue[system]` = hue of the epoch where the system has the most presence. `title` = `` `${pilot??'Pilot'} · last ${runs} runs · ${span}` `` with the span formatted as in the report (`16 Oct 11:39–17 Oct 00:28Z`, same-day form `16 Oct 08:16–21:30Z`).
  `export function artSvg(m:MapModel,size:{width:number;height:number}):string` — background, neighbour dots and jump lines, route (white, 2 px), donut rings (arcs by kind in `KINDS` order, colours from `KIND_COLOURS`), epoch tints in the lane, the step line, the actions bar columns, hour gridlines. Everything geometric, no text, no badges.
  `export function labelsSvg(m:MapModel,size:{width:number;height:number}):string` — transparent background; title; legend (five kind rows, route row, epochs swatch row); system names with halo and leader lines (four candidates then ring search at 30 and 60 px); visit-order badges filled with `badgeHue`; heaviest-leg `xN`; `you are here` ring when the current system is not badge 1; level numbers in gaps in the epoch's hue; `k systems` header in dense epochs; dotted separators; hour labels (omitted when the label centre falls in a gap). `font-family="Arial, Helvetica, sans-serif"`.
  Both functions scale all coordinates by `size.width/800` so the same model renders at 1024x768.

- [ ] **Step 1: Write the failing tests**

```ts
test('buildModel composes a model from a small synthetic runtime',async()=>{ /* journal with 2 runs over systems a,b; galaxy passed in opts with a,b,c (c neighbour); expect epochs.length>=1, placed has a and b, neighbours includes c, badgeHue has a and b, title contains 'last 28 runs' */ });
test('artSvg has one donut per visited system and no text',()=>{ /* count '<path class="donut' occurrences === visits.length; assert !/<text/.test(svg) */ });
test('labelsSvg has one badge per visited system filled with its epoch hue and one level label per shown level',()=>{ /* regex count of 'class="badge"' === visits.length; the fill attr equals badgeHue[sys]; count of 'class="lvl"' === labels.flat().filter(l=>l.shown).length */ });
test('labelsSvg omits an hour label whose centre lands in a gap',()=>{ /* construct axis where 12:00 falls in a gap; assert no '12:00Z' text */ });
test('svg scales with size',()=>{ /* artSvg at 1024x768 has viewBox="0 0 1024 768" and the map rect x scaled by 1.28 */ });
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL.

- [ ] **Step 3: Implement `src/picture/model.ts` then `src/picture/svg.ts`**

Name placement algorithm (the one piece the tests do not determine): for each visited system in badge order, try right, left, above, below of the node at `r+6` px; accept the first whose text box (estimate 0.55·font per character, font 12 bold) does not intersect any placed name box, any node circle (r+2) or any route segment (point-to-segment distance < 6); otherwise search eight directions at 30 then 60 px for a clear box and draw a 1 px leader from the box edge to the node ring. Tag elements with classes `donut`, `badge`, `lvl`, `name`, `leader`, `hour` so tests can count them.

- [ ] **Step 4: Run tests, typecheck, lint** — Expected: PASS, clean, clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): the map model and its art and label SVG layers"`

---

### Task 8: Rasterising and compositing with resvg

**Files:**
- Create: `src/picture/raster.ts`
- Test: `src/picture/raster.test.ts`

**Interfaces:**
- Consumes: `artSvg`, `labelsSvg`, `MapModel` (Task 7); `@resvg/resvg-wasm` (`initWasm`, `Resvg`).
- Produces:
  `export const DEFAULT_FONTS=['/System/Library/Fonts/Supplemental/Arial Bold.ttf','/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];`
  `export async function rasterize(svg:string,opts?:{fonts?:string[]}):Promise<{png:Uint8Array;fontsUsed:string[]}>` — initialises the wasm once (module-level promise, reading `index_bg.wasm` from the package via `import.meta.resolve`), loads every font path in `opts.fonts??process.env.SPACEMOLT_MAP_FONTS?.split(':')??DEFAULT_FONTS` that exists, renders at the SVG's own width and height. With no fonts found, renders anyway (text disappears) and `fontsUsed=[]`.
  `export async function compose(artPng:Uint8Array,labelsSvg:string,size:{width:number;height:number},opts?):Promise<Uint8Array>` — wraps the art PNG as a base64 `<image>` under the label layer's content in one SVG and rasterises it; this is how the restyled art meets the labels without a pixel library.
  `export async function renderMap(runtime:string,opts?:{runs?:number;pilot?:string;fonts?:string[];galaxy?:Galaxy}):Promise<{png:Uint8Array;model:MapModel;fontsUsed:string[]}>` — `buildModel` → `artSvg` at 800x600 → `rasterize` → `compose` with `labelsSvg`.

- [ ] **Step 1: Write the failing tests**

```ts
test('rasterize produces a PNG of the requested size',async()=>{ const {png}=await rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#000"/></svg>'); assert.deepEqual([...png.slice(0,8)],[137,80,78,71,13,10,26,10]); /* IHDR width 20 at bytes 16-19 */ assert.equal(png[19],20); });
test('rasterize without any font still renders',async()=>{ const {fontsUsed}=await rasterize('<svg …><text>x</text></svg>',{fonts:['/nonexistent.ttf']}); assert.deepEqual(fontsUsed,[]); });
test('renderMap on an empty runtime returns an 800x600 PNG and an empty model',async()=>{ /* mkdtemp; galaxy opt with no systems; expect png IHDR 800 and model.activity.visits.length===0 */ });
test('compose embeds the art under the labels',async()=>{ /* compose a 1x1 red PNG from rasterize with a labels svg; result is a PNG of the size */ });
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL.

- [ ] **Step 3: Implement `src/picture/raster.ts`**

- [ ] **Step 4: Run tests** — `node --test src/picture/raster.test.ts` — Expected: PASS (the font-dependent assertions only check `fontsUsed`, never pixels).

- [ ] **Step 5: Commit** — `git commit -m "feat(picture): rasterise and composite the map with resvg"`

---

### Task 9: The dev script and a run against the real journal

**Files:**
- Create: `scripts/render-map.ts`
- Modify: `package.json` (scripts: `"render:map": "node scripts/render-map.ts"`)
- Modify: `docs/superpowers/specs/2026-10-16-activity-map-design.md` (append a "How to render" section, 6 lines)

**Interfaces:**
- Consumes: `renderMap` (Task 8).
- Produces: CLI `node scripts/render-map.ts <runtime-dir> [--out map.png] [--runs 28] [--pilot Kvothe] [--art-only 1024x768]`. Prints the fonts used, the window span, systems visited, epochs (count and systems per epoch), unknown systems, and the output path. `--art-only` writes only the art layer at the given size (the input the Qwen edit would take).

- [ ] **Step 1: Write the script** (no unit test; it is glue over `renderMap`). Argument parsing with `node:util` `parseArgs`.

- [ ] **Step 2: Render Kvothe's live runtime, read-only**

Run: `node scripts/render-map.ts ~/.hermes/profiles/kvothe/spacemolt/runtime --out experiments/map-spike/impl-near.png --pilot Kvothe`
Then: `node scripts/render-map.ts ~/.hermes/profiles/kvothe/spacemolt/runtime --out experiments/map-spike/impl-wide.png --pilot Kvothe --runs 40`
Expected: two PNGs; the printed epochs resemble the reference renders (`vV1.png`: 2 epochs; `vV2.png`: 4 epochs with a dense first one). Open both and compare with the reference renders; note differences in the commit body, do not chase pixel parity.

- [ ] **Step 3: Typecheck, lint, full test run**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean and green.

- [ ] **Step 4: Append the "How to render" section to the design report** naming the script and its flags.

- [ ] **Step 5: Commit** — `git add scripts/render-map.ts package.json docs/superpowers/specs/2026-10-16-activity-map-design.md experiments/map-spike/impl-*.png && git commit -m "feat(picture): render-map dev script and reference renders from the live journal"`
