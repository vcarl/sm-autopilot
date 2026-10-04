import {acceptMission, completeMissions, missions, note, unwrap} from 'play';

export default async function main() {
  const board = unwrap(await missions());
  let accepted = 0;
  for (const m of board.filter(m => m.reward >= 100)) {
    const r = await acceptMission(m.id);
    if (r.ok) { accepted++; continue; }
    if (r.error._tag === 'NoSlots') break;
    throw r.error;
  }
  const done = await completeMissions();
  if (!done.ok) {
    if (done.error._tag !== 'NothingCompletable') throw done.error;
    note('nothing completable');
  }
  return accepted;
}
