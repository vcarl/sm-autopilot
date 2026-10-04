import {goTo, hunt, disengage} from 'play';
export default async function main() {
  await goTo('sol_nebula');
  const h = await hunt({fights: 2});
  await disengage();
  return h;
}
