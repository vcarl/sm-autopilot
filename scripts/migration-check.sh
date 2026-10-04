#!/usr/bin/env bash
# The whole-project definition of done for the Effect migration. Exit 0 = done, F-final flown.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
T=docs/effect-migration-progress.md
npm run typecheck
npx effect-language-service patch >/dev/null && npm run typecheck      # floatingEffect
npm test                                                               # includes readme-examples
shopt -s nullglob                                                      # every *.test.ts must be one the test script runs
picked=$(printf '%s\n' $(node -p 'require("./package.json").scripts.test.replace(/^node --test /,"")') | sort)
[ "$(find src -name '*.test.ts' | sort)" = "$picked" ] || { echo 'test files the test script does not run'; exit 1; }
npm run lint
node -e 'const off=v=>["off","allow",0].includes(Array.isArray(v)?v[0]:v);
  const o=JSON.parse(require("fs").readFileSync(".oxlintrc.json","utf8")).overrides??[];
  const left=o.filter(x=>off(x.rules?.["typescript/consistent-type-assertions"])).flatMap(x=>x.files).filter(f=>!/test/.test(f));
  if(left.length){console.error("migration override list not empty:",left);process.exit(1)}'
npm run gen:wire && git diff --exit-code -- src/wire.gen.ts src/wire-drift.gen.ts
node scripts/surface.ts --check
node scripts/debt.ts --zero src                                        # outside tests and *.gen.ts
if grep -rn 'tryPromise' src --include='*.ts' | grep -v -e '^src/play/game.ts:' -e '\.test\.ts:'; then echo 'tryPromise outside Game'; exit 1; fi
if grep -rn '// bridge: U' src; then echo 'unconverted crossings remain'; exit 1; fi
if grep -E '^\| (P0\.[0-9]+[a-z]?|U[0-9]{2}|M-[A-Za-z0-9]+|F-[A-Za-z0-9]+) \|' "$T" | grep -vE '^\| ([^F|][^|]* \| done|F-[A-Za-z0-9]+ \| flown) \|'; then echo 'tracker rows not done'; exit 1; fi
grep -qE '^\| M-final \| done \|' "$T"                                  # the rows exist at all
grep -qE '^\| F-final \| flown \|' "$T"
