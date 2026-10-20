# Cameras and clothing (2026-10-19)

**Question.** Does a clothing clause stop the pilot being drawn as an airline captain, and can the camera be varied?

**Method.** The loose spike's `look` prompts with only the look clause and the camera opening changed, on its seeds, so
renders compare one to one. 60 renders over 8 runs, seeds 1 and 2. The look, by hand from SOUL.md: "a small, lean man with
fiery red hair, in travel-worn utility clothes with many pockets".

**Findings.**
- Clothing ends the drift: 8/8 lost the white shirt, stripes and uniform for a jacket with pockets.
- A camera that only names the seat comes back as the shoulder shot ("up", "profile", and two low-angle wordings). What
  re-poses is naming the viewpoint and where things sit in the frame, and leaving the seat out:

| camera | wording, after `{style}: ` | re-posed |
|---|---|---|
| shoulder | `from the pilot's seat of {own}, {cockpit}, through {canopy} onto {view}, the pilot, {look}, small in the lower left corner` | the default |
| side | `a side view across the cockpit of {own}, {cockpit}: the pilot, {look}, seen in profile from his left, his green eyes on the canopy at the right of the frame, through {canopy} onto {view}` | 11/12 |
| low | `a worm's-eye view from the cockpit floor of {own}, …, looking steeply up past the pilot's chin, …` | 7/12 face-on |
| wide | `a wide shot of the whole cockpit of {own} from behind, {cockpit}, the pilot, {look}, small in his seat at the centre, through {canopy} onto {view}` | 12/12 |

- Still weak: trading and docked draw the same docking ring; travel and a mission are both just a sun; gas shows no
  harvester. The style's "deep indigo shadows" turns red and blue-white suns indigo. The low camera draws the pilot large.

**Verdict.** Three cameras, picked by `seed % 3`; the look is SOUL.md's build, hair and clothing.

**Kept:** shoulder, side and wide (`prompts.ts` `CAMERA_ORDER`); clothing in the look; the eyes only in the side view.
**Dropped:** the worm's-eye camera and every seat-only wording.
