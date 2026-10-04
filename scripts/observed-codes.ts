// node scripts/observed-codes.ts   prints `code count source`, the evidence for src/play/codes.ts.
// Reads every profile's journal READ-ONLY (docs/EFFECT-MIGRATION.md "Error tags (P0.6)"): each failed
// `command` line counts by its `code`, else by the `^([a-z_]+): ` prefix of its summary, else as prose.
// Then the codes src/ branches on and the ones the test world raises, at count 0 when unobserved.
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const profiles = join(homedir(), '.hermes', 'profiles');
const counts = new Map<string, number>(), sources = new Map<string, Set<string>>();
const note = (code: string, source: string, n = 0) => {
  counts.set(code, (counts.get(code) ?? 0) + n);
  sources.set(code, (sources.get(code) ?? new Set()).add(source));
};
let failed = 0, prose = 0;
for (const profile of existsSync(profiles) ? readdirSync(profiles) : []) {
  const dir = join(profiles, profile, 'spacemolt', 'runtime');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(f => /^gameplay.*\.jsonl$/.test(f))) {
    for (const text of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!text.includes('"event":"command"') || !text.includes('"ok":false')) continue;
      let row: unknown;
      try { row = JSON.parse(text); } catch (e) { console.error(`${profile}/${file}: unparsed line (${String(e)})`); continue; } // edge: a torn last line is reported, not fatal
      if (typeof row !== 'object' || row === null || !('event' in row) || row.event !== 'command' || !('ok' in row) || row.ok !== false) continue;
      failed++;
      const code = 'code' in row && row.code !== undefined ? String(row.code)
        : 'summary' in row ? /^([a-z_]+): /.exec(String(row.summary))?.[1] : undefined;
      if (code === undefined) prose++; else note(code, 'journal', 1);
    }
  }
}
const grep = (file: string, re: RegExp, source: string) => {
  for (const m of readFileSync(file, 'utf8').matchAll(re)) for (const code of (m[1] ?? '').matchAll(/'([a-z_]+)'/g)) note(code[1] ?? '', source);
};
const src = readdirSync('src', {recursive: true}).map(String).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('test-support'));
for (const f of src) grep(join('src', f), /code\s*===\s*('[a-z_]+')/g, `branch:${f}`);
grep('src/mine.ts', /new Set\((\[[^\]]*\])\)/g, 'branch:mine.ts');
grep('src/test-support/bridge-world.ts', /new SpacemoltError\(('[a-z_]+')/g, 'world');
console.log(`failed command lines: ${failed}; with a code: ${failed - prose}; prose: ${prose}`);
for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  console.log(`${code} ${n} ${[...sources.get(code) ?? []].join(',')}`);
