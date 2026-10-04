import {missions, note, orient, prices} from 'play';

export default async function main() {
  const [here, quotes, board] = await Promise.all([orient(), prices(), missions()]);
  const best = [...quotes].sort((a, b) => b.best_buy - a.best_buy)[0];
  note(`credits ${here.credits}, best ${best?.item_id ?? 'none'}, missions ${board.length}`);
}
