# Handoff: the cast-and-fixture residue (#1514)

Written 2026-08-24 against `chore/1514-builder-slot-overloads` at `ff1826591`, where
**test typecheck is 777** and `looseCast` is **1932**. Every number here was measured on that
tree, and **every recipe below was prototyped and then reverted** — none is a guess.

Read `HANDOFF-1514-delegable-clusters.md` §G1–G6 first. Those rules bind you unchanged,
including **G5 as amended**: you may not edit `src/` or `test/helpers/`. Escalate instead.

---

## 0. The loop, every commit, no exceptions

```
bun x tsc --noEmit                                  # src — must print NOTHING
bun x tsc --project tsconfig.test.json --noEmit     # count before/after
bun run check:all                                   # 25 gates
bun test <the files you touched> --timeout=30000    # must pass
bun run test                                        # full suite
bun run check:test-typecheck:update                 # baseline LAST, only if all green
```

`check:test-typecheck` prints `worse: <n>` per file. **`worse` must be 0.** If a file you did
not touch got worse, you changed a shared type — stop.

**Never** run `check:test-escape-hatches:update`. If a counter rises your fix is wrong.

---

## 1. Cluster A — `config-resolution.test.ts` (16 errors) ✅ GREEN, take this first

`test/integration/plugins/config-resolution.test.ts`. Four identical fake optimizer plugins
written against an interface that no longer exists. One cause, one substitution.

Each block reads:

```ts
async optimize(input) {
  return {
    optimizedPrompt: input.prompt,
    estimatedTokens: input.estimatedTokens,   // not a field of PromptOptimizerInput at all
    tokensSaved: 0,
    appliedStrategies: [],
  };
}
```

The real contract is `src/optimizer/types.ts`:

| dead field | real field (`PromptOptimizerResult`) |
|:--|:--|
| `optimizedPrompt` | `prompt: string` |
| `estimatedTokens` | `originalTokens: number` **and** `optimizedTokens: number` |
| `tokensSaved` | `savings: number` (a **ratio 0–1**, not a token count) |
| `appliedStrategies` | `appliedRules: string[]` |

Replace each of the four blocks with:

```ts
async optimize(input) {
  return { prompt: input.prompt, originalTokens: 0, optimizedTokens: 0, savings: 0, appliedRules: [] };
}
```

**Verified safe:** no test in this file asserts on the optimizer's return value — I grepped
every reference. The plugin exists only to be *loaded*, and these tests assert on resolution,
not on optimization. If you find an assertion I missed, stop and escalate rather than
inventing a value that makes it pass.

### The trap in this file — it will not show up in your error count

Lines ~53–62 contain **the same obsolete shape inside a template string** that gets written
to disk as a plugin file:

```ts
optimizer: {
  name: "${plugin.extensions.optimizer.name}",
    optimizedPrompt: input.prompt,
    estimatedTokens: input.estimatedTokens,
    ...
```

It is a string, so **tsc cannot see it** and fixing the four typed blocks will leave it
behind, diverged. Update it to the same real shape. Then re-run the file's tests — it is
loaded for real at runtime, so a mistake there fails as a test failure, not a type error.

**Expected: 16 → 0.**

---

## 2. Cluster B — `story-orchestrator-logs.test.ts` (2 errors) ✅ GREEN

Lines 304 and 373. The `semanticConfig` fixture supplies only `model` and `timeoutMs`.
`SemanticReviewConfig` (`src/review/types.ts:77`) requires **five**:

```ts
semanticConfig: {
  model: "balanced",
  diffMode: "ref",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 1_000,
},
```

`substantiation` and `excludePatterns` are optional — do not add them.

These two were masked until `#1514`'s builder-overload fix landed (STATUS §19): a wholesale
overload rejection reports one error per call and hides every field error underneath it.
Expect no unmask here; it is a leaf.

**Expected: 2 → 0.**

---

## 3. Cluster C — the `Record<string, unknown>` residue (13) 🟡 AMBER, measure first

STATUS §22 cleared the config-literal half of this family (34 → 13) by deleting casts that
did nothing. **The 13 left are a different cause and are not free.** Two shapes:

**C1 — dynamic dep-bag save/restore (4).** `bakeoff/coordinator.test.ts:61,68`,
`bakeoff/run-action.test.ts:39,44`:

```ts
saved[key] = (_coordinatorDeps as Record<string, unknown>)[key];
```

A `keyof D`-typed helper would cover all four, but `Object.keys()` returns `string[]`, so it
needs **one cast at the boundary** (`Object.keys(overrides) as Array<keyof D>`). That is a
`looseCast` +1 in the helper against −4 at the call sites — net −3, which is allowed, but it
is a **design decision, not a mechanical fix**. Write the helper *in the test file that needs
it*, not in `test/helpers/` (G5). If both bakeoff files want it, that is two copies or an
escalation — your call is to escalate.

**C2 — captured-argument reads (rest).** `acceptance-fix.test.ts:209`,
`mutation-summary-completion.test.ts:95`, and singles elsewhere. Each is `capturedInput = input as
Record<...>` where `input` is generic. These are one-offs with no shared fix. **Do them last
or not at all.**

---

## 4. Cluster D — `config/merger.test.ts` (19) 🔴 RED. Do not take this.

I prototyped the obvious recipe and **it made things worse.** Recorded here so you do not
repeat it.

`deepMergeConfig<T = NaxConfig>(base, override): T`. The tests merge arbitrary objects
(`{ a: 1, b: 2 }`), so the default `T = NaxConfig` rejects them — 12 `TS2769`. The obvious
fix is to pass a type argument at all 29 call sites:

```ts
deepMergeConfig<Record<string, unknown>>(base, override)   // ← DO NOT DO THIS
```

Result: 19 → 15, but it **introduced new errors of new kinds** — six `TS2339`
(`Property 'hooks' does not exist on type '{}'`) and six `TS18046`
(`'result.constitution' is of type 'unknown'`). Some call sites genuinely merge real
`NaxConfig` and want the typed result back; a blanket type argument destroys that.

This cluster needs a **per-call-site** decision about what each merge actually produces. That
is judgement, not a recipe, and it is the owner's.

The remaining 6 in this file (`ConstitutionConfig.content` ×4, `NaxConfig.value`/`.config`)
are **dead-fixture-key verdicts** — each needs "is this key dead, or is `src` missing it?"
answered per key. Use the method in `HANDOFF-1514-dead-fixture-keys.md`; do not guess.

---

## 5. The method that found these — use it, not the file list

Clustering by **file** hid every cluster in this doc. Clustering by **what the type is** found
them in one pass:

```bash
bun x tsc --project tsconfig.test.json --noEmit > /tmp/t.txt 2>&1

# group TS2352 by what is being cast TO
grep -oE "error TS2352: Conversion of type .* to type '[^']+'" /tmp/t.txt \
  | sed -E "s/.* to type '([^']+)'/\1/" | sort | uniq -c | sort -rn

# group TS2741 by "missing property -> target type"
grep -oE "error TS2741: Property '[^']+' is missing in type .* but required in type '[^']+'" /tmp/t.txt \
  | sed -E "s/.*Property '([^']+)'.* required in type '([^']+)'/\1 -> \2/" | sort | uniq -c | sort -rn
```

That is how `Record<string, unknown>` (34, across 12 files) and `ParseFn` (15) surfaced.

### Three rules this branch paid for

- **Ask whether the cast does anything before designing a seam.** In STATUS §22 all 36 casts
  were removable outright — no helper, no containment. In §17/§18 they were not. Check first.
- **Probe before editing.** Write the three-line cast-free version, compile it, *then* edit
  the real file. §20 mis-diagnosed a whole phase for want of this.
- **Print the region you just edited.** A scripted exact-string replacement once omitted a
  function's trailing `return base;`, leaving unreachable code after a `return` —
  **not a TypeScript error and not a Biome finding.** No gate can catch it. Read it back.

### Expect the estimate to be wrong, downward

Every cluster on this branch decomposed into 2–5 causes on contact, and removing a wholesale
rejection *reveals* field-level errors underneath it. §19 targeted 50 and got 48. Cluster A's
16 is a count of errors, not of causes. **A file getting worse for one step before it gets
better is normal** — judge on the final number, with `worse: 0`.

---

## 6. Order, and when to stop

1. **Cluster A** (16) — highest confidence, self-contained, has a named trap you now know about.
2. **Cluster B** (2) — trivial, five named fields.
3. **Cluster C1** (4) — only if you are comfortable justifying the helper's one cast. Otherwise skip.
4. **Stop.** D is the owner's, and C2 is not worth a session.

A realistic result is **777 → ~757**. If you find yourself inventing a value, widening a
`src/` type, adding a cast to make an error go away, or arguing that a test is wrong — that
is the escalation signal. Write it up in `STATUS-1514-drain.md` and stop. Every escalation on
this branch so far turned out to be a real defect worth more than the errors it was blocking.
