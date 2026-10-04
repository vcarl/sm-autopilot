import {completeMissions, gatherUntil, note, orient, sell, service} from 'play';

export default async function main() {
  try {
    const trip = await gatherUntil({poi: 'kepler_belt', base: 'kepler_station'});
    if (trip.status !== 'done') return trip;
    await sell(trip.detail.settled.filter(r => r.item_id === 'copper_ore'), {from: 'store'});
    const serviced = await service();
    await completeMissions();
    return serviced;
  } finally {
    const look = await orient();
    note(`credits ${look.now.credits}`);
  }
}
