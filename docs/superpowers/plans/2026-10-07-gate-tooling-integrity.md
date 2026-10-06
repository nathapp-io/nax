# Gate/Tooling Integrity Trio (#2323 items 2–5, #2326, #2329) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three "a gate is silently narrower than what it claims to police" issues in one PR: the reachability/allow-list/boundary/biome-parity gate hardening (#2323 items 2–5), the repo-tooling complexity ratchet (#2326), and nax's coverage `--require-all-files` flip (#2329).

**Architecture:** Tasks 1–5 harden the repo's meta-gates (all in `packages/*/scripts/` + one parity test — no runtime code). Tasks 6–10 make nax's coverage gate honest: delete the six genuinely dead files, cover the three live ones, then flip `--require-all-files` last so CI goes green in the same commit. Task 11 verifies the whole repo and opens the PR.

**Tech Stack:** Bun 1.4.0 (pinned), TypeScript ESM, `bun:test`, Biome 2.5.10, `gh` CLI.

**Spec:** GitHub issues #2323 (items 2–5 only — item 1, the 32 stale citations across 44 files, is explicitly out of scope per the issue's own grouping), #2326, #2329. Read all three with `gh issue view <n>` before starting.

## Global Constraints

- Run package commands from the package directory (`cd packages/nax`), never from the repo root.
- Never run bare `bun test` (always a path) and never `bun run nax` (AGENTS.md).
- Gates shared by 2+ packages live in `packages/repo-tooling/scripts/`; gates only nax runs stay in `packages/nax/scripts/`.
- After every task, `check-gate-reachability` must stay green: every `scripts/check-*.{ts,sh}` in ANY package must be reachable from a CI entry point.
- The complexity ratchet only ever goes down; `--init-baseline` never overwrites an existing baseline.
- The coverage per-file floor is 0.8 and the aggregate floor is `{lines: 0.8, functions: 0.8}` — do not touch `FLOOR`/`PER_FILE_FLOOR`.
- UNMEASURABLE entries in `check-coverage.ts` are a last resort: file + reason, and keep the map as small as possible.
- Branch: `fix/gate-tooling-integrity` off `main`. Conventional commits referencing the issue(s) fixed by each commit.

## Review Focus

The failure modes this plan's tests must pin (each line's test lives in the named task):

1. **A new `scripts/check-*` file in any package that no CI entry point reaches** — must fail `check-gate-reachability`, including in a third package (nax-ai), not just nax/repo-tooling. → Task 1's two new tests.
2. **A future sixth workspace package (or a tree with no package name)** — must fail `check-nax-ai-imports` closed with "no nax-ai allow-list", never silently inherit nax's rule. → Task 2's two new tests.
3. **A nax-agent `src/` file importing `@nathapp/nax-agent` or `.../internal` by package name** — must fail `check-package-boundaries`, while `test/` keeps passing (the packaging tests legitimately import the public entry). → Task 3's two tests.
4. **A rule tightened in nax's `biome.json` but not copied** — must fail the parity test until deliberately copied, including `files.includes`, `assist`, override plugin lists, and the `*-internals.ts` override. → Task 4's full-config `toEqual`.
5. **A new nax `src/` file holding executable code that no gated test loads** — must fail `bun run test:coverage` in CI; and a file a test loads but Bun still omits (#1779) must go to `UNMEASURABLE` with a reason, never silently pass. → Task 10's gate run.

---

### Task 1: gate-reachability polices every workspace package (#2323 item 2)

**Files:**
- Modify: `packages/nax/scripts/check-gate-reachability.ts`
- Test: `packages/nax/test/unit/scripts/check-gate-reachability.test.ts`

**Interfaces:**
- Consumes: existing `discoverCheckScripts(root)`, `findUnreachableCheckScriptsInRepo(packageRoot, repoRoot)` (both exported, already tested).
- Produces: `findUnreachableCheckScriptsInRepo` now counts `check-*` scripts in EVERY `packages/*/scripts/` directory (previously hard-coded to nax + repo-tooling). Task 5 relies on this to police repo-tooling's new gate wiring.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git checkout main && git pull && git checkout -b fix/gate-tooling-integrity
```

- [ ] **Step 2: Write the failing tests**

In `packages/nax/test/unit/scripts/check-gate-reachability.test.ts`, inside the existing `describe("findUnreachableCheckScriptsInRepo across workspace packages")` block (it already has the `file()` helper and `repo`/`afterEach` scaffolding), add two tests. Do NOT modify the existing `seed()` tests — these use their own fixtures:

```ts
  test("a third package's gate reached through its own CI job is not reported", () => {
    repo = makeTempDir("gate-reach-third-ok-");
    file(
      ".github/workflows/ci.yml",
      "jobs:\n  nax-ai:\n    defaults:\n      run:\n        working-directory: packages/nax-ai\n    steps:\n      - run: bun run check:all\n",
    );
    file(
      "packages/nax-ai/package.json",
      JSON.stringify({ scripts: { "check:all": "bun run lint", lint: "bun run scripts/check-pi.ts" } }),
    );
    file("packages/nax-ai/scripts/check-pi.ts", "");
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax-ai"), repo)).toEqual([]);
  });

  test("a third package's gate no job reaches is reported", () => {
    repo = makeTempDir("gate-reach-third-orphan-");
    file(
      ".github/workflows/ci.yml",
      "jobs:\n  nax-ai:\n    defaults:\n      run:\n        working-directory: packages/nax-ai\n    steps:\n      - run: bun run lint\n",
    );
    file("packages/nax-ai/package.json", JSON.stringify({ scripts: { lint: "echo lint only" } }));
    file("packages/nax-ai/scripts/check-pi.ts", "");
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax-ai"), repo)).toEqual(["check-pi.ts"]);
  });
```

Check the import at the top of the test file already includes `findUnreachableCheckScriptsInRepo` (it does).

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd packages/nax && bun test test/unit/scripts/check-gate-reachability.test.ts
```

Expected: the two new tests FAIL (the implementation hard-codes `[packageRoot, join(repoRoot, TOOLING_DIR)]`, so `check-pi.ts` in nax-ai is never counted — test 1 passes vacuously but test 2 returns `[]` instead of `["check-pi.ts"]`).

- [ ] **Step 4: Implement**

In `packages/nax/scripts/check-gate-reachability.ts`:

a) Add next to `discoverCheckScripts`:

```ts
/** Every workspace package that has a scripts/ directory, so a gate added to any package is policed, not just nax and repo-tooling (#2323). */
function workspacePackageRoots(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .map((entry) => join(packagesDir, entry))
    .filter((dir) => existsSync(join(dir, "scripts")));
}
```

b) In `findUnreachableCheckScriptsInRepo`, replace:

```ts
  const checkScripts = [packageRoot, join(repoRoot, TOOLING_DIR)].flatMap((root) =>
    discoverCheckScripts(root).map((name) => join(root, "scripts", name)),
  );
```

with:

```ts
  const roots = [...new Set([resolve(packageRoot), ...workspacePackageRoots(repoRoot).map((dir) => resolve(dir))])];
  const checkScripts = roots.flatMap((root) =>
    discoverCheckScripts(root).map((name) => join(root, "scripts", name)),
  );
```

c) In `main()`, replace the `total` computation:

```ts
  const repoRoot = findRepoRoot(packageRoot);
  const roots = [...new Set([resolve(packageRoot), ...workspacePackageRoots(repoRoot).map((dir) => resolve(dir))])];
  const total = roots.reduce((count, root) => count + discoverCheckScripts(root).length, 0);
```

d) Update the doc comment on `findUnreachableCheckScriptsInRepo` (currently says "The checked scripts are `packageRoot/scripts` plus repo-tooling's (S2-0)") to say: "The checked scripts are every workspace package's `scripts/` (#2323)."

(`readdirSync`, `existsSync`, `resolve`, `findRepoRoot` are all already imported.)

- [ ] **Step 5: Run the tests to verify they pass, then the real gate**

```bash
bun test test/unit/scripts/check-gate-reachability.test.ts
bun run check:gate-reachability
```

Expected: all tests PASS; the real gate prints `OK: all N check scripts are reachable from CI` where N is now larger (it gains `packages/nax-ai/scripts/check-pi-ai-imports.ts`, which IS reachable via the `nax-ai-static` CI job's `bun run check:all`).

- [ ] **Step 6: Commit**

```bash
git add packages/nax/scripts/check-gate-reachability.ts packages/nax/test/unit/scripts/check-gate-reachability.test.ts
git commit -m "fix(nax): gate-reachability polices every workspace package's check scripts (#2323)"
```

---

### Task 2: check-nax-ai-imports fails closed on unknown packages (#2323 item 3)

**Files:**
- Modify: `packages/repo-tooling/scripts/check-nax-ai-imports.ts`
- Test: `packages/repo-tooling/test/unit/scripts/check-nax-ai-imports.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `allowListFor(root)` now fails the gate (exit 1) for any package whose name is neither `@nathapp/nax` nor `@nathapp/nax-agent`, or when no package.json/name exists. Four existing fixture tests must gain explicit `package.json` files to keep exercising their original paths.

- [ ] **Step 1: Write the failing tests**

In `packages/repo-tooling/test/unit/scripts/check-nax-ai-imports.test.ts`:

a) Add `"package.json": JSON.stringify({ name: "@nathapp/nax" }),` as the first entry of the `tree({...})` argument in these four existing tests (they currently rely on the nax fallback this task removes):
   - "fails when nax-ai is imported from outside that directory"
   - "ignores the import name inside a comment"
   - "passes when nax-ai is imported only from src/agents/catalog"
   - "nax: src/agents/native is no longer an allowed site, since the native agent moved to nax-agent"

b) Add two new tests inside the `describe`:

```ts
  // Default-deny, like the RULES map in check-package-boundaries.ts: a package
  // with no rule must fail the gate, not inherit nax's allow-list (#2323 item 3).
  test("fails closed for a package with no allow-list rule", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "@nathapp/nax-repo-tooling" }),
      "src/index.ts": "export const x = 1;\n",
    });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("no nax-ai allow-list");
  });

  test("fails closed when the tree has no package.json", () => {
    const root = tree({ "src/index.ts": "export const x = 1;\n" });
    const { code, out } = runGate(root);
    rmSync(root, { recursive: true, force: true });
    expect(code).not.toBe(0);
    expect(out).toContain("no nax-ai allow-list");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/repo-tooling && bun test test/unit/scripts/check-nax-ai-imports.test.ts
```

Expected: the two new tests FAIL (today the unknown package silently gets nax's allow-list and the gate passes).

- [ ] **Step 3: Implement**

In `packages/repo-tooling/scripts/check-nax-ai-imports.ts`, replace the `allowListFor` function (lines 35–39) with:

```ts
/**
 * The scanned package's allow-list. Default-deny, like the RULES map in
 * check-package-boundaries.ts: a package (or a tree with no readable package
 * name) with no entry fails the gate instead of silently inheriting nax's
 * rule — a fourth package would otherwise be policed by a rule written for a
 * different dependency layout (#2323 item 3).
 */
async function allowListFor(root: string): Promise<AllowList> {
  const pkg = Bun.file(join(root, "package.json"));
  const name = (await pkg.exists()) ? ((await pkg.json()) as { name?: string }).name : undefined;
  if (name === "@nathapp/nax-agent") return NAX_AGENT;
  if (name === "@nathapp/nax") return NAX;
  console.error(
    `check-nax-ai-imports: no nax-ai allow-list for package ${name ?? "(package.json missing or has no name)"} — ` +
      "the gate refuses to fall back to nax's rule. Add the package to allowListFor.",
  );
  process.exit(1);
}
```

Also add one line to the gate's header comment: "Default-deny: a package with no allow-list entry fails the gate (#2323)."

- [ ] **Step 4: Run the tests to verify they pass, then both real consumers**

```bash
bun test test/unit/scripts/check-nax-ai-imports.test.ts
cd ../nax && bun run check:nax-ai-imports
cd ../nax-agent && bun ../repo-tooling/scripts/check-nax-ai-imports.ts .
```

Expected: tests PASS; both real gates print clean/`check-nax-ai-imports: clean` (they run from packages whose names have rules).

- [ ] **Step 5: Commit**

```bash
git add packages/repo-tooling/scripts/check-nax-ai-imports.ts packages/repo-tooling/test/unit/scripts/check-nax-ai-imports.test.ts
git commit -m "fix(repo-tooling): check-nax-ai-imports fails closed without an allow-list rule (#2323)"
```

---

### Task 3: package-boundaries bans nax-agent self-imports outside test/ (#2323 item 4)

**Files:**
- Modify: `packages/nax/scripts/check-package-boundaries.ts`
- Test: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`

**Interfaces:**
- Consumes: existing `agentViolation(pkg, file, spec)` rule and the test file's `workspace()` fixture (a clean three-package workspace; each test adds one violation).
- Produces: a nax-agent file outside `test/` importing `@nathapp/nax-agent[...]` by name is a boundary violation. Decision taken: forbid (not document), because nax-agent's own context.md states the `#src/` rule and zero `src/` or `scripts/` files self-import today — only `test/unit/packaging/public-surface.test.ts` and `test/unit/tools/package-managers.test.ts` do, deliberately.

- [ ] **Step 1: Write the failing tests**

In `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`, add inside the top-level `describe` (which has `workspace()` and `write()` helpers in scope):

```ts
  test("nax-agent src/ may not import itself by package name", () => {
    workspace();
    write("packages/nax-agent/src/drift.ts", 'import { x } from "@nathapp/nax-agent/internal";\n');
    const violations = findBoundaryViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({
        file: expect.stringContaining("src/drift.ts"),
        why: expect.stringContaining("self-import"),
      }),
    );
  });

  test("nax-agent test/ may import the public entry by name (the packaging tests)", () => {
    workspace();
    write(
      "packages/nax-agent/test/unit/surface.test.ts",
      'import * as pub from "@nathapp/nax-agent";\nimport * as internal from "@nathapp/nax-agent/internal";\n',
    );
    expect(findBoundaryViolations(root)).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/nax && bun test test/unit/scripts/check-package-boundaries.test.ts
```

Expected: the first new test FAILS (line 117 `if (name === AGENT || pkg.deps.has(name)) return null;` admits the self-import).

- [ ] **Step 3: Implement**

In `packages/nax/scripts/check-package-boundaries.ts`, in `agentViolation`, replace:

```ts
  if (name === AGENT || pkg.deps.has(name)) return null;
```

with:

```ts
  if (name === AGENT) {
    // The packaging tests import the public entry by name; everything else must
    // use #src/ — the rule nax-agent's own context states (#2323 item 4).
    return inDir(pkg, file, "test")
      ? null
      : "self-import by package name; use #src/ (test/ may import the public entry)";
  }
  if (pkg.deps.has(name)) return null;
```

And update the gate header bullet (line 8–9) from "…relative paths that stay inside the package, and itself." to "…relative paths that stay inside the package, and itself from test/ only (the packaging tests import the public entry by name)."

- [ ] **Step 4: Run the tests to verify they pass, then the real gate**

```bash
bun test test/unit/scripts/check-package-boundaries.test.ts
bun run check:package-boundaries
```

Expected: tests PASS; the real gate prints `[OK] package boundaries hold` (no current src/scripts self-imports exist — verified on main 2026-10-07).

- [ ] **Step 5: Commit**

```bash
git add packages/nax/scripts/check-package-boundaries.ts packages/nax/test/unit/scripts/check-package-boundaries.test.ts
git commit -m "fix(nax): enforce nax-agent's #src rule — no package-name self-import outside test/ (#2323)"
```

---

### Task 4: biome parity — full-config pin for nax-agent and repo-tooling (#2323 item 5)

**Files:**
- Modify: `packages/nax-agent/biome.json` (align two override include lists to nax's, verbatim)
- Modify: `packages/repo-tooling/biome.json` (same two edits)
- Test: `packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a full-config `toEqual` pin for nax-agent and repo-tooling (test-kit stays on the existing three partial pins — it deliberately lacks nax's `bin/`/`scripts/` overrides because it has neither directory).

The only legitimate difference between nax's config and the two copies is plugin paths (`./biome-plugins/` → `../nax/biome-plugins/`). Today the copies also drop nax's `!src/cli/**`, `!src/commands/**`, `!src/config/loader.ts` exclusions and narrow the noConsole override's includes — inert but unpinned. This task pins everything.

- [ ] **Step 1: Write the failing test**

In `packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts`, after the existing `for (const pkg of [...])` loop, add:

```ts
/**
 * Full-config pin: nax-agent and repo-tooling carry the same override set as
 * nax, so their whole biome.json must equal nax's with every plugin path
 * remapped. test-kit lacks nax's bin/** and scripts/** overrides (it has
 * neither directory), so it stays on the partial pins above.
 */
function withRemappedPluginPaths(nax: BiomeConfig): BiomeConfig {
  const remap = (plugins?: string[]) => plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/"));
  return {
    ...nax,
    plugins: remap(nax.plugins),
    overrides: nax.overrides?.map((o) => ({ ...o, plugins: remap(o.plugins) })),
  };
}

for (const pkg of ["nax-agent", "repo-tooling"]) {
  describe(`${pkg} biome config — full pin`, () => {
    test("equals nax's config with every plugin path remapped", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy).toEqual(withRemappedPluginPaths(nax));
    });
  });
}
```

Also update the file's top doc comment to say it fully pins nax-agent and repo-tooling (plugin-path remap being the only allowed difference) and partially pins test-kit.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/nax && bun test test/unit/scripts/nax-agent-biome-parity.test.ts
```

Expected: the two new tests FAIL on the include-list differences (verified by diffing the configs on main 2026-10-07).

- [ ] **Step 3: Align the two configs**

In BOTH `packages/nax-agent/biome.json` and `packages/repo-tooling/biome.json`:

a) The override whose `includes` is `["src/**"]` becomes:

```json
      "includes": ["src/**", "!src/cli/**", "!src/commands/**", "!src/config/loader.ts"],
```

b) The noConsole override whose `includes` is `["scripts/**"]` becomes:

```json
      "includes": [
        "bin/**",
        "scripts/**",
        "src/cli/**",
        "src/commands/**",
        "src/precheck/index.ts",
        "src/execution/lifecycle/headless-formatter.ts",
        "src/logger/logger.ts"
      ],
```

(Paths that don't exist in those packages match nothing; Biome ignores them. Both packages already match nax everywhere else — verified by config diff.)

- [ ] **Step 4: Run the test to verify it passes, then the affected linters**

```bash
bun test test/unit/scripts/nax-agent-biome-parity.test.ts
cd ../nax-agent && bun run lint:biome
cd ../repo-tooling && bun run lint:biome
cd ../nax && bun run lint:biome
```

Expected: parity tests PASS; all three linters stay green (the `!` exclusions remove nothing that exists in those packages; the extra noConsole includes match nothing new except `scripts/**` which was already included).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/biome.json packages/repo-tooling/biome.json packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts
git commit -m "test(nax): pin nax-agent and repo-tooling biome configs to nax's full rule set (#2323)"
```

---

### Task 5: restore the repo-tooling complexity ratchet (#2326)

**Files:**
- Create: `packages/repo-tooling/scripts/baselines/complexity-baseline.json` (via `--init-baseline`, never by hand)
- Modify: `packages/repo-tooling/package.json`

**Interfaces:**
- Consumes: `check-complexity.ts` (already package-root aware via `gatePackageRoot()`; scans `scripts/` + `test/` for repo-tooling since it has no `src/`).
- Produces: `cd packages/repo-tooling && bun run check:all` now runs lint AND the complexity ratchet. Task 1's gate-reachability change keeps the new wiring policed (the `tooling` CI job runs `check:all` with job working-directory `packages/repo-tooling`).

**Scope decision (record here and in the PR body):** `check-file-sizes` scans `src/` + `test/**/*.test.ts` and `check-import-cycles` scans `src/` only — neither ever covered `scripts/`, so the S2-0 move cost exactly one ratchet: complexity. Both stay out of repo-tooling's `check:all`; adding them would scan nothing new.

- [ ] **Step 1: Wire the scripts (RED)**

In `packages/repo-tooling/package.json`, add to `scripts`:

```json
    "check:complexity": "bun scripts/check-complexity.ts",
    "check:complexity:update": "bun scripts/check-complexity.ts --update-baseline",
```

and change:

```json
    "check:all": "bun run --silent lint && bun run --silent check:complexity"
```

- [ ] **Step 2: Run check:all to verify it fails**

```bash
cd packages/repo-tooling && bun run check:all
```

Expected: FAILS with `ERROR: .../scripts/baselines/complexity-baseline.json missing. Create one with --init-baseline.`

- [ ] **Step 3: Create the baseline**

```bash
bun scripts/check-complexity.ts --init-baseline
cat scripts/baselines/complexity-baseline.json
```

Expected output (probe-verified on main 2026-10-07; `updatedAt` will differ, scores must match — if biome reports different scores, record what the tool writes and note it in the PR):

```json
{
  "updatedAt": "<timestamp>",
  "limit": 20,
  "byFile": {
    "scripts/check-coverage.ts": { "checkPerFile": 27 },
    "scripts/check-git-spawn-env.ts": { "findGitSpawnViolations": 41, "mask": 25 },
    "scripts/check-import-cycles.ts": { "stripComments": 47, "stronglyConnectedComponents": 44 }
  }
}
```

Note: `checkPerFile: 27` is new since the issue was written (`--require-all-files` grew `checkPerFile` in #2328's wake); the git-spawn-env and import-cycles entries are exactly the two the S2-0 move dropped.

- [ ] **Step 4: Run check:all to verify it passes**

```bash
bun run check:all
```

Expected: lint OK, then `OK: 5 baselined functions over 20 in 3 files.`

- [ ] **Step 5: Confirm gate-reachability still holds repo-wide**

```bash
cd ../nax && bun run check:gate-reachability
```

Expected: `OK: all N check scripts are reachable from CI` (repo-tooling's `check-complexity.ts` was already counted; its new `check:complexity` wrapper is reached via the `tooling` job's `bun run check:all`).

- [ ] **Step 6: Commit**

```bash
git add packages/repo-tooling/package.json packages/repo-tooling/scripts/baselines/complexity-baseline.json
git commit -m "chore(repo-tooling): restore the complexity ratchet over the gate scripts (#2326)"
```

---

### Task 6: delete the six dead files (#2329)

**Files:**
- Delete: `packages/nax/src/acceptance/templates/cli.ts`, `component.ts`, `e2e.ts`, `snapshot.ts`, `unit.ts`
- Delete: `packages/nax/src/constitution/generator.ts`
- Modify: `docs/architecture/subsystems.md` (remove the `### Templates` section), `docs/guides/acceptance-review-flow.md` (remove the templates bullet)

**Interfaces:**
- Consumes: nothing.
- Produces: the unreported-files list shrinks from 9 to 3. Verified dead on main 2026-10-07: zero references to any of the six anywhere in `src/`, `test/`, `bin/`, `scripts/` (grep for `acceptance/templates`, `templates/<name>`, `constitution/generator"`, `./generator`, `../generator`), no dynamic `import()` hits. `AcceptanceCriterion` (imported by the templates) has other live consumers — it stays. Historical docs (`docs/specs/acceptance-ui-strategies.md`, `docs/plans/STATUS-coverage-drain.md`, `docs/20260910-review-nax.md`) are audit trails — leave them.

- [ ] **Step 1: Re-verify deadness (cheap RED)**

```bash
cd packages/nax
grep -rn "acceptance/templates" src test bin scripts --include="*.ts" --include="*.tsx"
grep -rn "constitution/generator" src test bin scripts --include="*.ts" | grep -v "generators/"
grep -rn "from \"\./generator\"" src/constitution/ | grep -v generator.ts
```

Expected: all three greps empty. If ANY hit appears, STOP and report — the file is not dead.

- [ ] **Step 2: Delete and update the two living docs**

```bash
git rm src/acceptance/templates/cli.ts src/acceptance/templates/component.ts src/acceptance/templates/e2e.ts src/acceptance/templates/snapshot.ts src/acceptance/templates/unit.ts src/constitution/generator.ts
```

In `docs/architecture/subsystems.md` (§20 Acceptance): delete the whole block from `### Templates` through the table's last row (`| Snapshot | snapshot.ts | Output stability |`) inclusive. In `docs/guides/acceptance-review-flow.md`: delete the line `- \`src/acceptance/templates/\` — strategy-specific templates` from the stage's Files list.

- [ ] **Step 3: Verify nothing broke**

```bash
cd packages/nax && bun run typecheck && bun run test:unit
```

Expected: typecheck clean; unit suite green (20700+ pass, 0 fail).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(nax): delete dead acceptance templates and constitution generator (#2329)"
```

---

### Task 7: cover `sumTddTokenUsage` (#2329)

**Files:**
- Test (create): `packages/nax/test/unit/verification/tdd-token-usage.test.ts`

**Interfaces:**
- Consumes: `sumTddTokenUsage(sessions: TddSessionResult[]): TokenUsage | undefined` from `@/tdd/types` (the only runtime value in `src/tdd/types.ts`; all existing imports of that file are `import type`, which is why Bun records no `SF:` line). `TddSessionResult` requires `role`, `success`, `estimatedCostUsd`, `filesChanged`, `durationMs`; `tokenUsage?` has optional `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`.

- [ ] **Step 1: Write the test**

```ts
/**
 * `src/tdd/types.ts` was invisible to the coverage gate (#2329): every other
 * import of it is type-only, so the module never executed and Bun wrote no
 * `SF:` record. This exercises its one runtime value.
 */
import { describe, expect, test } from "bun:test";
import { sumTddTokenUsage } from "@/tdd/types";
import type { TddSessionResult } from "@/tdd/types";

function session(tokenUsage?: TddSessionResult["tokenUsage"]): TddSessionResult {
  return { role: "implementer", success: true, estimatedCostUsd: 0, filesChanged: [], durationMs: 0, tokenUsage };
}

describe("sumTddTokenUsage", () => {
  test("returns undefined when no session reported usage", () => {
    expect(sumTddTokenUsage([])).toBeUndefined();
    expect(sumTddTokenUsage([session(), session()])).toBeUndefined();
  });

  test("sums usage across sessions", () => {
    expect(
      sumTddTokenUsage([
        session({ inputTokens: 100, outputTokens: 10 }),
        session({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 6 }),
      ]),
    ).toEqual({ inputTokens: 101, outputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 6 });
  });

  test("omits the cache keys while every cache total is zero", () => {
    expect(sumTddTokenUsage([session({ inputTokens: 3, outputTokens: 4 })])).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm the file now records**

```bash
cd packages/nax
bun test test/unit/verification/tdd-token-usage.test.ts
bun test test/unit/verification/tdd-token-usage.test.ts --coverage --coverage-reporter=lcov >/dev/null 2>&1
grep -c "SF:src/tdd/types.ts" coverage/lcov.info
```

Expected: tests pass; grep prints `1` (the record exists). Restore nothing — the next full gate run rewrites `coverage/lcov.info`.

- [ ] **Step 3: Commit**

```bash
git add test/unit/verification/tdd-token-usage.test.ts
git commit -m "test(nax): cover sumTddTokenUsage (#2329)"
```

---

### Task 8: cover the detect command (#2329)

**Files:**
- Test (create): `packages/nax/test/unit/commands/detect.test.ts`

**Interfaces:**
- Consumes: `detectCommand(options: DetectOptions): Promise<void>` from `@/commands/detect` (wired in `bin/nax.ts:84`, never executed by tests). Probe-verified contract on main 2026-10-07:
  - `resolveProject({dir})` requires `<dir>/.nax/config.json` to exist (NaxError otherwise) — the fixture must create both.
  - Tier-1 detection needs a literal `test: { include: ["<pattern>"] }` in `vitest.config.ts` (a bare `*.test.ts` file is NOT enough — tiers 3/4 need git, which a temp dir lacks).
  - `--json` prints one JSON object via `console.log` and sets `process.exitCode` to 0 (signals found) or 1 (all empty).

- [ ] **Step 1: Write the test**

```ts
/**
 * `src/commands/detect.ts` was invisible to the coverage gate (#2329): the
 * command is wired in bin/nax.ts, which the gated suites never execute. These
 * tests run `detectCommand` in-process against fixture trees.
 *
 * Fixture contract (probed 2026-10-07): resolveProject demands
 * `.nax/config.json`; tier-1 detection needs a literal
 * `test: { include: [...] }` in vitest.config.ts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { detectCommand } from "@/commands/detect";

describe("detectCommand", () => {
  let dir = "";
  let logs: string[] = [];
  let logSpy: ReturnType<typeof spyOn> | undefined;
  let prevExitCode = 0;

  afterEach(() => {
    logSpy?.mockRestore();
    logSpy = undefined;
    process.exitCode = prevExitCode;
    if (dir) cleanupTempDir(dir);
    dir = "";
  });

  function startCapture(): string[] {
    logs = [];
    prevExitCode = process.exitCode ?? 0;
    logSpy = spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    return logs;
  }

  function seedProject(): void {
    dir = makeTempDir("detect-cmd-");
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), "{}\n");
  }

  test("--json reports tier-1 patterns and exits 0", async () => {
    seedProject();
    writeFileSync(
      join(dir, "vitest.config.ts"),
      'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n',
    );
    const out = startCapture();
    await detectCommand({ json: true, dir });
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as {
      workdir: string;
      root: { detected: { patterns: readonly string[]; confidence: string } };
    };
    expect(parsed.workdir).toBe(dir);
    expect(parsed.root.detected.confidence).toBe("high");
    expect(parsed.root.detected.patterns).toContain("tests/**/*.test.ts");
  });

  test("--json exits 1 when detection finds no signals", async () => {
    seedProject();
    const out = startCapture();
    await detectCommand({ json: true, dir });
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(out.join("\n")) as { root: { detected: { confidence: string } } };
    expect(parsed.root.detected.confidence).toBe("empty");
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd packages/nax && bun test test/unit/commands/detect.test.ts
```

Expected: both tests PASS. (If the vitest fixture yields different normalized patterns, print `parsed.root.detected` and pin the assertion to the actual tier-1 output — the contract under test is "tier-1 config is found, confidence high, exit 0".)

- [ ] **Step 3: Commit**

```bash
git add test/unit/commands/detect.test.ts
git commit -m "test(nax): cover the detect command (#2329)"
```

---

### Task 9: cover the TUI entry point (#2329)

**Files:**
- Test (create): `packages/nax/test/ui/tui-entry.test.tsx`

**Interfaces:**
- Consumes: `renderTui(props: TuiProps)` from `@/tui` (src/tui/index.tsx — loaded only via type imports today, so no `SF:` record). `TuiProps` requires `feature`, `stories`, `events`; `new PipelineEventEmitter()` takes no arguments. Follows the `@/pipeline` import convention of `test/ui/tui-retry.test.tsx`.

- [ ] **Step 1: Write the test**

```tsx
/**
 * `src/tui/index.tsx` was invisible to the coverage gate (#2329): test/ui
 * renders subcomponents directly, so the entry module was only ever reached
 * through `import type`. This loads and exercises it.
 */
import { expect, test } from "bun:test";
import { PipelineEventEmitter } from "@/pipeline";
import { renderTui } from "@/tui";

test("renderTui renders the root app and unmounts cleanly", () => {
  const instance = renderTui({ feature: "tui-entry", stories: [], events: new PipelineEventEmitter() });
  expect(typeof instance.unmount).toBe("function");
  instance.unmount();
});
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd packages/nax && bun test test/ui/tui-entry.test.tsx
```

Expected: PASS. If ink's non-TTY render misbehaves where `ink-testing-library` (used by every other test/ui file) does not, switch this test to import `App` via the entry instead: `import { renderTui } from "@/tui"` is the point — do NOT switch to importing `@/tui/App` (that would not record `index.tsx`). If render genuinely cannot run headless, stop and record the file in `UNMEASURABLE` in `packages/repo-tooling/scripts/check-coverage.ts` with reason "entry module; ink render requires a TTY (see #2329)" instead.

- [ ] **Step 3: Commit**

```bash
git add test/ui/tui-entry.test.tsx
git commit -m "test(nax): cover the TUI entry point (#2329)"
```

---

### Task 10: flip nax's coverage gate to `--require-all-files` (#2329)

**Files:**
- Modify: `packages/nax/package.json` (four `test:coverage*` scripts)

**Interfaces:**
- Consumes: Tasks 6–9 (the unreported list must be empty before this flips).
- Produces: nax's coverage scripts match nax-agent's (`--require-all-files` on all four), so a future src file with code and no test fails CI.

- [ ] **Step 1: Edit the four scripts**

In `packages/nax/package.json`, change exactly these four values (mirroring nax-agent's):

```json
    "test:coverage": "bun run ../repo-tooling/scripts/check-coverage.ts --require-all-files",
    "test:coverage:report": "bun run ../repo-tooling/scripts/check-coverage.ts --require-all-files --report",
    "test:coverage:update": "bun run ../repo-tooling/scripts/check-coverage.ts --require-all-files --update-baseline",
    "test:coverage:list": "bun run ../repo-tooling/scripts/check-coverage.ts --require-all-files --list",
```

- [ ] **Step 2: Run the full coverage gate (GREEN check, ~3–5 min)**

```bash
cd packages/nax && AGENT=1 bun run test:coverage
```

Expected: `[coverage] OK — at or above floor.` with `unreported src/ files with code: 0`, aggregate ~96.5% lines / ~93.8% functions, and the one baselined below-floor file (`src/execution/feature-lock.ts` at 76.62%) still passing its ratchet.

If a loaded-but-unrecorded file appears (the #1779 class): run that file's test alone with `--coverage` to confirm, then add it to `UNMEASURABLE` in `packages/repo-tooling/scripts/check-coverage.ts` with the reason and `#1779` — that is a deliberate, reviewed edit, not a workaround. If a NEW below-floor file appears (a Task 7–9 test left its file under 80%): grandfather it with `AGENT=1 bun run test:coverage:update` and mention it in the PR.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(nax): require every src file with code in the coverage report (#2329)"
```

---

### Task 11: whole-repo verification and PR

**Files:**
- None (verification + PR only).

- [ ] **Step 1: Repo-wide gates**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck && bun run check:all
```

Expected: clean in every package, in dependency order (this runs each package's `check:all`, including the new repo-tooling ratchet and all hardened gates).

- [ ] **Step 2: Full nax test suite**

```bash
cd packages/nax && AGENT=1 bun run test
```

Expected: all suites green.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/gate-tooling-integrity
gh pr create --title "fix: gate/tooling integrity — reachability, allow-lists, self-imports, biome parity, complexity ratchet, coverage (#2323 #2326 #2329)" --body-file - <<'EOF'
Bundles three gate-integrity issues (#2323 items 2-5, #2326, #2329) — all "a gate silently narrower than what it claims to police" defects in `packages/*/scripts/`, no runtime code.

## #2323 items 2-5 — boundary-gate hardening
- `check-gate-reachability` now counts `check-*` scripts in EVERY `packages/*/scripts/` (was hard-coded to nax + repo-tooling); picks up nax-ai's `check-pi-ai-imports.ts`.
- `check-nax-ai-imports` fails closed for packages without an allow-list entry instead of inheriting nax's rule.
- `check-package-boundaries` forbids nax-agent package-name self-imports outside `test/` (the packaging tests keep their deliberate public-entry imports).
- The biome parity test fully pins nax-agent's and repo-tooling's `biome.json` to nax's (plugin-path remap is the only allowed difference); both configs gain nax's `!src/cli/**`-style exclusions verbatim. test-kit stays on partial pins (it lacks nax's bin/scripts overrides by design). Item 1 (32 stale moved-path citations) remains open, per the issue's own grouping.

## #2326 — repo-tooling complexity ratchet
- `check:complexity` added to repo-tooling's `check:all`; baseline re-records the two entries the S2-0 move dropped (`check-git-spawn-env.ts` 41/25, `check-import-cycles.ts` 47/44) plus `check-coverage.ts checkPerFile 27` (grew with #2328).
- Scope decision: `check-file-sizes` (src/ + test) and `check-import-cycles` (src/ only) never scanned `scripts/`, so the move cost exactly one ratchet; both stay out of repo-tooling's `check:all`.

## #2329 — nax coverage require-all-files
- Deleted the six genuinely dead unreported files (5x `src/acceptance/templates/*`, `src/constitution/generator.ts`) and the two living-doc mentions of the templates.
- Added the three missing tests: `sumTddTokenUsage`, `detectCommand` (fixture contract: `.nax/config.json` + literal vitest `test.include`), and the TUI entry point.
- nax's `test:coverage*` scripts now pass `--require-all-files`, matching nax-agent.

Fixes #2326, fixes #2329, refs #2323 (item 1 stays open).
EOF
```

- [ ] **Step 4: Comment on #2323** that items 2–5 are addressed by the PR and item 1 (stale citations) remains open with its own scope.

---

## Self-Review (done at plan time)

- **Spec coverage:** #2323 items 2/3/4/5 → Tasks 1/2/3/4; #2326 (baseline, check:all wiring, file-sizes/import-cycles decision, gate-reachability) → Task 5; #2329 (9 files: 6 dead → Task 6, tdd/types → Task 7, detect → Task 8, tui → Task 9, `--require-all-files` flip → Task 10; depends-on #2328 flag already merged and in use). Item 1 of #2323 excluded per the issue's own grouping — stated in the PR body and issue comment.
- **Placeholder scan:** every code step carries the exact code; the two conditional branches (detect pattern drift, ink TTY failure) specify both the primary assertion and the precise fallback action.
- **Type consistency:** `withRemappedPluginPaths(nax: BiomeConfig): BiomeConfig` defined once (Task 4) and used in the same task; `findUnreachableCheckScriptsInRepo(packageRoot, repoRoot)` signature unchanged; `renderTui`/`PipelineEventEmitter`/`sumTddTokenUsage`/`detectCommand` signatures match the sources read on main.
- **Review Focus:** each of the five failure modes has its pinning test named in Tasks 1–4 and 10.
