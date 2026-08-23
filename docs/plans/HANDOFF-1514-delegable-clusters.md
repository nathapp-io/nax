# HANDOFF: #1514 test-typecheck drain — clusters safe to delegate

**Audience:** a fresh session on a cheaper model.
**Baseline at handoff:** 1030 errors across 276 files (`main` @ the commit that adds this file).
**Status doc:** `docs/plans/STATUS-1514-drain.md` — read §11 and the "Rules" sections before starting.

This file names three clusters that are safe to execute mechanically, three that are **not**,
and the guardrails that make the difference. Every recipe below was validated on real code
before being written down; where a recipe failed, that failure is recorded rather than hidden.

---

## 0. Guardrails — read these first, they are not optional

### G1. A big sudden drop in the error count means you broke a file, not that you succeeded

This is the most dangerous failure mode and it looks exactly like a win.

While preparing this handoff a regex introduced a syntax error into one test file. The
project-wide count went **1067 → 16**. Nothing had been fixed: a parse failure stops `tsc`
from reporting semantic errors across the project, so 1051 real errors simply stopped being
counted.

**Before believing any drop larger than the cluster you touched:**

```bash
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -E "error TS1[0-9]{3}:"
```

`TS1005`, `TS1109`, `TS1128` and friends are **syntax** errors. On a healthy tree this
command prints **nothing**. (Note `TS18046`/`TS18047`/`TS18048` are five digits and are
*not* syntax errors — do not confuse them.)

### G2. Never run a `--update-baseline` command except the two named in §4

Specifically: never run `check:test-escape-hatches:update`. That baseline is the only thing
standing between this drain and silent debt. Raising it converts "I hid an error" into
"the gate is happy". If a counter rises, **your fix is wrong** — revert it and pick a
different approach.

### G3. Never delete or skip a test to remove an error

Deleting a test lowers the count and removes coverage. If a test looks wrong, stop and write
it up in the status doc instead.

### G4. These six counters may go down or stay flat. They may never go up

`asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`, `anyType`, `looseCast` — plus
`as unknown as`, tracked separately by `check:test-as-unknown-as`.

A typecheck drop paired with a counter rise is a **failed** change, not a partial win. The
gate enforces this and names the offending file, so you will find out; the point is not to
get there.

**The uncounted hole to stay out of:** the non-null assertion `!` is matched by *none* of the
six patterns. `foo!.bar` silences a `TS18048` and no ratchet can see it. That is why §5.1
below is on the do-not-delegate list.

### G5. Do not edit anything in `test/helpers/` or `src/`

`test/helpers/` is shared by hundreds of files; a change there is a design decision with a
blast radius no per-cluster verification will catch. `src/` is out of scope entirely — this
is a test-fixture drain.

If a cluster seems to *need* a helper change, that is the signal to **stop and escalate**,
not to make the change. A prior handoff (`HANDOFF-1514-mechanical-fixture-fields.md`) said a
file was "out of scope" but did not say its shared helper was, and the helper got extended
anyway. Hence this rule stated plainly.

### G6. Regex is for finding, hand-editing is for fixing

Two of the recipes below were originally attempted as regex substitutions. One worked
(§1, flat call expressions). One silently corrupted nested object literals and made the file
*worse* — 10 errors → 19 (§5.3). Nested braces defeat regex. Use `grep -n` to locate sites,
then edit each one.

---

## 1. Cluster A — event handlers that return a value  ✅ DONE, use as the worked example

**Already fixed** in the commit that adds this file. Read its diff first: it is the reference
for what "mechanical" looks like here.

30 errors, 5 files, one cause: an arrow handler whose body is `array.push(x)` returns a
`number`, but the listener signature is `(e) => void | Promise<void>`.

```ts
// before — push() returns number
bus.on("story:completed", (e) => received.push(e));

// after — braces discard the return
bus.on("story:completed", (e) => {
  received.push(e);
});
```

Where braces do not fit (a one-line object-literal property), `void` is the idiomatic
alternative and is **not** a counted escape hatch:

```ts
onTick: (s) => void ticks.push(s),
```

---

## 2. Cluster B — `createDebateRunner` stubs  ✅ RECIPE VALIDATED, 2 files left

`makeDebateRunner()` already exists in `test/helpers/debate-runner.ts` and its docstring
describes exactly this use. `DebateRunner` is a class with eight `private readonly` fields,
so a `{ runPlan }` object literal can never satisfy it structurally.

```ts
// before
_planDeps.createDebateRunner = mock(() => ({ runPlan: runPlanMock }));

// after
_planDeps.createDebateRunner = mock(() => makeDebateRunner({ runPlan: runPlanMock }));
```

Add `makeDebateRunner` to the existing `@test/helpers` import; do not add a second import line.

**Validated:** applied to `test/unit/cli/plan-debate.test.ts` (7 sites) in the accompanying
commit — that file went **22 → 15**, 11 tests still pass.

**Remaining (yours):**
- `test/unit/cli/plan-decompose-ac-repair.test.ts`
- `test/integration/plan/plan-callop.test.ts`

Find them with:
```bash
grep -rn "createDebateRunner = mock(() => ({" test/
```

Expect a partial drop, not zero: these files have unrelated errors too. Only claim the ones
whose message mentions `DebateRunner`.

---

## 3. Cluster C — PRD / UserStory object literals  ⚠️ HAND-EDIT ONLY

~11 errors, 5 files. Literals missing required fields:
`PRD` wants `project`, `feature`, `branchName`, `createdAt`, `updatedAt`;
`UserStory` wants `tags`, `dependencies`, `passes`, `escalations`, `attempts`.

`makePRD()` and `makeStory()` in `test/helpers/mock-story.ts` supply every one, and both take
a `Partial<>` override, so the fix preserves whatever the test actually set:

```ts
// before
const prd = {
  feature: "test-feature",
  userStories: [{ id: "US-001", title: "Story 1", status: "pending" as const, ... }],
};

// after
const prd = makePRD({
  feature: "test-feature",
  userStories: [makeStory({ id: "US-001", title: "Story 1", status: "pending" })],
});
```

Note `"pending" as const` can drop its `as const` — `makeStory`'s parameter type supplies the
contextual type.

**Read G6 before starting.** A regex attempt on
`test/integration/pipeline/reporter-lifecycle-basic.test.ts` took it from 10 errors to 19
because the story literals nest inside the PRD literal and brace-matching went wrong. It was
reverted. Do these by hand, one `const prd` at a time, re-running the per-file check after each.

Sites:
```bash
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -E "from type 'PRD'|from type 'UserStory'"
```
- `reporter-lifecycle-basic.test.ts` (6)
- `reporter-lifecycle-resilience.test.ts` (3)
- `storyid-events.test.ts` (1), `subscribers/interaction.test.ts` (1)

---

## 4. The loop — run this for every single commit, in this order

Work **one cluster per commit**. Do not batch clusters.

```bash
# 1. count before
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -cE "^test/.*error TS"

# 2. ... make the edits ...

# 3. no syntax errors introduced (G1) — must print nothing
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -E "error TS1[0-9]{3}:"

# 4. count after — the drop must roughly match the cluster size
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -cE "^test/.*error TS"

# 5. the files you touched still pass
bun test <each file you edited> --timeout=60000

# 6. format
bun run lint:fix

# 7. full suite — all three phases must pass
bun run test

# 8. counters: flat or down, never up (G4)
bun run scripts/check-test-escape-hatches.ts

# 9. update the ONE allowed baseline, in the same commit as the fix
bun run check:test-typecheck:update

# 10. all 25 gates
bun run check:all
```

Step 9 is the only `--update-baseline` you may run (see G2).

---

## 5. Do NOT delegate these — and why

### 5.1 `TS18046` / `TS18047` / `TS18048` "possibly undefined" — 43 errors

Looks like the easiest cluster in the repo. It is a trap.

The natural fix is `result.hooks!.foo`, and `!` is matched by **none** of the six ratchet
patterns (G4). You would delete 43 typecheck errors and create 43 pieces of debt that no gate
can ever see again — the exact failure this drain exists to avoid.

The honest fix is per-site and needs judgement: `expect(x).toBeDefined()` does not narrow for
TypeScript, and `expect(result.hooks?.foo).toBe(...)` can weaken an assertion into vacuous
truth when the expected value is itself `undefined`. Needs a human decision per site, or a
counted helper designed first.

### 5.2 `test/integration/plugins/loader.test.ts` — 22 errors

The optimizer stubs return `{ optimizedPrompt, estimatedTokens }`. The real
`PromptOptimizerResult` (`src/optimizer/types.ts:34`) is
`{ prompt, originalTokens, optimizedTokens, savings, appliedRules }`, and
`PromptOptimizerInput` has no `estimatedTokens` at all. The fixture predates an interface
change and every assertion around it has to be re-read against the current type.

Needs a `makeOptimizerResult()` helper designed first — which is a `test/helpers/` change,
forbidden by G5. Escalate; do not improvise.

### 5.3 `parallel-batch.test.ts` (36), `story-orchestrator-*` (73), config suites (63+)

`Mock<() => X>` values assigned to multi-parameter function slots, plus config-shape drift.
Each needs the real signature read and the mock's parameters annotated individually. No single
recipe covers them, and several are entangled with `makeMockRuntime` wiring.

---

## 6. What "done" looks like

A PR per cluster, each with: the before/after count, confirmation that step 3 printed nothing,
the counter line from step 8, and one sentence on anything the fix unmasked.

If a cluster unmasks more errors than it fixes, **revert it** and say so in the status doc —
that is a real result, not a failure. §11 of the status doc records one such case that was
kept because the arithmetic still came out ahead, and the reasoning is worth copying.

Append a numbered section to `docs/plans/STATUS-1514-drain.md` for each cluster you finish.
