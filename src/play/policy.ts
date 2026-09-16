/** The static game policy over a pilot file, same blanked-source regex style as the boundary.
 * What stays static is only what a runtime check cannot catch in time: an uncapped loop, a
 * landing that strands passengers, and the entry the runner calls. Everything else is
 * refused at runtime by the rules inside the helpers. */
import {blank} from './boundary.ts';
import type {Verdict} from './boundary.ts';

export function checkPolicy(source:string,path:string,entry=false):Verdict {
  const code=blank(source),errors:string[]=[];
  if(/\bunload_passenger\s*\(\s*\{[^}]*\bid\s*:\s*['"]all['"]/.test(code))
    errors.push(`${path}: unload_passenger with id 'all' strands passengers; carryPassengers handles landings`);
  if(/\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/.test(code)&&!/\bstopped\s*\(\s*\)/.test(code))
    errors.push(`${path}: an unbounded loop must check stopped() (a run has no wall-clock cap)`);
  if(entry&&!/\bexport\s+default\s+async\s+function\s+main\b/.test(code))
    errors.push(`${path}: must export default async function main`);
  return {ok:!errors.length,errors};
}
