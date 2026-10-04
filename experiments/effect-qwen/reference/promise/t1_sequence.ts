import {goTo, mine, sell, service} from 'play';

export default async function main() {
  await goTo('sol_belt');
  for (let i = 0; i < 3; i++) await mine();
  await goTo('sol_base');
  await sell([{item_id: 'iron_ore'}]);
  return service();
}
