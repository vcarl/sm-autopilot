import {goTo, sleep} from 'play';

export default async function main() {
  for (let attempt = 0; ; attempt++) {
    const r = await goTo('sol_belt');
    if (r.ok) return r.value;
    if (r.error._tag !== 'ServerBusy' || attempt >= 5) throw r.error;
    await sleep(1000 * 2 ** attempt);
  }
}
