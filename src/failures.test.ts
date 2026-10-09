/** The pilot's last five distinct failures (`failures.ts`), and their block in the juncture context. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderContext} from './context.ts';
import {KEPT,failuresOf,noteFailures,normalize,readFailures} from './failures.ts';
import {journalRun,watchJournal} from './run-record.ts';

const runtime=()=>{const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-failures-')),'runtime');mkdirSync(dir,{recursive:true});return dir;};
const command=(tool:string,action:string,summary:string,more:Record<string,unknown>={})=>
  ({event:'command',tool,action,params:{},ok:false,summary,...more});

test('identifiers and numbers do not make a failure new', () => {
  // Live kvothe 10-08: the same refusals, a different item or level each time.
  assert.equal(normalize("Unknown item 'pirate_bounty_chip'. Use exact item ID (e.g. 'iron_ore')"),
    normalize("Unknown item 'steel_plate'. Use exact item ID (e.g. 'iron_ore')"));
  assert.equal(normalize('Flying a Tier 3 ship requires Piloting level 20 (you have 13).'),
    normalize('Flying a Tier 2 ship requires Piloting level 10 (you have 4).'));
  assert.equal(normalize('docking refused at c18bc91c2d6c27e59f56c32bd24fdd3b'),'docking refused at #');
  assert.notEqual(normalize('Access denied'),normalize('Target system not found'));
});

test('a repeat counts and moves first; five are kept, the newest', () => {
  const dir=runtime();
  noteFailures(dir,{at:'2026-10-06T14:02:00Z',...command('spacemolt_market','estimate_purchase',"Unknown item 'pirate_bounty_chip'. Use exact item ID",{params:{item_id:'pirate_bounty_chip'}})});
  noteFailures(dir,{at:'2026-10-06T15:00:00Z',...command('spacemolt','dock','Access denied')});
  noteFailures(dir,{at:'2026-10-07T09:00:00Z',...command('spacemolt_market','estimate_purchase',"Unknown item 'gold_bar'. Use exact item ID",{params:{item_id:'gold_bar'}})});
  let kept=readFailures(dir);
  assert.equal(kept.length,2);
  assert.deepEqual({...kept[0],key:undefined},{key:undefined,command:'spacemolt_market/estimate_purchase item_id=gold_bar',
    text:"Unknown item 'gold_bar'. Use exact item ID",first_at:'2026-10-06T14:02:00Z',last_at:'2026-10-07T09:00:00Z',count:2});
  // The same words from another command are another failure: the key is the command's name and the words.
  noteFailures(dir,{at:'2026-10-07T10:00:00Z',...command('spacemolt','undock','Access denied')});
  for(let n=0;n<KEPT-1;n++)noteFailures(dir,{at:new Date(Date.parse('2026-10-07T11:00:00Z')+n*60_000).toISOString(),event:'defect',fn:`job${n}`,why:'boom'});
  kept=readFailures(dir);
  assert.equal(kept.length,KEPT);
  assert.deepEqual([kept[0]?.command,kept.at(-1)?.command],[`job${KEPT-2}`,'spacemolt/undock']);
});

test('connection noise, the runtime\'s own sends and freighters are not the pilot\'s failures', () => {
  for(const line of [command('spacemolt_battle','status','No active battle. Use attack to engage a target.'),
    command('spacemolt_battle','stance','You are not in a battle. Use attack to engage a target.'),
    command('spacemolt_intel','submit_trade_intel','nope'),
    command('spacemolt','mine','WebSocket connection closed',{code:1006}),
    command('spacemolt','travel','account is reconnecting',{lost:true}),
    command('spacemolt','find_route','No response',{code:'connect_timeout'}),
    command('spacemolt','sell','cannot send: not connected'),
    command('spacemolt','sell','Sent before connected'),
    command('spacemolt','dock','Access denied',{freighter:'hauler'}),
    {event:'command',tool:'spacemolt',action:'dock',ok:true,summary:'docked'}])
    assert.deepEqual(failuresOf(line),[],JSON.stringify(line));
});

test('a run\'s refused and failed calls, a refused check and a defect are failures', () => {
  assert.deepEqual(failuresOf({event:'run',phase:'ended',calls:[{fn:'goTo',arg:'x',status:'done'},
    {fn:'buy',arg:'10',status:'refused',did:'did not buy steel_plate',why:'steel_plate costs 201 for 10 here'},
    {fn:'stow',arg:'',status:'failed',did:'stow nothing'}]}),
  [{name:'buy',command:'buy(10)',text:'steel_plate costs 201 for 10 here',gist:'did not buy steel_plate'},
    {name:'stow',command:'stow()',text:'stow nothing',gist:'stow nothing'}]);
  assert.deepEqual(failuresOf({event:'run',phase:'refused',script:'index.ts',errors:['tsc: pilot/index.ts(4,83): error TS2339: no length\n    4 | x']}),
    [{name:'check',command:'check index.ts',text:'tsc: pilot/index.ts(4,83): error TS2339: no length'}]);
  assert.deepEqual(failuresOf({event:'defect',fn:'goTo',why:'Cannot read properties of undefined'}),
    [{name:'goTo',command:'goTo',text:'Cannot read properties of undefined'}]);
});

test('a call is keyed on its did, not the particulars its why names', () => {
  // Live kvothe: 150 completeMissions refusals, each why naming the missions then held.
  const dir=runtime(),refused=(why:string,did:string)=>({event:'run',phase:'ended',calls:[{fn:'completeMissions',arg:'',status:'refused',did,why}]});
  noteFailures(dir,{at:'2026-10-07T09:00:00Z',...refused('First Haul: 0 of 1','nothing completable; 3 remain, 2 slot(s) free')});
  noteFailures(dir,{at:'2026-10-07T10:00:00Z',...refused('Leviathan Bounty: 0 of 1','nothing completable; 4 remain, 1 slot(s) free. First Haul: Sell 1 wreck')});
  assert.deepEqual(readFailures(dir).map(row=>[row.count,row.text]),[[2,'Leviathan Bounty: 0 of 1']]);
});

test('the bridge keeps them as the journal is written', () => {
  const dir=runtime(),unwatch=watchJournal(entry=>noteFailures(dir,entry));
  try {journalRun(dir,command('spacemolt','dock','Access denied'),'command');} finally {unwatch();}
  assert.equal(readFailures(dir)[0]?.command,'spacemolt/dock');
});

test('the context shows them before the recent flights, newest first', () => {
  const dir=runtime();
  noteFailures(dir,{at:'2026-10-06T14:02:00Z',event:'run',phase:'ended',calls:[{fn:'buy',arg:'10',status:'refused',why:'steel_plate costs 201 for 10 here'}]});
  noteFailures(dir,{at:'2026-10-08T10:00:00Z',event:'run',phase:'ended',calls:[{fn:'buy',arg:'5',status:'refused',why:'steel_plate costs 99 for 5 here'}]});
  noteFailures(dir,{at:'2026-10-08T11:30:00Z',...command('spacemolt_ship','commission_quote','Flying a Tier 3 ship requires Piloting level 20 (you have 13).')});
  const text=renderContext({now:'2026-10-08T12:00:00.000Z',stance:'Trader',present:{system:'sol',docked_at:'base'}},dir);
  assert.match(text,/Failures you have hit \(newest first, repeats counted once\):\n {2}spacemolt_ship\/commission_quote — Flying a Tier 3 ship requires Piloting level 20 \(you have 13\)\. — once, 30m ago\.\n {2}buy\(5\) — steel_plate costs 99 for 5 here — 2×, last 2h ago, first 10-06 14:02Z\.\nYour recent flights/);
  assert.ok(!renderContext({now:'2026-10-08T12:00:00.000Z'},runtime()).includes('Failures you have hit'));
});
