/** The library's own command reference, read at call time: what `command(ctx, …)` may name. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const COMMANDS_MD=new URL('../node_modules/@spacemolt/lib/COMMANDS.md',import.meta.url);
export const COMMAND_LINES=40;

export function commandLines(search:string):{search:string;matched:number;lines:string[]} {
  const needle=search.toLowerCase();
  // Each command line is spelled the way `command(ctx, …)` takes it: the `## tool` heading it
  // sits under, a slash, the action (live 2026-09-16 00:14: the pilot sent 'sell' bare).
  let tool='';
  const lines:string[]=[];
  for(const line of readFileSync(COMMANDS_MD,'utf8').split('\n')) {
    if(line.startsWith('## ')){tool=line.slice(3).trim();continue;}
    if(!line.startsWith('- `')||!line.toLowerCase().includes(needle))continue;
    lines.push(tool.startsWith('spacemolt')?`- \`${tool}/${line.slice(3)}`:line);
  }
  return {search,matched:lines.length,lines:lines.slice(0,COMMAND_LINES)};
}

/** A bare action ('sell') resolved to its tool ('spacemolt/sell') when the reference names it
 * once; an action already spelled tool/action is returned as given; an unknown or ambiguous
 * bare name is returned bare, and the game's own refusal says so. */
export function resolveAction(action:string):string {
  if(action.includes('/'))return action;
  let tool='';const hits=new Set<string>();
  for(const line of readFileSync(COMMANDS_MD,'utf8').split('\n')) {
    if(line.startsWith('## ')){tool=line.slice(3).trim();continue;}
    if(line.startsWith(`- \`${action}(`)&&tool.startsWith('spacemolt'))hits.add(`${tool}/${action}`);
  }
  return hits.size===1?[...hits][0]:action;
}
