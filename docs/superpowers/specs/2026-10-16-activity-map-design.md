# The activity map: design report

2026-10-16. The "where has the pilot been and what did it do there" picture, settled over
twelve rounds of throwaway renders against Kvothe's live journal. Companion to
[the pilot pictures design](2026-10-16-pilot-pictures-design.md), which owns the image server,
the reference images and the picture kinds. This document owns the map's content and rules.

The reference renders are `experiments/map-spike/vV1.png` (a six-system day) and `vV2.png`
(the same day plus a thirty-two-system march). The prototype scripts that drew them are not
committed; the rules in this document are the implementation. Where a rule has a number, the number was chosen by
looking at those two renders and is a knob, not a law.

## What the picture is

An 800 by 600 image in three regions:

- **Title**, one line top-left: `Kvothe · last 28 runs · 16 Oct 11:39–17 Oct 00:28Z`.
- **Legend**, top-right, one column: the five activity kinds as colour swatch plus word, a
  `route` swatch, and an `epochs` row of small swatches in epoch order. No box.
- **Map**, filling the space left of the legend and above the timeline.
- **Timeline**, the bottom 30% of the image, full width: a location lane (about 70% of the
  band) over a single stacked actions bar (about 20%), with hour labels under it.

Dark navy theme. The restyle pass (Qwen edit) applies only to the map's art layer; every
glyph, number, label, the legend and the whole timeline are drawn on a label layer that is
composited over the restyled art, so nothing the reader has to read is ever touched by the
model.

## The window

The last N runs, N about 28, read newest-first through the journal tail walker until N runs
or the files run out. Everything below is computed from that window: the systems visited,
the path, the counts, the presence intervals.

## The map

- **Geometry**: real galaxy coordinates and connections from the lib's public map (`GET
  /api/map`, fetched once per bridge boot and cached). Fit to the map rectangle preserving
  aspect ratio. Visited systems plus their immediate neighbours; neighbours are faint dots with
  faint jump lines and no names.
- **Nodes are donuts.** Outer radius scales with the square root of the system's total
  activity count, floor 7 px, cap 22 px. The ring is split into arcs by kind in a fixed
  order. A system with no activity is a bare ring at the floor size.
- **Activity kinds and colours**: fights (red), docked (blue; docks and repairs), traded
  (green), fuel (amber; refuels), creatures sighted (violet). Deaths and strandings are
  rare and get a distinct mark only when present. Counts are facts from the journal: fights
  are `battle_ended` outcomes (victory and stalemate; losses are not distinguishable today),
  trades are `trade` events, creatures are the latest sighting per POI and species.
- **Route**: the travelled path, white, 2 px, drawn over the jump lines. **Visit-order
  badges**: a filled circle with the order number beside each visited node, filled with the
  hue of the epoch in which that system had the most time (see below), number in dark text.
- **Heaviest leg**: one label `xN` for the most-travelled leg, placed at the leg's midpoint
  offset perpendicular until at least 16 px clear of other routes and nodes, with a halo.
- **Names**: bold, white with a dark halo. Four candidate positions (right, left, above,
  below), the first that clears other names, nodes and route segments wins; otherwise a
  leader line to the nearest clear spot searched on a ring of eight directions at 30 and 60 px.
  Current position is marked with a ring and `you are here` whenever the current system is placed on the map.
- **No security rings, no per-edge counts, no arrows.** The journal's security data is flat
  and the counts and arrows lost every legibility test.

## The timeline

### Presence and epochs

**Presence intervals** come from run starts and successful jump arrivals: the pilot is in a
system from arrival until the next jump. A day of shuttling produces dozens of short
intervals; the design must survive that and a thirty-system march in thirty minutes.

**Epochs** group the intervals. A new epoch begins at a stay of 25 minutes or more in a
system different from the last long stay, and only when the current epoch is already at
least one eighth of the window's span. Adjacent epochs with identical system sets merge.
Each epoch gets a hue from the palette, in order: teal `#2EC4B6`, amber `#F4A261`, violet
`#B388EB`, rose `#E76F8A`, sage `#8BC34A`, steel `#6FA8DC`, cycling after six.

### The location lane

The lane is a step line: x is time, y is a level, one level per system present in the
epoch. The line's shape is the signal: flat is a stay, a zigzag is shuttling, a steep ramp
is a march. This read better than every band, box or row design tried.

- **Levels are fixed pitch and anchored at the bottom.** Within an epoch with k systems,
  pitch P = min(17 px, (lane height − 6) / k); level i sits at bottom − 6 − i·P. A
  two-system epoch therefore uses only the bottom of the lane and a thirty-two-system epoch
  compresses to fit. Epochs never stretch to fill the height.
- **Ordering**: rank by presence time within the epoch, most at level 0. For continuity, a
  system present in the previous epoch keeps its previous level when that level is free;
  everything else takes the lowest free level in rank order.
- **Gaps carry the labels.** The time axis is piecewise: every epoch is preceded by a 24 px
  gap of dead time, and each epoch's span maps linearly onto its share of the remaining width,
  proportional to duration. The level numbers sit in the gap, right-aligned, one per occupied
  level; the step line runs only between gaps, so a number never overprints the line.
- **Labels are plain numbers**, the visit-order number of the system, bold 10 px (8 px when
  P < 12), in the epoch's hue with a 1 px dark halo. No circles, no names: the map's badges
  decode the numbers, and the hue ties badge, label and tint together.
- **Dense epochs** (P < 9 px): label as many levels as fit without overlap, walking from the
  bottom, and draw a `k systems` header in the gap above the numbers.
- **Tint and separators**: the epoch's hue at 18% alpha fills its span and its gap; a dotted
  separator in the hue stands at the gap's left edge.

### The actions bar

One stacked column per 20-minute bucket on the same piecewise axis, so bars sit under the
moments they belong to and gaps stay empty. Column height is 4 + (bar height − 4)·√(total /
max), segments stacked bottom-up in kind order with the activity colours, 1 px between
columns. Hour gridlines run through both lanes; an hour label is omitted when its centre falls
in a gap.

## Per-juncture selection (proposed 2026-10-17, built 2026-10-19)

Carl wants the chart scoped to a juncture rather than to the last N runs. The join exists:
every `run started` line carries the `juncture_id` of the fire that produced it, and every line
written during the run carries its `run_id`.

- **Selector.** `readWindow` gains `{juncture:id}` beside `{runs:N}`: the runs whose
  `juncture_id` matches (normally one; none means no chart), their lines, and the sightings and
  fights in that span.
- **Focus and context.** The juncture's run is the focus: its systems, route, counts, intervals
  and epochs in colour. The preceding runs, back to six hours or ten runs whichever is less, are
  drawn underneath muted: hollow grey donuts, thin grey route, grey step line and tints. The
  timeline axis spans context start to focus end. Built with the context on (the coordinator's ruling, 2026-10-19).
- **Numbering.** Badges count first visits within the focus run only, so the selfie caption, the
  oracle and the map agree on "where this run went". Built so (the coordinator's ruling, 2026-10-19).
- **Title.** `Kvothe · juncture 16:36Z · 16:36–17:14Z`.
- **When.** Rendered and posted at the run's `ended` line, with the oracle and the selfies of the flight's two moments, in one
  Discord message, the map first (src/pictures.ts, src/picture/flight.ts). On demand from a
  look, the current juncture is the focus and the in-flight run contributes what it has written.
- **Build.** A `focus` flag on runs, visits, legs, intervals and epochs; `MUTED_HUE` for unfocused elements in the SVG (hollow
  donuts, thin route, step line, tints, smaller grey names, an `earlier runs` legend row, no badges); the selector in `window.ts`
  (`{juncture}`, a run id when no run carries it); context epochs cut on their own span before the focus's. `render-map.ts
  --juncture <id>` draws one.

## What was tried and dropped, so it is not tried again

- Glyph icons with counts, or sized by count: unreadable at this size, and the model's
  restyle moved them. Donuts replaced them.
- A legend of nine glyph rows: replaced by five colour rows and words under nothing.
- One row per system in the timeline: fails at twenty systems, the march becomes one block.
- Collapsed bands (stay, shuttle, march) in one lane: readable only when wide enough to label;
  most bands were not.
- Fixed ranked levels with up to fifteen named axis entries: names unreadable below about
  ten levels; a two-sided axis helped but cost width.
- y as hops from home: the whole day sits at one hop.
- Epochs stretched to fill the lane height: the line jumps meaninglessly between epochs.
- Linking epochs to the map with boxes and connector lines: too faint to see at 800 px when
  subtle, and the march's box covers the whole map. Hue on route legs: invisible under nodes.
  Hue on the badges carries the link.
- Drawing at 1600 and downscaling: text blurs. Draw at output size; with an SVG rasteriser
  shapes stay anti-aliased, which the Pillow prototype could not do.

## Implementation notes for the builder

Render the map as SVG in two documents, art and labels, from one computed model (window,
systems, path, counts, intervals, epochs, geometry). Rasterise with `@resvg/resvg-wasm`: the
art layer at 1024 by 768 for the Qwen edit and again at 800 by 600 if no restyle is wanted;
the label layer at 800 by 600; composite labels over the restyled art after downscaling it.
Fonts: embed or point resvg at a system font so text metrics are deterministic in tests.
Test the model, not the pixels: the epoch rule, the merge, the re-slot, the piecewise axis
and the label-fit walk each get a table test against synthetic journals built in the tests.

## How to render

`npm run render:map -- <runtime-dir> [--out map.png] [--runs 28 | --juncture <id>] [--pilot Pilot] [--art-only 1024x768]`
(`node scripts/render-map.ts` directly works too). It reads the pilot's journal under `<runtime-dir>` and writes one PNG: the
800 by 600 composite (art plus labels) to `--out`, or with `--art-only WxH` just the art layer at that size, the input of the Qwen edit.
It prints the fonts used, the window span, the systems visited in badge order, each epoch's systems, and the unknown systems.
The only file it may write into the runtime directory is `galaxy.json`, the fetched-once galaxy cache.
