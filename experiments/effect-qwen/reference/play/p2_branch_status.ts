import {goTo, note, service} from 'play';

export default async function main() {
  const trip = await goTo('kepler_station');
  if (trip.status === 'refused' || trip.status === 'failed') { note(`goTo ${trip.status}: ${trip.why ?? ''}`); return trip; }
  if (!trip.detail.docked) { note('arrived undocked'); return trip; }
  return service();
}
