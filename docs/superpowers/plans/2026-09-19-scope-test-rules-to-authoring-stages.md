# Scope Test-Authoring Rules to Test-Authoring Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping ~27 KB of test-authoring rules to the fresh TDD implementer session, which is forbidden from writing tests, by narrowing four rule files' `stages:` frontmatter — and pin the narrowing with a regression test so it cannot silently widen again.

**Architecture:** nax already has a working role/stage axis: `stages:` frontmatter on each `.nax/rules/*.md`, matched against the assembling context-engine stage by `StaticRulesProvider`. Nothing in nax's code is wrong. The four rules that exist purely for test *authors* list `tdd-implementer` in their own `stages:`, so the provider correctly ships them. This is a frontmatter change plus a guard test. No `src/` change.

**Tech Stack:** Markdown frontmatter (`.nax/rules/*.md`), TypeScript, Bun (`bun:test`).

**Spec:** No separate spec file — evidence and scope boundary are inline in "Background" below. Source analysis: `projects/nax/nax-implementer-test-writer-prompt-enhancement-2026-09-19.md` (outside this repo; §F-1 of rev 2).

## Global Constraints

- Repo root for all paths: the worktree root. Branch: `feat/scope-test-rules-to-authoring-stages`, based on `origin/main` @ `e0659eb7f`.
- **Never run bare `bun test`.** Use `bun run test` (full suite) or `CI=1 AGENT=1 bun test --timeout=60000 <files>` (scoped).
- Static gates, all must pass before the final commit: `bun x tsc --noEmit`, `bun x tsc --noEmit -p tsconfig.test.json`, `AGENT=1 bun run lint:biome`, `AGENT=1 bun run check:all-without-biome`.
- **`.nax/rules/` is the source of truth. `.claude/rules/` is generated** by `nax rules export --agent=claude` and gated by `scripts/check-rules-drift.ts` (which runs inside `check:all-without-biome`). Never hand-edit `.claude/rules/`.
- Edit **only** the `stages:` list in the four named files. Do not touch `priority:`, `appliesTo:`, `description:`, or any rule body — `appliesTo:` is a *path-glob* axis and means something different (see Background).
- Conventional commits: `fix:`, `test:`, `chore:`.

---

## Background — why the implementer carries test rules

### Measured

`us-001-implementer-run-t01` from the `native-agent-scratchpad` run (2026-09-18) is 101.3 KB. Its rule fragments:

| block | KB | % of prompt |
|---|---:|---:|
| test-ratchets.md | 17.5 | 17.2 |
| forbidden-patterns-source.md | 10.6 | 10.4 |
| monorepo-awareness.md | 10.0 | 9.9 |
| project-conventions.md | 9.2 | 9.1 |
| **ROLE (the actual task)** | **7.9** | **7.8** |
| testing-commands.md | 5.5 | 5.4 |
| forbidden-patterns-tests.md | 4.9 | 4.8 |
| test-architecture.md | 4.4 | 4.3 |
| test-helpers.md | 4.0 | 4.0 |
| config-patterns.md | 3.4 | 3.4 |
| error-handling.md | 2.9 | 2.9 |
| test-writing.md | 1.3 | 1.3 |

Static rules are ~73 KB (73%); story-specific content is ~10 KB (10%). The implementer's own Rules block says *"Do NOT modify test files"*, yet test-ratchets + testing-commands + forbidden-patterns-tests + test-architecture + test-helpers + test-writing = **32.7 KB, 32% of the prompt.**

Across both features' implementer and test-writer sessions there were **1,492 model calls**, and the preamble is re-sent on every one. implementer + test-writer accounted for **84% of run cost**.

### The mechanism — two gates, both passing legitimately

`StaticRulesProvider` (`src/context/engine/providers/static-rules.ts`) selects canonical rules by two independent pieces of frontmatter:

- **`stages:`** — the role/stage axis. Matched against the assembling stage by `ruleMatchesStage` (`static-rules.ts:153`). **Fail-open: a rule with no `stages:` key is universal.**
- **`appliesTo:`** — **path globs**, matched against `request.scopeFiles` by `ruleMatchesScopeFiles` (`static-rules.ts:133`). Not a role list.

The role axis **works** — verified against the artifacts. `forbidden-patterns-source.md` declares `stages: [context, execution, tdd-implementer, rectify, autofix, single-session, tdd-simple]` (no `tdd-test-writer`), and it is present in the implementer prompt and absent from the test-writer's:

```
us-001 implementer : … forbidden-patterns-source.md, forbidden-patterns-tests.md, … test-ratchets.md, test-writing.md, testing-commands.md
us-001 test-writer :                                 forbidden-patterns-tests.md, … test-ratchets.md, test-writing.md, testing-commands.md
```

(Measured from the rendered `### <file>.md` headers in the prompt body. Do **not** measure from the `[project] …` lines under `## Prior Stage Summary` — that is the *previous* stage's chunk manifest and over-reports.)

So the test rules reach the implementer because:

1. **`stages:`** — all six explicitly list `tdd-implementer`. An authoring choice, not an omission.
2. **`appliesTo: test/**`** — matches because `scopeFiles` contains test files. `resolveScopeFiles` (`src/pipeline/scope-files.ts:38`) = PRD `contextFiles` ∪ `expectedFiles` ∪ `git diff` since the story ref, and the PRD names test files directly:

```
US-001 contextFiles  = [src/tools/types.ts, src/tools/policy.ts, src/utils/realpath.ts,
                        test/unit/tools/policy.test.ts]
US-002 expectedFiles = [src/tools/scratchpad.ts, test/unit/tools/scratchpad.test.ts]
```

The path gate therefore matches before any commit, and again afterwards because in three-session TDD the test-writer has already committed its tests by the time the implementer's bundle is assembled. **Only gate 1 is addressable by frontmatter.** That is what this plan changes.

### Which stage the implementer actually uses — verified

`src/context/engine/phase-stage-map.ts:18-21`:

```ts
const THREE_SESSION_STAGE_MAP = {
  "test-writer": "tdd-test-writer",
  implementer: "tdd-implementer",
  verifier: "tdd-verifier",
};
```

and `src/context/engine/phase-stage-map.ts:57-62`:

```ts
const RECTIFICATION_STAGE_MAP = {
  "autofix-implementer": "rectify",
  "full-suite-rectify": "rectify",
  "repo-scoped-test-fix": "rectify",
  implementer: "rectify",          // checked BEFORE the three-session branch
};
```

So removing `tdd-implementer` affects **only the fresh implementer session** (`implementer-run-t01`). Every rectification turn resolves to `rectify`, which all four files keep. This is the conservative property that makes the change safe: the rectifier — the one implementer context that legitimately edits tests, under the three narrow exceptions — is untouched.

### Which four, and why not the other two

| Rule | KB | `tdd-implementer`? | Decision |
|---|---:|---|---|
| `test-ratchets.md` | 17.7 | remove | Governs writing test files. Roughly half is dated changelog (`### Tier 1/2/3 promotions (2026-08-28)`). Kept on `rectify`. |
| `test-architecture.md` | 4.6 | remove | Directory structure, placement, naming — decisions only an author makes. |
| `test-helpers.md` | 4.3 | remove | Which shared mock factory to use when writing a test. |
| `test-writing.md` | 1.7 | remove | Test-writing rules, by name. |
| `testing-commands.md` | 5.8 | **KEEP** | The implementer runs scoped tests every cycle and needs the mandatory `timeout` wrapper and the scoped-run recipe. |
| `forbidden-patterns-tests.md` | 5.4 | **KEEP** | Cheap, and the implementer's three test-edit exceptions (lint-only fix, contract drift, sibling rename) can violate it. |

Expected removal: **~28.3 KB off the fresh implementer prompt (~28%).**

### Honest limits of this change

- **The cost saving is modest.** Rules ride the prompt cache (`cacheRead` at 0.015/1M vs 0.075/1M for input), and transcript growth is the larger half of the 185M cacheRead tokens observed. The primary win is attention — a role told 28% of the time about work it is forbidden to do — not price.
- **It does not touch the `appliesTo` path gate.** Making the intent declarative in nax's own code (an `authorsTestFiles` stage flag mirroring the existing `producesTestFiles`) is deliberately out of scope here; it is a `src/` change needing its own plan.
- **It does not change the rules budget.** `kind: "static"` is a `FLOOR_KIND` (`src/context/engine/packing.ts:54`) and bypasses both the min-score filter and the packing budget by design. That is nax#2061, already ruled (concede + reserve; `enforceBudget: false` stays). Do not reopen it here.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `.nax/rules/test-ratchets.md` | modify (frontmatter only) | Drop `tdd-implementer` from `stages:`. |
| `.nax/rules/test-architecture.md` | modify (frontmatter only) | Same. |
| `.nax/rules/test-helpers.md` | modify (frontmatter only) | Same. |
| `.nax/rules/test-writing.md` | modify (frontmatter only) | Same. |
| `test/unit/context/rules/nax-rules-stage-scoping.test.ts` | **create** | Reads this repo's real `.nax/rules/` and pins which rules each TDD stage admits — both directions, so neither a silent widening nor an over-narrowing passes. |

---

### Task 1: Pin the stage scoping, then narrow the four rules

Test first. The test reads the repo's actual rule files through the real loader, so it fails now (the four rules still name `tdd-implementer`) and passes after the edit. A mocked-loader unit test would prove nothing here — the artifact under change *is* the repo's frontmatter.

**Files:**
- Create: `test/unit/context/rules/nax-rules-stage-scoping.test.ts`
- Modify: `.nax/rules/test-ratchets.md`, `.nax/rules/test-architecture.md`, `.nax/rules/test-helpers.md`, `.nax/rules/test-writing.md` (each: one line removed from `stages:`)

**Interfaces:**
- Consumes: `loadCanonicalRules(workdir: string): Promise<CanonicalRule[]>` and the `CanonicalRule` type, both exported from `@/context` (`src/context/index.ts:48-53`). `CanonicalRule.stages?: string[]` and `CanonicalRule.fileName: string` are the two fields used.
- Produces: nothing importable. Task 2 consumes only the files this task edits.
- Note: `loadCanonicalRules` is not memoized — the per-workdir cache lives in a separate wrapper (`src/context/engine/providers/canonical-rules-cache.ts`) used by the provider. Calling it directly reads from disk, so no cache reset is needed.

- [ ] **Step 1: Record the current state**

```bash
for f in test-ratchets test-architecture test-helpers test-writing testing-commands forbidden-patterns-tests; do
  echo "--- $f"; awk '/^---$/{n++; next} n==1' ".nax/rules/$f.md"
done
```

Expected: all six list `tdd-implementer` under `stages:`. If any already lacks it, stop and re-read Background — the premise has changed.

- [ ] **Step 2: Write the failing test**

Create `test/unit/context/rules/nax-rules-stage-scoping.test.ts`:

```ts
/**
 * Stage scoping of THIS repo's own .nax/rules/*.md.
 *
 * `stages:` frontmatter is the role axis: StaticRulesProvider admits a rule to
 * a context-engine stage only when the stage is listed (ruleMatchesStage,
 * src/context/engine/providers/static-rules.ts). It is FAIL-OPEN — a rule with
 * no `stages:` key is universal — so this file asserts both directions:
 * rules that must NOT reach a stage, and rules that must.
 *
 * Why the assertion is worth having: the fresh TDD implementer session
 * (op `implementer` -> stage `tdd-implementer`, phase-stage-map.ts) is
 * forbidden from writing test files, yet the four test-authoring rules below
 * listed that stage and made up ~28% of its prompt. Re-adding the stage is a
 * one-line edit in a file nobody reads twice; this test is what notices.
 *
 * Deliberately reads the real files rather than a fixture: the artifact under
 * test IS this repo's frontmatter, so a mocked loader would assert nothing.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadCanonicalRules } from "@/context";
import type { CanonicalRule } from "@/context";

// test/unit/context/rules/<this file> -> repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The fresh TDD implementer session's stage. Rectification turns use `rectify`. */
const IMPLEMENTER_STAGE = "tdd-implementer";
const TEST_WRITER_STAGE = "tdd-test-writer";
const RECTIFY_STAGE = "rectify";

/** Rules that exist for whoever AUTHORS test files. */
const TEST_AUTHORING_RULES = [
  "test-ratchets.md",
  "test-architecture.md",
  "test-helpers.md",
  "test-writing.md",
] as const;

/**
 * Test-related rules the implementer legitimately needs:
 *  - testing-commands: it runs scoped tests every cycle (timeout wrapper, scoped recipe).
 *  - forbidden-patterns-tests: its three narrow test-edit exceptions can violate these.
 */
const IMPLEMENTER_TEST_RULES = ["testing-commands.md", "forbidden-patterns-tests.md"] as const;

let cached: CanonicalRule[] | undefined;
async function rules(): Promise<CanonicalRule[]> {
  cached ??= await loadCanonicalRules(REPO_ROOT);
  return cached;
}

async function ruleNamed(fileName: string): Promise<CanonicalRule> {
  const found = (await rules()).find((r) => r.fileName === fileName);
  if (!found) throw new Error(`.nax/rules/${fileName} not found — was it renamed or deleted?`);
  return found;
}

describe("nax .nax/rules — the loader sees a usable rule set", () => {
  test("the canonical store loads and every rule declares stages", async () => {
    const all = await rules();
    expect(all.length).toBeGreaterThan(0);

    // `stages:` is fail-open, so a rule that drops the key silently becomes
    // universal — which is the failure mode this whole file guards against.
    const universal = all.filter((r) => r.stages === undefined || r.stages.length === 0);
    expect(universal.map((r) => r.fileName)).toEqual([]);
  });
});

describe("nax .nax/rules — test-authoring rules are scoped to authoring stages", () => {
  for (const fileName of TEST_AUTHORING_RULES) {
    test(`${fileName} does NOT reach the fresh implementer session`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages).toBeDefined();
      expect(rule.stages, `${fileName} must not list ${IMPLEMENTER_STAGE}`).not.toContain(IMPLEMENTER_STAGE);
    });

    test(`${fileName} still reaches the test-writer`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${TEST_WRITER_STAGE}`).toContain(TEST_WRITER_STAGE);
    });

    test(`${fileName} still reaches rectification`, async () => {
      // Rectification turns dispatch the `implementer` op onto the `rectify`
      // stage (RECTIFICATION_STAGE_MAP is consulted before the three-session
      // branch), and that is the implementer context that may edit tests under
      // the three narrow exceptions. Narrowing must not reach it.
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${RECTIFY_STAGE}`).toContain(RECTIFY_STAGE);
    });
  }
});

describe("nax .nax/rules — the implementer keeps the test rules it needs", () => {
  for (const fileName of IMPLEMENTER_TEST_RULES) {
    test(`${fileName} still reaches the fresh implementer session`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${IMPLEMENTER_STAGE}`).toContain(IMPLEMENTER_STAGE);
    });
  }
});

describe("nax .nax/rules — source rules stay off the test-writer", () => {
  test("forbidden-patterns-source.md does not reach the test-writer", async () => {
    // The mirror image of the narrowing above, and the observation that proved
    // the `stages:` axis works at all: this rule is in the implementer prompt
    // and absent from the test-writer's.
    const rule = await ruleNamed("forbidden-patterns-source.md");
    expect(rule.stages).not.toContain(TEST_WRITER_STAGE);
    expect(rule.stages).toContain(IMPLEMENTER_STAGE);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/context/rules/nax-rules-stage-scoping.test.ts
```

Expected: **4 FAIL** — one `does NOT reach the fresh implementer session` per test-authoring rule. Every other test in the file should PASS right now; those are the regression half that proves the narrowing does not overshoot.

If a `still reaches the test-writer` or `still reaches rectification` case fails before any edit, stop: that rule's `stages:` is not what Background recorded, and the narrowing below would remove a stage the rule needs.

- [ ] **Step 4: Narrow the four rules**

In each of the four files, delete **only** the line `  - "tdd-implementer"` from the `stages:` list. Leave every other key, every other stage entry, and the whole body untouched.

The lists are long — `test-architecture.md` declares 25 stage entries, `test-helpers.md` and `test-writing.md` 22 each, `test-ratchets.md` 5 — so they are not reproduced here. The edit is one deletion per file, at these exact lines on `origin/main` @ `e0659eb7f`:

| File | `stages:` entries | Line to delete | Line no. |
|---|---:|---|---:|
| `.nax/rules/test-ratchets.md` | 5 | `  - "tdd-implementer"` | 8 |
| `.nax/rules/test-architecture.md` | 25 | `  - "tdd-implementer"` | 9 |
| `.nax/rules/test-helpers.md` | 22 | `  - "tdd-implementer"` | 9 |
| `.nax/rules/test-writing.md` | 22 | `  - "tdd-implementer"` | 9 |

The line is exactly two spaces, a hyphen, a space, and the double-quoted stage name.

**Do not remove any other stage.** In particular these four rules also list `single-session`, `tdd-simple`, `batch` and `no-test` — the single-session family, where one agent writes the tests *and* implements. That role authors tests, so it must keep them. Only the three-session `tdd-implementer` stage is being narrowed.

A single-line removal per file. Apply it with an editor, or:

```bash
for f in test-ratchets test-architecture test-helpers test-writing; do
  sed -i '' '/^  - "tdd-implementer"$/d' ".nax/rules/$f.md"
done
RTK_DISABLED=1 git diff --stat .nax/rules/
```

Expected diff: exactly 4 files changed, 0 insertions, 4 deletions. **If it is anything else, revert and do it by hand** — `tdd-implementer` must not be removed from `testing-commands.md` or `forbidden-patterns-tests.md`, and no body line may move.

- [ ] **Step 5: Run the test to verify it passes**

```bash
CI=1 AGENT=1 bun test --timeout=60000 test/unit/context/rules/nax-rules-stage-scoping.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add .nax/rules/test-ratchets.md .nax/rules/test-architecture.md .nax/rules/test-helpers.md \
        .nax/rules/test-writing.md test/unit/context/rules/nax-rules-stage-scoping.test.ts
git commit -m "fix(rules): scope test-authoring rules off the fresh implementer session

test-ratchets, test-architecture, test-helpers and test-writing exist for
whoever AUTHORS test files, and all four listed tdd-implementer in stages: —
so ~28KB (~28%) of the fresh implementer prompt described work that session's
own Rules block forbids it from doing.

Rectification is unaffected: the implementer op maps to the rectify stage
inside the fix cycle (RECTIFICATION_STAGE_MAP is consulted first), and all
four keep rectify — that is the implementer context that may edit tests under
the three narrow exceptions. testing-commands and forbidden-patterns-tests
keep tdd-implementer: it runs scoped tests, and its test-edit exceptions can
violate the forbidden patterns.

Adds a regression test over the real .nax/rules/ asserting both directions,
since stages: is fail-open and re-adding a stage is a one-line edit."
```

---

### Task 2: Verify the generated mirror, the gates, and the measured effect

A frontmatter change has two ways to go wrong that a unit test will not catch: the generated `.claude/rules/` mirror drifting, and the narrowing having no measurable effect on the thing it was supposed to shrink.

**Files:** none modified, unless Step 1 reports drift.

- [ ] **Step 1: Check the generated mirror**

`.claude/rules/` is regenerated from `.nax/rules/` and gated by `scripts/check-rules-drift.ts`.

```bash
bun scripts/check-rules-drift.ts
```

Expected: exit 0, no drift. The exported frontmatter carries `description:` and `paths:` only — not `stages:` — so a `stages:`-only edit should produce no change. **Verify, do not assume.** If it reports drift:

```bash
bun bin/nax.ts rules export --agent=claude
RTK_DISABLED=1 git diff --stat .claude/rules/
bun scripts/check-rules-drift.ts
```

Then include the regenerated files in the Step 5 commit and say so in the message.

- [ ] **Step 2: Lint the rules**

```bash
bun bin/nax.ts rules lint
```

Expected: no error for the four edited files. `rules-lint` validates `stages:` entries against the known stage names and re-emits loader warnings, so a typo introduced by the `sed` would surface here.

- [ ] **Step 3: Run the full suite and every static gate**

```bash
bun run test
bun x tsc --noEmit
bun x tsc --noEmit -p tsconfig.test.json
AGENT=1 bun run lint:biome
AGENT=1 bun run check:all-without-biome
```

Expected: all pass. `check:all-without-biome` includes `check:rules-drift`, so Step 1 is re-confirmed here.

**Note:** `bun run typecheck` is NOT part of `check:all` in this repo — run both `tsc` invocations explicitly, as above.

- [ ] **Step 4: Measure the effect**

The claim is "~28 KB off the fresh implementer prompt". Prove it rather than restating it. Compare the bytes of the four narrowed rules against the whole rule corpus:

```bash
echo "narrowed off tdd-implementer:"
wc -c .nax/rules/test-ratchets.md .nax/rules/test-architecture.md \
      .nax/rules/test-helpers.md .nax/rules/test-writing.md | tail -1
echo "whole canonical corpus:"
wc -c .nax/rules/*.md | tail -1
```

Expected: ~28-29 KB removed against a ~99 KB corpus. Record both numbers in the PR body.

Then confirm the four rules are genuinely no longer selected for the stage, through the loader rather than by reading the files again:

```bash
bun -e '
import {loadCanonicalRules} from "./src/context";
const rules = await loadCanonicalRules(process.cwd());
for (const stage of ["tdd-implementer","tdd-test-writer","rectify"]) {
  const hit = rules.filter(r => r.stages?.includes(stage)).map(r => r.fileName).sort();
  console.log(stage.padEnd(18), hit.join(", "));
}
'
```

Expected: `tdd-implementer` lists neither `test-ratchets.md`, `test-architecture.md`, `test-helpers.md` nor `test-writing.md`, but does list `testing-commands.md` and `forbidden-patterns-tests.md`. `tdd-test-writer` and `rectify` still list all four.

- [ ] **Step 5: Review the diff and push**

```bash
RTK_DISABLED=1 git diff origin/main...HEAD
git push -u origin feat/scope-test-rules-to-authoring-stages
```

The diff should be 4 single-line frontmatter deletions, one new test file, and nothing else (plus regenerated `.claude/rules/` only if Step 1 required it).

PR body should carry: the measured before/after from Step 4, the statement that rectification is unaffected and why (`RECTIFICATION_STAGE_MAP`), and the honest note that the saving is primarily attention rather than cost, because static rules ride the prompt cache.

- [ ] **Step 6: Note the follow-up, do not implement it**

The `appliesTo: test/**` path gate still matches for the implementer, because the PRD names test files in `contextFiles`/`expectedFiles`. Making that declarative in nax's own code — an `authorsTestFiles` stage flag mirroring the existing `producesTestFiles` in `stage-config.ts`, so `ruleMatchesScopeFiles` ignores test-shaped paths for non-authoring stages — is a `src/` change and needs its own plan. Mention it in the PR as a follow-up. Do not start it here.

---

## Self-Review

**Spec coverage.** Background makes four claims; each maps to a step. The four test-authoring rules → Task 1 Step 4. The two rules that must be kept → asserted in Task 1 Step 2's third describe block. Rectification must be unaffected → asserted per-rule in Task 1 Step 2 and re-verified through the loader in Task 2 Step 4. The generated mirror → Task 2 Step 1. The two explicitly-out-of-scope items (`authorsTestFiles`, the nax#2061 rules budget) are stated in Background and restated at Task 2 Step 6, so a zero-context engineer does not wander into either.

**Placeholder scan.** No TBDs. Every frontmatter edit is shown as a before/after block, and the `sed` alternative is paired with an exact expected diff stat so a mis-fire is caught immediately.

**Type consistency.** `CanonicalRule.stages?: string[]` and `.fileName: string` are the only fields used, and both are read from `src/context/rules/rules-frontmatter.ts:73-85`. `loadCanonicalRules` is imported from `@/context` in both the test (Task 1) and the inline check (Task 2 Step 4). Stage-name string constants (`tdd-implementer`, `tdd-test-writer`, `rectify`) match `STAGE_CONTEXT_MAP` in `src/context/engine/stage-config.ts` exactly.

**Known risk.** `stages:` is fail-open, so the most likely regression is not a wrong stage but a *dropped key* — a rule that loses `stages:` entirely becomes universal again and every narrowing assertion would still pass. Task 1 Step 2's first describe block covers exactly that: it asserts no canonical rule has an absent or empty `stages:`.
