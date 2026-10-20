# Pilot pictures: "show us what you see"

2026-10-16. Design for two image outputs from the SpaceMolt pilot, generated locally with
Qwen Image 2.1 Turbo served by mlx-serve, an existing lightweight local server (oMLX cannot
serve it; see Constraints).

## Intent

A human watching the pilot in Discord reads text. Carl wants to *see* it: what the ship is
looking at right now, where it has been and what it did there, and, after each flight, a
picture of what the pilot went through. All of it rendered on the Mac that already runs the
pilot's model, with no cloud image API.

## Goals

1. **On demand, from the observer.** A `spacemolt_look` program can call a lib function that
   returns a picture: a generated view of the pilot's situation (two kinds, below), or the
   activity map of recent systems and what happened in each, restyled to the player's aesthetic.
2. **Automatically, at the end of a flight.** When a run ends, one picture of what the pilot
   experienced in it is posted to the journal webhook beside the text burst.
3. **Local, no custom server.** Qwen Image 2.1 runs on the same Mac as the pilot's LLM, in
   mlx-serve, a Homebrew CLI daemon. This repo ships no image-serving code.
4. **Iterable prompts.** The end-of-flight prompt is a plain template over journal lines, with a
   script that prints or renders it for any recorded run, so Carl and the agent can tune it on
   Kvothe's real logs before it goes live.

## Non-goals

- Images in the pilot's own context (vision input). Pictures are for the human.
- Per-POI map detail, LoRA training, cloud fallback, a general image tool for the pilot.
- Making oMLX serve the model (Carl: no fork), writing our own image server (Carl: use an
  existing lightweight process), or installing more than one candidate to compare.

## Anti-goals

- **A picture must never cost the pilot anything.** A failed or slow image never fails a run,
  a query, or a juncture. (AGENTS.md: observe, don't gate.) Failures go to the journal and the
  bridge's stderr.
- **No verdicts in the map.** It draws counts and facts from the journal, never "productive"
  or "good". Only what the journal records is drawn; gaps stay gaps.
- **The restyle must not lie.** Labels, lines and glyphs stay legible and exact after the
  Qwen edit.

## Constraints

- Apple M5 Max, 128 GB. oMLX (Homebrew tap `jundot/omlx`, installed 0.6.3rc3, upstream at
  0.7.1rc1) serves the 27B pilot model on `127.0.0.1:8000` with an API key.
- oMLX 0.6.3 has no image engine, no images route and no plugin hook, and runs every MLX call
  on one global single-worker executor, so an image inside it would stall the pilot's LLM.
  Carl: do not fork oMLX. A separate server process never stalls the LLM.
- Evaluated and rejected (2026-10-16): vmlx / MLX Studio (one project; no Qwen Image 2.1, old
  Qwen-Image-Edit at 54 GB), Rapid-MLX (img2img only, 40 steps), Osaurus (62 GB app), Draw
  Things (no OpenAI routes). mlx-serve is the only candidate with 2.1 generate, instruction edit
  with references and OpenAI-style routes as a plain CLI daemon.
- Hermes delivers a file to Discord only from a `MEDIA:/abs/path.png` tag in the model's final
  reply; a plugin tool's result is never scanned. The path must be an existing regular file
  outside Hermes' denylist. In strict mode it must also be under ten minutes old or in an
  allowlisted directory.
- The bridge's `query` request is capped at 90 s and its programs may import only the play lib.
- No build step in the bridge; new npm packages must land in `package-lock.json`.

## Decisions taken (Carl's)

- Qwen Image 2.1, locally, served by mlx-serve. Not a cloud backend, not an oMLX fork, not a
  server of our own.
- Two look pictures: a generated scene, and a conventionally rendered map that is then edited
  by Qwen for style.
- The map's content: recently visited systems, the travelled path, and what was done in each.
  The spike at `experiments/map-spike/` (28 runs, real galaxy coordinates, glyphs with counts,
  labels on a separate layer) is the reference for what "faithful and detailed" means.
- An automatic end-of-flight picture; its prompt iterated together on Kvothe's logs.
- The player aesthetic is palette and medium, not props: ink and lamplight, worn leather and
  brass, no chrome. No lute.

## Decisions taken (agent's, overridable)

### The image server: mlx-serve

- **Install.** `brew tap ddalcu/mlx-serve https://github.com/ddalcu/mlx-serve`, trust the
  formula only, `brew install --formula ddalcu/mlx-serve/mlx-serve`. Version 26.10.2. Needs
  macOS 26.2 or later. The app (cask) is not installed.
- **Model.** `ddalcu/Qwen-Image-2.1-Turbo-MLX-Serve-8bit`, pulled into `~/.mlx-serve/models`
  (about 19 GB on disk and at peak). Turbo is 8 steps; the model card quotes single-digit
  seconds per 1024 image on M5 Ultra. The 4-bit pack (13 GB) and the base 40-step packs are
  alternatives if quality or memory says so.
- **Run.** `mlx-serve serve --host 127.0.0.1 --port 11234 --api-key <key>`; models load on
  demand by name. How it is kept running is deploy, Carl's. Manual `POST /v1/unload-model`
  exists; idle unload is not documented.
- **Routes.** `POST /v1/images/generations` (JSON: `model`, `prompt`, `size`, `seed`; also
  `"mode":"edit"` with `image` and `ref_images`) and `POST /v1/images/edits` (OpenAI SDK
  multipart, repeated `image[]`). Response shape is confirmed by the first spike, below.
- **Measured 2026-10-16 on this Mac** (`experiments/qwen-spike/`): text-to-image 1024x1024
  in 20 s including the model's first load; edit of a 1600x1600 reference to 1024x1024 in 21 s.
  Both routes answer `{"created":0,"data":[{"b64_json":"..."}]}`; the edits route takes the
  OpenAI multipart form with `image[]`. A look with both pictures is therefore under a minute.
  The pilot's LLM on oMLX was not affected.
- **Size.** 1024x1024 everywhere.

### Plugin side (sm-autopilot)

- **Settings**, same pattern as the journal webhook (`plugin.yaml` `config_schema`,
  `get_secret` in `service.py`, env var into the bridge): `SPACEMOLT_IMAGER_URL` (no default;
  unset means no pictures and nothing else changes), `SPACEMOLT_IMAGER_KEY`,
  `SPACEMOLT_IMAGE_MODEL` (the mlx-serve model name), and `SPACEMOLT_IMAGE_STYLE` (the
  aesthetic line; default is the one above).
- **Files** go to `runtime/images/<kind>-<utc stamp>.png`. Not denylisted; fresh enough for
  strict mode. Kept, never rotated, like `programs/`.
- **`picture(kind)` in the play lib** (`src/play/`, exported from the barrel, `npm run gen:play`).
  `kind` is `'scene'` or `'map'`. Returns the absolute path and writes a `MEDIA:<path>` line to
  the program's output. Awaiting it does not count against the 90 s query cap; the picture call
  itself gives up at 180 s. On any failure it returns `null` and journals a `picture` line.
  It is one more barrel export, so the pilot could call it; nothing refuses that (observe, don't
  gate). Only the observer's prompt section mentions it, and the play README does not.
- **Picture kinds.** Two generated kinds, each a prompt template over the same scene facts,
  with empty slots dropping their sentence. Templates live in one TypeScript module so tuning
  is one file; the filled prompt is journalled with the picture.
  - **Seat selfie** (the default "what you see"): an arm's-length selfie from the pilot's seat,
    the pilot small in a lower corner turned toward the canopy, the view as the subject: the
    docked station or the current POI, the system's other POIs nearest first, nearby ships by
    class, pirates by count and tier, creatures by species, security, hull and fuel cues, and
    what the last work call did. The pilot's description is read from the profile's `SOUL.md`
    (a two-sentence physical paragraph, added 2026-10-16) and distilled to a clause.
  - **Rendered scene**: a third-person cinematic wide shot of the ship in the same surroundings,
    no cockpit, no pilot.
  - Reference renders and the exact prompt texts are in `experiments/codex-refs/PROMPTS.md`
    and `prompts/seat-selfie-v1.txt`.
- **Reference images from the codex.** Each generation carries up to five reference images
  so the model draws SpaceMolt's own ships, stations and creatures rather than inventing them.
  Sources are the game's asset CDN (`assets.spacemolt.com/images/`): per-ship renders at
  `ships/catalog/<class_id>.webp`, per-item art at `items/<item_id>.webp`, empire art at
  `home/empire-<empire>.jpg`, and a short list of generic scene cards (stations, wildlife,
  battles). There is no creature, station or facility art; generic cards stand in. Selection
  is a keyword map from the scene's ids to URLs, data not code, most specific first; the prompt
  names each reference by index. Fetches go through an ETag cache: a manifest keyed by URL
  with `etag`, `last_modified`, `fetched_at` and `max_age`; the CDN serves strong ETags and a
  one-year `immutable`, so revalidation is skipped inside max-age and sends `If-None-Match`
  when forced. Cache under `runtime/refs/`. Prototype: `experiments/codex-refs/codex_refs.py`.
- **Journal snapshot fields the references need** (additions to `stateSnapshot`, raw ids, no
  verdicts): our ship's `class_id`, `id` and fitted module `type_id`s; the player's `empire`,
  `faction_id` and two paint colours; the location's `poi_type`, `security_status`, `empire`
  and mineable resource item ids; nearby players', empire NPCs' and prizes' ship classes
  (capped) and pirate count and tier. Creature species already live in the fight record and
  sightings; adding species to battle push lines would make a flight self-contained.
- **The map** is specified in full in [the activity map design report](2026-10-16-activity-map-design.md):
  donut nodes on real galaxy coordinates, a time-local-epoch stepped timeline with a stacked
  actions bar, 800 by 600, SVG in two layers rasterised with `@resvg/resvg-wasm`. Only the art
  layer goes through the Qwen edit; every label is composited over it afterwards.
- **The journal oracle.** A pure function over the runtime directory that answers "where are
  we, how are we, and what have we been up to lately" as one structured record, the `Scene`,
  which the seat-selfie and rendered-scene templates render from. It runs at the close of every
  flight (on `run` `ended`, from the end state) and on demand for a look (from the live
  location). It reads the journal tail, `end_state`, `places.json`, `names.json`,
  `sightings.json` and `combat.json`, and it never calls the game. Fields, all facts:
  - **where**: `system`, `system_name`, `poi`, `poi_name`, `poi_type?`, `docked_at`,
    `base_name`, `security?`, `empire?`.
  - **status**: `hull`/`max_hull`, `fuel`/`max_fuel`, `credits`, `cargo_used`/`cargo_capacity`,
    `cargo` (top items by quantity), `ship_class?`.
  - **company**: creatures by species with counts from recent sightings at this POI; nearby ship
    classes, pirates and NPCs when the live location is available (a look), else empty.
  - **lately**: the last few runs' `work` (fn, status, credits, items, xp), fights since a cutoff
    (count, won, lost, last opponent), trades (bought, sold, where), deaths and strandings,
    systems visited in order, and the span covered. Bounded: about the last ten runs or six
    hours, whichever is less.
  - **flags** the templates use for cues: `in_battle`, `hull_low`, `fuel_low`, `fresh_from`
    (`hunt`, `mine`, `trade`, `travel` or null).
  The oracle writes one `oracle` journal line with the record (raw, joinable by `run_id`), so
  prompt iteration can replay real scenes without the game, and so a reviewer can see exactly
  what a picture was told. The end-of-flight picture is then: oracle, then seat selfie from the
  `Scene`, then post to the journal webhook as a multipart message (`payload_json` +
  `files[0]`) with a one-line caption built from `where`, `status` and `lately`. The `run`
  reply to Hermes does not wait; an oracle still rendering when the next run ends means the new
  one is skipped and journalled, never queued. Proposal status: agreed in principle 2026-10-16,
  not yet built.
- **Prompt iteration.** `scripts/flight-prompt.ts <run_id|latest> [--render]` prints the prompt
  for a recorded run from any profile's runtime dir, and with `--render` writes the picture. The
  template lives in one function so tuning is one file.
- **Observer prompt.** The observer toolset's system-prompt section tells the model to repeat
  any `MEDIA:` line from a look's output verbatim in its reply, outside code fences.
- **Journal.** New `picture` event: `kind`, `run_id` or `query_id`, `ok`, `ms`, `path`, `error`,
  `model`. Raw facts only.

## What the image spikes taught us

2026-10-19. Each spike is condensed in [the spike notes](../spikes/README.md); the renders stay out of the repo.
These are the lessons that outlive them. The code cites them where it leans on one (`imager.ts`, `refs.ts`,
`prompts.ts`, `moments.ts`, `stars.ts`).

**What is built.** At the end of every flight with an own act, one Discord post: the juncture's activity map, drawn as it
is (no restyle), then a selfie of each of the flight's two moments, then a caption. A flight with no own act posts
nothing. Each selfie is the loose one-pass prompt (no style frame, no plates), on one of three cameras by seed.

**The prompt** (Qwen Image 2.1 Turbo, guidance 1, over a hundred renders):
- Edit mode only (`mode: "edit"`), and a picture without a reference still goes through it, of a flat grey
  frame: a plain generation of the same prompt came out a monochrome pen sketch, off the look.
- Camera first. "We look straight up from underneath at X" re-posed 6/6; "X, seen from directly below" 1/6.
- Short, because every noun pulls. A thing named is drawn, even to exclude it: the reference's shipyard came
  back when the prompt said it was absent, a station's "plaque" became a sheet of names in the cockpit.
  Negative prompts and guidance change nothing; `steps` is ignored (the Turbo grid is 8).
- One subject re-poses: the one whose pose is stated most forcefully, in its own parts relative to us ("its
  bow pointing straight at us"), against the reference's pose. Every other subject keeps its reference pose.
- References get copied: pose, light and backdrop pasted like a sticker, and any full-scene card becomes the
  picture. Whether a subject's art is copied is seed-dependent (0/4 at one size, 4/4 at another, same
  seeds), so budget 2–3 seeds. Rewording the reference sentence unpasted nothing; a tight crop to the
  subject helps and costs nothing. Send one-subject art only.
- The camera re-poses the shot when its words name the viewpoint and where things sit in the frame ("a side
  view across the cockpit … his eyes on the canopy at the right of the frame", "a wide shot of the whole
  cockpit from behind"). A camera that only names the seat comes back as the shoulder shot, and the seat
  camera alone gives every flight the same picture. The selfie takes one of three cameras by `seed % 3`
  (camera spike; the worm's-eye one was dropped).
- A fixed style frame (one of our renders, the canopy blanked) made every picture the same picture, and was
  dropped. The cockpit is now words ("a worn starship cockpit of brass and leather").
- Clothing in the look ends the airline-captain drift: with no clothes named, the pilot wore a white shirt
  and stripes; "in travel-worn utility clothes with many pockets" drew a jacket with pockets 8 of 8. The look
  is SOUL.md's build, hair and clothing; the eyes go only in the side view.
- Proper names draw signs ("MARKET PRIAME") or nothing; a subject is named by its kind.
- A colour word the art does not show repaints the subject. The pilot's own ship takes no words, or it is
  drawn outside the canopy.

**The words** (catalog spike, 38 renders):
- Prompts use only text the game server sends (Carl's rule). The one authored exception is the
  Morgan–Keenan star table: a sun by its class is the strongest flavour per word, and every system has one.
- Raw or mechanically selected server text adds little: trailing description sentences were ignored 3/3,
  extracted adjectives vanished or attached to something new. The looks come from the catalog art; words
  can only reinforce it. Creatures, empires and most POIs have no text at all; a species with no art gets a
  portrait generated once from its name and its loot's own sentences.

**The moment** (scorer dry runs over seven of Kvothe's junctures):
- A flight shows its majority action, the category of most of the pilot's own commands, unless a fight, a
  death or a first find overrides. The best-scoring moment alone drew one argon deposit for five hours of
  gas harvesting.
- The second moment is the scope's best other moment that shows the pilot's own act or a fight, preferring
  another category or subject, so the two pictures differ. Its seed is the next one, so its camera differs too.
- Scored excitement peaks in short local spans, so a steady shift splits into hundreds of near-equal
  moments, and a thin scope gives a thin picture.
- The journal loses opponents (`combat.json` keeps 60 fights); the raw frame log is the source. A failed
  hunt (`action_error`) scores nothing, and `exchange_fill` is muted by default and never arrives.

**Tried and dropped:** a fixed style frame (every picture the same picture); two-pass drawing (a layout
pass, then an edit with the references: still pasted, and over-sharpened); composite references (several of
a kind on one image, weighted: pasted as one sticker); three-view sheets (re-pose, but invent wings);
line-drawing or white-ground references (their own medium, or nothing over a crop); a canvas plus a reference
("replace the freighter in image 1": nothing swapped); hand-written flavour tables for POIs, stations and
pirate ships (Carl: server text only). Two-pass compositing with per-pilot cockpit plates (a cockpit plate,
its canopy masked or keyed out by a prompted chroma-key screen, and the view drawn alone and composited in)
worked, and was shelved for the loose one-pass prompt, which needs no plates.

## Left to the builder

- Measured timings and the edits response shape, from the first spike against the real
  server; the bridge and plugin tests mock the imager over HTTP and never need it.
- SVG design details within the spike's vocabulary; resvg font loading on macOS.
- The restyle instruction wording and the edit `strength`; whether the composite needs a
  slight darkening under labels for contrast.
- How the query cap exclusion is implemented (deadline extension vs. a separate race).
- Test strategy per AGENTS.md: TypeScript tests for the map spec builder, the prompt template
  and the webhook multipart post (no network); Python tests for the settings plumbing; nothing
  for the server, which is not ours.

## Status

- Builder check (first draft) asked six questions; all answered above.
- Design iteration 2026-10-16: map and timeline settled (see the map report); picture kinds
  settled as seat selfie and rendered scene; reference-image system prototyped end to end;
  journal oracle proposed.
- Implementation order: the map renderer first, as a clean-room TypeScript module in this repo
  that nothing imports yet (a proposal for inclusion, not wired to `picture()` or the bridge);
  then the reference cache and picture templates; then `picture()` and the oracle. Prototype
  code under `experiments/` is reference material only and is not ported.
