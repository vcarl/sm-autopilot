// The rules table's first consumer. It adds no judgement of its own: the table decides
// what is admissible, this splits the verdicts into the options the agent picks from and
// the refusals that say what would make them admissible (VISION, "The menu").
import {evaluateMenu,resolveBounds,type Bounds,type Call,type Facts} from './rules-table.ts';

export interface Option {job:string;reason:string;bounds:Bounds;admissible:true;call:Call|null}
export interface Refusal {job:string;reason:string}
export interface Menu {options:Option[];unavailable:Refusal[]}

export function buildMenu(facts:Facts):Menu {
  const bounds=resolveBounds(facts.mood),options:Option[]=[],unavailable:Refusal[]=[];
  for(const verdict of evaluateMenu(facts)) {
    if(verdict.admissible)options.push({job:verdict.job,reason:verdict.reason,bounds,admissible:true,call:verdict.call??null});
    else unavailable.push({job:verdict.job,reason:verdict.reason});
  }
  return {options,unavailable};
}
