/** What a person reads: one line per thing that happened, and nothing for the noise. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {LINE_CHARS,renderLine} from './journal-lines.ts';

const AT='2026-09-15T18:35:00.000Z';
const line=(entry:Record<string,unknown>)=>renderLine({at:AT,...entry});

test('every kind of entry renders one short line carrying its numbers', () => {
  const rendered:[Record<string,unknown>,RegExp][]=[
    [{event:'run',phase:'started',script:'gather',params:{poi_id:'colony_debris_field'}},
      /run gather → colony_debris_field/],
    [{event:'run',phase:'ended',script:'gather',outcome:'done',
      jobs:[{job:'gather',outcome:'done',yield:[{item_id:'carbon_ore',quantity:61}]}]},
      /gather done: \+61 carbon_ore/],
    [{event:'step',job:'gather',step:'mine',outcome:'done',
      yield:[{item_id:'carbon_ore',quantity:61},{item_id:'iron_ore',quantity:59}]},
      /gather mine \+61 carbon_ore \+59 iron_ore/],
    [{event:'step',job:'hunt',step:'fight 2',outcome:'blocked',species:'drifter',reason:'broke off'},
      /hunt fight 2 blocked: broke off/],
    [{event:'step',job:'craft',step:'confirm',outcome:'done',recipe_id:'fuse_reinforced_glass',
      yield:[{item_id:'reinforced_glass',quantity:5}]},/craft confirm .*\+5 reinforced_glass/],
    [{event:'rest',home:'first_step_memorial_station'},/rest at first_step_memorial_station/],
    [{event:'reflection',stance:'Industrialist',mood:'Cautious',goal:'two loads of ore'},
      /reflection: Industrialist\/Cautious — two loads of ore/],
    [{event:'instruction',text:'go look at the far belt'},/instruction: "go look at the far belt"/],
    [{event:'unsolicited_move',cause:'towed',evidence:'docked at outpost'},/moved \(towed\)/],
    [{event:'command',tool:'spacemolt',action:'mine',ok:false,summary:'cargo hold is full'},
      /! spacemolt\/mine: cargo hold is full/],
    [{event:'request',request:{action:'travel'},response:{ok:false,error:'no route to belt'}},
      /! travel: no route to belt/],
  ];
  for(const [entry,shape] of rendered) {
    const text=line(entry);
    assert.ok(text,`${JSON.stringify(entry)} renders nothing`);
    assert.match(text!,shape);
    assert.ok(text!.length<=LINE_CHARS,`${text!.length} characters: ${text}`);
    assert.match(text!,/^\d\d:\d\d /,'every line is stamped with the hour it happened');
  }
});

test('the noise renders nothing at all', () => {
  assert.equal(line({event:'request',request:{action:'status'},response:{ok:true,result:{running:false}}}),null);
  assert.equal(line({event:'request',request:{action:'where'},response:{ok:true,result:{bytes:4000}}}),null);
  assert.equal(line({event:'command',tool:'spacemolt',action:'get_system',ok:true,summary:'normal'}),null,
    'a command that took is already inside the step line above it');
  assert.equal(line({event:'run',phase:'progress',script:'gather'}),null);
  assert.equal(renderLine(null),null);
  assert.equal(renderLine({at:AT,event:'something nobody writes'}),null);
});

test('a long reason is cut, never wrapped, and a torn stamp still renders', () => {
  const long=line({event:'step',job:'gather',step:'settle',outcome:'failed',
    reason:'x'.repeat(400)})!;
  assert.equal(long.length,LINE_CHARS);
  assert.ok(long.endsWith('…'));
  assert.match(renderLine({at:'not a date',event:'rest'})!,/^--:-- rest/);
});

test('a step with many rows names three and counts the rest', () => {
  const text=line({event:'step',job:'stow',step:'deposit',outcome:'done',base_id:'sol_base',
    yield:[{item_id:'a',quantity:1},{item_id:'b',quantity:2},{item_id:'c',quantity:3},
      {item_id:'d',quantity:4},{item_id:'e',quantity:5}]})!;
  assert.match(text,/@ sol_base \+1 a \+2 b \+3 c \+2 more/);
});
