/** The barrel: everything a script may reach, and nothing else.
 *
 * A script in `src/scripts/` composes these in ordinary TypeScript — a loop, a condition, a
 * variable. `script-lint.ts` refuses any script that imports another module, so this list is
 * the whole of the surface a script is written against, and widening it is a deliberate act.
 *
 * Jobs (`gather`) are the long steps: they check the rules before they start and record
 * their own outcome. Helpers are the short moves between them.
 *
 * Scripts are here too, under their own camelCase names, because a script has a job's
 * signature and composes like one: `stock-up` runs `gatherUntil` as a step. The barrel is
 * the only door — a script reaching `../scripts/gather-until.ts` directly is refused — and
 * `gather` is absent because its script is one call to the job of that name, which is here.
 */
export {Blocked,type Ctx,type JobOutcome} from './ctx.ts';
export {craft,type CraftParams} from './craft.ts';
export {gather,type GatherParams} from './gather.ts';
export {hunt,type HuntParams} from './hunt.ts';
export {stow,type StowParams} from './stow.ts';
export {withdraw,type WithdrawParams} from './withdraw.ts';
export {dock,journal,service,storage,travel,where,
  type DockReport,type TravelReport,type Where} from './helpers.ts';
export type {StorageView} from '../storage.ts';
export {default as gatherUntil} from '../scripts/gather-until.ts';
export {default as stockUp} from '../scripts/stock-up.ts';
