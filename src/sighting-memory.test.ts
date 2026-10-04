/** What the sighting memory has to be true for: a look that found prey, a look that found
 * none, and the difference between "there is nothing there" and "we no longer know". The clock
 * is an argument in every case — an age test that sleeps is a flaky test. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ABSENCE_STALE,CAP,PRESENCE_STALE,TICK_MS,readSightings,recall,writeLook,
  type Sighting} from './sighting-memory.ts';

const temp=()=>mkdtempSync(join(tmpdir(),'spacemolt-sightings-'));
const ago=(ticks:number,now:number)=>new Date(now-ticks*TICK_MS).toISOString();
/** A row as a look would have written it, but stamped by hand so the age is the test's. */
const row=(poi_id:string,species:string|undefined,count:number,at:string):Sighting=>
  ({poi_id,...species?{species}:{},count,legal:count,at});

test('a look written is a look read back, newest first',()=>{
  const dir=temp();
  try {
    writeLook(dir,{poi_id:'poi-a',seen:[{species:'belt_grazer',count:3,legal:2}]});
    writeLook(dir,{poi_id:'poi-b',seen:[{species:'slag_tortoise',count:1,legal:1}]});
    const rows=readSightings(dir);
    assert.equal(rows.length,2);
    assert.equal(rows[0]!.poi_id,'poi-b','the newest look leads');
    assert.ok(rows.every(one=>Date.parse(one.at)>0),'every row carries a parseable stamp');
    const grazer=rows.find(one=>one.species==='belt_grazer');
    assert.equal(grazer?.count,3);
    assert.equal(grazer?.legal,2,'legal is kept apart from count');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an absent or torn store is no memory, not a crash',()=>{
  const dir=temp();
  try {
    assert.deepEqual(readSightings(dir),[],'nothing written yet is nothing remembered');
    assert.deepEqual(readSightings(undefined),[],'no runtime dir is no memory');
    writeFileSync(join(dir,'sightings.json'),'{"sightings":[{"poi_id"');
    assert.deepEqual(readSightings(dir),[],'a half-written file reads as empty');
    writeFileSync(join(dir,'sightings.json'),'{"sightings":[{"count":1},{"poi_id":"poi-a","count":1,"legal":1,"at":"x"}]}');
    assert.equal(readSightings(dir).length,1,'a row without a POI is not a sighting');
    writeFileSync(join(dir,'sightings.json'),'{"sightings":[{"poi_id":"poi-b","count":1,"at":"x"},{"poi_id":"poi-a","count":1,"legal":1,"at":"x"}]}');
    assert.deepEqual(readSightings(dir).map(row=>row.poi_id),['poi-a'],'a row without a legal count is not a sighting');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the cap evicts the oldest look, not the newest',()=>{
  const dir=temp();
  try {
    for(let i=0;i<CAP+5;i+=1)writeLook(dir,{poi_id:`poi-${i}`,seen:[{species:'belt_grazer',count:1,legal:1}]});
    const rows=readSightings(dir);
    assert.equal(rows.length,CAP,'the store stays bounded');
    assert.equal(rows[0]!.poi_id,`poi-${CAP+4}`,'the last look survives');
    assert.ok(!rows.some(one=>one.poi_id==='poi-0'),'the first look is gone');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a stale absence reads as unknown, never as nothing there',()=>{
  const now=Date.parse('2026-09-25T12:00:00Z');
  const fresh=recall([row('poi-a',undefined,0,ago(1,now))],'poi-a','belt_grazer',now);
  assert.equal(fresh.state,'seen','a look a tick ago is still an answer');
  assert.equal(fresh.state==='seen'&&fresh.count,0,'and the answer is that there was nothing');

  // An absolute age, not `ABSENCE_STALE+1`: a bound expressed in terms of itself would hold for
  // any bound at all, including one so wide that nothing ever expires. An absence a day old must
  // not be an answer whatever the constant says, and the bound must be tighter than a presence's.
  assert.ok(Number.isFinite(ABSENCE_STALE)&&ABSENCE_STALE<PRESENCE_STALE,'absences expire, and sooner');
  const day=recall([row('poi-a',undefined,0,ago(8640,now))],'poi-a','belt_grazer',now);
  assert.notEqual(day.state,'seen','a day-old absence is not a current answer');

  const stale=recall([row('poi-a',undefined,0,ago(ABSENCE_STALE+1,now))],'poi-a','belt_grazer',now);
  assert.notEqual(stale.state,'seen','an aged absence is not a current answer');
  assert.equal(stale.state,'stale');
  assert.ok(!('count' in stale),'a stale row hands back no count to misread as zero prey');

  const unstamped=recall([row('poi-a',undefined,0,'not a date')],'poi-a','belt_grazer',now);
  assert.notEqual(unstamped.state,'seen','an unstamped absence must not read as fresh');
  const unlooked=recall([],'poi-a','belt_grazer',now);
  assert.equal(unlooked.state,'unlooked','never looked is its own state, not a stale one');
});

test('a fresh sighting and a stale sighting are different answers',()=>{
  const now=Date.parse('2026-09-25T12:00:00Z');
  const rows=[row('poi-a','belt_grazer',4,ago(2,now)),row('poi-b','belt_grazer',9,ago(PRESENCE_STALE+10,now))];
  const here=recall(rows,'poi-a','belt_grazer',now),there=recall(rows,'poi-b','belt_grazer',now);
  assert.equal(here.state,'seen');
  assert.equal(here.state==='seen'&&here.count,4);
  assert.equal(there.state,'stale','a presence old enough is knowledge, not a recommendation');
  assert.ok(here.ticks_old<there.ticks_old,'age grows with the clock');
});

test('a look that saw one species is a known absence of every other',()=>{
  // `get_nearby` lists everything present at a POI — there is no per-species query — so a look
  // that came back with four belt_grazers and nothing else established that there were no slag
  // tortoises there. Reading that as `unlooked` throws away the more useful half of the look and
  // makes "we looked and it wasn't there" indistinguishable from "nobody has ever been".
  const now=Date.parse('2026-09-25T12:00:00Z');
  const fresh=recall([row('poi-a','belt_grazer',4,ago(2,now))],'poi-a','slag_tortoise',now);
  assert.equal(fresh.state,'seen','the POI was looked at, so there is an answer about the tortoise');
  assert.equal(fresh.state==='seen'&&fresh.count,0,'and the answer is none');

  // And it ages as strictly as any other absence: the bound that governs it is the absence bound,
  // not the presence bound, even though the look that recorded it did see something.
  const aged=recall([row('poi-a','belt_grazer',4,ago(ABSENCE_STALE+1,now))],'poi-a','slag_tortoise',now);
  assert.equal(aged.state,'stale','an absence this old is no longer an answer, whatever else the look saw');
  // The same row, asked about what it DID see, is still a presence: the two bounds are per
  // question, not per row.
  assert.equal(recall([row('poi-a','belt_grazer',4,ago(ABSENCE_STALE+1,now))],'poi-a','belt_grazer',now).state,'seen');
});

test('a fresh look at a POI replaces what was remembered there',()=>{
  const dir=temp();
  try {
    writeLook(dir,{poi_id:'poi-a',seen:[{species:'belt_grazer',count:5,legal:5}]});
    writeLook(dir,{poi_id:'poi-a',seen:[]});
    const rows=readSightings(dir);
    assert.equal(rows.filter(one=>one.poi_id==='poi-a').length,1,'the older look is superseded');
    const answer=recall(rows,'poi-a','belt_grazer');
    assert.equal(answer.state,'seen');
    assert.equal(answer.state==='seen'&&answer.count,0,'the emptier, newer look is the one believed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
