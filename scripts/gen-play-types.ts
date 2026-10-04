// Generates play.gen/: the declarations of the `play` barrels, which the pilot's tsconfig resolves
// `play` and `play/<career>` to (`pilotHome`, src/run.ts). Checked against these, a pilot program
// parses and checks no library implementation and none of Effect's sources, so its gate stays fast.
// A declaration file that imports `effect` still brings Effect's .d.ts in; the pilot surface itself
// names no Effect type. Rerun after any change under src/play; CI diffs the result.
import {globSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=join(root,'play.gen');
const read=ts.readConfigFile(join(root,'tsconfig.json'),ts.sys.readFile);
const {options}=ts.parseJsonConfigFileContent(read.config,ts.sys,root);
const barrels=['src/play/index.ts',...globSync('src/play/*/index.ts',{cwd:root}).sort()].map(file=>join(root,file));
const program=ts.createProgram(barrels,{...options,noEmit:false,declaration:true,emitDeclarationOnly:true,
  rootDir:join(root,'src'),outDir:out,plugins:[]});
const errors=[...ts.getPreEmitDiagnostics(program)];
if(errors.length)throw new Error(ts.formatDiagnostics(errors,{getCurrentDirectory:()=>root,getCanonicalFileName:f=>f,getNewLine:()=>'\n'}));
rmSync(out,{recursive:true,force:true});
// The generated wire schemas (2.7 MB of declarations) are reached only by implementations that
// decode replies, never by a play declaration: not emitted, and a declaration that names one fails
// here, because the pilot's gate would then load all of it.
const generated=/\.gen\.d\.ts$/,named:string[]=[];
const emitted=program.emit(undefined,(file,text)=>{
  if(generated.test(file))return;
  if(/(?:from |import\()['"][^'"]*\.gen(?:\.d)?\.ts['"]/.test(text))named.push(file);
  ts.sys.writeFile(file,text);
});
if(named.length)throw new Error(`a play declaration imports a generated file: ${named.join(', ')}`);
if(emitted.emitSkipped||emitted.diagnostics.length)throw new Error(`declaration emit failed: ${emitted.diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('; ')}`);
