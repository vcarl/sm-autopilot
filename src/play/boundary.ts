/** What a pilot file is allowed to reach: the library (`play`, `play/<folder>`), the lib's
 * types (`@spacemolt/lib`), and its own siblings (`./name.ts`). Anything else — a node
 * builtin, a package, a dynamic import, `require`, `eval`, `Function`, `process`,
 * `globalThis`, `fetch` — is refused before the file is loaded.
 *
 * ponytail: regex over the source with comments blanked, not a parser. The rule is blunt on
 * purpose — anything that even looks like a reach outside is refused — so a miss costs a
 * rejected file, never an escaped one. A real parser the day a pilot needs to say something
 * this cannot read.
 */
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

/** Comments blanked, length preserved so line numbers still line up. */
export function blank(source:string):string {
  const blanks=(text:string)=>text.replace(/[^\n]/g,' ');
  return source.replace(/\/\*[\s\S]*?\*\//g,blanks).replace(/\/\/[^\n]*/g,blanks);
}

const FORBIDDEN:[RegExp,string][]=[
  [/\bimport\s*\(/,'a dynamic import()'],
  [/\brequire\s*\(/,'require()'],
  [/\beval\s*\(/,'eval()'],
  [/\bnew\s+Function\s*\(|\bFunction\s*\(/,'Function()'],
  [/\bprocess\s*\./,'process'],
  [/\bglobalThis\b/,'globalThis'],
  [/\bfetch\s*\(/,'fetch()'],
];
const FROM=/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]*)['"]/g;
const BARE=/\bimport\s*['"]([^'"]*)['"]/g;
const LIBRARY=/^play(\/[a-z_]+)*$/;
const SIBLING=/^\.\/[a-z0-9_-]+\.ts$/;

export interface Verdict {ok:boolean;errors:string[]}

/** Every specifier a source names, in every import spelling. */
export function specifiers(source:string):string[] {
  const code=blank(source),seen=new Set<string>();
  for(const pattern of [FROM,BARE]){pattern.lastIndex=0;for(const match of code.matchAll(pattern))seen.add(match[1]!);}
  return [...seen];
}

export function checkBoundary(source:string,path:string):Verdict {
  const code=blank(source),errors:string[]=[];
  for(const [pattern,name] of FORBIDDEN)
    if(pattern.test(code))errors.push(`${path}: ${name} is not available to a pilot file`);
  for(const spec of specifiers(source))
    if(!LIBRARY.test(spec)&&spec!=='@spacemolt/lib'&&!SIBLING.test(spec))
      errors.push(`${path}: imports ${JSON.stringify(spec)}; a pilot file may import 'play', 'play/<folder>', '@spacemolt/lib' or './<name>.ts'`);
  return {ok:!errors.length,errors};
}

/** The entry file and every sibling it reaches, each checked once. */
export function checkTree(entry:string):Verdict {
  const errors:string[]=[],seen=new Set<string>(),queue=[entry];
  while(queue.length) {
    const path=queue.shift()!;
    if(seen.has(path))continue;
    seen.add(path);
    if(!existsSync(path)){errors.push(`${path}: missing`);continue;}
    const source=readFileSync(path,'utf8');
    errors.push(...checkBoundary(source,path).errors);
    for(const spec of specifiers(source))if(SIBLING.test(spec))queue.push(join(dirname(path),spec));
  }
  return {ok:!errors.length,errors};
}
