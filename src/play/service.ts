/** The service counter: fuel and hull. Insurance and dues wait for a later slice. */
import type {GetBaseResponse} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import {journalRun} from '../run-record.ts';
import {ServiceBlocked,ServiceUnsafe,serviceShipEffect,words} from '../servicing.ts';
import {replyBody,rows} from '../storage.ts';
import {counterEffect} from './counter.ts';
import {Game,field} from './game.ts';
import {readPlaces} from './places.ts';
import {Run,acct,burnCells,edge,jobEffect,line,pilot,runtimeDir,stopped,type Said} from './runtime.ts';
import {goToEffect} from './travel.ts';
import type {Outcome} from './types.ts';

export interface Serviced {
  /** The counter as it was read before the spend. A posted `fuel_price_all_in` or
   * `repair_price_per_hull` is an estimate; an absent one is not a refusal. */
  base:GetBaseResponse;
  /** The commands sent (`spacemolt/refuel`, `spacemolt/repair`) and what they cost together. */
  issued:string[];
  spent:number;
  /** What this call was asked for and did not do (`insure`, `dues`, partial targets). */
  short:string[];
  /** True when this call cleared a Tired mood. */
  cleared_tired:boolean;
}

/** One base worth flying to for a service, as a move: the call, and everything known about it.
 * The menu offers these and a refused (or partially filled) `service` names them in `next`, so
 * the advice a pilot is given is the same advice either way. */
export interface Elsewhere {call:string;why:string;base:string}

/** Where else the pilot could be brought up. Only a service clears Tired, so a station that
 * cannot quote what is missing leaves the mood standing: the route to a base that might is the
 * useful line, not a flat reserve.
 *
 * Reads only, and every read may fail — no advice beats a made-up one. What a read cannot answer
 * is said in the row rather than keeping the row off the list: an unverifiable trip the pilot may
 * attempt beats a verified dead end, and the judgement is the pilot's (the live deadlock,
 * 2026-09-24, where the only offered move was a `service()` that refuses every time).
 *
 * The prices are `inspect({id})`'s: it names a base by id and answers with the docked-base body
 * (`InspectResponse.base: GetBaseResponse`). Its reach is **this system only** — the live server
 * refuses a far id with "You can only inspect a point of interest in your current system"
 * (2026-09-24, a run that broke on exactly that) — so it is asked for in-system candidates and
 * not asked at all for a base the journal remembers in another system, whose row says plainly
 * that no price is readable from here. It may also decline in-system, so it is still guarded.
 *
 * The candidates are this system's bases, else the far ones `places.json` has placed. The journal
 * was the far list once, read for docks in `response.result`: on the live journal (2026-09-28) that
 * shape matched nothing, and a Tired pilot one jump from a placed base resupplied "stranded". */
export const serviceElsewhereEffect=(docked?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  const trip=(id:string)=>Effect.gen(function*() {
    const read=yield* Effect.result(game.command('spacemolt/find_route',{id}));
    if(Result.isFailure(read))return `no route quote (${words(read.failure)})`;
    const quote=replyBody(read.success);
    return field(quote,'found')?`${field(quote,'estimated_fuel')} fuel, ${field(quote,'total_jumps')} jump(s)`:'no route from here';
  });
  /** What an in-system counter posts, read from here, or the plain admission that nothing does. */
  const posted=(base:string,fuelPrice?:number)=>Effect.gen(function*() {
    const read=yield* Effect.result(game.command('spacemolt/inspect',{id:base}));
    // no quote from here is the answer, not a guess
    const quoted=Result.isSuccess(read)?field(replyBody(read.success),'base'):undefined;
    const fuel=field(quoted,'fuel_price_all_in')??fuelPrice,hull=field(field(quoted,'base'),'repair_price_per_hull');
    const lost=Result.isFailure(read)?` (${words(read.failure)})`:'';
    const prices=[...Number.isFinite(fuel)?[`refuel ${fuel} cr/unit`]:[],
      ...Number.isFinite(hull)&&Number(hull)>0?[`repair ${hull} cr/hull`]:[]];
    return prices.length?`posts ${prices.join(' and ')}; the rest is unknown until docked`
      :`no price readable from here${lost}; unknown until docked`;
  });
  const listed=yield* Effect.result(game.command('spacemolt/get_system',{}));
  // no listing is no advice
  const pois=Result.isSuccess(listed)?rows(field(field(replyBody(listed.success),'system'),'pois')):[];
  const system=acct().state.location?.system_id??'this system';
  const out:Elsewhere[]=[];
  for(const poi of pois) {
    const base=field(poi,'base_id');
    if(typeof base!=='string'||!base||base===docked)continue;
    if(out.length>=3)break;
    const name=field(poi,'base_name'),price=field(poi,'fuel_price');
    out.push({call:`goTo('${base}')`,base,
      why:`${typeof name==='string'&&name?name:base} in ${system}: ${yield* trip(base)}; ${yield* posted(base,typeof price==='number'?price:undefined)}`});
  }
  if(out.length)return out;
  // Nothing else in this system. A base `places.json` has placed is a far one it can name, so it
  // is named as what it is — placed, with whatever a route quote from here says — nearest first.
  // ponytail: one find_route per placed base; cap the quotes if places.json grows large.
  const runtime=runtimeDir(),far:{base:string;jumps:number;quote:string}[]=[];
  for(const base of Object.keys(runtime?readPlaces(runtime):{}).filter(base=>base!==docked)) {
    const read=yield* Effect.result(game.command('spacemolt/find_route',{id:base}));
    // unquoted is still nameable
    if(Result.isFailure(read)) {far.push({base,jumps:Number.MAX_SAFE_INTEGER,quote:`no route quote (${words(read.failure)})`});continue;}
    const route=replyBody(read.success),found=Boolean(field(route,'found'));
    far.push({base,jumps:found?Number(field(route,'total_jumps')):Number.MAX_SAFE_INTEGER,
      quote:found?`${field(route,'estimated_fuel')} fuel, ${field(route,'total_jumps')} jump(s)`:'no route from here'});
  }
  for(const {base,quote} of far.sort((a,b)=>a.jumps-b.jumps).slice(0,3))
    out.push({call:`goTo('${base}')`,base,
      // No inspect: it is current-system only, so the call could only fail and break nothing usefully.
      why:`a base this pilot has placed: ${quote}; no price readable from here; unknown until docked`});
  return out;
});

/** The same advice as one line per row, which is the shape an Outcome's `next` takes. */
const asNext=(rows:Elsewhere[],system:string):string[]=>rows.length
  ?rows.map(row=>`${row.call} — ${row.why}`)
  :[`no other base in ${system}, and none placed: no station's service counter can be read from where you are`];

// The live body is not decoded: the server omits spec fields, so a strict decode would refuse real quotes.
// oxlint-disable-next-line typescript/consistent-type-assertions
export const asBase=(body:unknown)=>body as GetBaseResponse; // cast: frozen surface (GetBaseResponse)
/** Bring the ship up at the counter you are docked at: full tank and full hull.
 *
 * Over `refuel` + `repair` it adds: the quote read first, the mood's spend margin on the repair
 * (never the fuel: a mood must not strand a ship) and `permissions.credit_reserve` enforced, the charge checked against the quote, and the
 * post-state read to confirm the fill. A full ship sends nothing. Not docked: `refused`.
 *
 * A counter bills on credits and reports the charge afterwards, so a station that posts no
 * price still refuels and repairs: the posted price is only a pre-flight estimate, and the
 * reserve is held against the charge itself.
 *
 * A wallet short of the whole bill buys what it can — the fuel first, then the repair if it still
 * fits — and the call is `partial`, with what was not bought in `short` and `why`.
 *
 * Tired: resupplying back inside the margins is what clears it (the mood is derived from the
 * ship), and `cleared_tired` says so. `insure` and `dues` are accepted and
 * reported in `short` until a later slice implements them. */
export const serviceEffect=(opts:NonNullable<Parameters<typeof service>[0]>={})=>jobEffect<Serviced>('service',Object.keys(opts).join(' '),Effect.gen(function*() {
  const game=yield* Game;
  const who=pilot();
  const short:string[]=[];
  if(opts.insure)short.push('insure: not implemented yet; account().commands.spacemolt_salvage.quote/insure');
  if(opts.dues)short.push('dues: not implemented yet; account().commands.spacemolt.prepay_tax / pay_bounty');
  if(opts.fuel!==undefined||opts.hull!==undefined)short.push('partial targets: not implemented yet; a service is a full fill');
  // The surface promises a `GetBaseResponse`; a refusal before the quote has none to give.
  const empty:Serviced={base:asBase({}),issued:[],spent:0,short,cleared_tired:false};
  const found=yield* Effect.result(counterEffect());
  if(Result.isFailure(found)) {
    if(found.failure._tag==='DockBlocked')return {status:'failed',did:'service broke',why:found.failure.message,detail:empty};
    return yield* Effect.fail(found.failure);
  }
  const at=found.success;
  if('refused' in at)return {status:'refused',did:'serviced nothing',why:at.refused,detail:empty};
  const docked=at.docked;
  const quoted=yield* Effect.result(game.command('spacemolt/get_base',{}));
  if(Result.isFailure(quoted))return {status:'failed',did:`${docked} would not quote`,why:words(quoted.failure),detail:empty};
  const base=asBase(replyBody(quoted.success));
  // The quote above was a command, and a command is where Tired is imposed: the mood that
  // picks the spend margin is read here, not at the top of the job. Tired's row is "service
  // only" — the mood it replaced would refuse the very bill that clears it.
  const mood=pilot().mood??'Cautious';
  const system=()=>acct().state.location?.system_id??'this system';
  const served=yield* Effect.result(serviceShipEffect(acct(),{mood,creditReserve:who.permissions?.credit_reserve??0,
    ...runtimeDir()===undefined?{}:{runtime:runtimeDir()}}));
  if(Result.isFailure(served)) {
    const error=served.failure;
    if(error instanceof ServiceBlocked) {
      const blockers=[...error.blockers];
      const detail:Serviced={base,issued:[],spent:0,short:[...short,...blockers],cleared_tired:false};
      return {status:'refused',did:`not serviced at ${docked}`,why:blockers.join('; '),detail,
        next:[...asNext(yield* serviceElsewhereEffect(docked),system()),
          'a calmer bill, a bolder mood, or another station admits it']};
    }
    // The custody checks are not the game refusing: said as `job` always said a throw. A refusal or lost reply goes up, folded by name.
    if(error instanceof ServiceUnsafe)return {status:'failed',did:'service broke',why:error.message,detail:empty};
    return yield* error;
  }
  const done=served.success,cells=done.cells;
  const cleared=mood==='Tired'&&pilot().mood!=='Tired';
  const did=done.issued.length
    ?`serviced at ${docked}: ${done.issued.map(action=>action.split('/')[1]).join(' and ')} for ${done.spent} cr; fuel ${done.fuel}, hull ${done.hull}`
    :`already serviced at ${docked}: fuel ${done.fuel}, hull ${done.hull}`;
  const kept=cells?.target?`; fuel cells ${cells.held}/${cells.target}${cells.bought?` (bought ${cells.bought} for ${cells.spent} cr)`:''}${cells.skipped?`, none bought: ${cells.skipped.replace(/^fuel cells: /,'')}`:''}`:'';
  const detail:Serviced={base,issued:done.issued,spent:done.spent+(cells?.spent??0),short:[...short,...done.short??[]],cleared_tired:cleared};
  if(done.short)return {status:'partial',did:did+kept,why:done.short.join('; '),detail,
    next:asNext(yield* serviceElsewhereEffect(docked),system())};
  return {status:'done',did:did+kept,detail,next:cleared?['Tired cleared: the mood before it is back']:[]};
}));
export function service(opts:{fuel?:number;hull?:number;insure?:boolean;dues?:boolean|'all'}={}):Promise<Outcome<Serviced>> {return edge(serviceEffect(opts));}

/** Tired's guarantee, kept by the runtime and not left to the script: bring the ship back inside
 * its margins. Docked, service here; otherwise (or when this counter could not clear it) fly to
 * each base `serviceElsewhere` names and service there, until one clears it. `travel:false`
 * services only where the ship stands — a stopped flight does not fly off. Every attempt is
 * journalled as `resupply`, with what triggered it and the ship before and after. Away from a counter the fuel cells aboard are burned first
 * (`burnCells`), which may be all a fuel crossing needs.
 *
 * `cleared` when the ship is no longer Tired; `broke` when a counter was reached but the wallet
 * did not cover what clears it, so earning is the way out; `stranded` otherwise.
 *
 * ponytail: the bases are tried in `serviceElsewhere`'s order (this system first), not by route
 * cost, and a wallet refused here is still flown to the next counter. */
export const resupplyEffect=(opts:{travel?:boolean;trigger:Trigger})=>Effect.gen(function*() {
  const run=yield* Run;
  run.resupplying=true;
  return yield* resupplying(opts).pipe(Effect.ensuring(Effect.sync(()=>{run.resupplying=false;})));
});
type Trigger='dock'|'arrival'|'call'|'run_end';
const resupplying=({travel,trigger}:{travel?:boolean;trigger:Trigger})=>Effect.gen(function*() {
  const tired=()=>pilot().mood==='Tired';
  const ship=()=>acct().state.ship,started=Date.now(),before={fuel_before:ship()?.fuel??null,hull_before:ship()?.hull??null};
  yield* burnCells;
  if(!tired())return 'cleared' as const;
  let broke=false;
  const runtime=runtimeDir(),tired_by=pilot().tired_by;
  const log=(entry:Record<string,unknown>)=>{if(runtime)journalRun(runtime,{trigger,tired_by,...before,
    fuel_after:ship()?.fuel??null,hull_after:ship()?.hull??null,seconds:Math.round((Date.now()-started)/100)/10,...entry},'resupply');};
  line(`tired (${tired_by}): the flight computer is bringing the ship up`);
  const at=(base:string)=>Effect.gen(function*() {
    const done=yield* serviceEffect();
    log({base,status:done.status,spent:done.detail.spent,issued:done.detail.issued,cleared:!tired(),...done.why?{why:done.why}:{}});
    if(done.status==='refused'||done.status==='partial')broke=true;
    return !tired();
  });
  const docked=acct().state.location?.docked_at??undefined;
  if(docked&&(yield* at(docked)))return 'cleared' as const;
  const failed=():'broke'|'stranded'=>{
    if(broke)return 'broke';
    // Its own event, beside the `resupply` lines: the one outcome that leaves the ship stuck.
    const {ship,location}=acct().state;
    if(runtime)journalRun(runtime,{tired_by,fuel:ship?.fuel??null,hull:ship?.hull??null,system:location?.system_id??null,
      poi:location?.poi_id??null,docked_at:location?.docked_at??null},'stranded');
    return 'stranded';
  };
  if(travel===false) {
    log({cleared:false,why:trigger==='run_end'?'the run is stopping: no flight to another counter':'serviced in place: inside a helper, flying off would leave it at the wrong counter'});
    return failed();
  }
  for(const row of yield* serviceElsewhereEffect(docked)) {
    if(stopped())break;
    const trip=yield* goToEffect(row.base);
    if(trip.status==='done'&&trip.detail.docked) {
      if(yield* at(row.base))return 'cleared' as const;
    } else log({base:row.base,cleared:false,why:`did not reach it: ${trip.why??trip.did}`});
  }
  log({cleared:false,stranded:!broke,why:broke?'no counter reached had anything the wallet covers':'no base the flight computer knows was reached and serviced'});
  line(`still tired (${pilot().tired_by}): ${broke?'the wallet covers nothing at the counters reached':'no base the flight computer knows was reached and serviced'}`);
  return failed();
});

/** Tired's guarantee wherever the ship stops: a dock, a goTo's arrival, or a call `main()` made
 * itself (`admit`). Docked, service here. Flying to another counter is only for the program's
 * own call (depth 1): inside a helper it would leave the helper at the wrong counter. Never a
 * refusal: the act that docked or arrived reports as it would, and the top-level call's `did` names
 * the resupply. The resupply's own docks and arrivals start none, and a system it flew out of to
 * no counter is not flown out of again this flight (one `stranded` line, not one per call). */
export const tiredCheck=(trigger:'dock'|'arrival'|'call'):Effect.Effect<void,never,Game|Run>=>Effect.gen(function*() {
  const run=yield* Run;
  if(run.resupplying||pilot().mood!=='Tired')return;
  const {location,ship}=acct().state,system=location?.system_id;
  const travel=trigger!=='dock'&&run.depth<=1&&run.strandedIn!==system;
  if(!travel&&!location?.docked_at)return;
  const tired_by=pilot().tired_by,fuel=ship?.fuel,hull=ship?.hull;
  const out=yield* resupplyEffect({travel,trigger});
  run.short=out==='cleared'?undefined:out;
  if(travel&&out==='stranded')run.strandedIn=system;
  const now=acct().state;
  run.resupplied.push(`Tired (${tired_by}) ${trigger==='arrival'?'on arrival':`at a ${trigger}`}: ${out==='cleared'?'resupplied':out==='broke'?'resupply unaffordable':'no counter reached'}`
    +` at ${now.location?.docked_at??now.location?.poi_id??'?'}, fuel ${fuel} → ${now.ship?.fuel}, hull ${hull} → ${now.ship?.hull}`);
});
