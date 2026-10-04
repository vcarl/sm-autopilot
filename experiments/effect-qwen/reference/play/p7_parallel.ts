import {missions, note, orient, prices} from 'play';

export default async function main() {
  const [look, market, board] = await Promise.all([orient(), prices(), missions()]);
  const best = [...market.detail.quotes].sort((a, b) => b.best_buy - a.best_buy)[0];
  note(`credits ${look.now.credits}, best ${best?.item_id ?? 'none'}, missions ${board.detail.board.length}`);
  return market;
}
