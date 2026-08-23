# Handoff: #1514 dead-fixture-keys — verified-safe deletions and renames

Self-contained. You do not need to read the proposal, the issue, or any commit.

**Branch:** `chore/1514-dead-fixture-keys` (off `main` @ `df9bb89b1`).
**Start:** typecheck **1633**, casts **102**,
`asAny=1394, tsSuppress=54, ratchetAllow=107, absentValue=17, anyType=1886, looseCast=2008`.

> **Commit tag:** `(#1514 dead-fixture-keys)`. Do **not** use a "phase N" tag — the original
> #1514 plan already used "phase 3a"/"phase 3c" for unrelated work, so the numbers are
> ambiguous in this repo's history.

**49 errors, 12 keys, 21 files.** Every verdict below was decided against `src/` before this
document was written — the evidence is given so you can confirm, not re-derive. **There is no
judgement work here.** If a site does not match its described shape, escalate.

**Read §1 first.** It is the one behaviour that makes this task different from a find-replace.

---

## 1. Deleting a key usually reveals a second bug — that is expected

TypeScript reports an **unknown property instead of a missing required one** on the same
object literal. So removing a dead key routinely unmasks a `TS2741: Property 'X' is missing`.

That already happened once on this branch. 12 fixtures set `turnId` on a `TurnResult` (the
field lives nested at `protocolIds.turnId`); deleting it revealed that all 18 of those
literals **also** omitted required `internalRoundTrips`. See `59674c69b` for the worked
example.

**So the typecheck total may not drop by the number of keys you delete, and that is not a
failure.** What must hold:

- `bun x tsc --noEmit` (src) stays **0**
- the per-file gate stays **`worse: 0`**
- the full suite stays green

When a deletion reveals a missing required field:

- **A factory exists** (`grep -rn "): <Type>" test/helpers/`) → use it. That is the fix.
- **No factory, ≤2 sites** → write the field out with the value from the type's own default.
- **Anything else** → **escalate**. Do not invent a value, and do not restore the deleted key
  to make the error go away.

---

## 2. Category A — delete these keys (33 errors)

Each was verified to have **zero mentions anywhere in `src/`**, by two independent greps: a
word-boundary regex *and* a plain fixed-string search. Both are needed — a word-boundary
pattern silently fails on a quoted key like `"on-story-complete"`, and a plain substring
search over-matches (`getAll` "hits" `getAllAgents`). One entry was removed from this table
after the second grep caught exactly that; see §9.

The fixture is setting a field nothing reads and no type declares. Delete the whole
`key: value,` line.

| Key | On type | Errors | Files |
|:--|:--|--:|:--|
| `defaultTier` | `RoutingConfig` | 9 | `test/integration/cli/cli-plugins.test.ts` |
| `skipGeneratedVerificationTests` | `TddConfig` | 5 | `cli-precheck-checks`, `cli-precheck-integration`, `precheck-canonical-lint-orchestrator`, `precheck-checks-tier1-blockers`, `precheck-checks-tier2-warnings` (1 each) |
| `minTestCoverage` | `QualityConfig` | 5 | same five files as above |
| `dangerouslySkipPermissions` | `ExecutionConfig`, `DeepPartial<ExecutionConfig>` | 3 | `prompt-acceptance` (2), `completion-review-gate` (1) |
| `getAll` | `PluginRegistry` | 3 | `runner-completion-events`, `runner-completion-postrun`, `runner-completion-skip` (1 each) |
| `maxCostUSD` | `ExecutionConfig` | 3 | `precheck-canonical-lint-orchestrator`, `precheck-checks-tier1-blockers`, `precheck-checks-tier2-warnings` |
| `timeoutRetryCountMap` | `PipelineHandlerContext` | 2 | `test/integration/interaction/interaction-chain-pipeline.test.ts` |
| `estimatedComplexity` | `UserStory` | 2 | `cli-precheck-run`, `utils-helpers` |
| `onWatchdogRegister` | `AcpClientOptions` | 1 | `test/unit/agents/acp/activity-emission.test.ts` |

Two of these deserve a sentence each, because they look riskier than they are:

- **`getAll` is a stub *method*, not a config value** — `getAll: () => []` on a fake
  `PluginRegistry`. The real class exposes `getSource`, `getOptimizers`, `getRouters`,
  `getAgent`, `getReviewers`, `getContextProviders`, `getReporters`, `getPostRunActions`,
  `getPostRunActionRegistrations` — and no `getAll`. Nothing in `src/` calls `.getAll()`, so
  deleting it cannot break a caller. If a test fails after removal, that is a real finding —
  escalate rather than restoring it.
- **`dangerouslySkipPermissions` is documented as live and is not.** `CLAUDE.md` still says it
  is "deprecated — the resolver handles it", but it has **zero** occurrences in `src/`,
  including `src/config/`. Delete the fixture key. **Do not** update `CLAUDE.md` — that is a
  separate finding, and it is noted in §6 for someone to file.

## 3. Category B — rename these keys (16 errors)

TypeScript names the target itself (`TS2561: … Did you mean to write 'X'?`), and each target
was confirmed to exist on the type. Rename the key; **keep the value unchanged**.

| From | To | On type | Errors | Files |
|:--|:--|:--|--:|:--|
| `ruleId` | `rule` | `Finding` | 10 | `semantic-verdict` (3), `rectifier-builder-review-labels` (3), `prompts/builders/rectifier-builder` (2), `prompts/rectifier-builder` (2) |
| `cacheCreationTokens` | `cacheCreationInputTokens` | `TokenUsage` | 4 | `test/unit/agents/fail-stale-complete.test.ts` |
| `naxConfig` | `config` | `RunAdversarialReviewOptions` | 2 | `test/unit/review/adversarial-metadata-audit.test.ts` |

`Finding.rule` is declared `rule?: string` (`src/findings/types.ts:111`) — optional, so
deleting `ruleId` would also typecheck. **Rename, do not delete**: these tests assert on the
value, and dropping it would silently weaken them.

---

## 4. Two traps that already cost time on this branch

**Never regex over a nested object literal.** A non-greedy pattern matches the *inner*
`JSON.stringify({ … })` close brace and shreds the file. When that happens the typecheck
total collapses to a single-digit number, because tsc aborts at the first parse error — if
step 2 of the loop prints `1` or `10`, you broke the syntax. Edit these by hand, or match
braces properly.

**`check:file-sizes` can reject your fix.** `test/unit/execution/story-orchestrator.test.ts`
is grandfathered at 2006 lines against an 800 limit, and other targets may be too. If a fix
would *add* lines to a capped file, make it line-neutral instead (that is why `59674c69b`
adds a field inline there rather than wrapping in a factory). Never lower a file-size
baseline to get past it.

---

## 5. The loop

```bash
# after editing each file
bun x biome check --write test/
bun test <the file you changed> --timeout=60000
```

Per commit (one key, or 2–3 keys of the same category), **all six, in this order**:

```bash
# 1. src must stay clean
bun x tsc --noEmit

# 2. test typecheck count — record it before you start
bun x tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c 'error TS'

# 3. no single file worse than its baseline
bun -e '
const b=require("./scripts/baselines/test-typecheck-baseline.json").byFile;
const out=require("child_process").execSync("bun x tsc --project tsconfig.test.json --noEmit 2>&1 || true",{encoding:"utf8",maxBuffer:1e8});
const cur={};for(const l of out.split("\n")){const m=l.match(/^([^(]+)\(\d+,\d+\): error TS/);if(m)cur[m[1]]=(cur[m[1]]||0)+1;}
const worse=Object.keys(cur).filter(f=>cur[f]>(b[f]??0));
console.log("total:",Object.values(cur).reduce((a,x)=>a+x,0),"| worse:",worse.length);
worse.forEach(f=>console.log("  ",f,(b[f]??0),"->",cur[f]));'

# 4. every gate green — BEFORE any baseline update
bun run check:all

# 5. full suite green
bun run test

# 6. only now, lower the baseline
bun run check:test-typecheck:update
git diff scripts/baselines/   # must have gone DOWN
```

Commit as `test(<area>): drop the dead <key> fixture key (#1514 dead-fixture-keys)` or
`test(<area>): rename <from> to <to> (#1514 dead-fixture-keys)`, with a body line
`typecheck: P -> Q`.

## 6. Forbidden

- Adding `as any`, `: any`, `<any>`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`,
  `@ts-nocheck`, or `// test-ratchet-allow`. This task adds **zero** casts.
- Restoring a deleted key to silence a revealed `TS2741`. The revealed error is the finding.
- Inventing a value for a revealed required field. Use a factory, or the type's own default,
  or escalate.
- Changing any value that is not part of a rename in §3.
- Changing a type in `src/` so a fixture fits. **There is no `src/` change in this task.**
- Touching `CLAUDE.md` for the `dangerouslySkipPermissions` discrepancy — report it instead.
- Deleting, skipping, or `.skip`-ing a test; narrowing a `describe`.
- Lowering a file-size baseline, or `--update-baseline` on a count that grew.

## 7. Escalate — stop and report, do not guess

- A deletion reveals a missing required field with no factory and more than ~2 sites.
- A test fails after a deletion — that means something *was* reading the key, which
  contradicts the evidence here. Report it; it is a finding, not a reason to revert.
- A site does not match the shape described in §2/§3.
- Any counter other than `check:test-typecheck` moves.
- The same file fails twice in a row. Two attempts, then hand it back.

## 8. Definition of done

`bun run check:all` green, `bun run test` green, `bun x tsc --noEmit` = 0, per-file gate
`worse: 0`, typecheck baseline lower. Expected landing: **1633 → ~1584**, though see §1 —
revealed errors may offset some of the drop, and that is acceptable as long as the per-file
gate holds.

**Casts stay at 102 and all six hatch counters stay at or below baseline.** No step may trade
one counter against another.

Report before/after for: src tsc, test typecheck, casts, all six hatch counters, plus any
revealed-required-field findings and the `CLAUDE.md` discrepancy from §2.

## 9. Not in scope

The other ~73 errors of this class, where the key **does** exist in `src/` but not on the type
the fixture claims (`timeout` 318 mentions, `durationMs` 266, `run` 1845, `defaultAgent` 70,
…). Those need someone to read what each test meant to say, one site at a time. They are a
separate pass — do not attempt them.

**Specifically excluded, and worth knowing why:**
`"on-story-complete"` in `test/unit/pipeline/subscribers/hooks.test.ts:47` was in an earlier
draft of §2 as a deletion. **That was wrong.** It *is* a valid `HookEvent`
(`src/hooks/types.ts:11`); the fixture just nests it wrongly — `HooksConfig` is
`{ hooks: Partial<Record<HookEvent, HookDef>> }`, so the correct shape is
`{ hooks: { "on-story-complete": … } }`, not a top-level key. Deleting it would have emptied
the fixture and left the test *"errors in hooks don't propagate to callers"* wiring **zero
hooks** — passing while asserting nothing. Restructuring it is a real fix, and it belongs to
the not-in-scope pass.
