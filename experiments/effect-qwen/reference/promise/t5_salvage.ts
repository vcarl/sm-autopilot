import {disengage, goTo, isError, note, orient, salvage, sell} from 'play';

export default async function main() {
  try {
    return await salvage();
  } catch (e) {
    if (isError(e, 'NoWreck')) { note('no wreck'); return; }
    if (isError(e, 'InBattle')) { await disengage(); return salvage(); }
    if (isError(e, 'HoldFull')) {
      await goTo('sol_base');
      const here = await orient();
      await sell(here.cargo.map(r => ({item_id: r.item_id})));
      await goTo('sol_debris');
      return salvage();
    }
    throw e;
  }
}
