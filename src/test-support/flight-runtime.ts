/** A runtime dir holding one juncture's flight in the journal alone (no frames): two runs of context (a dock at sol and a jump to
 * rigel, then a quiet run back at sol), then the juncture's run, three mines at sol and, an hour on, a jump to vega. Moment 1 is the mining (the majority), moment 2 the jump (another category). */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalRun} from '../run-record.ts';

export const FLIGHT_RUN='f1a9c0de-0000-4000-8000-000000000001',FLIGHT_JUNCTURE='0d8e53df1e6a458c81130fae3d184dd6';
const T0=Date.parse('2026-10-19T08:00:00.000Z'),iso=(min:number)=>new Date(T0+min*60_000).toISOString();
const state=(system:string)=>({system,poi:`${system}_belt`,docked_at:null,credits:1000,fuel:90,max_fuel:100,hull:80,max_hull:80,cargo_used:4,cargo_capacity:50,cargo:[]});

export function flightRuntime(opts:{idle?:boolean}={}):string {
  const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-flight-')),'runtime');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'galaxy.json'),JSON.stringify({fetched_at:new Date().toISOString(),systems:{
    sol:{id:'sol',name:'Sol',x:0,y:0,connections:['vega','rigel']},vega:{id:'vega',name:'Vega',x:10,y:5,connections:['sol']},
    rigel:{id:'rigel',name:'Rigel',x:-8,y:6,connections:['sol']}}}));
  const run=(id:string,juncture:string,from:number,to:number,acts:(()=>void)|null,end=state('sol'))=>{
    journalRun(dir,{at:iso(from),phase:'started',run_id:id,started:iso(from),mood:'Focused',juncture_id:juncture,start_state:state('sol')},'run');
    acts?.();
    journalRun(dir,{at:iso(to),phase:'ended',run_id:id,outcome:'done',work:{fn:'gatherUntil',status:'done',credits:0,items:3,xp:5},end_state:end,calls:[]},'run');
  };
  const cmd=(id:string,min:number,action:string,params:Record<string,unknown>={})=>
    journalRun(dir,{at:iso(min),run_id:id,tool:'spacemolt',action,params,ok:true,summary:action},'command');
  const C1='c0000000-0000-4000-8000-000000000001';
  run(C1,'a0000000000000000000000000000001',0,20,()=>{cmd(C1,10,'dock');cmd(C1,15,'jump',{id:'rigel'});},state('rigel'));
  run('c0000000-0000-4000-8000-000000000002','a0000000000000000000000000000002',25,40,null);
  run(FLIGHT_RUN,FLIGHT_JUNCTURE,45,130,opts.idle?null:()=>{
    for(const m of [50,52,54])cmd(FLIGHT_RUN,m,'mine');
    cmd(FLIGHT_RUN,120,'jump',{id:'vega'});
  },opts.idle?state('sol'):state('vega'));
  return dir;
}
