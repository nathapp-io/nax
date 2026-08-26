# HANDOFF — `noExplicitAny` drain, batch 10 (the thirty-four-file tier tied at 2)

Delegation brief for the queue head recorded in `STATUS-test-debt-drain.md` §8.22. Read that
doc's **§4 (forbidden list), §3 (per-commit loop), §5 (escalation rules)** before starting —
they are binding and are not repeated in full here. Also read **§0.1**: biome is the
authoritative counter, the regex ratchet is only the fast tripwire.

Branch: `fix/drain-no-explicit-any-story-orchestrator`. Baseline at hand-off: biome
`noExplicitAny` **127 across 86 files**. This batch: **34 files tied at 2 (68 sites)** taken
to zero by four delegates on disjoint file sets. `interaction/plugins/cli.test.ts` (8 sites)
is **out of scope** — held escalation, src-blocked (§8.19); do not touch it.

---

## 0. What you must not do

- **No counter may rise so another can fall.** Adding `as any`, `as never`, `as X`,
  `@ts-ignore`/`@ts-expect-error`, `absentValue<T>()`, or `// test-ratchet-allow` markers is a
  trade, refused at review. Both ratchets must stay green after every file.
- **Do not edit `src/` or `test/helpers/**`.** If the honest fix is a source-type change or a
  shared-helper change, escalate with file:line and reason instead.
- **Do not delete/skip a test, narrow a describe, weaken an assertion, or exclude a file from
  tsconfig.test.json.**
- **Do not commit. Do not run any `--update-baseline` script.** The owner integrates.
- **Do not quote the drained shape in surviving prose/comments** — the raw-text ratchet counts
  backticked text (`[:<|&,(]\s*any\b` matches inside code spans; §8.16).
- **Never invoke bare `bun test <path>` without `--timeout=60000`** — bunfig.toml defaults to
  5s and slow files cascade misleading failures across files (§8.13).

## 1. Your file set

Each delegate owns exactly these files. Nobody else touches them; you touch nothing else.
(The sets are listed in your dispatch prompt; this section is intentionally empty.)

## 2. Standing recipes — proven in batches 1–9, apply by shape

| Shape | Recipe |
|:--|:--|
| dead cast on a value/type the declared types already admit | delete outright — **first question at every site: is this cast doing anything at all?** Largest single family in batches 6–9 |
| hand-rolled runtime bag `{ agentManager, … } as any` | `makeMockRuntime({ … })` / `makeMockCallContext()` / `makeTestContext()` / `makeTestRuntime()` from `@test/helpers` |
| partial-config literal | `makeNaxConfig(overrides)`; `makeSparseNaxConfig` where an *omission* is under test |
| story / PRD fragments | `makeStory(...)` / `makePRD(...)` / `makeResolvedTestPatterns(...)` |
| generic dep slot `<I, O, C>` | `makeCallOp({ fallback, onDispatch })`; or mock typed via `Parameters<typeof origFn>` and swapped with `Object.assign(_deps, {…})` + finally-restore |
| spawn mocks / `(Bun as any).x` patches | `makeSpawn(...)` / `makeSpawnResult(...)`; `Object.assign(Bun, { … })` with restore likewise |
| union-member call `(op.retry as any)(…)`, `(op.build as any)` | `typeof === "function"` guard, `"prop" in` narrowing, deterministically-typed local |
| absent-key probes `(x as any)?.key` | local predicate via `key in obj`, undefined-safe |
| loosely typed `test.each` rows | explicit `test.each<[TupleTypes]>(…)` generic |
| poke narrows a type (setting a key undefined) | §8.12 weak alias: `const w: { mode?: T } = obj; w.mode = undefined;` — no assertion needed; extends to null (`§8.22`: `{ acceptanceCriteria?: string[] \| null }`) |
| `session!.x` / non-null after async load | `assertDefined(x, …)` from `@test/helpers` right after the load |
| incomplete object the type requires | complete the fixture at its declared type; `satisfies RealType` gets you contextual typing |
| deliberate illegal literal under test | supply via `JSON.parse('…')` — the corruption arrives as JSON in production (profile.test.ts precedent) |
| omission-under-test fixtures | factory base + weak alias + `delete` for genuinely-absent keys (precheck-tier1 precedent) |

### Known traps

- **`Partial<NaxConfig>` is not deep** (§8.19): nested sections must be complete — build full
  sections through `makeNaxConfig({ section: {...} })`, don't nest partial literals.
- **Factory returns are unsafe to mutate below top level** (§8.20): `deepMerge` shares unmodified
  subtrees with `DEFAULT_CONFIG`, so writes poison other tests process-wide.
  `structuredClone(makeNaxConfig())` before ANY write-through.
- **What the fixture omits can be the thing under test** (§8.4/§8.17): before completing a
  fixture, check whether an omission drives a fallback/default branch. Complete only at call
  sites that need it; use `makeSparseNaxConfig` for intentional sparseness.
- **Fixture-value corrections are allowed** when the old cast masked an impossible value, IF
  every assertion still passes unchanged — report each one (file:line, old → new value, why).
  If the corrected value feeds a classifier/switch branch, say so in your report (owner runs
  coverage).
- **Ratchet false positive** (§8.14): a comment whose last word ends in `-as` directly above a
  line starting with a capitalised word reads as one `looseCast`. Reorder lines rather than
  rewording meaninglessly.

## 3. Per-file gate loop — everything cheap, every file

```bash
# 1. see this file's sites (authoritative):
bun x @biomejs/biome@2.5.10 check --config-path=/tmp/biome-probe "$PWD/<file>" \
  --reporter=json --max-diagnostics=50000 2>/dev/null \
| python3 -c "import json,sys,collections;d=json.load(sys.stdin)['diagnostics'];print(collections.Counter(x['category'] for x in d))"

# NOTE: pass ABSOLUTE paths — relative args resolve against the --config-path dir.
# The probe config already exists at /tmp/biome-probe/biome.json (organizeImports off).

# 2. fix (recipes above)

# 3. gates, in order:
bun x tsc --noEmit -p tsconfig.test.json          # 0 errors
bun test <file> --timeout=60000                    # green, same test count as before
bun run check:test-as-unknown-as                   # green
bun run check:test-escape-hatches                  # green
bun run check:file-sizes                           # green
bun run check:deep-relatives                       # green
```

A file is done when its `noExplicitAny` count reads 0 in step 1 and all six gates stay green.
If a gate you did not cause fails, report it — do not chase it into another delegate's files.
**Known blind spot:** the probe config turns `organizeImports` off, so your loop cannot see
import-order problems — the owner runs one repo-config pass over touched files at integration;
do not try to fix that yourself.

## 4. Stop and hand back when

- The same file fails twice in a row — two attempts, then report.
- Removing a cast changes what the test asserts.
- The error names a **source** type, not the fixture.
- A private-member injection site with no existing seam — that is src-blocked (§8.19 ruling);
  record it and leave the site, do not invent a third workaround.
- You cannot reach 0 without adding any counted escape hatch.

## 5. Report format

Per file: sites found (with line numbers) → recipe applied → final biome count for the file →
test count before/after. Plus: every fixture-value correction (old → new, why safe), every
escalation (file:line, reason, proposed seam if src-blocked), and anything you deliberately
left. **Do not report a count you have not read out of the biome JSON output.**
