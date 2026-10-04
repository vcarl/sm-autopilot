// node harness.ts run --doc v1 --variants effect,promise --samples 3 --thinking on [--tasks t1_sequence,...] [--out name]
// node harness.ts reference            score reference/<variant>/<task>.ts (proves tasks are solvable)
// node harness.ts rescore <file.jsonl> re-score saved completions in place (after a harness fix); the old file is kept as .bak
// node harness.ts recheat <file.jsonl ...> re-apply only the cast detector to saved records, in place
// node harness.ts probe               one tiny request each way, to see latency and the thinking toggle
import {spawnSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tasks} from './tasks.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODEL = 'mlx-community--Qwen3.8-27B-4bit';
const URL_ = 'http://localhost:8000/v1/chat/completions';
const THINKING_BUDGET = 4096;   // what the kvothe profile sends
type Variant = 'effect' | 'promise' | 'result';

function apiKey(): string {
  const env = readFileSync(join(homedir(), '.hermes/profiles/kvothe/.env'), 'utf8');
  const m = env.match(/^OPENAI_API_KEY=["']?([^"'\n]+)/m);
  if (!m) throw new Error('no OPENAI_API_KEY in the profile .env');
  return m[1];
}

async function ask(system: string, user: string, thinking: boolean) {
  for (let attempt = 1; ; attempt++) {
    try { return await askOnce(system, user, thinking); }
    catch (e) { if (attempt >= 4) throw e; console.error(`request failed (${e}); retrying in 60s`); await new Promise(r => setTimeout(r, 60_000)); }
  }
}

async function askOnce(system: string, user: string, thinking: boolean) {
  const body: Record<string, unknown> = {model: MODEL, messages: [{role: 'system', content: system}, {role: 'user', content: user}], max_tokens: 12000};
  if (thinking) body.thinking_budget = THINKING_BUDGET;
  else body.chat_template_kwargs = {enable_thinking: false};
  const t0 = Date.now();
  const res = await fetch(URL_, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}`},
    body: JSON.stringify(body), signal: AbortSignal.timeout(20 * 60_000)});
  const json = await res.json() as {choices?: {message: {content?: string; reasoning_content?: string; reasoning?: string}; finish_reason?: string}[]; usage?: unknown; error?: unknown};
  const msg = json.choices?.[0]?.message;
  return {latency_s: (Date.now() - t0) / 1000, content: msg?.content ?? '', reasoning: msg?.reasoning_content ?? msg?.reasoning ?? '',
    finish: json.choices?.[0]?.finish_reason, usage: json.usage, error: json.error};
}

function extract(content: string): string | null {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  const blocks = [...text.matchAll(/```(?:ts|typescript|tsx)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  if (!blocks.length) return null;
  return blocks.find(b => /export default/.test(b)) ?? blocks[blocks.length - 1];
}

const CHECK: Record<Variant, string> = {
  effect: `import type {Effect} from 'effect';\nimport type {Game} from 'LIB/core.ts';\nimport main from './index.ts';\nexport const _check: Effect.Effect<unknown, unknown, Game> = main;\n`,
  promise: `import main from './index.ts';\nexport const _check: () => Promise<unknown> = main;\n`,
  result: `import main from './index.ts';\nexport const _check: () => Promise<unknown> = main;\n`,
};
const TSCONFIG = JSON.stringify({compilerOptions: {target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
  noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: []}, files: ['index.ts', 'check.ts']});

/** Casts, `any` and suppressions: what a model reaches for to silence the checker. */
export function cheats(source: string): string[] {
  // One pass, so a `//` in a string or a quote in a comment can't fool the other: comments go,
  // strings become '', and a template literal keeps only its `${…}` expressions (casts hide there).
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\$]|\$(?!\{))*`/gm,
    t => t.startsWith('`') ? (t.match(/\$\{[^}]*\}/g) ?? []).join(' ') : t.startsWith('/') ? '' : "''")
    // import renames, multi-line ones too, and local export lists (`export {main as default};`)
    .replace(/^\s*(import|export)\b[^;]*?\bfrom\s*'';?|^\s*export\s*\{[^}]*\};?/gm, '');
  const hits: string[] = [];
  // `any` but not `Promise.any`; `x!` but not `!=`/`!==`. Suppressions live in comments, so they
  // are looked for in the source.
  for (const [name, re, text] of [['as-cast', /\bas\s+(?!const\b)[A-Za-z{[(]/g, code], ['any', /(?<!\.)\bany\b/g, code],
    ['ts-ignore', /@ts-(ignore|expect-error|nocheck)/g, source], ['non-null!', /[\w)\]]!(?!=)/g, code]] as const)
    for (const m of text.matchAll(re)) hits.push(`${name}: ${text.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\n/g, ' ')}`);
  return hits;
}

function score(variant: Variant, code: string, taskId: string, dir: string) {
  mkdirSync(dir, {recursive: true});
  const up = relative(dir, join(ROOT, 'lib'));
  const lib = `${up}/${variant}.ts`;
  writeFileSync(join(dir, 'index.ts'), code.replace(/from\s+(['"])play\1/g, `from '${lib}'`));
  writeFileSync(join(dir, 'check.ts'), CHECK[variant].replace('LIB', up));
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  const tsc = spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', dir], {encoding: 'utf8', timeout: 120_000});
  const tsc_errors = (tsc.stdout + tsc.stderr).split('\n').filter(l => /error TS/.test(l)).map(l => l.replace(dir + '/', ''));
  const task = tasks.find(t => t.id === taskId)!;
  const scenarios = task.scenarios.map((s, i) => {
    const r = spawnSync('node', ['--no-warnings', join(ROOT, 'runner.ts'), variant, join(dir, 'index.ts'), taskId, String(i)], {encoding: 'utf8', timeout: 30_000});
    const line = r.stdout.trim().split('\n').pop() ?? '';
    try { const j = JSON.parse(line); return {name: s.name, pass: j.pass as boolean, why: j.why, result: j.result}; }
    catch { return {name: s.name, pass: false, why: r.error ? 'timeout' : `runner crashed: ${(r.stderr || '').slice(0, 300)}`, result: null}; }
  });
  const cheat_hits = cheats(code);
  const tsc_ok = tsc_errors.length === 0 && tsc.status === 0;
  const behavior_pass = scenarios.every(s => s.pass);
  return {tsc_ok, tsc_errors, cheat_hits, scenarios, behavior_pass, pass: tsc_ok && cheat_hits.length === 0 && behavior_pass};
}

function userPrompt(taskPrompt: string) {
  return `Task: ${taskPrompt}\n\nWrite pilot/index.ts. Answer with the whole file in one \`\`\`ts block.`;
}

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

if (args[0] === 'probe') {
  for (const thinking of [true, false]) {
    const r = await ask('You are terse.', 'Write a TypeScript one-liner that sums an array xs.', thinking);
    console.log(JSON.stringify({thinking, latency_s: r.latency_s, usage: r.usage, finish: r.finish, reasoning_chars: r.reasoning.length, content: r.content.slice(0, 300), error: r.error}));
  }
} else if (args[0] === 'reference') {
  for (const variant of ['effect', 'promise', 'result'] as Variant[])
    for (const t of tasks) {
      const f = join(ROOT, 'reference', variant, `${t.id}.ts`);
      if (!existsSync(f)) { console.log(variant, t.id, 'MISSING'); continue; }
      const s = score(variant, readFileSync(f, 'utf8'), t.id, join(ROOT, 'work/reference', variant, t.id, '0'));
      console.log(variant.padEnd(8), t.id.padEnd(16), s.pass ? 'PASS' : 'FAIL', s.tsc_errors.join(' ; '), s.cheat_hits.join(' ; '),
        s.scenarios.filter(x => !x.pass).map(x => `${x.name}: ${x.why} ${JSON.stringify(x.result)}`).join(' ; '));
    }
  // Negative controls: each must FAIL, or the scoring is too lenient.
  for (const f of readdirSync(join(ROOT, 'reference/negative'))) {
    const [variant, task, label] = f.replace(/\.ts$/, '').split('__');
    const s = score(variant as Variant, readFileSync(join(ROOT, 'reference/negative', f), 'utf8'), task, join(ROOT, 'work/reference/negative', label, 'x', 'y'));
    console.log('negative', f.padEnd(40), s.pass ? 'PASSED (BAD)' : 'failed (good)', `tsc=${s.tsc_ok}`, `cheats=${s.cheat_hits.length}`,
      s.scenarios.filter(x => !x.pass).map(x => `${x.name}: ${x.why}`).join(' ; '));
  }
} else if (args[0] === 'repair') {
  // One repair round, as spacemolt_check gives it: a sample that failed the typecheck gets its
  // diagnostics back and one more try. Writes results/<run>-repair.jsonl.
  const file = args[1];
  const thinking = opt('thinking', 'off') === 'on';
  const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const only = opt('variants', 'effect,promise,result').split(',');
  const out = file.replace(/\.jsonl$/, '-repair.jsonl');
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return `${j.variant}/${j.task}/${j.sample}`; }) : []);
  for (const rec of recs) {
    const key = `${rec.variant}/${rec.task}/${rec.sample}`;
    if (rec.tsc_ok || done.has(key) || !only.includes(rec.variant)) continue;
    const system = readFileSync(join(ROOT, 'docs', `${rec.variant}.${rec.doc}.md`), 'utf8');
    const task = tasks.find(t => t.id === rec.task)!;
    const diags = rec.code
      ? rec.tsc_errors.map((e: string) => e.replace(/^.*check\.ts\S*: error TS\d+:/, 'the default export has the wrong type:')
        .replace(/^.*index\.ts/, 'index.ts').replace(/"[^"]*lib\/\w+\.ts"/g, '"play"')).join('\n')
      : 'no ```ts block with the file was found in your answer';
    const t0 = Date.now();
    const body: Record<string, unknown> = {model: MODEL, max_tokens: 12000, messages: [
      {role: 'system', content: system}, {role: 'user', content: userPrompt(task.prompt)}, {role: 'assistant', content: rec.completion},
      {role: 'user', content: `spacemolt_check refused the file:\n${diags}\n\nFix it. Answer with the whole file in one \`\`\`ts block.`}]};
    if (thinking) body.thinking_budget = THINKING_BUDGET; else body.chat_template_kwargs = {enable_thinking: false};
    const res = await fetch(URL_, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}`}, body: JSON.stringify(body), signal: AbortSignal.timeout(20 * 60_000)});
    const json = await res.json() as {choices?: {message: {content?: string}}[]; usage?: unknown};
    const content = json.choices?.[0]?.message?.content ?? '';
    const code = extract(content);
    const s = code ? score(rec.variant, code, rec.task, join(ROOT, 'work', `${rec.run}-repair`, rec.variant, rec.task, String(rec.sample)))
      : {tsc_ok: false, tsc_errors: ['no code block'], cheat_hits: [], scenarios: [], behavior_pass: false, pass: false};
    appendFileSync(out, JSON.stringify({...rec, run: `${rec.run}-repair`, repair_of: rec.run, first_errors: rec.tsc_errors, latency_s: (Date.now() - t0) / 1000,
      usage: json.usage, completion: content, reasoning: '', code, ...s}) + '\n');
    console.log(`${key} repair ${s.pass ? 'PASS' : 'fail'} tsc=${s.tsc_ok}`);
  }
} else if (args[0] === 'rescore') {
  const file = args[1];
  const out = file + '.tmp';
  writeFileSync(out, '');
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line);
    const s = rec.code ? score(rec.variant, rec.code, rec.task, join(ROOT, 'work', rec.run, rec.variant, rec.task, String(rec.sample)))
      : {tsc_ok: false, tsc_errors: ['no code block'], cheat_hits: [], scenarios: [], behavior_pass: false, pass: false};
    appendFileSync(out, JSON.stringify({...rec, ...s}) + '\n');
  }
  renameSync(file, file.replace(/\.jsonl$/, `.${Date.now()}.bak`));
  renameSync(out, file);
  console.log('rescored', file);
} else if (args[0] === 'recheat') {
  // Re-apply only cheats() to saved records, in place: no tsc, no runner, no model. For a fix to
  // the cast detector; tsc_ok and behavior_pass are kept as scored.
  for (const file of args.slice(1)) {
    let moved = 0;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      const rec = JSON.parse(l);
      const cheat_hits = rec.code ? cheats(rec.code) : [];
      const pass = rec.tsc_ok && cheat_hits.length === 0 && rec.behavior_pass;
      if (pass !== rec.pass) { moved++; console.log(`${file} ${rec.variant}/${rec.task}/${rec.sample} ${rec.pass ? 'PASS' : 'fail'} -> ${pass ? 'PASS' : 'fail'} ${cheat_hits.join(' ; ')}`); }
      return JSON.stringify({...rec, cheat_hits, pass});
    });
    writeFileSync(file, lines.join('\n') + '\n');
    console.log(`recheated ${file}: ${moved} moved`);
  }
} else if (args[0] === 'run') {
  const doc = opt('doc', 'v1');
  const variants = opt('variants', 'effect,promise').split(',') as Variant[];
  const samples = Number(opt('samples', '3'));
  const thinking = opt('thinking', 'on') === 'on';
  const only = opt('tasks', 'all');
  const run = opt('out', `${doc}-${thinking ? 'think' : 'nothink'}`);
  const out = join(ROOT, 'results', `${run}.jsonl`);
  mkdirSync(dirname(out), {recursive: true});
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return `${j.variant}/${j.task}/${j.sample}`; }) : []);
  // Interleave variants and tasks so a partial run still compares like with like.
  for (let sample = 0; sample < samples; sample++)
    for (const t of tasks.filter(t => only === 'all' || only.split(',').includes(t.id)))
      for (const variant of variants) {
        const key = `${variant}/${t.id}/${sample}`;
        if (done.has(key)) continue;
        const system = readFileSync(join(ROOT, 'docs', `${variant}.${doc}.md`), 'utf8');
        const r = await ask(system, userPrompt(t.prompt), thinking);
        const code = extract(r.content);
        const s = code ? score(variant, code, t.id, join(ROOT, 'work', run, variant, t.id, String(sample)))
          : {tsc_ok: false, tsc_errors: ['no code block'], cheat_hits: [], scenarios: [], behavior_pass: false, pass: false};
        const rec = {run, doc, variant, task: t.id, sample, thinking, model: MODEL, latency_s: r.latency_s, usage: r.usage, finish: r.finish,
          reasoning_chars: r.reasoning.length, error: r.error, completion: r.content, reasoning: r.reasoning, code, ...s};
        appendFileSync(out, JSON.stringify(rec) + '\n');
        console.log(`${key} ${s.pass ? 'PASS' : 'fail'} tsc=${s.tsc_ok} cheats=${s.cheat_hits.length} behav=${s.scenarios.filter(x => x.pass).length}/${s.scenarios.length} ${r.latency_s.toFixed(0)}s ${JSON.stringify(r.usage)}`);
      }
} else {
  console.log('usage: node harness.ts run|reference|rescore|recheat|probe');
}
