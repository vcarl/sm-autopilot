// Proof, not product: the scratch generator that made the wire drift check clean against
// @spacemolt/lib 14.2.0 and effect 4.0.0-rc.118 (run beside openapi.json, a libnames.ts that
// imports '@spacemolt/lib', and those node_modules). It breaks the ban list; runbook P0.5 rewrites
// it as scripts/gen-wire.ts. Kept so the five known cases it handles aren't rediscovered.
import {readFileSync, writeFileSync} from 'node:fs';
import {SchemaRepresentation, JsonSchema} from 'effect';
import ts from 'typescript';

const mode = process.argv[2] ?? 'plain';
const spec: {components: {schemas: JsonSchema.Definitions}} = JSON.parse(
  readFileSync('openapi.json', 'utf8').replaceAll('#/components/schemas/', '#/$defs/'));
const defs = spec.components.schemas;
const roots = Object.keys(defs);
const opts = mode === 'default' ? {} : {patterns: 'apply' as const};
let failed = 0;
const asts = roots.flatMap(n => { try { return [SchemaRepresentation.fromJsonSchemaDocument(
  {dialect: 'draft-2020-12', schema: {$ref: `#/$defs/${n}`}, definitions: defs}, opts).ast]; } catch (e) { failed++; console.log('FAIL', n, String(e).slice(0, 160)); return []; } });
console.log(`imported ${asts.length}/${roots.length}`);
if (failed) process.exit(0);
const [first, ...rest] = asts;
const reps = SchemaRepresentation.toRepresentations([first!, ...rest]);
// The importer types an open value (additionalProperties: true, {}) as Schema.Json; the lib types it unknown.
const unjson = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(unjson);
  if (v === null || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return v;
  const o = v as {_tag?: unknown; representation?: {id?: unknown}; annotations?: object};
  if (o._tag === 'Declaration' && o.representation?.id === 'effect/schema/Json') {
    const {expected: _, ...annotations} = (o.annotations ?? {}) as Record<string, unknown>;
    return {_tag: 'Unknown', annotations, checks: []};
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unjson(x)]));
};
const doc = SchemaRepresentation.toCodeDocument(mode === 'json' ? reps : unjson(reps) as typeof reps);
const out = ["import {Schema} from 'effect';"];
for (const r of doc.references.nonRecursives) out.push(`export const ${r.$ref} = ${r.code.runtime};`);
if (Object.keys(doc.references.recursives).length) throw new Error('recursives');
doc.codes.forEach((c, i) => { if (c.runtime !== roots[i] && !out.some(l => l.startsWith(`export const ${roots[i]} =`))) out.push(`export const ${roots[i]} = ${c.runtime};`); });
const suspended = new Set([...out.join('\n').matchAll(/Schema\.Codec<(\w+)>/g)].map(m => m[1]));
for (const n of suspended) out.push(`export type ${n} = typeof ${n}.Type;`);
const src = out.join('\n') + '\n';
writeFileSync('wire.gen.ts', src);
console.log('decls', out.length - 1, 'bytes', Buffer.byteLength(src));
const prog = ts.createProgram(['libnames.ts'], {module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext});
const chk = prog.getTypeChecker();
const sf = prog.getSourceFile('libnames.ts')!;
const mod = chk.getSymbolAtLocation((sf.statements[0] as ts.ImportDeclaration).moduleSpecifier)!;
// Only names that resolve to the generated OpenAPI types: the lib shadows MapSystem with its map-data type.
const genSf = prog.getSourceFiles().find(f => f.fileName.endsWith('/openapi/types.gen.d.ts'))!;
const declared = (s: ts.Symbol) => chk.getDeclaredTypeOfSymbol(s.flags & ts.SymbolFlags.Alias ? chk.getAliasedSymbol(s) : s);
const gen = new Map(chk.getExportsOfModule(chk.getSymbolAtLocation(genSf)!).map(s => [s.name, declared(s)]));
const lib = new Set(chk.getExportsOfModule(mod).filter(s => gen.get(s.name) === declared(s)).map(s => s.name));
console.log('shadowed', chk.getExportsOfModule(mod).filter(s => roots.includes(s.name) && !lib.has(s.name)).map(s => s.name));
const names = roots.filter(n => lib.has(n));
// The lib's generator drops patternProperties and types the record's values `never`; the spec says string.
const patches: Record<string, string> = process.argv[3] === 'nopatch' ? {} : {
  RecoveredBattleSummary: `Omit<L.RecoveredBattleSummary, 'side_factions'> & {side_factions?: {[key: string]: string}}`,
  BattleLogEntry: `Omit<L.BattleLogEntry, 'recovered_summary'> & {recovered_summary?: Lib_RecoveredBattleSummary}`,
  GetBattleLogResponse: `Omit<L.GetBattleLogResponse, 'entries'> & {entries: Array<Lib_BattleLogEntry>}`,
};
const drift = [`import type * as L from '@spacemolt/lib';`, `import type * as Wire from './wire.gen.ts';`,
  `type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;`,
  `type M<T> = unknown extends T ? T : { -readonly [K in keyof T]: M<T[K]> };`,
  ...(patches.RecoveredBattleSummary ? [`export const _libBug: Same<NonNullable<L.RecoveredBattleSummary['side_factions']>, {[key: string]: never}> = true;`] : []),
  ...Object.entries(patches).map(([n, t]) => `type Lib_${n} = ${t};`),
  ...names.map(n => `export const _${n}: Same<M<typeof Wire.${n}.Type>, ${patches[n] ? `Lib_${n}` : `L.${n}`}> = true;`)];
writeFileSync('wire-drift.gen.ts', drift.join('\n') + '\n');
console.log('assertions', names.length);
