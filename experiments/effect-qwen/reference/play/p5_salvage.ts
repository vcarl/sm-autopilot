import {goTo, note, salvage, sell} from 'play';

export default async function main() {
  const first = await salvage();
  if (first.status === 'refused') { note(`no wreck: ${first.why ?? ''}`); return first; }
  if (first.status !== 'partial') return first;
  await goTo('sol_station');
  await sell(first.gained.items.map(r => ({item_id: r.item_id})));
  await goTo('sol_debris');
  return salvage();
}
