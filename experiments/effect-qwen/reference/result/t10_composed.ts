import {completeMissions, disengage, goTo, mine, note, orient, sell, service, unwrap} from 'play';

export default async function main() {
  try {
    unwrap(await goTo('kepler_belt'));
    for (;;) {
      const m = await mine();
      if (m.ok) continue;
      if (m.error._tag === 'HoldFull') break;
      if (m.error._tag === 'InBattle') { await disengage(); continue; }
      throw m.error;
    }
    unwrap(await goTo('kepler_base'));
    unwrap(await sell([{item_id: 'copper_ore'}]));
    unwrap(await service());
    const done = await completeMissions();
    if (!done.ok && done.error._tag !== 'NothingCompletable') throw done.error;
  } finally {
    note(`credits ${unwrap(await orient()).credits}`);
  }
}
