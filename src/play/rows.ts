import {Option,type Schema} from 'effect';
import {field,type GameError} from './game.ts';
import {step} from './runtime.ts';
import {OffSpec} from './storage.ts';

/** A value as a pilot writes it: single quotes, bare keys. */
export const literal=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');

/** Edits (insert, delete, swap one letter) from `a` to `b`. */
const edits=(a:string,b:string)=>{
  let row=Array.from({length:b.length+1},(_,j)=>j);
  for(let i=1;i<=a.length;i++) {
    const next=[i];
    for(let j=1;j<=b.length;j++)next.push(Math.min((row[j]??0)+1,(next[j-1]??0)+1,(row[j-1]??0)+(a[i-1]===b[j-1]?0:1)));
    row=next;
  }
  return row[b.length]??0;
};
/** Up to eight `ids` a mistyped `text` most likely meant: those holding most of its words (inside underscored ids too),
 * then the fewest edits from it. `words` is what an id is matched on, the id itself unless said. */
export const nearest=(text:string,ids:Iterable<string>,words:(id:string)=>string=id=>id):string[]=>{
  const lower=text.toLowerCase(),asked=lower.split(/[^a-z]+/).filter(word=>word.length>2);
  return [...ids].map(id=>({id,hits:asked.filter(word=>words(id).includes(word)).length,far:edits(lower,id)}))
    .filter(row=>row.hits>0).sort((a,b)=>b.hits-a.hits||a.far-b.far).slice(0,8).map(row=>row.id);
};

/** The rows of a reply's list whose read fields decode, as the game sent them. A row that does not is left out and said in a
 * step; an absent or `null` list reads as none (the live server sends `null` for an empty collection). `name` is the row's id for that line. */
export const kept=(action:string,key:string,list:unknown,decode:(row:unknown)=>Option.Option<unknown>,name:(row:unknown)=>unknown):unknown[]=>
  Array.isArray(list)?list.filter(row=>{
    if(Option.isSome(decode(row)))return true;
    step(`${action}: a ${key} row (${String(name(row)??'no id')}) did not read; left out`);
    return false;
  }):[];

/** A reply's number, or `undefined` when it is absent or not one. */
export const num=(body:unknown,key:string):number|undefined=>{const value=field(body,key);return typeof value==='number'?value:undefined;};

/** The only place a refusal becomes a string: the action and the server's code. */
export const told=(error:Exclude<GameError,{_tag:'ReplyLost'}>)=>`${error.action}: ${error.code} — ${error.message}`;
/** A reply that did not decode, as the named `OffSpec` for that action. */
export const offSpec=(action:string)=>(error:Schema.SchemaError)=>new OffSpec({action,message:error.message});
