/** The barrel: everything a script may reach, and nothing else.
 *
 * A script in `src/scripts/` composes these in ordinary TypeScript — a loop, a condition, a
 * variable. `script-lint.ts` refuses any script that imports another module, so this list is
 * the whole of the surface a script is written against, and widening it is a deliberate act.
 *
 * Jobs (`gather`) are the long steps: they check the rules before they start and record
 * their own outcome. Helpers are the short moves between them.
 */
export {Blocked,type Ctx,type JobOutcome,type ScriptResult} from './ctx.ts';
export {gather,type GatherParams} from './gather.ts';
export {dock,journal,service,storage,travel,where,
  type DockReport,type TravelReport,type Where} from './helpers.ts';
export type {StorageView} from '../storage.ts';
