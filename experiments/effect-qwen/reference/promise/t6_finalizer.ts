import {disengage, goTo, hunt} from 'play';

export default async function main() {
  try {
    await goTo('sol_nebula');
    return await hunt({fights: 2});
  } finally {
    await disengage();
  }
}
