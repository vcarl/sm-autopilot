import {disengage, goTo, note, orient, salvage, sell, unwrap} from 'play';

export default async function main() {
  const s = await salvage();
  if (s.ok) return s.value;
  switch (s.error._tag) {
    case 'NoWreck': note('no wreck'); return;
    case 'InBattle': await disengage(); return unwrap(await salvage());
    case 'HoldFull': {
      unwrap(await goTo('sol_base'));
      const here = unwrap(await orient());
      unwrap(await sell(here.cargo.map(r => ({item_id: r.item_id}))));
      unwrap(await goTo('sol_debris'));
      return unwrap(await salvage());
    }
  }
}
