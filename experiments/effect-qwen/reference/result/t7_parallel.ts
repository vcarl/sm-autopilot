import {missions, note, orient, prices, unwrap} from 'play';

export default async function main() {
  const [here, quotes, board] = await Promise.all([orient(), prices(), missions()]);
  const best = [...unwrap(quotes)].sort((a, b) => b.best_buy - a.best_buy)[0];
  note(`credits ${unwrap(here).credits}, best ${best?.item_id ?? 'none'}, missions ${unwrap(board).length}`);
}
