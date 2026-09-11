import type {Account} from '@spacemolt/lib';
import type {Job} from './execution-store.ts';
import type {Home} from './execution-policy.ts';
import type {ServiceFuelQuote} from './servicing.ts';
import {jobBudget} from './spending.ts';

export interface TransportCleanupAllocation {
  owner_job_id:string;allocated_at:string;amount:number;gross_spend_at_allocation:number;
  quote:ServiceFuelQuote;
  limitation:string;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** A dated home price reserves money; it does not quote remote or future service. */
export function planTransportCleanup(account:Account,home:Home|undefined,job:Job,jobs:Job[],runJobs:Job[],requiredFuel:number) {
  const budget=jobBudget(job,jobs),owner=jobs.find(row=>row.id===budget.owner_job_id)!;
  const previous=owner.transport_cleanup_allocation;
  const quote=previous?.quote??runJobs.flatMap(row=>row.service_fuel_quotes??[]).filter(row=>row.base_id===home?.base_id).at(-1);
  const blockers:string[]=[];
  if(!home||!quote||quote.base_id!==home.base_id||quote.ship_id!==account.ship?.id||quote.max_fuel!==account.ship?.max_fuel||!finite(quote.unit_price)||!Number.isFinite(Date.parse(quote.observed_at)))blockers.push('Observed home fuel price for this ship and capacity required; service at home before a new transport commitment');
  if(budget.gross_spend===null)blockers.push('Unpriced job expenditure prevents cleanup allocation');
  const spentSinceAllocation=previous&&budget.gross_spend!==null?budget.gross_spend-previous.gross_spend_at_allocation:0;
  const estimate=quote&&finite(quote.unit_price)&&finite(requiredFuel)&&finite(account.ship?.fuel)
    ?(quote.max_fuel-account.ship.fuel+requiredFuel)*quote.unit_price:NaN;
  const amount=Math.max(previous?.amount??0,spentSinceAllocation+estimate);
  if(!finite(amount))blockers.push('Itinerary cleanup allocation is unknown');
  const remaining=amount-spentSinceAllocation;
  if(!finite(spentSinceAllocation)||!finite(remaining)||budget.gross_spend===null||budget.max_spend-budget.gross_spend<remaining)blockers.push('Remaining gross job budget cannot fund the cleanup allocation');
  if(!finite(account.credits)||account.credits-budget.credit_reserve<remaining)blockers.push('Wallet headroom cannot fund cleanup without anticipated delivery income');
  const allocation:TransportCleanupAllocation|undefined=blockers.length?undefined:previous?{...previous,amount}:{
    owner_job_id:budget.owner_job_id,allocated_at:new Date().toISOString(),amount,
    gross_spend_at_allocation:budget.gross_spend!,quote:quote!,
    limitation:'Itinerary fuel estimate plus local/escape allowance priced at the observed home rate; a planning reservation, not a physical or price guarantee. Actual cleanup is requoted against the original gross job budget and wallet reserve, with any planning overrun reported. Future repair costs and remote services remain unknown.',
  };
  return {status:blockers.length?'blocked':'ready',blockers,quote,allocation,remaining_cleanup_allowance:finite(remaining)?remaining:null,budget};
}

/** Linked returns consume the original allocation; neither income nor resume refills it. */
export function remainingTransportCleanup(job:Job,jobs:Job[]):number|undefined {
  const budget=jobBudget(job,jobs),allocation=jobs.find(row=>row.id===budget.owner_job_id)?.transport_cleanup_allocation;
  if(!allocation)return undefined;
  if(budget.gross_spend===null)return 0;
  return Math.max(0,allocation.amount-(budget.gross_spend-allocation.gross_spend_at_allocation));
}
