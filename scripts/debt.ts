// node scripts/debt.ts [--tests] [--by-file] [--zero] [path ...]   default path: src
// AST counts of the docs/EFFECT.md ban list. --zero exits 1 unless every count is 0.
import ts from 'typescript';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const paths = args.filter(a => !a.startsWith('--'));
const expand = (p: string) => statSync(p).isDirectory() ? readdirSync(p, {recursive: true}).map(f => join(p, String(f))) : [p];
const files = (paths.length ? paths : ['src']).flatMap(expand)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.gen.ts') && (flag('--tests') || !(f.endsWith('.test.ts') || f.includes('test-support/'))));
const keys = ['cast', 'unknown_cast', 'any', 'non_null', 'ts_comment', 'catch'] as const;
const zero = () => Object.fromEntries(keys.map(k => [k, 0])) as Record<typeof keys[number], number>;
const total = zero();
for (const f of [...new Set(files)].sort()) {
  const text = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
  const n = zero();
  const visit = (node: ts.Node): void => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
        && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(sf) === 'const')) {
      n.cast++;
      if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) n.unknown_cast++;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) n.any++;
    if (ts.isNonNullExpression(node)) n.non_null++;
    // A catch is debt unless its own line says why it is an edge: `catch (e) { // edge: <reason>`.
    if (ts.isCatchClause(node) && !/\/\/ edge:/.test(text.split('\n')[sf.getLineAndCharacterOfPosition(node.getStart(sf)).line] ?? '')) n.catch++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  n.ts_comment = (text.match(/@ts-(ignore|expect-error|nocheck)/g) ?? []).length;
  for (const k of keys) total[k] += n[k];
  if (flag('--by-file') && keys.some(k => n[k])) console.log(f, JSON.stringify(n));
}
console.log(JSON.stringify({files: files.length, ...total}));
if (flag('--zero') && keys.some(k => total[k])) process.exit(1);
