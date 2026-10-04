import {disengage, goTo, isError, note} from 'play';

export default async function main() {
  try {
    try { return await goTo('kepler_base'); }
    catch (e) {
      if (!isError(e, 'InBattle')) throw e;
      await disengage();
      return await goTo('kepler_base');
    }
  } catch (e) {
    note(`goTo failed: ${typeof e === 'object' && e !== null && '_tag' in e ? String(e._tag) : String(e)}`);
  }
}
