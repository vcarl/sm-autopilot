import {disengage, goTo, hunt, unwrap} from 'play';

export default async function main() {
  try {
    unwrap(await goTo('sol_nebula'));
    return unwrap(await hunt({fights: 2}));
  } finally {
    await disengage();
  }
}
