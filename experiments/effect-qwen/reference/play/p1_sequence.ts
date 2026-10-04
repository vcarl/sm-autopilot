import {gatherUntil, sell, service} from 'play';

export default async function main() {
  const trip = await gatherUntil({poi: 'unknown_edge_mineral_fields'});
  if (trip.status !== 'done') return trip;
  await sell(trip.detail.settled, {from: 'store'});
  return service();
}
