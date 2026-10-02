# S2-0 — `repo-tooling` and `test-kit` packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create two private workspace packages: `packages/test-kit` (`@nathapp/nax-test-kit`), which holds the ten generic test helpers, and `packages/repo-tooling` (`@nathapp/nax-repo-tooling`), which holds the check scripts more than one package runs. Every package then calls one implementation of each gate, and nax-agent stops reaching into `../nax/scripts`. No behaviour change to the nax CLI.

**Architecture:** Both packages are private, unpublished, Bun-only, and depend on no nax package (repo-tooling may use test-kit from its tests). Files move with `git mv`, so history follows. Callers change only their paths: every nax `check:*` script name stays the same, so `.nax/rules`, docs and CI that say `bun run check:x` keep working. Package-rooted gates now default to the **current working directory** instead of "the package the script file sits in", because the script no longer sits in the package it scans.

**Tech Stack:** Bun 1.4 workspaces (`linker = "isolated"`), TypeScript 7.0.2, Biome 2.5.10, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§6, §9 row S2-0). S2-1 to S2-9 get their own plans, written just in time against the `main` this PR produces.

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Work on branch `feat/s2-nax-agent-node-publish` (it already carries the spec and this plan). Rebase it onto `origin/main` before Task 1.
- Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Bun 1.4.0 in CI; TypeScript `7.0.2` exact; Biome `2.5.10` exact.
- New package names: `@nathapp/nax-test-kit` and `@nathapp/nax-repo-tooling`. Both `"private": true`, `"version": "0.0.0"`, `"license": "MIT"`, `"type": "module"`.
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`. New packages may only be added to `devDependencies`, as `"workspace:*"`.
- No test is edited to make it pass. A test changes only to (a) move, (b) change an import specifier or a script path, or (c) test a gate this PR changes. Each such change is listed in its task.
- **Test counts are conserved.** Record the counts in Task 0. After Task 7, nax + nax-agent + repo-tooling unit tests must equal the Task 0 nax + nax-agent total, plus the new tests this plan adds (each one listed).
- Every commit leaves `bun run check:all` and the unit suites green in every package it touches. Conventional commits (`feat:`, `refactor:`, `test:`, `ci:`, `docs:`, `chore:`), no emojis.
- No push, no PR, no `nax run` / `nax plan` without the maintainer's explicit approval.
- Max 2 fix rounds per task review.

## Decisions taken in this plan (deviations from the spec, each measured)

1. **`./test/helpers/*` is narrowed in S2-0, not removed.** Six nax tests still use the three helpers that import nax-agent source (`command-safety`, `sandbox`, `systemone-stub`): `test/unit/tools/runtime-sandbox-argv.test.ts`, `test/unit/tools/runtime-command-safety-guard.test.ts`, `test/unit/agents/coding-tool-sandbox.test.ts`, `test/unit/sandbox/launcher-session-tmp.test.ts`, `test/integration/permissions/sandbox-wiring.test.ts`, `test/integration/permissions/bash-deny-suite.test.ts`. Two of them are among the eight that S2-2 moves. Copying the three helpers into nax now would create a duplicate that S2-2 deletes. So nax-agent exports exactly those three subpaths until S2-2, which removes the export (spec §6.2 end state).
2. **`test-kit/cases` is not created here.** It holds the runtime behaviour cases, which first exist in S2-4. An empty subpath now would be a placeholder.
3. **`lib/repo-root.ts`, `lib/import-specifiers.ts` and `lib/agent-bundling.ts` stay in nax.** Only nax-only gates use them. `lib/package-root.ts` moves, because only moved gates use it. `import-specifiers.ts` keeps importing `stripComments`, now from `@nathapp/nax-repo-tooling/scripts/check-import-cycles`.
4. **`check-no-bun-apis` moves in S2-0** (nax-ai already runs it). Widening it (`globalThis.Bun`, `typeof Bun`, `import.meta.dir`) and running it over nax-agent are S2-5's.

## Review Focus

1. **A gate run from a package directory with no `--package` must scan that package, not repo-tooling.** Every nax `check:*` script relies on it. Pinned in Task 3 (`gatePackageRoot` defaults to the cwd) and Task 4 Step 9 (each nax gate prints the same file counts as on `main`).
2. **A moved gate test that read nax's real tree must still read nax's tree.** If such a test moves blindly, it silently scans repo-tooling and stays green. Pinned in Task 4 Step 3 (the known blocks stay in nax) and Step 8 (a grep for `import.meta.dir` depth in moved tests).
3. **A new `packages/*` directory with no boundary rule.** The boundary gate is default-deny; Task 1 adds the rules before the packages exist.
4. **A check script that no pipeline runs after the move.** Pinned in Task 6: `check-gate-reachability` now discovers repo-tooling's gates and follows every package's scripts.
5. **A Biome rule that drifts between the package copies.** Pinned in Task 2 and Task 3: the parity test covers the two new configs.

---

## File structure

**New: `packages/test-kit/`**
- `package.json`: exports `"./bun/*": "./src/bun/*.ts"`.
- `tsconfig.json`, `biome.json`.
- `src/bun/{absent,assert-defined,deps,fake-clock,fs,mock-fetch,session-tmp-deps,spawn,temp,timeout}.ts`: moved from `packages/nax-agent/test/helpers/`.

**New: `packages/repo-tooling/`**
- `package.json`: exports `"./scripts/*": "./scripts/*.ts"`; imports `"#scripts/*": "./scripts/*.ts"`; devDependency test-kit.
- `tsconfig.json`, `biome.json`, `bunfig.toml`.
- `scripts/`: the 15 gates, `report-test-consolidation.ts` and `check-no-bun-apis.ts`, plus `scripts/lib/package-root.ts` and `scripts/lib/sort.ts`.
- `test/unit/scripts/*.test.ts`: the moved gate tests, at the same depth as in nax, so `join(import.meta.dir, "../../../scripts/…")` still resolves.

**Modified:**
- `packages/nax/scripts/check-package-boundaries.ts` and its test.
- `packages/nax/scripts/check-gate-reachability.ts` and its test.
- `packages/nax/scripts/lib/import-specifiers.ts` (import path only).
- `packages/nax/package.json`: script paths, two devDependencies.
- `packages/nax/test/helpers/*.ts`: 10 shims retargeted.
- `packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts`.
- `packages/nax-agent/package.json` (exports narrowed, script paths, devDependency) and `packages/nax-agent/test/helpers/index.ts`.
- `packages/nax-ai/package.json` (`check:no-bun-apis` path).
- `.github/workflows/ci.yml`: new `tooling` job.
- `.nax/context.md`, then regenerate the generated agent files.
- `bun.lock`.

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Rebase and install**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git fetch origin && git rebase origin/main
bun install --frozen-lockfile
```

- [ ] **Step 2: Record test counts and gate outputs**

```bash
cd packages/nax && bun test test/unit/ --timeout=60000 2>&1 | tail -4 > /tmp/s2-0-nax-unit-before.txt
bun test test/integration/ --timeout=60000 2>&1 | tail -4 > /tmp/s2-0-nax-int-before.txt
cd ../nax-agent && bun test ./test/unit/ --timeout=60000 2>&1 | tail -4 > /tmp/s2-0-agent-unit-before.txt
cd ../nax && for s in nax-error file-sizes complexity import-cycles test-as-unknown-as test-escape-hatches test-satellites no-control-bytes no-real-global-nax permission-mode-ssot feature-dir-ssot package-frame-derivation git-spawn-env sandbox-imports nax-ai-imports; do echo "== $s"; bun run --silent check:$s 2>&1 | tail -3; done > /tmp/s2-0-nax-gates-before.txt
cd ../nax-agent && bun run --silent lint:checks > /tmp/s2-0-agent-gates-before.txt 2>&1; echo "exit $?" >> /tmp/s2-0-agent-gates-before.txt
```

Expected: every file ends green. Keep these files; Task 7 compares against them.

---

### Task 1: Boundary rules for the two new packages

`check-package-boundaries` is default-deny, so the rules must exist before the packages do.

**Files:**
- Modify: `packages/nax/scripts/check-package-boundaries.ts`
- Test: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`

**Interfaces:**
- Produces: the rules `@nathapp/nax-test-kit` and `@nathapp/nax-repo-tooling`. nax may import test-kit only from `test/`, and repo-tooling only from `scripts/` and `test/`. nax may import from nax-agent only `.`, `/internal` and exactly three helper subpaths: `@nathapp/nax-agent/test/helpers/{command-safety,sandbox,systemone-stub}`.

- [ ] **Step 1: Update the clean workspace fixture and write the failing tests**

In `check-package-boundaries.test.ts`, replace the body of `workspace()`'s nax test file write and add the two packages:

```ts
  write(
    "packages/nax/package.json",
    JSON.stringify({
      name: "@nathapp/nax",
      devDependencies: { "@nathapp/nax-test-kit": "workspace:*", "@nathapp/nax-repo-tooling": "workspace:*" },
    }),
  );
```

(replacing the existing `packages/nax/package.json` line), and replace

```ts
  write("packages/nax/test/a.test.ts", 'import { t } from "@nathapp/nax-agent/test/helpers/temp";\n');
```

with

```ts
  write(
    "packages/nax/test/a.test.ts",
    'import { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { s } from "@nathapp/nax-agent/test/helpers/sandbox";\n',
  );
  write("packages/nax/scripts/gate.ts", 'import { c } from "@nathapp/nax-repo-tooling/scripts/check-import-cycles";\n');
  write("packages/test-kit/package.json", JSON.stringify({ name: "@nathapp/nax-test-kit" }));
  write("packages/test-kit/src/bun/temp.ts", 'import { mkdtempSync } from "node:fs";\nimport { mock } from "bun:test";\n');
  write(
    "packages/repo-tooling/package.json",
    JSON.stringify({ name: "@nathapp/nax-repo-tooling", devDependencies: { "@nathapp/nax-test-kit": "workspace:*" } }),
  );
  write("packages/repo-tooling/scripts/check-x.ts", 'import { Glob } from "bun";\nimport { r } from "#scripts/lib/package-root";\n');
  write("packages/repo-tooling/test/unit/x.test.ts", 'import { t } from "@nathapp/nax-test-kit/bun/temp";\n');
```

Replace the test `"nax may use only the two entries, and the test helpers only from test/"` with:

```ts
  test("nax may use the two entries and three named helper subpaths, the helpers only from test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { g } from "@nathapp/nax-agent/src/tools/git";\nimport { s } from "@nathapp/nax-agent/test/helpers/sandbox";\n',
    );
    write("packages/nax/test/bad.test.ts", 'import { t } from "@nathapp/nax-agent/test/helpers/temp";\n');
    expect(whys()).toHaveLength(3);
  });

  test("nax may import test-kit only from test/ and repo-tooling only from scripts/ and test/", () => {
    workspace();
    write(
      "packages/nax/src/bad.ts",
      'import { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { c } from "@nathapp/nax-repo-tooling/scripts/check-import-cycles";\n',
    );
    expect(whys()).toEqual([
      "packages/nax/src/bad.ts @nathapp/nax-test-kit/bun/temp @nathapp/nax-test-kit imported outside test/",
      "packages/nax/src/bad.ts @nathapp/nax-repo-tooling/scripts/check-import-cycles @nathapp/nax-repo-tooling imported outside scripts/ and test/",
    ]);
  });

  test("test-kit imports no nax package", () => {
    workspace();
    write(
      "packages/test-kit/src/bun/bad.ts",
      'import { a } from "@nathapp/nax-agent/internal";\nimport { r } from "@nathapp/nax-repo-tooling/scripts/x";\n',
    );
    expect(whys()).toEqual([
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-agent/internal @nathapp/nax-test-kit imports @nathapp/nax-agent",
      "packages/test-kit/src/bun/bad.ts @nathapp/nax-repo-tooling/scripts/x @nathapp/nax-test-kit imports @nathapp/nax-repo-tooling",
    ]);
  });

  test("repo-tooling imports no nax package, and test-kit only from test/", () => {
    workspace();
    write(
      "packages/repo-tooling/scripts/bad.ts",
      'import { a } from "@nathapp/nax-agent/internal";\nimport { t } from "@nathapp/nax-test-kit/bun/temp";\nimport { x } from "../../nax/scripts/y";\n',
    );
    expect(whys()).toEqual([
      "packages/repo-tooling/scripts/bad.ts @nathapp/nax-agent/internal @nathapp/nax-repo-tooling imports @nathapp/nax-agent",
      "packages/repo-tooling/scripts/bad.ts @nathapp/nax-test-kit/bun/temp devDependency @nathapp/nax-test-kit imported outside test/",
      "packages/repo-tooling/scripts/bad.ts ../../nax/scripts/y relative import leaves the package",
    ]);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/nax && bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000`
Expected: FAIL. `a clean workspace passes` throws `no boundary rule for these packages ... @nathapp/nax-repo-tooling, @nathapp/nax-test-kit`, and the new tests fail.

- [ ] **Step 3: Implement the rules**

In `check-package-boundaries.ts`:

Replace the header bullet about nax with:

```ts
 * - packages/nax reaches nax-agent only through `@nathapp/nax-agent` or
 *   `@nathapp/nax-agent/internal`, plus three named helper subpaths
 *   (`@nathapp/nax-agent/test/helpers/{command-safety,sandbox,systemone-stub}`)
 *   from its own tests until S2-2. It may import test-kit only from test/ and
 *   repo-tooling only from scripts/ and test/. Never a relative path into
 *   another package.
 * - packages/test-kit and packages/repo-tooling (private tooling) import no nax
 *   package; repo-tooling may use test-kit from its tests (a devDependency).
```

Replace the constants

```ts
const NAX_TEST_HELPERS = `${AGENT}/test/helpers/`;
```

with

```ts
const NAX_AGENT_HELPERS = new Set(
  ["command-safety", "sandbox", "systemone-stub"].map((name) => `${AGENT}/test/helpers/${name}`),
);
const TEST_KIT = "@nathapp/nax-test-kit";
const REPO_TOOLING = "@nathapp/nax-repo-tooling";
const NAX_PACKAGES = new Set(["@nathapp/nax", AGENT, "@nathapp/nax-ai", TEST_KIT, REPO_TOOLING]);

function inDir(pkg: PackageInfo, file: string, dir: string): boolean {
  return relative(pkg.dir, file).startsWith(`${dir}${sep}`);
}
```

Replace `naxViolation` with:

```ts
function naxViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (leavesPackage(pkg, file, spec)) return "relative import leaves the package";
  const name = packageName(spec);
  if (name === TEST_KIT) return inDir(pkg, file, "test") ? null : `${TEST_KIT} imported outside test/`;
  if (name === REPO_TOOLING) {
    return inDir(pkg, file, "test") || inDir(pkg, file, "scripts")
      ? null
      : `${REPO_TOOLING} imported outside scripts/ and test/`;
  }
  if (name !== AGENT || NAX_ALLOWED_AGENT_SPECS.has(spec)) return null;
  if (inDir(pkg, file, "test") && NAX_AGENT_HELPERS.has(spec)) return null;
  return `only ${[...NAX_ALLOWED_AGENT_SPECS].join(" or ")} (and ${[...NAX_AGENT_HELPERS].join(", ")} from test/)`;
}

/** test-kit and repo-tooling: leaf packages that import no nax package (repo-tooling's tests may use test-kit). */
function toolingViolation(pkg: PackageInfo, file: string, spec: string): string | null {
  if (isBuiltin(spec) || spec.startsWith("#")) return null;
  if (spec.startsWith(".")) return leavesPackage(pkg, file, spec) ? "relative import leaves the package" : null;
  const name = packageName(spec);
  if (name === pkg.name) return null;
  if (pkg.devDeps.has(name)) return inDir(pkg, file, "test") ? null : `devDependency ${name} imported outside test/`;
  if (NAX_PACKAGES.has(name)) return `${pkg.name} imports ${name}`;
  if (pkg.deps.has(name)) return null;
  return `undeclared dependency ${name}`;
}
```

Add both packages to `RULES`:

```ts
const RULES: Readonly<Record<string, Rule>> = {
  "@nathapp/nax-agent": agentViolation,
  "@nathapp/nax-ai": naxAiViolation,
  "@nathapp/nax": naxViolation,
  [TEST_KIT]: toolingViolation,
  [REPO_TOOLING]: toolingViolation,
};
```

In `agentViolation`, change `const inTests = relative(pkg.dir, file).startsWith(\`test${sep}\`);` to `const inTests = inDir(pkg, file, "test");` (same behaviour, one helper).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd packages/nax && bun test test/unit/scripts/check-package-boundaries.test.ts --timeout=60000`
Expected: PASS, all tests.

Run: `bun run check:package-boundaries`
Expected: exactly ten violations, one per generic shim `packages/nax/test/helpers/<name>.ts` (they still import `@nathapp/nax-agent/test/helpers/<name>`, which the narrowed rule no longer allows). Nothing else. Task 2 retargets those shims. Do **not** commit yet: Task 2 commits both together, so no commit has a red gate.

---

### Task 2: `test-kit` package; move the ten generic helpers

**Files:**
- Create: `packages/test-kit/package.json`, `packages/test-kit/tsconfig.json`, `packages/test-kit/biome.json`
- Move: `packages/nax-agent/test/helpers/{absent,assert-defined,deps,fake-clock,fs,mock-fetch,session-tmp-deps,spawn,temp,timeout}.ts` → `packages/test-kit/src/bun/`
- Modify: `packages/nax-agent/test/helpers/index.ts`, `packages/nax-agent/test/helpers/command-safety.ts`, `packages/nax-agent/package.json`
- Modify: the ten `packages/nax/test/helpers/<name>.ts` shims, `packages/nax/package.json`
- Test: `packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts`

**Interfaces:**
- Consumes: Task 1's rules.
- Produces: `@nathapp/nax-test-kit/bun/<name>` for the ten names above, each exporting exactly what it exported before the move (for example `makeTempDir`, `cleanupTempDir` and `withTempDir` from `temp`; `withDepsRestore` from `deps`; `makeSpawn` and `makeSpawnResult` from `spawn`).

- [ ] **Step 1: Extend the Biome parity test to cover test-kit (failing)**

In `nax-agent-biome-parity.test.ts`, wrap the existing three tests in a loop over the package copies. Replace `describe("nax-agent biome config", () => {` … `});` with:

```ts
for (const pkg of ["nax-agent", "test-kit"]) {
  describe(`${pkg} biome config`, () => {
    test("has nax's linter and formatter settings", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy.linter).toEqual(nax.linter);
      expect(copy.formatter).toEqual(nax.formatter);
    });

    test("runs nax's root plugins from nax's biome-plugins directory", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      expect(copy.plugins).toEqual(nax.plugins?.map((p) => p.replace("./biome-plugins/", "../nax/biome-plugins/")));
    });

    test("keeps nax's test/** override", async () => {
      const [nax, copy] = await Promise.all([config("nax"), config(pkg)]);
      const testOverride = (c: BiomeConfig) => c.overrides?.find((o) => o.includes?.includes("**/test/**"));
      expect(testOverride(copy)?.linter).toEqual(testOverride(nax)?.linter);
    });
  });
}
```

If the file has other tests after these three, leave them unchanged. Then run `cd packages/nax && bun test test/unit/scripts/nax-agent-biome-parity.test.ts`. Expected: FAIL for `test-kit` (`ENOENT` on `packages/test-kit/biome.json`).

- [ ] **Step 2: Create the package**

`packages/test-kit/package.json`:

```json
{
  "name": "@nathapp/nax-test-kit",
  "version": "0.0.0",
  "private": true,
  "description": "Shared bun:test helpers for the nax workspace packages. Never published.",
  "type": "module",
  "exports": {
    "./bun/*": "./src/bun/*.ts"
  },
  "scripts": {
    "typecheck": "bun x tsc --noEmit",
    "lint": "bun x biome check --error-on-warnings --diagnostic-level=warn src/",
    "lint:fix": "bun x biome check --write src/",
    "check:all": "bun run --silent lint"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.10",
    "@types/bun": "^1.3.8",
    "bun-types": "^1.3.9",
    "typescript": "7.0.2"
  },
  "license": "MIT"
}
```

`packages/test-kit/tsconfig.json`: copy `packages/nax-agent/tsconfig.json` and set `"include": ["src/**/*.ts"]`.

`packages/test-kit/biome.json`: copy `packages/nax-agent/biome.json` byte-for-byte. Both are siblings of `packages/nax`, so `../nax/biome-plugins/` resolves the same.

- [ ] **Step 3: Move the helpers**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
mkdir -p packages/test-kit/src/bun
for n in absent assert-defined deps fake-clock fs mock-fetch session-tmp-deps spawn temp timeout; do
  git mv "packages/nax-agent/test/helpers/$n.ts" "packages/test-kit/src/bun/$n.ts"
done
```

The moved files import only `node:*`, `bun:test` and each other's siblings. No content change is needed, except one doc comment in `deps.ts`: its usage example says `import { withDepsRestore } from "@test/helpers";`. Leave it; it is still true for nax tests.

- [ ] **Step 4: Repoint nax-agent's barrel and the one agent-bound helper**

In `packages/nax-agent/test/helpers/index.ts`, change each moved helper's `from "./<name>"` to `from "@nathapp/nax-test-kit/bun/<name>"` (ten names; `command-safety`, `sandbox` and `systemone-stub` keep `./`). Update the header line to:

```ts
/** Barrel for nax-agent's test helpers: the generic ones live in @nathapp/nax-test-kit/bun (S2-0). */
```

In `packages/nax-agent/test/helpers/command-safety.ts`, change `from "./assert-defined"` to `from "@nathapp/nax-test-kit/bun/assert-defined"`.

In `packages/nax-agent/package.json`:
- replace `"./test/helpers/*": "./test/helpers/*.ts"` with the three exact subpaths:

```json
    "./test/helpers/command-safety": "./test/helpers/command-safety.ts",
    "./test/helpers/sandbox": "./test/helpers/sandbox.ts",
    "./test/helpers/systemone-stub": "./test/helpers/systemone-stub.ts"
```

- add `"@nathapp/nax-test-kit": "workspace:*"` to `devDependencies`.

- [ ] **Step 5: Retarget nax's ten shims**

For each of the ten names, rewrite `packages/nax/test/helpers/<name>.ts` to exactly:

```ts
/** Moved to @nathapp/nax-test-kit by S2-0; nax keeps this path for its own tests. */
export * from "@nathapp/nax-test-kit/bun/<name>";
```

(with `<name>` substituted). Leave `command-safety.ts`, `sandbox.ts` and `systemone-stub.ts` unchanged.

In `packages/nax/package.json` `devDependencies`, add `"@nathapp/nax-test-kit": "workspace:*"`. Do not touch `dependencies`.

Then:

```bash
bun install
```

Expected: `bun.lock` gains the two workspace links. `git diff --stat bun.lock` is small.

- [ ] **Step 6: Verify**

```bash
cd packages/test-kit && bun run typecheck && bun run check:all
cd ../nax-agent && bun run typecheck && bun run check:all && bun test ./test/unit/ --timeout=60000 2>&1 | tail -4
cd ../nax && bun run typecheck && bun test test/unit/scripts/nax-agent-biome-parity.test.ts test/unit/scripts/check-package-boundaries.test.ts && bun run check:package-boundaries && bun test test/unit/ --timeout=60000 2>&1 | tail -4
```

Expected:
- every command is green;
- nax-agent unit equals `/tmp/s2-0-agent-unit-before.txt`;
- nax unit equals `/tmp/s2-0-nax-unit-before.txt` + 3 (Task 1: one boundary test replaced, three added) + 3 (the parity loop's test-kit copy).

- [ ] **Step 7: Commit**

```bash
git add -A packages/test-kit packages/nax-agent packages/nax/test/helpers packages/nax/package.json packages/nax/scripts/check-package-boundaries.ts packages/nax/test/unit/scripts bun.lock
git commit -m "refactor: move the generic test helpers into a private test-kit package"
```

---

### Task 3: `repo-tooling` package; package-rooted gates default to the cwd

**Files:**
- Create: `packages/repo-tooling/package.json`, `tsconfig.json`, `biome.json`, `bunfig.toml`
- Move: `packages/nax/scripts/lib/package-root.ts` → `packages/repo-tooling/scripts/lib/package-root.ts`
- Move: `packages/nax/test/unit/scripts/package-root.test.ts` → `packages/repo-tooling/test/unit/scripts/package-root.test.ts`
- Create: `packages/repo-tooling/scripts/lib/sort.ts`
- Modify: `packages/nax/test/unit/scripts/nax-agent-biome-parity.test.ts`

**Interfaces:**
- Produces:
  - `gatePackageRoot(argv: readonly string[] = process.argv, cwd: string = process.cwd()): string`. It returns `--package=<dir>` resolved against `cwd`, else `cwd`. **The `scriptDir` parameter is removed.**
  - `gateBaselinePath(packageRoot: string, file: string): string`, unchanged.
  - `byCodePoint(a: string, b: string): number` in `#scripts/lib/sort`.

- [ ] **Step 1: Create the package skeleton**

`packages/repo-tooling/package.json`:

```json
{
  "name": "@nathapp/nax-repo-tooling",
  "version": "0.0.0",
  "private": true,
  "description": "Check scripts shared by the nax workspace packages. Never published.",
  "type": "module",
  "exports": {
    "./scripts/*": "./scripts/*.ts"
  },
  "imports": {
    "#scripts/*": "./scripts/*.ts"
  },
  "scripts": {
    "typecheck": "bun x tsc --noEmit",
    "lint": "bun x biome check --error-on-warnings --diagnostic-level=warn scripts/ test/",
    "lint:fix": "bun x biome check --write scripts/ test/",
    "test": "bun test ./test/unit/ --timeout=60000",
    "check:all": "bun run --silent lint"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.10",
    "@nathapp/nax-test-kit": "workspace:*",
    "@types/bun": "^1.3.8",
    "bun-types": "^1.3.9",
    "typescript": "7.0.2"
  },
  "license": "MIT"
}
```

`packages/repo-tooling/tsconfig.json`: copy `packages/nax-agent/tsconfig.json` and set `"include": ["scripts/**/*.ts", "test/**/*.ts"]`.

`packages/repo-tooling/biome.json`: copy `packages/nax-agent/biome.json` byte-for-byte.

`packages/repo-tooling/bunfig.toml`:

```toml
# Bun test configuration for repo-tooling (the gate scripts' own tests).

[test]
smol = true
root = "./test"
timeout = 5000
```

In `nax-agent-biome-parity.test.ts`, change the loop list to `["nax-agent", "test-kit", "repo-tooling"]`.

- [ ] **Step 2: Move package-root and its test**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
mkdir -p packages/repo-tooling/scripts/lib packages/repo-tooling/test/unit/scripts
git mv packages/nax/scripts/lib/package-root.ts packages/repo-tooling/scripts/lib/package-root.ts
git mv packages/nax/test/unit/scripts/package-root.test.ts packages/repo-tooling/test/unit/scripts/package-root.test.ts
```

In the moved test, change `from "@scripts/lib/package-root"` to `from "#scripts/lib/package-root"` and `from "@test/helpers"` (if present) to `from "@nathapp/nax-test-kit/bun/temp"`.

- [ ] **Step 3: Write the failing tests for the cwd default**

In the moved `package-root.test.ts`, replace the `describe("gatePackageRoot", ...)` block with:

```ts
describe("gatePackageRoot", () => {
  test("defaults to the current working directory, not the script's own package", () => {
    expect(gatePackageRoot(["bun", "check-x.ts"], "/repo/packages/nax")).toBe("/repo/packages/nax");
  });

  test("--package= resolves a relative directory against the cwd", () => {
    expect(gatePackageRoot(["bun", "check-x.ts", "--package=."], "/repo/packages/nax-agent")).toBe(
      "/repo/packages/nax-agent",
    );
    expect(gatePackageRoot(["bun", "check-x.ts", "--package=../nax"], "/repo/packages/nax-agent")).toBe(
      "/repo/packages/nax",
    );
  });

  test("--package= keeps an absolute directory", () => {
    expect(gatePackageRoot(["bun", "check-x.ts", "--package=/abs/pkg"], "/repo")).toBe("/abs/pkg");
  });
});
```

Leave `describe("gateBaselinePath", ...)` unchanged. The `"a gate honours --package="` block spawns `NAX_ERROR_GATE` and `SATELLITES_GATE` at `../../../scripts/...`; those gates arrive in Task 4, so this block stays red until then. Do not skip or edit it.

Run: `cd packages/repo-tooling && bun install && bun test ./test/unit/scripts/package-root.test.ts`
Expected: the three new `gatePackageRoot` tests FAIL (the signature still takes `scriptDir`), and the `--package=` block fails (gate scripts not there yet).

- [ ] **Step 4: Implement**

Replace `packages/repo-tooling/scripts/lib/package-root.ts` with:

```ts
/**
 * Which package a gate scans. Gates live in packages/repo-tooling and scan the
 * package they are run from: the current working directory by default (every
 * `bun run check:*` runs from its package directory), or `--package=<dir>`
 * resolved against the cwd. A baseline lives with the package it describes.
 */
import { isAbsolute, join, resolve } from "node:path";

const FLAG = "--package=";

export function gatePackageRoot(argv: readonly string[] = process.argv, cwd: string = process.cwd()): string {
  const flag = argv.find((a) => a.startsWith(FLAG));
  if (flag === undefined) return cwd;
  const dir = flag.slice(FLAG.length);
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

export function gateBaselinePath(packageRoot: string, file: string): string {
  return join(packageRoot, "scripts", "baselines", file);
}
```

Create `packages/repo-tooling/scripts/lib/sort.ts`:

```ts
/**
 * Code-point ordering for strings: a local copy of nax-agent's `byCodePoint`
 * (packages/nax-agent/src/internal/sort.ts). repo-tooling depends on no nax
 * package, so the gates that need a stable order use this one-liner instead.
 */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
```

- [ ] **Step 5: Run the gatePackageRoot tests**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/package-root.test.ts -t "gatePackageRoot|gateBaselinePath"`
Expected: PASS for `gatePackageRoot` and `gateBaselinePath`. The `--package=` block is still red until Task 4. **Do not commit yet**: Tasks 3 and 4 land as one commit, because nax's gates import `./lib/package-root` until Task 4 rewires them.

---

### Task 4: Move the shared gates and their tests; rewire every caller

**Files:**
- Move (`git mv`) `packages/nax/scripts/<gate>.ts` → `packages/repo-tooling/scripts/<gate>.ts` for: `check-nax-error`, `check-file-sizes`, `check-complexity`, `check-import-cycles`, `check-test-as-unknown-as`, `check-test-escape-hatches`, `check-test-satellites`, `check-no-control-bytes`, `check-no-real-global-nax`, `check-permission-mode-ssot`, `check-feature-dir-ssot`, `check-package-frame-derivation`, `check-git-spawn-env`, `check-sandbox-imports`, `check-nax-ai-imports`, `report-test-consolidation`.
- Move the matching tests `packages/nax/test/unit/scripts/<gate>.test.ts` → `packages/repo-tooling/test/unit/scripts/<gate>.test.ts`, except the blocks Step 3 keeps in nax. `check-nax-error.test.ts` and `check-file-sizes.test.ts` do not exist.
- Modify: the moved gates' imports; `packages/nax/package.json` and `packages/nax-agent/package.json` scripts; `packages/nax/scripts/lib/import-specifiers.ts`.
- Create: `packages/nax/test/unit/scripts/check-complexity-nax.test.ts`, plus any other `<gate>-nax.test.ts` that Step 3 requires.

**Interfaces:**
- Consumes: `gatePackageRoot()`, `gateBaselinePath()` and `byCodePoint` from Task 3.
- Produces: `packages/repo-tooling/scripts/<gate>.ts` with every existing export unchanged, importable as `@nathapp/nax-repo-tooling/scripts/<gate>` or `#scripts/<gate>`.

- [ ] **Step 1: Move the gate files**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
GATES="check-nax-error check-file-sizes check-complexity check-import-cycles check-test-as-unknown-as check-test-escape-hatches check-test-satellites check-no-control-bytes check-no-real-global-nax check-permission-mode-ssot check-feature-dir-ssot check-package-frame-derivation check-git-spawn-env check-sandbox-imports check-nax-ai-imports report-test-consolidation"
for g in $GATES; do git mv "packages/nax/scripts/$g.ts" "packages/repo-tooling/scripts/$g.ts"; done
for g in $GATES; do [ -f "packages/nax/test/unit/scripts/$g.test.ts" ] && git mv "packages/nax/test/unit/scripts/$g.test.ts" "packages/repo-tooling/test/unit/scripts/$g.test.ts"; done
git status --short | grep -c '^R'
```

Expected: `R` count = 16 gates + 14 tests + the 2 Task 3 moves = 32.

- [ ] **Step 2: Fix the moved gates' imports**

In every moved gate:
- `from "./lib/package-root"` → `from "#scripts/lib/package-root"`;
- `from "@nathapp/nax-agent/internal"` (`byCodePoint`, in `check-nax-error`, `check-complexity`, `check-test-satellites`) → `from "#scripts/lib/sort"`;
- `from "./report-test-consolidation"` (in `check-test-satellites`) → `from "#scripts/report-test-consolidation"`;
- `gatePackageRoot(import.meta.dir)` → `gatePackageRoot()` (in the seven package-rooted gates and `report-test-consolidation`).

Verify:

```bash
cd packages/repo-tooling && grep -nE 'from "\./lib/|nax-agent|import\.meta\.dir\)' scripts/*.ts
```

Expected: no output.

- [ ] **Step 3: Keep the blocks that read nax's own tree in nax**

A moved test whose `REPO`/`repoRoot` is `join(import.meta.dir, "..", "..", "..")` now points at repo-tooling, not nax. Any block that relies on nax's real files must stay in nax. Known blocks:

| Moved test | Block(s) that stay in nax | New nax file |
|---|---|---|
| `check-complexity.test.ts` | `describe("biome.json")` (imports `@/worktree`, reads nax's `biome.json`) and `describe("check-complexity script")` (runs against nax's committed complexity baseline) | `test/unit/scripts/check-complexity-nax.test.ts` |
| `check-git-spawn-env.test.ts` | the test in `describe("check-git-spawn-env CLI")` that sets `repoRoot = join(import.meta.dir, "../../..")` and scans nax's real tree | `test/unit/scripts/check-git-spawn-env-nax.test.ts` |
| `check-test-satellites.test.ts` | any test that reads `NAX_BASELINE` (nax's real `scripts/baselines/test-satellites-baseline.json`) | `test/unit/scripts/check-test-satellites-nax.test.ts` |
| `report-test-consolidation.test.ts` | every block (they spawn the report with `cwd: REPO` against nax's real test tree) | the whole file stays: `git mv` it back to `packages/nax/test/unit/scripts/report-test-consolidation.test.ts` |

For each row:
- cut the block(s) out of the moved file into the new nax file;
- copy the imports they use, with gate imports as `from "@nathapp/nax-repo-tooling/scripts/<gate>"` and `REPO` re-derived the same way (it now resolves to `packages/nax` again);
- change script paths from `join(REPO, "scripts", "<gate>.ts")` / `join(import.meta.dir, "../../../scripts/<gate>.ts")` to `join(REPO, "..", "repo-tooling", "scripts", "<gate>.ts")`;
- keep the spawn `cwd` as nax.

Then audit the rest: open each remaining moved test and confirm that every `import.meta.dir`-derived path points either at a temp fixture or at `../../../scripts/<gate>.ts`, which is now repo-tooling's copy of the gate itself. Any other block that reads a real nax file joins the table above.

Imports in the moved tests (all files under `packages/repo-tooling/test/`):
- `@scripts/` → `#scripts/`;
- `@test/helpers` → `@nathapp/nax-test-kit/bun/temp` (they use `makeTempDir`/`cleanupTempDir` only; if a file also uses another helper, import it from its own `@nathapp/nax-test-kit/bun/<name>`);
- `@nathapp/nax-agent/internal` (`byCodePoint` in `check-import-cycles.test.ts`) → `#scripts/lib/sort`.

`check-nax-ai-imports.test.ts` and `check-sandbox-imports.test.ts` mention `@nathapp/nax-ai`, `#src/...` and `../pipeline/stages` only **inside fixture strings**. Verify with `grep -n '^import' <file>` and leave those strings alone.

- [ ] **Step 4: Rewire nax's scripts**

In `packages/nax/package.json`, for each moved gate change only the path. Every script **name** stays the same:

```bash
cd packages/nax
for g in check-nax-error check-file-sizes check-complexity check-import-cycles check-test-as-unknown-as check-test-escape-hatches check-test-satellites check-no-control-bytes check-no-real-global-nax check-permission-mode-ssot check-feature-dir-ssot check-package-frame-derivation check-git-spawn-env check-sandbox-imports check-nax-ai-imports report-test-consolidation; do
  sed -i '' "s#scripts/$g\.ts#../repo-tooling/scripts/$g.ts#g" package.json
done
grep -c 'repo-tooling/scripts' package.json
```

Expected: the count equals the number of script entries that named a moved gate on `main` (each `check:x` plus each `:update` variant). Check it by hand with `git diff package.json`.

Add `"@nathapp/nax-repo-tooling": "workspace:*"` to nax's `devDependencies`.

In `packages/nax/scripts/lib/import-specifiers.ts`, change `from "../check-import-cycles"` to `from "@nathapp/nax-repo-tooling/scripts/check-import-cycles"`.

- [ ] **Step 5: Rewire nax-agent's scripts**

In `packages/nax-agent/package.json`, replace every `../nax/scripts/` with `../repo-tooling/scripts/` (in `lint:checks`, `check:test-satellites` and `check:test-satellites:update`). `--package=.` and the trailing `.` arguments stay.

```bash
cd ../nax-agent && sed -i '' 's#\.\./nax/scripts/#../repo-tooling/scripts/#g' package.json && grep -c '\.\./nax/scripts' package.json
```

Expected: `0`.

nax-agent's `test/unit/tools/policy.test.ts:489` mentions `bun scripts/check-test-escape-hatches.ts` in a comment only. Leave it.

- [ ] **Step 6: Install and typecheck**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax && bun install
cd packages/repo-tooling && bun run typecheck
cd ../nax && bun run typecheck
cd ../nax-agent && bun run typecheck
```

Expected: all green.

- [ ] **Step 7: Run the moved and split tests**

```bash
cd packages/repo-tooling && bun test ./test/unit/ --timeout=60000 2>&1 | tail -4
cd ../nax && bun test test/unit/scripts/ --timeout=60000 2>&1 | tail -4
```

Expected: both green. This includes the `"a gate honours --package="` block in `package-root.test.ts`, whose spawned gates now exist at `../../../scripts/`. If a moved test fails only because nax's test preload is missing (for example it needs `NAX_GLOBAL_CONFIG_DIR` isolated), add **only that isolation** to a new `packages/repo-tooling/test/preload.ts`, wire it in `bunfig.toml` (`preload = ["./test/preload.ts"]`), and record the reason in the commit body. Do not change the test.

- [ ] **Step 8: Prove nothing silently re-scoped**

```bash
cd packages/repo-tooling && grep -nE 'join\(import\.meta\.dir, *"\.\.", *"\.\.", *"\.\."\)|"\.\./\.\./\.\."' test/unit/scripts/*.test.ts
```

Expected: every hit is followed by `scripts/<gate>.ts`, the gate under test. Any hit that reads `src/`, `test/`, `biome.json` or `scripts/baselines/` is a real-tree block that belongs in nax (Step 3).

- [ ] **Step 9: Gate outputs are unchanged**

```bash
cd packages/nax && for s in nax-error file-sizes complexity import-cycles test-as-unknown-as test-escape-hatches test-satellites no-control-bytes no-real-global-nax permission-mode-ssot feature-dir-ssot package-frame-derivation git-spawn-env sandbox-imports nax-ai-imports; do echo "== $s"; bun run --silent check:$s 2>&1 | tail -3; done > /tmp/s2-0-nax-gates-after.txt
diff /tmp/s2-0-nax-gates-before.txt /tmp/s2-0-nax-gates-after.txt
cd ../nax-agent && bun run --silent lint:checks > /tmp/s2-0-agent-gates-after.txt 2>&1; echo "exit $?" >> /tmp/s2-0-agent-gates-after.txt
diff /tmp/s2-0-agent-gates-before.txt /tmp/s2-0-agent-gates-after.txt
```

Expected: no diff (same file counts, same OK lines, same exit). A diff in a count means a gate is scanning a different package: stop and fix the scoping, never the baseline.

- [ ] **Step 10: Commit (Tasks 3 and 4 together)**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A packages/repo-tooling packages/nax packages/nax-agent bun.lock
git commit -m "refactor: move the shared check scripts into a private repo-tooling package

Gates scan the package they are run from (cwd) unless --package= says
otherwise; nax and nax-agent call one implementation of each gate.
Test blocks that read nax's own tree stay in nax."
```

---

### Task 5: Move `check-no-bun-apis` from nax-ai; give it `--package`

**Files:**
- Move: `packages/nax-ai/scripts/check-no-bun-apis.ts` → `packages/repo-tooling/scripts/check-no-bun-apis.ts`
- Modify: `packages/nax-ai/package.json` (`check:no-bun-apis`)
- Test: `packages/repo-tooling/test/unit/scripts/check-no-bun-apis.test.ts` (new; the gate had no test)

**Interfaces:**
- Produces: `findBunApiUses(srcDir: string, packageRoot: string): Promise<BunApiViolation[]>` where `interface BunApiViolation { readonly file: string; readonly line: number; readonly text: string }`. `file` is relative to `packageRoot`. The CLI scans `<gatePackageRoot()>/src`.

- [ ] **Step 1: Write the failing test**

`packages/repo-tooling/test/unit/scripts/check-no-bun-apis.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { findBunApiUses } from "#scripts/check-no-bun-apis";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function src(name: string, content: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", name), content, "utf8");
}

describe("findBunApiUses", () => {
  test("flags Bun globals and bun: modules in code, relative to the package", async () => {
    root = makeTempDir("no-bun-apis-");
    src("a.ts", 'const f = Bun.file("x");\nimport { test } from "bun:test";\nconst ok = 1;\n');
    expect(await findBunApiUses(join(root, "src"), root)).toEqual([
      { file: join("src", "a.ts"), line: 1, text: 'const f = Bun.file("x");' },
      { file: join("src", "a.ts"), line: 2, text: 'import { test } from "bun:test";' },
    ]);
  });

  test("ignores comment lines and identifiers that merely end in Bun", async () => {
    root = makeTempDir("no-bun-apis-");
    src("b.ts", "// Bun.spawn is not allowed here\n * Bun.file in a doc comment\nconst myBun = { x: 1 };\nmyBun.x;\n");
    expect(await findBunApiUses(join(root, "src"), root)).toEqual([]);
  });
});
```

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/check-no-bun-apis.test.ts`
Expected: FAIL (`Cannot find module '#scripts/check-no-bun-apis'`).

- [ ] **Step 2: Move and refactor the gate**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git mv packages/nax-ai/scripts/check-no-bun-apis.ts packages/repo-tooling/scripts/check-no-bun-apis.ts
```

Edit the moved file. Keep the header comment, but change "This package declares `engines.node >= 22.19`" to "A package this gate runs over declares `engines.node >= 22.19`". Replace the `ROOT`/`SCAN_DIR` constants, `Violation` and `main()` with:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gatePackageRoot } from "#scripts/lib/package-root";

const BUN_GLOBAL = /(?<![\w$.])Bun\s*\./;
const BUN_MODULE = /from\s+["']bun:[\w-]+["']|import\s*\(\s*["']bun:[\w-]+["']/;

export interface BunApiViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

/** Every non-comment line under `srcDir` that uses a Bun global or a `bun:` module. */
export async function findBunApiUses(srcDir: string, packageRoot: string): Promise<BunApiViolation[]> {
  const violations: BunApiViolation[] = [];
  for await (const file of walk(srcDir)) {
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((text, index) => {
      // Comments legitimately discuss Bun (this gate's own rationale does),
      // so only flag lines that are not purely commentary.
      const stripped = text.trim();
      if (stripped.startsWith("*") || stripped.startsWith("//")) return;
      if (BUN_GLOBAL.test(text) || BUN_MODULE.test(text)) {
        violations.push({ file: relative(packageRoot, file), line: index + 1, text: stripped });
      }
    });
  }
  return violations;
}

async function main(): Promise<void> {
  const root = gatePackageRoot();
  const violations = await findBunApiUses(join(root, "src"), root);
  if (violations.length > 0) {
    console.error(`Bun-specific APIs found in src/ (${violations.length}):\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
    console.error("\nThis package must run on Node. Use node: builtins or web globals instead.");
    process.exit(1);
  }
  console.log("check-no-bun-apis: clean");
}

if (import.meta.main) await main();
```

The original file used `console.*` in a script; repo-tooling's Biome config is nax's, which errors on `noConsole` outside tests. Check how the other moved gates print (for example `check-package-frame-derivation.ts`) and use the same pattern. If they carry a `biome-ignore` for `noConsole`, or the config allows console in `scripts/`, follow that exactly.

In `packages/nax-ai/package.json`, change the script to:

```json
    "check:no-bun-apis": "bun ../repo-tooling/scripts/check-no-bun-apis.ts --package=.",
```

- [ ] **Step 3: Run the tests and the gate**

```bash
cd packages/repo-tooling && bun test ./test/unit/scripts/check-no-bun-apis.test.ts && bun run check:all
cd ../nax-ai && bun run check:no-bun-apis && bun run lint
```

Expected: tests PASS; nax-ai prints `check-no-bun-apis: clean`; lint green.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A packages/repo-tooling packages/nax-ai
git commit -m "refactor: move check-no-bun-apis into repo-tooling with --package"
```

---

### Task 6: `check-gate-reachability` sees repo-tooling's gates

Today the meta-gate discovers only `packages/nax/scripts/check-*` and follows only nax's `package.json`. After the move, 16 gates live in repo-tooling, and `check-no-bun-apis` is run only by nax-ai.

**Files:**
- Modify: `packages/nax/scripts/check-gate-reachability.ts`
- Test: `packages/nax/test/unit/scripts/check-gate-reachability.test.ts`

**Interfaces:**
- Produces: `findUnreachableCheckScriptsInRepo(packageRoot: string, repoRoot: string): string[]`, same signature. It discovers the check scripts of `packageRoot/scripts` and of `<repoRoot>/packages/repo-tooling/scripts`, and counts a script as reached when CI or any workspace package's `package.json` reaches it.

- [ ] **Step 1: Write the failing test**

Append to `check-gate-reachability.test.ts` (add `findUnreachableCheckScriptsInRepo` to the existing import from `@scripts/check-gate-reachability`, and `@nathapp/nax-agent/internal`'s `byCodePoint` stays as is):

```ts
describe("findUnreachableCheckScriptsInRepo across workspace packages", () => {
  let repo = "";
  afterEach(() => {
    if (repo) cleanupTempDir(repo);
    repo = "";
  });

  function file(rel: string, content: string): void {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }

  function seed(naxAiScripts: Record<string, string>): void {
    repo = makeTempDir("gate-reach-ws-");
    file(".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - run: bun run check:all\n");
    file(
      "packages/nax/package.json",
      JSON.stringify({ scripts: { "check:all": "bun scripts/check-a.ts && bun ../repo-tooling/scripts/check-b.ts" } }),
    );
    file("packages/nax/scripts/check-a.ts", "");
    file("packages/repo-tooling/package.json", JSON.stringify({ scripts: { "check:all": "bun run lint" } }));
    file("packages/repo-tooling/scripts/check-b.ts", "");
    file("packages/repo-tooling/scripts/check-c.ts", "");
    file("packages/nax-ai/package.json", JSON.stringify({ scripts: naxAiScripts }));
  }

  test("a repo-tooling gate reached only from another package counts as reached", () => {
    seed({ "check:all": "bun ../repo-tooling/scripts/check-c.ts --package=." });
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax"), repo)).toEqual([]);
  });

  test("a repo-tooling gate no package runs is reported", () => {
    seed({ "check:all": "bun run lint" });
    expect(findUnreachableCheckScriptsInRepo(join(repo, "packages", "nax"), repo)).toEqual(["check-c.ts"]);
  });
});
```

Run: `cd packages/nax && bun test test/unit/scripts/check-gate-reachability.test.ts`
Expected: the second test FAILS (expects `["check-c.ts"]`, gets `[]`, because today's code never discovers repo-tooling's scripts). The first test passes today for the same wrong reason; it pins the cross-package credit once discovery is added.

- [ ] **Step 2: Implement**

In `check-gate-reachability.ts`, replace `findUnreachableCheckScriptsInRepo` with:

```ts
const TOOLING_DIR = join("packages", "repo-tooling");

function readScripts(dir: string): Record<string, string> {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return {};
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

function workspacePackageDirs(repoRoot: string): string[] {
  const dir = join(repoRoot, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort(byCodePoint)
    .map((name) => join(dir, name))
    .filter((d) => existsSync(join(d, "package.json")));
}

/** Resolves every input from the repo on disk, then applies the rule.
 *  The checked scripts are `packageRoot/scripts` plus repo-tooling's (S2-0);
 *  a script counts as reached when CI or any workspace package's scripts reach it. */
export function findUnreachableCheckScriptsInRepo(packageRoot: string, repoRoot: string): string[] {
  const ciPath = join(repoRoot, CI_WORKFLOW);
  const ci = existsSync(ciPath)
    ? parseCiEntryPoints(readFileSync(ciPath, "utf8"))
    : { scriptNames: [], scriptFiles: [] };

  const reached = new Set<string>();
  for (const dir of [packageRoot, ...workspacePackageDirs(repoRoot)]) {
    const inputs = { entryScriptNames: ci.scriptNames, entryScriptFiles: ci.scriptFiles, packageScripts: readScripts(dir) };
    for (const file of collectReachableScriptFiles(inputs)) reached.add(file);
  }

  const checkScripts = [
    ...new Set([...discoverCheckScripts(packageRoot), ...discoverCheckScripts(join(repoRoot, TOOLING_DIR))]),
  ];
  return checkScripts.filter((name) => !reached.has(name)).sort(byCodePoint);
}
```

`SCRIPT_FILE_RE` matches `scripts/check-x.ts` inside `../repo-tooling/scripts/check-x.ts`, so the existing walk already credits cross-package paths. Update `main()`'s success line to count both directories:

```ts
  const total = new Set([
    ...discoverCheckScripts(packageRoot),
    ...discoverCheckScripts(join(findRepoRoot(packageRoot), TOOLING_DIR)),
  ]).size;
  console.log(`OK: all ${total} check scripts are reachable from CI`);
```

- [ ] **Step 3: Run**

```bash
cd packages/nax && bun test test/unit/scripts/check-gate-reachability.test.ts && bun run check:gate-reachability
```

Expected: tests PASS; the real gate prints `OK: all N check scripts are reachable from CI`, where N = nax's remaining check scripts + 16.

- [ ] **Step 4: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add packages/nax/scripts/check-gate-reachability.ts packages/nax/test/unit/scripts/check-gate-reachability.test.ts
git commit -m "fix: check-gate-reachability covers repo-tooling's gates across packages"
```

---

### Task 7: CI, context, citations, full verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.nax/context.md`, then regenerate the generated agent files
- Modify: comments in `packages/nax/src` and `packages/nax-agent/src` that name a moved gate's old path

- [ ] **Step 1: CI job**

In `.github/workflows/ci.yml`, after the `nax-agent` job, add:

```yaml
  tooling:
    name: tooling
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: packages/repo-tooling
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - name: Cache bun dependencies
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile
        working-directory: .

      - name: Typecheck (repo-tooling)
        run: bun run typecheck

      - name: Check all (repo-tooling)
        run: bun run check:all

      - name: Test (repo-tooling)
        run: bun run test

      - name: Typecheck (test-kit)
        run: bun run typecheck
        working-directory: packages/test-kit

      - name: Check all (test-kit)
        run: bun run check:all
        working-directory: packages/test-kit
```

In the `nax-agent` job, update the comment above `Check all` to say `bun ../repo-tooling/scripts/check-*.ts --package=.`.

- [ ] **Step 2: Context**

In `.nax/context.md`, add two rows to the Layout table:

```markdown
| `packages/repo-tooling` | `@nathapp/nax-repo-tooling` | Check scripts shared by the packages (private; never published) |
| `packages/test-kit` | `@nathapp/nax-test-kit` | Shared bun:test helpers (private; never published) |
```

Under Tooling, add:

```markdown
- Gates shared by more than one package live in `packages/repo-tooling/scripts/` and scan the package they are run from (`--package=<dir>` overrides). Gates only nax runs stay in `packages/nax/scripts/`.
```

Then regenerate every generated file (root and all packages):

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
git status --short | grep -E 'CLAUDE.md|AGENTS.md|GEMINI.md|codex.md'
```

Expected: the root generated files change. Package files change only if the generator output differs.

- [ ] **Step 3: Stale path citations**

```bash
cd packages
for g in check-nax-error check-file-sizes check-complexity check-import-cycles check-test-as-unknown-as check-test-escape-hatches check-test-satellites check-no-control-bytes check-no-real-global-nax check-permission-mode-ssot check-feature-dir-ssot check-package-frame-derivation check-git-spawn-env check-sandbox-imports check-nax-ai-imports report-test-consolidation check-no-bun-apis; do
  grep -rn "scripts/$g" nax/src nax-agent/src nax-ai/src ../.nax/rules 2>/dev/null | grep -v "repo-tooling/scripts/$g"
done
```

For each hit that names the old file path, change it to `packages/repo-tooling/scripts/<gate>.ts`. Hits that name a `bun run check:*` script stay unchanged (script names are unchanged). If `.nax/rules` changed, run `bun packages/nax/bin/nax.ts rules export --agent=claude` so `check:rules-drift` stays green.

- [ ] **Step 4: Full verification**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run typecheck
bun run check:all
cd packages/nax && bun test test/unit/ --timeout=60000 2>&1 | tail -4 && bun test test/integration/ --timeout=60000 2>&1 | tail -4 && bun run build && bun run check:bundle-externals && bun run test:coverage 2>&1 | tail -6
cd ../nax-agent && bun test ./test/unit/ --timeout=60000 2>&1 | tail -4 && bun test ./test/integration/ --timeout=60000 2>&1 | tail -4
cd ../repo-tooling && bun run test 2>&1 | tail -4
cd ../nax && git diff origin/main -- package.json | grep -A12 '"dependencies"'
```

Expected:
- every command is green;
- `dependencies` shows no diff lines;
- coverage lines/functions equal Task 0's state (96.80% / 94.2x%), give or take the moved gate lines, which no longer count toward nax.

**Test-count conservation:**

nax unit (after) + repo-tooling unit (after) = nax unit (Task 0) + 3 (Task 1: net new boundary tests) + 6 (parity loop: 3 per added package) + (3 − K) (Task 3: three new `gatePackageRoot` tests replace the old block of K tests) + 2 (Task 5) + 2 (Task 6).

Read K from `git show origin/main:packages/nax/test/unit/scripts/package-root.test.ts`. Moving or splitting a test file changes no count. Write the full equation, with the numbers, into the report. nax-agent unit and integration must equal Task 0 exactly.

- [ ] **Step 5: CLI unchanged**

```bash
cd packages/nax
for c in "--help" "config" "auth list" "agents" "models"; do bun bin/nax.ts $c 2>&1 | md5; done > /tmp/s2-0-cli-after.txt
git stash -u -q && git checkout -q origin/main && bun install --frozen-lockfile >/dev/null
for c in "--help" "config" "auth list" "agents" "models"; do bun bin/nax.ts $c 2>&1 | md5; done > /tmp/s2-0-cli-before.txt
git checkout -q - && git stash pop -q && bun install >/dev/null
diff /tmp/s2-0-cli-before.txt /tmp/s2-0-cli-after.txt && echo CLI-UNCHANGED
```

Expected: `CLI-UNCHANGED`. If `config` differs only by a path or timestamp, note the line and confirm it is environmental, not caused by this PR.

- [ ] **Step 6: Commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git add -A .github/workflows/ci.yml .nax CLAUDE.md AGENTS.md GEMINI.md codex.md packages
git commit -m "ci: tooling job for repo-tooling and test-kit; context and gate path citations"
```

- [ ] **Step 7: Stop and report**

Do not push or open a PR. Report to the maintainer:
- the commit list;
- the test-count equation with numbers;
- the gate before/after diffs (expected empty);
- the CLI md5 result;
- the coverage figures;
- every blocked test that Task 4 Step 3 kept in nax beyond the four known rows.

The maintainer records S2-0 in the arc SSOT and approves the push and PR.
