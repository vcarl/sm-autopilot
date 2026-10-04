import {goTo, mine, sell, service, unwrap} from 'play';

export default async function main() {
  unwrap(await goTo('sol_belt'));
  for (let i = 0; i < 3; i++) unwrap(await mine());
  unwrap(await goTo('sol_base'));
  unwrap(await sell([{item_id: 'iron_ore'}]));
  return unwrap(await service());
}
