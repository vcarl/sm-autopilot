import {completeMissions, disengage, goTo, isError, mine, note, orient, sell, service} from 'play';

export default async function main() {
  try {
    await goTo('kepler_belt');
    for (;;) {
      try { await mine(); }
      catch (e) {
        if (isError(e, 'HoldFull')) break;
        if (isError(e, 'InBattle')) { await disengage(); continue; }
        throw e;
      }
    }
    await goTo('kepler_base');
    await sell([{item_id: 'copper_ore'}]);
    await service();
    try { await completeMissions(); }
    catch (e) { if (!isError(e, 'NothingCompletable')) throw e; }
  } finally {
    note(`credits ${(await orient()).credits}`);
  }
}
