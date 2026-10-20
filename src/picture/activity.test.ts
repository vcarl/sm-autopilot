/** Replaying the window into visits, intervals and legs (`activity.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {markPlace} from '../play/places.ts';
import {journalRun} from '../run-record.ts';
import {replay} from './activity.ts';
import {readWindow} from './window.ts';

const runtime=()=>{const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-activity-')),'runtime');mkdirSync(dir,{recursive:true});return dir;};
const at=(h:number,m=0)=>`2026-10-16T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`;
const start=(dir:string,run_id:string,h:number,system:string)=>journalRun(dir,{phase:'started',run_id,at:at(h),started:at(h),start_state:{system}},'run');
const end=(dir:string,run_id:string,h:number,system:string)=>journalRun(dir,{phase:'ended',run_id,started:at(h),at:at(h,59),outcome:'done',end_state:{system}},'run');
const cmd=(dir:string,run_id:string,when:string,action:string,params:Record<string,string>={})=>
  journalRun(dir,{run_id,at:when,tool:'spacemolt',action,params,ok:true,summary:'x'},'command');

test('replay attributes counts to the system current at the time',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    cmd(dir,'r1',at(1,10),'dock');
    cmd(dir,'r1',at(1,20),'jump',{id:'b'});
    journalRun(dir,{run_id:'r1',at:at(1,30),push:'battle_ended'},'push');
    end(dir,'r1',1,'b');
    const got=replay(readWindow(dir),dir);
    assert.deepEqual(got.visits.map(v=>[v.system,v.order,v.counts.docked,v.counts.fights]),[['a',1,1,0],['b',2,0,1]]);
    assert.deepEqual(got.intervals.map(i=>i.system),['a','b']);
    assert.deepEqual(got.legs,[{a:'a',b:'b',trips:1,focus:true}]);
    assert.deepEqual(got.heaviest,{a:'a',b:'b',trips:1,focus:true});
    assert.deepEqual(got.events.map(e=>[e.system,e.kind,e.count]),[['a','docked',1],['b','fights',1]]);
    assert.deepEqual(got.current,{system:'b'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('replay sorts intervals and skips lines without at',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    cmd(dir,'r1',at(1,30),'jump',{id:'b'});
    cmd(dir,'r1',at(1,10),'jump',{id:'c'});
    cmd(dir,'r1','','jump',{id:'d'});
    end(dir,'r1',1,'b');
    const got=replay(readWindow(dir),dir);
    assert.ok(!got.visits.some(v=>v.system==='d'));
    assert.ok(got.intervals.every((i,n)=>n===0||+got.intervals[n-1]!.start<=+i.start));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('replay with no jumps yields one interval per run, merged when the system repeats',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');end(dir,'r1',1,'a');
    start(dir,'r2',2,'a');end(dir,'r2',2,'a');
    start(dir,'r3',3,'b');end(dir,'r3',3,'b');
    const got=replay(readWindow(dir),dir);
    assert.deepEqual(got.intervals.map(i=>[i.system,i.start.toISOString(),i.end.toISOString()]),
      [['a',at(1),at(2,59)],['b',at(3),at(3,59)]]);
    assert.deepEqual(got.legs,[]);
    assert.equal(got.heaviest,undefined);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('creatures come from sightings mapped through travel-learned POIs',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    cmd(dir,'r1',at(1,10),'travel',{id:'p'});
    end(dir,'r1',1,'a');
    writeFileSync(join(dir,'sightings.json'),JSON.stringify({sightings:[
      {poi_id:'p',species:'veil_ray',count:3,legal:3,at:at(1,20)},
      {poi_id:'p',species:'veil_ray',count:9,legal:9,at:at(0,20)},
      {poi_id:'p',species:'drone',count:1,legal:1,at:at(1,20)},
      {poi_id:'p',count:0,legal:0,at:at(1,20)},
      {poi_id:'elsewhere',species:'veil_ray',count:5,legal:5,at:at(1,20)}]}));
    const got=replay(readWindow(dir),dir);
    assert.equal(got.visits.find(v=>v.system==='a')?.counts.creatures,4);
    assert.deepEqual(got.events.filter(e=>e.kind==='creatures').map(e=>[e.at.toISOString(),e.system,e.count]),
      [[at(1,20),'a',3],[at(1,20),'a',1]]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a death is a mark on the system it happened in, and what follows belongs to the respawn base\'s system',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    markPlace(dir,'base1','b');
    journalRun(dir,{run_id:'r1',at:at(1,10),ship_lost:'Cobble',respawn_base:'base1'},'death');
    cmd(dir,'r1',at(1,20),'dock');
    journalRun(dir,{run_id:'r1',at:at(1,30),system:'b',tired_by:'fuel'},'stranded');
    journalRun(dir,{run_id:'r1',at:at(1,40),system:'nowhere'},'stranded'); // a system the pilot never was in falls back to where it is
    end(dir,'r1',1,'b');
    const got=replay(readWindow(dir),dir);
    assert.deepEqual(got.visits.map(v=>[v.system,v.counts.docked,v.marks]),[['a',0,{deaths:1,stranded:0}],['b',1,{deaths:0,stranded:2}]]);
    assert.deepEqual(got.intervals.map(i=>[i.system,i.start.toISOString()]),[['a',at(1)],['b',at(1,10)]]);
    assert.deepEqual(got.legs,[]); // a respawn is not a jump
    assert.deepEqual(got.events.map(e=>[e.system,e.kind]),[['b','docked']]); // marks are not activity kinds
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a death whose base is not placed stays where it was; marks start at zero',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    journalRun(dir,{run_id:'r1',at:at(1,10),respawn_base:'unplaced'},'death');
    cmd(dir,'r1',at(1,20),'dock');
    const got=replay(readWindow(dir),dir);
    assert.deepEqual(got.visits.map(v=>[v.system,v.counts.docked,v.marks]),[['a',1,{deaths:1,stranded:0}]]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('current falls back to where the replay ended when the last run has no end_state',()=>{
  const dir=runtime();
  try{
    start(dir,'r1',1,'a');
    cmd(dir,'r1',at(1,10),'jump',{id:'b'});
    assert.deepEqual(replay(readWindow(dir),dir).current,{system:'b'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
