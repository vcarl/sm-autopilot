// node check-doc.ts docs/effect.v3.md — typecheck every recipe block that has an `export default`,
// each as its own file with the doc's import header, so the doc never teaches a broken shape.
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const doc = process.argv[2];
const variant = /effect/.test(doc) ? 'effect' : /result/.test(doc) ? 'result' : 'promise';
const blocks = [...readFileSync(doc, 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map(m => m[1]);
const header = blocks.find(b => /^import /.test(b) && /from 'play'/.test(b) && !/export default/.test(b)) ?? '';
const dir = join(ROOT, 'work/doccheck', variant);
mkdirSync(dir, {recursive: true});
const lib = relative(dir, join(ROOT, 'lib', `${variant}.ts`));
const files: string[] = [];
blocks.filter(b => /export default/.test(b)).forEach((b, i) => {
  const src = (/^import /m.test(b) ? b : header + b).replace(/from 'play'/g, `from '${lib}'`);
  writeFileSync(join(dir, `r${i}.ts`), src);
  files.push(`r${i}.ts`);
});
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: []}, files}));
const r = spawnSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', dir], {encoding: 'utf8'});
console.log(`${files.length} recipe(s)`, r.status === 0 ? 'typecheck' : `FAIL\n${r.stdout}`);
