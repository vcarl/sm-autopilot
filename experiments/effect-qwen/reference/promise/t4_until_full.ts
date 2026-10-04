import {goTo, isError, mine, orient, sell} from 'play';

export default async function main() {
  for (;;) {
    try { await mine(); }
    catch (e) { if (isError(e, 'HoldFull')) break; throw e; }
  }
  await goTo('sol_base');
  const here = await orient();
  return sell(here.cargo.map(r => ({item_id: r.item_id})));
}
