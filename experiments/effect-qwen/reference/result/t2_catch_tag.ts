import {disengage, goTo, note} from 'play';

export default async function main() {
  let trip = await goTo('kepler_base');
  if (!trip.ok && trip.error._tag === 'InBattle') {
    await disengage();
    trip = await goTo('kepler_base');
  }
  if (!trip.ok) note(`goTo failed: ${trip.error._tag}`);
}
