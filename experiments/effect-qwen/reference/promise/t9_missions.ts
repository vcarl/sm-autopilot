import {acceptMission, completeMissions, isError, missions, note} from 'play';

export default async function main() {
  const board = await missions();
  let accepted = 0;
  for (const m of board.filter(m => m.reward >= 100)) {
    try { await acceptMission(m.id); accepted++; }
    catch (e) { if (isError(e, 'NoSlots')) break; throw e; }
  }
  try { await completeMissions(); }
  catch (e) { if (!isError(e, 'NothingCompletable')) throw e; note('nothing completable'); }
  return accepted;
}
