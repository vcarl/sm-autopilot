/** What a script is allowed to be.
 *
 * A script is the agent's own composition — a loop, a condition, a call — and it runs inside
 * the runner's process against a live game account. So the one thing it may reach is the
 * jobs barrel: the surface we chose to give it, with the pilot's bounds already applied.
 * Anything else (a sibling module, a node builtin, a package, a dynamic import, `eval`, the
 * process env) is refused before the script is ever loaded, so a bad import is a refusal
 * with a reason rather than a half-run job.
 *
 * ponytail: regex over the source with comments blanked, not a parser. The rule
 * is deliberately blunt — anything that even looks like a reach outside the barrel is
 * refused — so a miss costs a rejected script, never an escaped one. Swap in a real parser
 * if scripts ever need to say something this cannot read.
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

/** The one module a script may name, in the two spellings that resolve to it. */
const BARREL=new Set(['../jobs/index.ts','../jobs']);

/** Comments blanked, so a mention in prose is never read as code. Length is preserved so the
 * source the scan reads lines up with the file on disk. */
function blank(source:string):string {
  const blanks=(text:string)=>text.replace(/[^\n]/g,' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g,blanks)
    .replace(/\/\/[^\n]*/g,blanks);
}

const FORBIDDEN:[RegExp,string][]=[
  [/\bimport\s*\(/,'a dynamic import()'],
  [/\brequire\s*\(/,'require()'],
  [/\beval\s*\(/,'eval()'],
  [/\bnew\s+Function\s*\(|\bFunction\s*\(/,'Function()'],
  [/\bprocess\s*\./,'process'],
  [/\bglobalThis\b/,'globalThis'],
];

/** Every static import and re-export, in every spelling: `import x from`, `import {x} from`,
 * `import type ... from`, `export ... from`, and the side-effect `import 'x'`. */
const FROM=/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]*)['"]/g;
const BARE=/\bimport\s*['"]([^'"]*)['"]/g;

export interface LintResult {ok:boolean;errors:string[]}

export function lintScript(source:string,path:string):LintResult {
  const code=blank(source),errors:string[]=[];
  const say=(text:string)=>errors.push(`${path}: ${text}`);
  for(const [pattern,name] of FORBIDDEN)
    if(pattern.test(code))say(`${name} is not available to a script; a script composes the jobs barrel and nothing else`);
  const seen=new Set<string>();
  for(const pattern of [FROM,BARE]) {
    pattern.lastIndex=0;
    for(const match of code.matchAll(pattern))seen.add(match[1]!);
  }
  for(const specifier of seen)
    if(!BARREL.has(specifier))
      say(`imports ${JSON.stringify(specifier)}; a script may import only '../jobs/index.ts'`);
  if(!/\bexport\s+default\b/.test(code))say('exports no default function to run');
  return {ok:!errors.length,errors};
}

export const lintFile=(path:string):LintResult=>lintScript(readFileSync(path,'utf8'),path);

// CI entry: `node spacemolt/src/script-lint.ts spacemolt/src/scripts/*.ts`
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const paths=process.argv.slice(2);
  if(!paths.length){console.error('usage: script-lint.ts <script.ts>...');process.exit(2);}
  const failures=paths.flatMap(path=>lintFile(path).errors);
  for(const error of failures)console.error(error);
  console.log(`${paths.length - new Set(failures.map(line=>line.split(':')[0])).size}/${paths.length} scripts admissible`);
  process.exit(failures.length?1:0);
}
