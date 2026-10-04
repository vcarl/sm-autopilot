import {goTo, isError, sleep} from 'play';

export default async function main() {
  for (let attempt = 0; ; attempt++) {
    try { return await goTo('sol_belt'); }
    catch (e) {
      if (!isError(e, 'ServerBusy') || attempt >= 5) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
