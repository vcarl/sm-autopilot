/** The workshop counter: recipes, quotes, and crafts at the base you are docked at. */
import type {CraftJobResponse,CraftQuoteResponse,Recipe,RecipeInput} from '@spacemolt/lib';
import type {Outcome,Row} from '../types.ts';

/** The catalog recipe beside what it is worth here and what you already hold. */
export type Craftable=Recipe&{
  /** Value of outputs minus inputs at this base's live `best_buy`/`best_sell`, when quoted. */
  margin?:number;
  /** Each input against what you hold here (hold + store). */
  have:(RecipeInput&{have:number})[];
};

/** Recipes matching a search (item or recipe name), ranked by margin at this base's prices
 * and by how many inputs you already hold. Capped at 20. Reads the catalog
 * (`CatalogRecipe`) and the market; spends nothing. `next` names the recipe you could run
 * right now, if any. */
export function recipes(search?:string):Promise<Outcome<{recipes:Craftable[]}>> {throw new Error('unimplemented');}

/** A dry-run quote for a craft (`craft({dry_run:true})`): `cost`, `credits_total`,
 * `est_completion_tick`, `have_inputs`, `have_credits`, `have_capacity`. Nothing is
 * committed. `next` lists the missing inputs as `buy`/`withdraw` calls. */
export function quote(recipeId:string,quantity?:number):Promise<Outcome<CraftQuoteResponse>> {throw new Error('unimplemented');}

export interface Crafted {
  job:CraftJobResponse;
  /** What landed in the store, measured from `storage/view` before and after. */
  made:Row[];
}

/** Quote, commit the escrow, wait out the queue, confirm the outputs landed in this base's
 * store. Inputs are escrowed from the store (withdraw is not needed). Refused when the quote
 * says inputs, credits or capacity are short, or when the fee would breach `credit_reserve`.
 * A re-run after a restart re-enters at the wait for the `job_id` already queued; nothing is
 * escrowed twice. Waits up to 10 minutes, then `partial` with the job. Trains crafting, and
 * engineering for components and modules. Tired: refused. */
export function craft(recipeId:string,quantity?:number,opts?:{preset?:'fast'|'cheap'|'prefer_own'|'workshop'}):Promise<Outcome<Crafted>> {throw new Error('unimplemented');}
