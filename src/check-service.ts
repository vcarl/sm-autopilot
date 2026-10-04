/** The pilot gate's typecheck, warm: one language service per tsconfig, living as long as the
 * bridge does, so the library's parsed files stay in memory and only what changed is re-read.
 * A file's version is its mtime and size, so an edited library file or a moved plugin checkout
 * invalidates itself. Errors are taken and printed as `tsc --noEmit --pretty false -p` takes and
 * prints them, so the pilot reads the same text whichever path checked it. */
import {realpathSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import ts from 'typescript';

/** Shared across services: each runtime has its own tsconfig, but they all reach the same library. */
const registry=ts.createDocumentRegistry();
const services=new Map<string,{service:ts.LanguageService;config:{current:ts.ParsedCommandLine}}>();

function parse(tsconfig:string):ts.ParsedCommandLine {
  const read=ts.readConfigFile(tsconfig,ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config??{},ts.sys,dirname(tsconfig),undefined,tsconfig);
}

function serviceFor(tsconfig:string) {
  const kept=services.get(tsconfig);
  if(kept)return kept;
  const config={current:parse(tsconfig)};
  const host:ts.LanguageServiceHost={
    getCompilationSettings:()=>config.current.options,
    getScriptFileNames:()=>config.current.fileNames,
    getProjectReferences:()=>config.current.projectReferences,
    getScriptVersion:file=>{const stat=statSync(file,{throwIfNoEntry:false});return stat?`${stat.mtimeMs}:${stat.size}`:'';},
    getScriptSnapshot:file=>{const text=ts.sys.readFile(file);return text===undefined?undefined:ts.ScriptSnapshot.fromString(text);},
    getCurrentDirectory:()=>dirname(tsconfig),
    getDefaultLibFileName:ts.getDefaultLibFilePath,
    fileExists:ts.sys.fileExists,readFile:ts.sys.readFile,readDirectory:ts.sys.readDirectory,
    directoryExists:ts.sys.directoryExists,getDirectories:ts.sys.getDirectories,realpath:file=>ts.sys.realpath?.(file)??file,
  };
  const made={service:ts.createLanguageService(host,registry),config};
  services.set(tsconfig,made);
  return made;
}

/** `tsc --noEmit --pretty false -p tsconfig`'s output lines, from the warm service. Throws when
 * the service does; the caller falls back to the CLI. */
export function warmCheck(tsconfig:string):string[] {
  const {service,config}=serviceFor(tsconfig);
  config.current=parse(tsconfig);
  const program=service.getProgram();
  if(!program)throw new Error(`no program for ${tsconfig}`);
  // The order tsc's emitFilesAndReportErrors takes them in, each later kind only if the earlier are clean.
  const all=[...config.current.errors,...program.getConfigFileParsingDiagnostics()];
  const base=all.length;
  all.push(...program.getSyntacticDiagnostics());
  if(all.length===base) {
    all.push(...program.getOptionsDiagnostics(),...program.getGlobalDiagnostics());
    if(all.length===base)all.push(...program.getSemanticDiagnostics());
  }
  const sorted=ts.sortAndDeduplicateDiagnostics(all);
  // tsc runs with its cwd at the tsconfig's directory, and a process's cwd is the real path: on macOS
  // that is /private/var for a /var tmpdir, so tsc prints those files by a long relative path. Match it.
  // `.native` is getcwd's answer, case included; tsc compares path components through its canonical
  // (lower-cased where the file system ignores case) names, so this does too.
  const cwd=realpathSync.native(dirname(tsconfig));
  const text=ts.formatDiagnostics(sorted,{getCurrentDirectory:()=>cwd,getNewLine:()=>'\n',
    getCanonicalFileName:file=>ts.sys.useCaseSensitiveFileNames?file:file.toLowerCase()});
  return text.split('\n').filter(line=>line.trim());
}
