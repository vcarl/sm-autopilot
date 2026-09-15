/** The run on disk: what a restarting runner knows about the work it was doing.
 *
 * Nothing here decides anything. It is the durable half of `status`: which script was
 * running with which parameters, where it had got to, and the outcome once it has one, so a
 * bridge that died mid-run does not leave the next one answering `last: null` with the ship
 * still out at the belt.
 */
import {appendFileSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export interface RunRecord {
  script:string;
  /** The source of a script the pilot wrote, kept whole so a restart can re-run the very
   * script it was running. `script` is then the source's label, which is what the journal
   * and the juncture read: a hash names the run without carrying its text. */
  source?:string;
  params:Record<string,unknown>;
  /** The run's identity: no counter, no ids to keep unique across restarts. */
  started:string;
  /** The hold the pilot already had when the run started, so a re-run after a restart still
   * knows which cargo is the pilot's own and not the take it was carrying home. */
  keep:string[];
  last_job?:string;
  last_step?:string;
  ended:boolean;
  /** Present exactly when the run ended: the same shape the juncture reads as `last`. */
  outcome?:Record<string,unknown>;
}

/** Temp file then rename: a torn write would tell a restarting bridge a lie about the pilot. */
export function writeRun(runtime:string,record:RunRecord):void {
  mkdirSync(runtime,{recursive:true});
  const path=join(runtime,'run.json'),temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify(record),{mode:0o600});
  renameSync(temp,path);
}

/** No record, or one too broken to name a script, is the same answer: nothing to resume. */
export function readRun(runtime:string):RunRecord|null {
  try {
    const stored=JSON.parse(readFileSync(join(runtime,'run.json'),'utf8')) as RunRecord;
    return stored?.script&&stored.started?stored:null;
  } catch {return null;}
}

/** The tail of the journal as data: what the pilot has actually done, for the one reader
 * that needs history rather than the present (reflection, N7/N9).
 *
 * ponytail: the file is read whole and the tail kept. Rest happens once an evening, so a
 * few MB costs nothing; seek from the end if a journal ever outgrows that. */
export function readJournal(runtime:string,limit=400):Record<string,any>[] {
  try {
    const lines=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').split('\n').filter(line=>line.trim());
    return lines.slice(-limit).flatMap(line=>{
      try {return [JSON.parse(line) as Record<string,any>];} catch {return [];}
    });
  } catch {return [];}
}

/** The run's own lines in the pilot's journal, beside the request/response pairs. The
 * runner's other self-made changes take the same line under their own event name (S45). */
export function journalRun(runtime:string,entry:Record<string,unknown>,event='run'):void {
  mkdirSync(runtime,{recursive:true});
  appendFileSync(join(runtime,'gameplay.jsonl'),
    `${JSON.stringify({at:new Date().toISOString(),event,...entry})}\n`,{mode:0o600});
}
