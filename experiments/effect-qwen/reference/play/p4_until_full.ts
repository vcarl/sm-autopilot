import {gatherUntil, sell} from 'play';

export default async function main() {
  const run = await gatherUntil({poi: 'unknown_edge_mineral_fields', until: {item: 'iron_ore', quantity: 200}, maxTrips: 4});
  if (run.status === 'refused') return run;
  return sell(run.detail.settled.filter(r => r.item_id !== 'iron_ore'), {from: 'store'});
}
