# Review Fixes Bundle K — Tooling and CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** A stable release with no changelog entry still notifies cleanly, the import-cycle gate sees side-effect imports, and `bun run test:e2e` works on stock macOS.

**Architecture:** Three independent tasks: a one-line YAML guard (`.github/workflows/release.yml`), one more edge pattern in `packages/repo-tooling/scripts/check-import-cycles.ts`, and an e2e phase in nax's existing in-process test wrapper so `test:e2e` stops depending on GNU `timeout`.

**Tech Stack:** GitHub Actions YAML, TypeScript scripts, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #31, #32, #33.

**Branch:** `git fetch origin && git checkout -b fix/review-k-tooling-ci origin/main`

## Global Constraints

See the master plan. `scripts/run-tests.ts` is 204 lines; the new phase module is small.

## Files

- Modify: `.github/workflows/release.yml:255-258` (Task 1)
- Modify: `packages/repo-tooling/scripts/check-import-cycles.ts:76, 226-232` (Task 2)
- Test: `packages/repo-tooling/test/unit/scripts/check-import-cycles.test.ts` (321 lines)
- Create: `packages/nax/scripts/run-tests-phases.ts` (Task 3)
- Modify: `packages/nax/scripts/run-tests.ts:33-59, 190-198` (Task 3)
- Modify: `packages/nax/package.json:61` (Task 3)
- Test: `packages/nax/test/unit/scripts/run-tests-phases.test.ts` (new, mirrors the script)

---

### Task 1: The Telegram step tolerates a release with no notes (#31)

`/tmp/release-notes.md` is written only when CHANGELOG.md has a `## [X.Y.Z]` section, but the notify step `cat`s it unconditionally; under `bash -eo pipefail` the missing file fails the step after npm publish already succeeded.

**Files:**
- Modify: `.github/workflows/release.yml`

There is no test harness for workflow YAML in this repo; verification is by inspection plus a local shell check of the changed line.

- [ ] **Step 1: Reproduce the failure locally**

Run:

```bash
rm -f /tmp/nax-review-31-notes.md
bash -eo pipefail -c 'NOTES=$(cat /tmp/nax-review-31-notes.md | head -20); echo "reached: [$NOTES]"'; echo "exit=$?"
```

Expected: `cat: ... No such file or directory` and `exit=1` (the step would fail).

- [ ] **Step 2: Implement**

In `release.yml`, step `Notify Telegram`, change:

```yaml
          NOTES=$(cat /tmp/release-notes.md | head -20)
```

to:

```yaml
          # Written only when CHANGELOG.md has a section for this version (Extract release notes step).
          NOTES=$(head -20 /tmp/release-notes.md 2>/dev/null || true)
```

- [ ] **Step 3: Verify the new line locally**

Run:

```bash
bash -eo pipefail -c 'NOTES=$(head -20 /tmp/nax-review-31-notes.md 2>/dev/null || true); echo "reached: [$NOTES]"'; echo "exit=$?"
printf 'line one\nline two\n' > /tmp/nax-review-31-notes.md
bash -eo pipefail -c 'NOTES=$(head -20 /tmp/nax-review-31-notes.md 2>/dev/null || true); echo "reached: [$NOTES]"'; echo "exit=$?"
rm -f /tmp/nax-review-31-notes.md
```

Expected: `reached: []` / `exit=0`, then `reached: [line one` … `line two]` / `exit=0`. If `actionlint` is installed (`which actionlint`), also run `actionlint .github/workflows/release.yml`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): Telegram notify tolerates a release without changelog notes (review #31)"
```

---

### Task 2: The import-cycle gate counts side-effect imports (#32)

`STATIC_IMPORT_RE` requires a `from` clause, so `import "./x";` — a value import that runs at module init and takes part in ESM initialisation order — produces no edge, and a cycle built from such imports passes the gate. Latent today (the only side-effect-shaped hit in `src/` is template text, `nax/src/acceptance/generator-helpers.ts:40`, whose bare specifier `"testing"` resolves to no file).

**Files:**
- Modify: `packages/repo-tooling/scripts/check-import-cycles.ts`
- Test: `packages/repo-tooling/test/unit/scripts/check-import-cycles.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("buildImportGraph", ...)`:

```ts
  test("records a side-effect import as a value edge", () => {
    write(root, "src/a/leaf.ts", 'import "./other";\nexport const a = 1;\n');
    write(root, "src/a/other.ts", "export const b = 1;\n");

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([join(root, "src/a/other.ts")]);
  });

  test("ignores a side-effect import of a bare package specifier", () => {
    write(root, "src/a/leaf.ts", 'import "testing";\nexport const a = 1;\n');

    const graph = buildImportGraph(root);
    expect(graph.get(join(root, "src/a/leaf.ts"))).toEqual([]);
  });
```

Append inside `describe("findCyclicModules", ...)` (uses that block's `files` helper):

```ts
  test("reports a runtime cycle made only of side-effect imports", () => {
    write(root, "src/a/one.ts", 'import "./two";\nexport const one = 1;\n');
    write(root, "src/a/two.ts", 'import "./one";\nexport const two = 2;\n');
    expect(files(root)).toEqual(["src/a/one.ts", "src/a/two.ts"]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/repo-tooling`): `timeout 30 bun test test/unit/scripts/check-import-cycles.test.ts --timeout=5000`
Expected: the first and third new tests FAIL (no edge, no cycle); the bare-specifier test passes (it pins the no-false-edge case).

- [ ] **Step 3: Implement**

Below `STATIC_IMPORT_RE` add:

```ts
/**
 * `import "./x";` — a side-effect import has no `from`, but it is a value edge: the
 * module runs at init and takes part in ESM initialisation order (#32). Same `^`+`m`
 * anchoring as STATIC_IMPORT_RE, so only a statement at line start matches.
 */
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
```

In `buildImportGraph`, after the existing `for (const match of content.matchAll(STATIC_IMPORT_RE)) { ... }` loop, add:

```ts
    for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const target = match[1] ? resolveSpecifier(rootDir, file, match[1]) : null;
      if (target) deps.push(target);
    }
```

If the file's header comment claims the gate's answer is complete, add "side-effect imports included" to that sentence.

- [ ] **Step 4: Run tests and the real gate**

Run (from `packages/repo-tooling`): `timeout 30 bun test test/unit/scripts/ --timeout=5000`
Then run the gate on every package that uses it, to prove no real side-effect cycle exists today:

```bash
cd packages/nax && bun run check:import-cycles
cd ../nax-agent && bun ../repo-tooling/scripts/check-import-cycles.ts --package=.
cd ../nax-agent-acp && bun ../repo-tooling/scripts/check-import-cycles.ts --package=.
```

Expected: PASS everywhere, with the same module counts as on `main`. If a package now reports a new cycle, it is a real latent cycle the gate was blind to: STOP and report it in the PR body rather than baselining it.

- [ ] **Step 5: Commit**

```bash
git add packages/repo-tooling/scripts/check-import-cycles.ts packages/repo-tooling/test/unit/scripts/check-import-cycles.test.ts
git commit -m "fix(tooling): import-cycle gate counts side-effect imports (review #32)"
```

---

### Task 3: `test:e2e` runs through the in-process wrapper, not GNU `timeout` (#33)

`"test:e2e": "timeout -k 5s 180s bun test test/e2e/ --timeout=60000"` fails on stock macOS (`timeout` is GNU coreutils). `scripts/run-tests.ts` already implements a portable wall-clock cap with process-group reaping for the other three phases. Move the phase table into a small pure module, add an e2e phase that runs only with `--e2e`, and point `test:e2e` at the wrapper.

**Files:**
- Create: `packages/nax/scripts/run-tests-phases.ts`
- Modify: `packages/nax/scripts/run-tests.ts`
- Modify: `packages/nax/package.json:61`
- Test: `packages/nax/test/unit/scripts/run-tests-phases.test.ts`

**Interfaces:**
- Produces, in `scripts/run-tests-phases.ts`:

```ts
export type Phase = { name: string; dir: string; testTimeoutMs: number; phaseTimeoutMs: number };
export const SUITE_PHASES: readonly Phase[];
export const E2E_PHASE: Phase;
export function selectPhases(argv: readonly string[]): readonly Phase[];
```

- [ ] **Step 1: Write the failing test**

Create `packages/nax/test/unit/scripts/run-tests-phases.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { E2E_PHASE, SUITE_PHASES, selectPhases } from "@scripts/run-tests-phases";

describe("selectPhases", () => {
  test("the default run is unit, integration, ui — never e2e", () => {
    expect(selectPhases([]).map((p) => p.name)).toEqual(["unit", "integration", "ui"]);
    expect(selectPhases(["--bail"])).toEqual(SUITE_PHASES);
  });

  test("--e2e runs only the e2e phase", () => {
    expect(selectPhases(["--e2e"])).toEqual([E2E_PHASE]);
  });

  test("the e2e phase keeps the old script's caps: 180 s wall clock, 60 s per test", () => {
    expect(E2E_PHASE).toEqual({ name: "e2e", dir: "test/e2e/", testTimeoutMs: 60_000, phaseTimeoutMs: 180_000 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax`): `timeout 30 bun test test/unit/scripts/run-tests-phases.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/nax/scripts/run-tests-phases.ts`:

```ts
/**
 * The phases `scripts/run-tests.ts` runs. Kept pure (no spawning) so the
 * selection is unit-testable; the wrapper owns the timeouts and the reaping.
 */
export type Phase = {
  name: string;
  dir: string;
  /** Per-test timeout passed to Bun. */
  testTimeoutMs: number;
  /** Wall-clock cap for the whole phase. */
  phaseTimeoutMs: number;
};

export const SUITE_PHASES: readonly Phase[] = [
  // 240s, not 120s: the unit suite is ~21.7k tests across ~1.4k files, and a
  // fully-passing run was observed at 123.7s wall on a loaded runner — killed
  // by the old 120s budget with zero failing tests. The budget exists to bound
  // hangs (per-test timeout stays 5s; the group reap still fires on overrun),
  // so it must not sit at the suite's legitimate steady-state cost.
  { name: "unit", dir: "test/unit/", testTimeoutMs: 5_000, phaseTimeoutMs: 240_000 },
  { name: "integration", dir: "test/integration/", testTimeoutMs: 5_000, phaseTimeoutMs: 120_000 },
  { name: "ui", dir: "test/ui/", testTimeoutMs: 5_000, phaseTimeoutMs: 30_000 },
];

/**
 * `test/e2e/` is outside the default run by design (CI runs it as its own step).
 * The caps are the ones the old `timeout -k 5s 180s bun test test/e2e/ --timeout=60000`
 * script used; running it here makes them portable (stock macOS has no GNU `timeout`).
 */
export const E2E_PHASE: Phase = { name: "e2e", dir: "test/e2e/", testTimeoutMs: 60_000, phaseTimeoutMs: 180_000 };

export function selectPhases(argv: readonly string[]): readonly Phase[] {
  return argv.includes("--e2e") ? [E2E_PHASE] : SUITE_PHASES;
}
```

In `scripts/run-tests.ts`:
1. Delete the local `type Phase = { ... }` and `const PHASES: Phase[] = [ ... ];` (lines ~40-59, including the 240s comment, which now lives in the new module).
2. Add `import { type Phase, selectPhases } from "./run-tests-phases";` next to the existing `./run-tests-output` import.
3. Add `const PHASES = selectPhases(process.argv);` after `const BAIL = ...`.
4. Update the header's `Usage:` line to `bun run scripts/run-tests.ts [--bail] [--e2e]` and add one line: "`--e2e` runs only `test/e2e/` (the `test:e2e` script)."

`runPhase(phase: Phase)` and `main()`'s `for (const phase of PHASES)` keep working unchanged.

In `packages/nax/package.json`, change:

```json
    "test:e2e": "timeout -k 5s 180s bun test test/e2e/ --timeout=60000",
```

to:

```json
    "test:e2e": "bun run scripts/run-tests.ts --e2e",
```

- [ ] **Step 4: Run tests and the real e2e suite**

Run: `timeout 30 bun test test/unit/scripts/ --timeout=5000` — expect PASS.
Run (from `packages/nax`): `bun run test:e2e` — expect the e2e suite to run under `── e2e (test/e2e/, cap 180s) ──` and pass exactly as on `main` (the e2e suite was 33 tests on 2026-09-15; compare with `main` if the count differs). This is the step that proves the macOS fix: it must not print `command not found: timeout`.

- [ ] **Step 5: Commit**

```bash
git add packages/nax/scripts/run-tests-phases.ts packages/nax/scripts/run-tests.ts packages/nax/package.json packages/nax/test/unit/scripts/run-tests-phases.test.ts
git commit -m "fix(scripts): run test:e2e through the portable in-process wrapper (review #33)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `ci,tooling,scripts`, running the gates for repo-tooling and nax. The CI `Test (e2e)` job (`.github/workflows/ci.yml:98-99`) now exercises Task 3 on ubuntu; confirm it is green on the PR.
