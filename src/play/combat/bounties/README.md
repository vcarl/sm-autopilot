# combat/bounties — pirate hunting (intermediate+)

Pirates patrol systems with `police_level` ≤ 20. Killing them pays bounties, trains
bounty_hunting, and is the one loop that trains shields and armor. Insurance premiums barely
move for NPC pirate kills. Needs a T2+ hull and a full weapon fit; no permission gates it —
whether a sweep is worth flying is your call.

| Function | Promise |
|---|---|
| `patrol({systems?, maxTier?, fights?})` | sweep low-police neighbours for pirates, fight, come home |

```ts
import {orient, missions, acceptMission, patrol, service} from 'play';

export default async function main() {
  await orient();
  const board = await missions();
  const bounty = board.detail.board.find(m => m.type === 'bounty' || m.fits === 'hunt');
  if (bounty) await acceptMission(bounty.mission_id);
  const sweep = await patrol({maxTier: 1, fights: 3});
  if (sweep.status !== 'done') return sweep;
  return service({insure: true});
}
```

Never attack anything tagged `[POLICE]` or any player: `patrol` will not, and a raw
`account().commands.spacemolt.attack` on such a target is a crime. Retreat is automatic at the
mood's hull line; a ship that escapes keeps everything.
