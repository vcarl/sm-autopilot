/** The image server: mlx-serve's `POST /v1/images/generations` (JSON), answering `{"data":[{"b64_json":…}]}`. With
 * references it is an edit (`mode: "edit"`): the first is `image`, the rest `ref_images`, base64, and the prompt names them
 * `<image1>`, `<image2>`, …; the picture still starts from noise (experiments/qwen-spike/README.md). With none, still an edit,
 * of `NEUTRAL`. No guidance, negative prompt, steps or ref_resolution: the spike found none of them moves pose or copying. */
import {createHash} from 'node:crypto';
import {isRecord} from '../run-record.ts';
import {pngOf} from './crop.ts';
/** The image sent when a picture has no reference: a flat grey frame, nothing to copy. Live 2026-10-19 (recipe2, b9bbabf4 and
 * 7b7030a8): a plain generation of the same prompt came out a monochrome pen sketch with brown hair; the edit route, with this
 * frame as well as with a subject's art, draws the indigo and lamplight colour and the ash hair. It costs about 6 s a picture. */
export const NEUTRAL=pngOf(64,48,new Uint8Array(64*48*4).map((_,i)=>i%4===3?255:128));
/** The style, short: the picture prompt leads with it, and every noun in it pulls the picture toward it. */
export const STYLE='hand-inked illustration, warm lamplight, deep indigo shadows, fine crosshatching';
export interface Imager {url:string;key?:string;model:string;style:string}

export const imagerOf=(env:Record<string,string|undefined>=process.env):Imager=>({
  url:(env.SPACEMOLT_IMAGER_URL||'http://127.0.0.1:11234').replace(/\/+$/,''),
  ...env.SPACEMOLT_IMAGER_KEY?{key:env.SPACEMOLT_IMAGER_KEY}:{},
  model:env.SPACEMOLT_IMAGE_MODEL||'ddalcu/Qwen-Image-2.1-Turbo-MLX-Serve-8bit',
  style:env.SPACEMOLT_IMAGE_STYLE||STYLE,
});

/** A stable seed for a run: the first 31 bits of its id's SHA-1, so redrawing a flight redraws the same picture. */
export const seedOf=(id:string)=>Number.parseInt(createHash('sha1').update(id).digest('hex').slice(0,8),16)&0x7fffffff;

export interface Picture {prompt:string;refs:readonly Uint8Array[];size?:string;seed?:number}

/** The PNG the server draws for `p`. Throws on a non-2xx answer or one without `b64_json`. The
 * spec's picture call gives up at 180 s; a first render after a model load can take longer. */
export async function draw(imager:Imager,p:Picture,opts:{fetch?:typeof fetch;timeoutMs?:number}={}):Promise<Uint8Array> {
  const size=p.size??'1024x768',auth:Record<string,string>=imager.key?{authorization:`Bearer ${imager.key}`}:{};
  const signal=AbortSignal.timeout(opts.timeoutMs??180_000),send=opts.fetch??fetch;
  const [image,...more]=(p.refs.length?p.refs:[NEUTRAL]).map(r=>Buffer.from(r).toString('base64'));
  const res=await send(`${imager.url}/v1/images/generations`,{method:'POST',headers:{...auth,'content-type':'application/json'},signal,
    body:JSON.stringify({model:imager.model,prompt:p.prompt,size,...p.seed!==undefined?{seed:p.seed}:{},mode:'edit',image,...more.length?{ref_images:more}:{}})});
  const text=await res.text();
  if(!res.ok)throw new Error(`imager HTTP ${res.status}: ${text.slice(0,200)}`);
  let body:unknown;
  try {body=JSON.parse(text);} catch {body=undefined;} // edge: a body that is not JSON is the error below
  const first=isRecord(body)&&Array.isArray(body.data)?body.data[0]:undefined,b64=isRecord(first)?first.b64_json:undefined;
  if(typeof b64!=='string'||!b64)throw new Error(`imager answered no b64_json: ${text.slice(0,200)}`);
  return new Uint8Array(Buffer.from(b64,'base64'));
}
