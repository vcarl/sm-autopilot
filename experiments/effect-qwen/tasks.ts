// The tasks the model is asked to write, each with scenarios the script is run against.
import type {World} from './lib/core.ts';

export type Result = {ok: boolean; tag?: string; value?: unknown; message?: string};
export type Scenario = {name: string; world: Partial<World>; check: (w: World, r: Result) => string | null};
export type Task = {id: string; concept: string; prompt: string; scenarios: Scenario[]};

const held = (w: World, item: string) => w.cargo.find(c => c.item_id === item)?.quantity ?? 0;
const count = (w: World, prefix: string) => w.calls.filter(c => c.startsWith(prefix)).length;
const all = (...xs: (string | false)[]) => xs.find(x => typeof x === 'string') ?? null;
const at = (w: World, poi: string) => w.poi !== poi && `ended at ${w.poi}, not ${poi}`;
const undocked = {docked: false};

export const tasks: Task[] = [
  {id: 't1_sequence', concept: 'sequencing',
    prompt: 'You are docked at sol_base. Fly to sol_belt, mine three times, fly back to sol_base, sell all the iron_ore you hold, then service the ship.',
    scenarios: [{name: 'plain', world: {}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'sol_station'),
      w.mines !== 3 && `mined ${w.mines} times`, held(w, 'iron_ore') > 0 && 'iron_ore left aboard',
      w.fuel !== 100 && 'not serviced', w.credits !== 730 && `credits ${w.credits}, want 730`)}]},

  {id: 't2_catch_tag', concept: 'branch on a typed error',
    prompt: 'Go to kepler_base. If goTo fails because the ship is in battle (InBattle), disengage and try goTo once more. If it fails for any other reason, note the error\'s tag and finish without failing.',
    scenarios: [
      {name: 'in_battle', world: {battle: 'pirate_raider'}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'kepler_station'), w.battle !== null && 'still in battle')},
      {name: 'plain', world: {}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'kepler_station'))},
      {name: 'no_fuel', world: {fuel: 3}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, !w.notes.some(n => /NoFuel/.test(n)) && `no note naming NoFuel: ${JSON.stringify(w.notes)}`)},
    ]},

  {id: 't3_retry', concept: 'retry with backoff (Schedule)',
    prompt: 'Go to sol_belt. goTo sometimes fails with ServerBusy, which is transient. Retry only on ServerBusy, with exponential backoff starting at 1 second, at most 5 retries (6 attempts in all). Any other error must not be retried: let it fail the program.',
    scenarios: [
      {name: 'busy_twice', world: {busy: 2}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'sol_belt'), w.slept <= 0 && 'no backoff slept', count(w, 'goTo') !== 3 && `${count(w, 'goTo')} attempts, want 3`)},
      {name: 'busy_forever', world: {busy: 99}, check: (w, r) => all(r.ok && 'succeeded; should fail', r.tag !== 'ServerBusy' && `failed ${r.tag}, want ServerBusy`, count(w, 'goTo') !== 6 && `${count(w, 'goTo')} attempts, want 6`)},
      {name: 'in_battle', world: {battle: 'pirate_raider'}, check: (w, r) => all(r.ok && 'succeeded; should fail', r.tag !== 'InBattle' && `failed ${r.tag}, want InBattle`, count(w, 'goTo') !== 1 && `${count(w, 'goTo')} attempts, want 1`)},
    ]},

  {id: 't4_until_full', concept: 'loop until a typed error, then act',
    prompt: 'You are at sol_belt (undocked). Mine repeatedly until the hold is full (mine fails with HoldFull), then go to sol_base and sell everything in the hold, every item.',
    scenarios: [
      {name: 'empty_hold', world: {poi: 'sol_belt', ...undocked}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'sol_station'), w.cargo.length > 0 && `cargo left ${JSON.stringify(w.cargo)}`, w.credits !== 900 && `credits ${w.credits}, want 900`)},
      {name: 'part_full', world: {poi: 'sol_belt', ...undocked, cargo: [{item_id: 'copper_ore', quantity: 30}]}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.cargo.length > 0 && `cargo left ${JSON.stringify(w.cargo)}`, w.credits !== 1020 && `credits ${w.credits}, want 1020`)},
    ]},

  {id: 't5_salvage', concept: 'distinguish empty / refused / full',
    prompt: 'You are at sol_debris (undocked). Salvage the wrecks here. If there is no wreck (NoWreck), note "no wreck" and finish without failing. If the ship is in battle (InBattle), disengage and salvage again. If the hold is full (HoldFull), go to sol_base, sell everything in the hold, come back to sol_debris and salvage again.',
    scenarios: [
      {name: 'wreck', world: {poi: 'sol_debris', ...undocked}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, held(w, 'scrap') !== 20 && `scrap ${held(w, 'scrap')}, want 20`)},
      {name: 'no_wreck', world: {poi: 'sol_debris', ...undocked, wrecks: {}}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, !w.notes.some(n => /no wreck/i.test(n)) && 'no "no wreck" note')},
      {name: 'in_battle', world: {poi: 'sol_debris', ...undocked, battle: 'pirate_raider'}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.battle !== null && 'still in battle', held(w, 'scrap') !== 20 && `scrap ${held(w, 'scrap')}, want 20`)},
      {name: 'hold_full', world: {poi: 'sol_debris', ...undocked, cargo: [{item_id: 'iron_ore', quantity: 50}]}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'sol_debris'), held(w, 'iron_ore') > 0 && 'iron_ore not sold', held(w, 'scrap') !== 20 && `scrap ${held(w, 'scrap')}, want 20`)},
    ]},

  {id: 't6_finalizer', concept: 'finalizer (always disengage)',
    prompt: 'Fly to sol_nebula and hunt for 2 fights. Whatever happens — success or any failure — disengage() must run at the end of the program, after the hunt. Failures should still fail the program.',
    scenarios: [
      {name: 'plain', world: {}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.calls[w.calls.length - 1] !== 'disengage' && 'disengage was not the last call')},
      {name: 'hull_critical', world: {hullCriticalOnFight: 1}, check: (w, r) => all(r.ok && 'succeeded; should fail with HullCritical', w.battle !== null && 'left in battle', !w.calls.includes('disengage') && 'never disengaged')},
      {name: 'nothing_here', world: {fauna: {}}, check: (w, r) => all(r.ok && 'succeeded; should fail with NothingHere', !w.calls.includes('disengage') && 'never disengaged')},
    ]},

  {id: 't7_parallel', concept: 'parallel reads',
    prompt: 'You are docked at sol_base. Read orient(), prices() and missions() concurrently (all three at once, not one after another), then note one line with: your credits, the item_id with the highest best_buy, and how many missions are on the board.',
    scenarios: [{name: 'plain', world: {}, check: (w, r) => {
      const line = w.notes.join(' | ');
      return all(!r.ok && `failed ${r.tag}`, !/500/.test(line) && `credits missing: ${line}`, !/circuit_board/.test(line) && `best item missing: ${line}`, !/\b4\b/.test(line) && `mission count missing: ${line}`);
    }}]},

  {id: 't8_schema', concept: 'decode unknown with Schema, then decide',
    prompt: 'You are docked at sol_base. readMarket() returns the raw market book as unknown. Decode it with the MarketBook schema. Sell every item you hold whose best_buy is at least 10; keep the rest. If the book does not decode, note "bad book" and finish without failing.',
    scenarios: [
      {name: 'good', world: {cargo: [{item_id: 'iron_ore', quantity: 20}, {item_id: 'copper_ore', quantity: 20}, {item_id: 'scrap', quantity: 10}]},
        check: (w, r) => all(!r.ok && `failed ${r.tag}`, held(w, 'copper_ore') > 0 && 'copper not sold', held(w, 'iron_ore') !== 20 && 'iron sold', held(w, 'scrap') !== 10 && 'scrap sold')},
      {name: 'bad_book', world: {badBook: true, cargo: [{item_id: 'copper_ore', quantity: 20}]},
        check: (w, r) => all(!r.ok && `failed ${r.tag}`, !w.notes.some(n => /bad book/i.test(n)) && 'no "bad book" note', held(w, 'copper_ore') !== 20 && 'sold anyway')},
    ]},

  {id: 't9_missions', concept: 'iterate with typed stop condition',
    prompt: 'You are docked at sol_base. List the missions here and accept every mission whose reward is at least 100; if acceptMission fails with NoSlots, stop accepting. Then completeMissions(); if that fails with NothingCompletable, note it and carry on. The program returns the number of missions you accepted (a number).',
    scenarios: [
      {name: 'plain', world: {}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.active.map(m => m.id).sort().join() !== 'm1,m3,m4' && `active ${w.active.map(m => m.id)}`, r.value !== 3 && `returned ${JSON.stringify(r.value)}, want 3`)},
      {name: 'two_slots', world: {maxMissions: 2}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.active.length !== 2 && `active ${w.active.length}`, w.active.some(m => m.reward < 100) && 'accepted a cheap one', r.value !== 2 && `returned ${JSON.stringify(r.value)}, want 2`)},
      {name: 'completable', world: {cargo: [{item_id: 'circuit_board', quantity: 1}, {item_id: 'iron_ore', quantity: 10}]}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, w.credits !== 750 && `credits ${w.credits}, want 750`, r.value !== 3 && `returned ${JSON.stringify(r.value)}, want 3`)},
    ]},

  {id: 't10_composed', concept: 'composed job + recovery + finalizer',
    prompt: 'You are docked at sol_base. Go to kepler_belt and mine until the hold is full; if pirates engage you while mining (InBattle), disengage and keep mining. Then go to kepler_base, sell your copper_ore, service the ship, and completeMissions() (ignore NothingCompletable). Whatever happens, even if a step fails, the last thing the program does is note your current credits (from orient()).',
    scenarios: [
      {name: 'plain', world: {}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'kepler_station'), held(w, 'copper_ore') > 0 && 'copper left', w.fuel !== 100 && 'not serviced', w.notes[w.notes.length - 1]?.includes(String(w.credits)) !== true && `last note lacks credits ${w.credits}: ${JSON.stringify(w.notes)}`)},
      {name: 'ambush', world: {ambushAfterMines: 2}, check: (w, r) => all(!r.ok && `failed ${r.tag}`, at(w, 'kepler_station'), held(w, 'copper_ore') > 0 && 'copper left', w.battle !== null && 'in battle')},
      {name: 'no_fuel', world: {fuel: 10}, check: (w, r) => all(r.ok && 'succeeded; should fail with NoFuel', w.notes[w.notes.length - 1]?.includes('500') !== true && `no credits note: ${JSON.stringify(w.notes)}`)},
    ]},
];
