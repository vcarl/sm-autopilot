import {goTo} from 'play';

export default async function main() {
  let trip = await goTo('sol_belt');
  for (let retry = 0; retry < 5 && trip.status === 'failed'; retry++) {
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** retry));
    trip = await goTo('sol_belt');
  }
  return trip;
}
