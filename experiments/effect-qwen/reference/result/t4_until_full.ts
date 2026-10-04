import {goTo, mine, orient, sell, unwrap} from 'play';

export default async function main() {
  for (;;) {
    const m = await mine();
    if (m.ok) continue;
    if (m.error._tag === 'HoldFull') break;
    throw m.error;
  }
  unwrap(await goTo('sol_base'));
  const here = unwrap(await orient());
  return unwrap(await sell(here.cargo.map(r => ({item_id: r.item_id}))));
}
