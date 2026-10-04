// node scripts/surface.ts [--check] [--out <path>]   |   node scripts/surface.ts --internal <files…>
// The pilot surface, printed: every barrel export, then every src/ type it reaches, member by member.
// Default writes docs/effect-surface.txt (or --out); --check diffs against it and exits 1 on a change.
// --internal prints `name: E` for each exported Effect (or Effect-returning function) and exits 1 on an untyped E.
import ts from 'typescript';
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
const out = resolve(opt('--out') ?? join(root, 'docs/effect-surface.txt'));
const internal = args.includes('--internal') ? args.filter(a => !a.startsWith('--') && a !== opt('--out')).map(f => resolve(f)) : undefined;
const play = join(root, 'src/play');
const sub = (d: string) => readdirSync(d, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => join(d, e.name));
const barrels = [join(play, 'index.ts'), ...sub(play).flatMap(d => [d, ...sub(d)]).map(d => join(d, 'index.ts')).filter(existsSync)].sort();
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
const program = ts.createProgram([...cfg.fileNames, ...(internal ?? [])], cfg.options);
const checker = program.getTypeChecker();
const F = ts.TypeFormatFlags.NoTruncation;
const isRef = (t: ts.Type): t is ts.TypeReference => !!(ts.getObjectFlags(t) & ts.ObjectFlags.Reference);
const str = (t: ts.Type, alias = false) => checker.typeToString(t, undefined, F | (alias ? ts.TypeFormatFlags.InTypeAlias : 0));
const rel = (f: string) => relative(root, f);
const exportsOf = (f: string) => { const sf = program.getSourceFile(f); const m = sf && checker.getSymbolAtLocation(sf); return m ? checker.getExportsOfModule(m) : []; };
const target = (s: ts.Symbol) => s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
const inSrc = (s: ts.Symbol | undefined) => !!s?.declarations?.length && s.declarations.every(d => rel(d.getSourceFile().fileName).startsWith('src/'));
const valueType = (s: ts.Symbol) => checker.getTypeOfSymbol(s);

if (internal) {
  // Effect<A, E, R> carries `readonly ["~effect/Effect"]: Variance<A, E, R>`, and Variance._E is `Covariant<E>` = `(_: never) => E`.
  const errorOf = (t: ts.Type) => {
    const v = t.getProperty('~effect/Effect'), e = v && checker.getTypeOfSymbol(v).getProperty('_E');
    const sig = e && checker.getTypeOfSymbol(e).getCallSignatures()[0];
    return sig && checker.getReturnTypeOfSignature(sig);
  };
  let bad = 0;
  for (const f of internal) for (const s of exportsOf(f).map(target).filter(s => s.flags & ts.SymbolFlags.Value)) {
    const t = valueType(s), sigs = t.getCallSignatures();
    const es = [errorOf(t), ...(sigs.length ? sigs.map(g => errorOf(checker.getReturnTypeOfSignature(g))) : [])].filter(e => e !== undefined);
    for (const e of es) {
      const p = str(e);
      if (['unknown', 'any', 'Error', 'UnknownError'].includes(p) || p.includes('Cause')) bad++;
      console.log(`${rel(f)} ${s.name}: ${p}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

const lines = new Set<string>(), seen = new Set<ts.Type>(), named = new Set<ts.Symbol>();
const kind = (s: ts.Symbol) => s.flags & ts.SymbolFlags.Function ? 'function' : s.flags & ts.SymbolFlags.Class ? 'class'
  : s.flags & ts.SymbolFlags.Enum ? 'enum' : s.flags & ts.SymbolFlags.Variable ? 'const' : 'value';
const isReadonly = (p: ts.Symbol) => !!p.declarations?.some(d => ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly);
const walk = (t: ts.Type): void => {
  if (seen.has(t)) return;
  seen.add(t);
  t.aliasTypeArguments?.forEach(walk);
  for (const s of [t.aliasSymbol, t.getSymbol()]) if (s && inSrc(s) && s.flags & (ts.SymbolFlags.Type) && !named.has(s)) {
    named.add(s);
    const d = checker.getDeclaredTypeOfSymbol(s);
    if (s.flags & ts.SymbolFlags.TypeAlias) lines.add(`${s.name} = ${str(d, true)}`);
    walk(d);
  }
  if (t.isUnionOrIntersection()) t.types.forEach(walk);
  if (isRef(t)) checker.getTypeArguments(t).forEach(walk);
  const s = t.getSymbol();
  // A lib or package type contributes only its type arguments; a primitive or literal has no members of ours.
  if (s && !inSrc(s) || !(t.flags & ts.TypeFlags.Object || t.isIntersection())) return;
  for (const g of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
    g.getParameters().forEach(p => walk(checker.getTypeOfSymbol(p)));
    walk(checker.getReturnTypeOfSignature(g));
  }
  const owner = t.aliasSymbol ?? s;
  for (const p of t.getProperties()) {
    const pt = checker.getTypeOfSymbol(p);
    if (owner && named.has(owner) && checker.getDeclaredTypeOfSymbol(owner) === t)
      lines.add(`${owner.name}.${p.name}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}: ${str(pt)}${isReadonly(p) ? ' (readonly)' : ''}`);
    walk(pt);
  }
};
for (const b of barrels) for (const e of exportsOf(b)) {
  const s = target(e), at = rel(b);
  if (s.flags & ts.SymbolFlags.Value) { const t = valueType(s); lines.add(`${at} ${kind(s)} ${e.name}: ${str(t)}`); walk(t); }
  if (s.flags & ts.SymbolFlags.Type && !(s.flags & ts.SymbolFlags.Class)) {
    const t = checker.getDeclaredTypeOfSymbol(s);
    lines.add(`${at} ${s.flags & ts.SymbolFlags.Interface ? 'interface' : s.flags & ts.SymbolFlags.Enum ? 'enum' : 'type'} ${e.name}: ${str(t, true)}`);
    walk(t);
  }
}
const text = [...lines].sort().join('\n') + '\n';
if (!args.includes('--check')) { writeFileSync(out, text); process.exit(0); }
const was = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean) : []), now = new Set(lines);
const diff = [...[...was].filter(l => !now.has(l)).map(l => `- ${l}`), ...[...now].filter(l => !was.has(l)).map(l => `+ ${l}`)];
if (diff.length) { console.log(`${rel(out)} differs from the surface:\n${diff.join('\n')}`); process.exit(1); }
