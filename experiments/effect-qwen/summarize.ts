// node summarize.ts [results/*.jsonl ...]  — tables and concept tags, as markdown on stdout.
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
type Rec = {run: string; variant: string; task: string; sample: number; latency_s: number; usage?: {prompt_tokens?: number; completion_tokens?: number};
  reasoning_chars: number; code: string | null; tsc_ok: boolean; tsc_errors: string[]; cheat_hits: string[];
  scenarios: {name: string; pass: boolean; why: string | null}[]; behavior_pass: boolean; pass: boolean};

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(join(ROOT, 'results')).filter(f => f.endsWith('.jsonl')).map(f => join(ROOT, 'results', f));
const recs: Rec[] = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));

/** Concept tags: what went wrong, from the code and the checker's words. */
export function tags(r: Rec): string[] {
  const code = r.code ?? '';
  const lines = code.split('\n');
  const t = new Set<string>();
  if (!r.code) t.add('no code block');
  // Code-level signals.
  if (r.variant === 'effect') {
    if (/\byield\s+(?!\*)[\w(]/.test(code)) t.add('yield without *');
    if (/Effect\.run(Promise|Sync|Fork|Callback)|Effect\.provide|Layer\./.test(code)) t.add('runs/provides the effect itself');
    if (/\bawait\b/.test(code)) t.add('async/await mixed into Effect');
  } else {
    if (/instanceof\s+(InBattle|HoldFull|NoWreck|ServerBusy|NotDocked|NoSlots|NothingCompletable|BadData)/.test(code)) t.add('instanceof on errors');
  }
  if (/from ['"]fp-ts|from ['"]@effect\//.test(code)) t.add('hallucinated Effect API');
  if (r.cheat_hits.length) t.add('casts/any/suppression');
  // Each checker error, by what the line it points at is doing.
  for (const e of r.tsc_errors) {
    if (/check\.ts/.test(e)) { t.add('default export has the wrong type'); continue; }
    const m = e.match(/index\.ts\((\d+),\d+\): error (TS\d+): (.*)/);
    if (!m) { t.add('other type error'); continue; }
    const [, ln, tsCode, msg] = m;
    const ctx = lines.slice(Math.max(0, Number(ln) - 3), Number(ln)).join('\n');
    if (/Cannot find name|Cannot find module/.test(msg)) t.add('missing/wrong import');
    else if (/has no exported member/.test(msg)) t.add(/'(Schedule|Effect|Schema|pipe|Either)'/.test(msg) ? 'Effect names imported from play' : 'error/export names misspelled');
    else if (tsCode === 'TS2709') t.add('Effect namespace used as a type');
    else if (tsCode === 'TS1214' || tsCode === 'TS1163') t.add('yield* outside a generator');
    else if (tsCode === 'TS2349') t.add('Effect value called like a function');
    else if (tsCode === 'TS2554' && /but got 0/.test(msg)) t.add('pipe helper called with ()');
    else if (/"Left"|"Right"|Property '(left|right)'/.test(msg)) t.add('Either misuse');
    else if (/does not exist on type 'typeof import\(.*effect/.test(msg) || /Did you mean 'recurWhile'/.test(msg)) t.add('hallucinated Effect API');
    else if (/Schedule|retry/.test(ctx)) t.add('Schedule/retry typing');
    else if (/Schema|decode/.test(ctx)) t.add('Schema typing');
    else if (/catchTags?|catchAll|orElse/.test(ctx)) t.add('catchTag handler typing');
    else if (tsCode === 'TS2488') t.add('yield* on a non-Effect');
    else if (/TS7006|TS7022|TS7024|TS7031/.test(tsCode)) t.add('implicit any');
    else if (/TS18046|TS18048/.test(tsCode)) t.add('unknown/undefined not narrowed');
    else if (/readonly/.test(msg)) t.add('readonly arrays');
    else if (tsCode === 'TS2339') t.add('wrong field on game data');
    else t.add(`other type error (${tsCode})`);
  }
  for (const s of r.scenarios) if (!s.pass) {
    if (s.why === 'timeout') t.add('behaviour: hang');
    else if (/failed (defect|load)/.test(s.why ?? '')) t.add('behaviour: crashes at runtime');
    else if (/succeeded; should fail/.test(s.why ?? '')) t.add('behaviour: swallows a failure');
    else if (/^failed \w+$/.test(s.why ?? '')) t.add('behaviour: fails where it should recover');
    else t.add('behaviour: wrong outcome');
  }
  return [...t];
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const groups = new Map<string, Rec[]>();
for (const r of recs.filter(r => !r.run.endsWith('-repair'))) { const k = `${r.run}|${r.variant}`; groups.set(k, [...(groups.get(k) ?? []), r]); }

console.log('| run | variant | n | tsc ok | no casts | behaviour | full pass | median latency s | median completion tok |');
console.log('|---|---|---|---|---|---|---|---|---|');
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
for (const [k, rs] of [...groups].sort()) {
  const [run, variant] = k.split('|');
  console.log(`| ${run} | ${variant} | ${rs.length} | ${pct(rs.filter(r => r.tsc_ok).length, rs.length)} | ${pct(rs.filter(r => !r.cheat_hits.length).length, rs.length)} | ${pct(rs.filter(r => r.behavior_pass).length, rs.length)} | ${pct(rs.filter(r => r.pass).length, rs.length)} | ${med(rs.map(r => r.latency_s)).toFixed(0)} | ${med(rs.map(r => r.usage?.completion_tokens ?? 0))} |`);
}

const runs = [...new Set(recs.filter(r => !r.run.endsWith('-repair')).map(r => r.run))].sort();
const taskIds = [...new Set(recs.map(r => r.task))].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
console.log('\n### Full pass by task (passes/samples)\n');
const cols = [...groups.keys()].sort().map(k => k.split('|'));
console.log(`| task | ${cols.map(([r, v]) => `${r} ${v}`).join(' | ')} |`);
console.log(`|---|${cols.map(() => '---').join('|')}|`);
for (const t of taskIds) {
  const cells = cols.map(([run, v]) => {
    const rs = recs.filter(r => r.run === run && r.variant === v && r.task === t);
    return rs.length ? `${rs.filter(r => r.pass).length}/${rs.length}` : '-';
  });
  console.log(`| ${t} | ${cells.join(' | ')} |`);
}

console.log('\n### Failure tags (count of failing samples carrying the tag)\n');
for (const [run, v] of cols) {
  const rs = recs.filter(r => r.run === run && r.variant === v && !r.pass);
  const c = new Map<string, number>();
  for (const r of rs) for (const t of tags(r)) c.set(t, (c.get(t) ?? 0) + 1);
  console.log(`- **${run} ${v}** (${rs.length} failing): ${[...c].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}`);
}

// Pass after at most one repair round (a typecheck failure given its diagnostics back once).
const repaired = recs.filter(r => r.run.endsWith('-repair'));
if (repaired.length) {
  console.log('\n### Pass after one repair round (typecheck failures only are repaired)\n');
  console.log('| run | variant | n | first try | repaired | after repair | tsc ok after repair |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [k, rs] of [...groups].sort()) {
    const [run, variant] = k.split('|');
    if (run.endsWith('-repair')) continue;
    const fixes = repaired.filter(r => r.run === `${run}-repair` && r.variant === variant);
    if (!fixes.length) continue;
    const fixed = (r: Rec) => fixes.find(f => f.task === r.task && f.sample === r.sample);
    const after = rs.filter(r => r.pass || fixed(r)?.pass).length;
    const tscAfter = rs.filter(r => r.tsc_ok || fixed(r)?.tsc_ok).length;
    console.log(`| ${run} | ${variant} | ${rs.length} | ${pct(rs.filter(r => r.pass).length, rs.length)} | ${fixes.filter(f => f.pass).length}/${fixes.length} | ${pct(after, rs.length)} | ${pct(tscAfter, rs.length)} |`);
  }
}

if (process.env.DETAIL) for (const r of recs.filter(r => !r.pass && (!process.env.DETAIL_RUN || r.run === process.env.DETAIL_RUN))) {
  console.log(`\n#### ${r.run} ${r.variant} ${r.task} #${r.sample}: ${tags(r).join(', ')}`);
  for (const e of r.tsc_errors.slice(0, 6)) console.log('    ' + e.slice(0, 240));
  for (const c of r.cheat_hits.slice(0, 3)) console.log('    cheat ' + c);
  for (const s of r.scenarios.filter(s => !s.pass)) console.log(`    ${s.name}: ${s.why}`);
}
