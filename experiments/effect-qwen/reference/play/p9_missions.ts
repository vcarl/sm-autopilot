import {acceptMission, completeMissions, missions, note, outcome} from 'play';

export default async function main() {
  const here = await missions();
  let accepted = 0;
  for (const m of here.detail.board.filter(m => m.rewards.credits >= 100).slice(0, here.detail.slots_free)) {
    const took = await acceptMission(m.mission_id);
    if (took.status !== 'done') break;
    accepted++;
  }
  const done = await completeMissions();
  if (done.status !== 'done') note(`completeMissions: ${done.why ?? done.status}`);
  return outcome(`accepted ${accepted} missions`, 'done', {accepted});
}
