# S0 Monorepo Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the nax repo into a Bun-workspace monorepo in three PRs from `refactor/nax-monorepo`. `packages/nax` holds the current package, moved; `packages/nax-ai` holds nax-ai, imported with its history. No behaviour change.

**Architecture:**
- **PR 1:** docs plus removal of the pre-commit hook.
- **PR 2 (S0a):**
  - First, layout-agnostic prep commits that make checks and tests find repo-root resources through `findRepoRoot`.
  - Then a re-runnable conversion script (`tools/monorepo/convert-s0a.ts`) whose output is committed without hand edits.
- **PR 3 (S0b):** a `git filter-repo` history import merged with a merge commit, then the wiring commits.

**Tech Stack:** Bun 1.4.x workspaces (isolated linker), TypeScript, `bun:test`, Biome 2.5.10, GitHub Actions, git-filter-repo, npm trusted publishing.

**Spec:** `docs/superpowers/specs/2026-10-01-s0-monorepo-conversion-design.md`. Read it first; every design reason lives there. Where this plan and the spec disagree, the spec wins. Stop and report the disagreement instead of improvising.

**Arc SSOT:** the nax-agent master plan (`projects/nax/nax-agent-master-plan.md` in the maintainer's workspace, one level above `repos/nax`). After each PR merges, update its §5 row for S0 with the PR number and merge commit.

## Global Constraints

These apply to every task, word for word.

- **Working branch:** `refactor/nax-monorepo` in `repos/nax`. The spec is already committed on it (`eaa9e5449` plus later revisions).
- **Merge styles:** PR 1 squash, PR 2 (S0a) squash, PR 3 (S0b) **merge commit**. Never squash PR 3.
- **Bun:** CI pins Bun `1.4.0` and must stay pinned. Local runs use whatever `bun` is installed.
- **Test commands:**
  - Never run bare `bun test` with no path.
  - Never run `bun run nax`.
  - For nax, use `bun run test`, `bun run test:unit`, `bun run test:full`, `bun run test:e2e`, `bun run test:coverage`, or `bun test <explicit path> --timeout=60000`.
- **Billed runs:** `nax run` and `nax plan` are billed. **Stop and get the maintainer's explicit approval at launch.** Task 13 is the only place one is planned.
- **Outward-facing actions:** never publish to npm, push tags to the remote, archive a repo or change GitHub settings on your own. Each is a named maintainer step. Pushing the working branch and opening PRs is allowed once the maintainer has approved the PR's contents.
- **No releases** during S0.
- **Public repo:** nax is PUBLIC. Never name the maintainer's private projects in commits, PR bodies or docs. The spec says "the maintainer's other nax-managed monorepos".
- **Commits:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`). No emojis.
- **Immutability and file size:** follow the repo's rules in `.nax/rules/`. Prefer `const` and new objects; files stay under 400 lines.
- **Deleting and overwriting:** before deleting or overwriting anything outside the paths a task names, look at it first.

## Review Focus

These failure modes are the most likely to bite and are not obvious from the task tests. Each one is pinned by the task in brackets.

1. **The conversion runs twice** (quiet-window re-run) on an already-converted or dirty tree. Expected: the script refuses with a clear message and changes nothing. [Task 7: `assertPreconditions` tests]
2. **A `.gitignore` entry anchored under a moved directory** that the explicit move list does not cover, for example a new `src/foo/` line added on main before the quiet window. Expected: the classifier throws and names the line, rather than leaving it at the root where it silently stops matching. [Task 6: `splitGitignore` guard test]
3. **A rule file whose frontmatter already has `paths:`**, or an `appliesTo` entry that is already prefixed. Expected: prefixing is idempotent, and a pre-existing `paths:` makes the rewrite throw rather than produce two keys. [Task 6: `rewriteRuleFrontmatter` tests]
4. **The lock file drifts during regeneration:** `bun install` picks a newer version of a caret dependency while rewriting `bun.lock`. Expected: the script fails and lists the changed resolutions. [Task 6: `diffExternalResolutions` test; Task 8 wiring]
5. **A fresh clone or worktree after S0b** has no `packages/nax-ai/dist`. Expected: `bun install` alone makes `bun run typecheck` pass. [Task 16, step "clean clone"]

---

## File Structure

### PR 1

- Delete `.githooks/pre-commit`.
- Modify `package.json`: remove `prepare`.
- Modify comment-only lines: `test/unit/agents/native/session/loop-events/index.test.ts:39` and `test/helpers/trust-module.ts:14`.
- Add this plan file.

### PR 2 (S0a), before the move (paths are pre-move)

- Create `scripts/lib/repo-root.ts`: `findRepoRoot(start)`.
- Create `test/unit/scripts/repo-root.test.ts`.
- Modify `scripts/check-rules-drift.ts`, `scripts/check-nax-artifacts-untracked.ts`, `scripts/check-gate-reachability.ts` and `scripts/check-no-control-bytes.ts`.
- Modify `test/unit/scripts/check-gate-reachability.test.ts`, `test/unit/context/rules/rules-frontmatter.test.ts`, `test/unit/context/rules/nax-rules-stage-scoping.test.ts`, `test/unit/agents/retry/parse-retry.test.ts` and `test/unit/scripts/biome-test-severity.test.ts`.

### PR 2 (S0a), conversion tool

Everything lives under `tools/monorepo/` at the repo root, and it is removed in S0b.

| File | Contents |
|---|---|
| `lib/constants.ts` | Root-kept entries, the package dir, the gitignore move list |
| `lib/move-plan.ts` | `planMoves()` |
| `lib/gitignore-split.ts` | `splitGitignore()` |
| `lib/rule-frontmatter.ts` | `rewriteRuleFrontmatter()` |
| `lib/lock-resolutions.ts` | `externalResolutions()`, `diffExternalResolutions()` |
| `lib/preconditions.ts` | `assertPreconditions()` |
| `lib/sh.ts` | `run()`, a thin `Bun.spawnSync` wrapper that throws on a non-zero exit |
| `lib/edits.ts` | The JSON and text edits: package.json, `.nax/config.json`, `.claude/settings.json`, `CONTRIBUTING.md`, the biome config |
| `templates/` | `package.json`, `bunfig.toml`, `biome.json`, `README.md`, `root-context.md`, `ci.yml`, `release.yml` |
| `convert-s0a.ts` | The entry point. Runs the steps in the spec's §8.1 order and prints the report |
| `test/*.test.ts` | Unit tests for every `lib/` module |

### PR 3 (S0b)

- `packages/nax-ai/**` (imported).
- `packages/nax/scripts/check-nax-ai-pin.ts` and `packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts`.
- `packages/nax-ai/test/package-metadata.test.ts`.
- Modified: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `packages/nax/package.json`, `packages/nax-ai/package.json`, `packages/nax-ai/biome.json`, `packages/nax-ai/scripts/release.ts`, `.nax/mono/packages/*`, `bun.lock`.
- Deleted: `tools/monorepo/`.

---

## PR 1 — docs and pre-S0

### Task 1: Remove the pre-commit hook

**Files:**
- Delete: `.githooks/pre-commit` (the directory has only this file)
- Modify: `package.json` (the line `"prepare": "git config core.hooksPath .githooks",`)
- Modify: `test/unit/agents/native/session/loop-events/index.test.ts:39` (comment only)
- Modify: `test/helpers/trust-module.ts:14` (comment only)

**Interfaces:** none.

- [ ] **Step 1: Confirm the branch and a clean tree**

Run: `git -C repos/nax status -sb`
Expected: `## refactor/nax-monorepo` and no modified files.

- [ ] **Step 2: Read the two comments before editing them**

Run: `sed -n 35,42p test/unit/agents/native/session/loop-events/index.test.ts; sed -n 10,18p test/helpers/trust-module.ts`

Each comment calls the pre-commit hook a gate. In both, replace the hook reference with CI: "…the CI `typecheck` step…" or "…a hard gate in CI (`check:all`)…". Keep the rest of the sentence. Change comment text only.

- [ ] **Step 3: Delete the hook and the prepare script**

```bash
git rm -r .githooks
```

Then edit `package.json` and remove exactly this line (and nothing else):

```json
    "prepare": "git config core.hooksPath .githooks",
```

- [ ] **Step 4: Verify nothing else references the hook**

Run: `git grep -n -e "githooks" -e "hooksPath" -- ':!CHANGELOG.md' ':!docs/' ':!.nax/features/'`
Expected: no output. `test/fixtures/command-safety/corpus.jsonl` contains `git config core.hooksPath` as benign corpus data. If it shows up, it is fine; leave it.

- [ ] **Step 5: Run the gates the hook used to run**

Run: `bun run typecheck && bun run check:all`
Expected: both pass. The hook is gone, so commits no longer run them.

- [ ] **Step 6: Unset the local hooks path**

Run: `git config --unset core.hooksPath || true`

- [ ] **Step 7: Commit**

```bash
git add -A .githooks package.json test/unit/agents/native/session/loop-events/index.test.ts test/helpers/trust-module.ts
git commit -m "chore: remove the pre-commit hook; CI runs every gate (#1520)"
```

### Task 2: Open PR 1 (maintainer approval required)

**Files:** none new. The spec and this plan are already committed on the branch.

- [ ] **Step 1: Show the maintainer what PR 1 contains**

Run: `git log --oneline origin/main..HEAD && git diff --stat origin/main...HEAD`
Expected: the spec commit(s), the plan commit and the Task 1 commit only. Ask the maintainer: "PR 1 is ready: spec + plan + hook removal. Push and open it?" **Wait for yes.**

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin refactor/nax-monorepo
gh pr create --base main --title "docs+chore: S0 monorepo conversion spec/plan; remove pre-commit hook" \
  --body "Part 1 of 3 of the S0 monorepo conversion (spec: docs/superpowers/specs/2026-10-01-s0-monorepo-conversion-design.md, plan: docs/superpowers/plans/2026-10-01-s0-monorepo-conversion.md). Removes .githooks/ and the prepare script: every gate already runs in CI since #1520 (check-gate-reachability enforces it). No behaviour change to the published package. Merge: squash."
```

- [ ] **Step 3: After CI is green and the maintainer merges (squash), rebase**

```bash
git fetch origin
git checkout refactor/nax-monorepo
git reset --hard origin/main
```

The branch now equals main. All PR 1 content is in main's squash commit, so resetting loses nothing. Record the PR number and merge commit in the master plan §5.

---

## PR 2 — S0a

### Task 3: `findRepoRoot` helper

**Files:**
- Create: `scripts/lib/repo-root.ts`
- Test: `test/unit/scripts/repo-root.test.ts`

**Interfaces:**
- Produces: `export function findRepoRoot(start: string): string`, importable as `@scripts/lib/repo-root` from tests and as `./lib/repo-root` from `scripts/`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/scripts/repo-root.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@scripts/lib/repo-root";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanupTempDir(dir);
  dir = undefined;
});

describe("findRepoRoot", () => {
  test("returns the nearest ancestor holding a .git directory", () => {
    dir = makeTempDir("nax-repo-root-");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "packages", "nax", "scripts"), { recursive: true });
    expect(findRepoRoot(join(dir, "packages", "nax", "scripts"))).toBe(dir);
  });

  test("accepts a .git FILE (git worktree checkout)", () => {
    dir = makeTempDir("nax-repo-root-");
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(dir, "a"), { recursive: true });
    expect(findRepoRoot(join(dir, "a"))).toBe(dir);
  });

  test("returns start itself when start is the root", () => {
    dir = makeTempDir("nax-repo-root-");
    mkdirSync(join(dir, ".git"));
    expect(findRepoRoot(dir)).toBe(dir);
  });

  test("throws naming the start dir when no ancestor has .git", () => {
    expect(() => findRepoRoot("/")).toThrow(/no \.git found above \//);
  });

  test("finds this repository from this test file", () => {
    const root = findRepoRoot(import.meta.dir);
    expect(Bun.file(join(root, ".nax", "config.json")).size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/scripts/repo-root.test.ts --timeout=60000`
Expected: FAIL, `Cannot find module '@scripts/lib/repo-root'`.

- [ ] **Step 3: Implement**

```typescript
// scripts/lib/repo-root.ts
/**
 * Repo-root discovery for scripts and tests that read repo-wide resources
 * (.nax/rules, .claude/rules, .github/workflows, docs/). After the monorepo
 * move, a package's own root (`import.meta.dir/..`) is no longer the git root.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`findRepoRoot: no .git found above ${start}`);
    dir = parent;
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/unit/scripts/repo-root.test.ts --timeout=60000`
Expected: PASS, 5 tests.

- [ ] **Step 5: Check the satellite ratchet**

Run: `bun run check:test-satellites && bun run lint:biome`
Expected: OK. If `check-test-satellites` flags the new file name, rename the test to match the ratchet's naming rule in `.nax/rules/test-ratchets.md`.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/repo-root.ts test/unit/scripts/repo-root.test.ts
git commit -m "feat(scripts): add findRepoRoot for repo-wide resources"
```

### Task 4: Point repo-wide checks at the repo root

**Files:**
- Modify: `scripts/check-rules-drift.ts` (the `ROOT` constant, line 31)
- Modify: `scripts/check-nax-artifacts-untracked.ts` (`main()`: `const repoRoot = process.cwd();`)
- Modify: `scripts/check-gate-reachability.ts` (`findUnreachableCheckScriptsInRepo` and `main()`)
- Modify: `scripts/check-no-control-bytes.ts:20`
- Test: `test/unit/scripts/check-gate-reachability.test.ts` (the "the nax repo itself" block and a new two-root case)

**Interfaces:**
- Consumes: `findRepoRoot` (Task 3).
- Produces: `export function findUnreachableCheckScriptsInRepo(packageRoot: string, repoRoot: string): string[]`.

- [ ] **Step 1: Write the failing two-root test**

In `test/unit/scripts/check-gate-reachability.test.ts`, replace the `describe("the nax repo itself", …)` block with:

```typescript
describe("findUnreachableCheckScriptsInRepo — package root vs repo root", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) cleanupTempDir(dir);
    dir = undefined;
  });

  test("reads package.json + scripts/ from the package and ci.yml from the repo root", async () => {
    const { findUnreachableCheckScriptsInRepo } = await import("@scripts/check-gate-reachability");
    dir = makeTempDir("nax-gate-two-roots-");
    const pkg = join(dir, "packages", "nax");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "check-a.ts"), "");
    writeFileSync(join(pkg, "scripts", "check-b.ts"), "");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ scripts: { "check:a": "bun run scripts/check-a.ts" } }));
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "      - run: bun run check:a\n");

    expect(findUnreachableCheckScriptsInRepo(pkg, dir)).toEqual(["check-b.ts"]);
  });
});

describe("the nax repo itself", () => {
  test("every scripts/check-* gate is reachable from CI", async () => {
    const { findUnreachableCheckScriptsInRepo } = await import("@scripts/check-gate-reachability");
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const packageRoot = join(import.meta.dir, "..", "..", "..");

    expect(findUnreachableCheckScriptsInRepo(packageRoot, findRepoRoot(packageRoot))).toEqual([]);
  });
});
```

`afterEach`, `mkdirSync`, `writeFileSync`, `makeTempDir` and `cleanupTempDir` are already imported at the top of this file (lines 1-8). Keep those imports.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/unit/scripts/check-gate-reachability.test.ts --timeout=60000`
Expected: FAIL. The two-root case returns `["check-a.ts","check-b.ts"]`, because `ci.yml` is looked up under the package root.

- [ ] **Step 3: Implement the signature split**

In `scripts/check-gate-reachability.ts`, change the function and `main()`:

```typescript
/** Resolves every input from the repo on disk, then applies the rule.
 *  `packageRoot` owns package.json + scripts/; `repoRoot` owns .github/. */
export function findUnreachableCheckScriptsInRepo(packageRoot: string, repoRoot: string): string[] {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const packageScripts = pkg.scripts ?? {};

  const ciPath = join(repoRoot, CI_WORKFLOW);
  const ci = existsSync(ciPath)
    ? parseCiEntryPoints(readFileSync(ciPath, "utf8"))
    : { scriptNames: [], scriptFiles: [] };

  return findUnreachableCheckScripts({
    checkScripts: discoverCheckScripts(packageRoot),
    entryScriptNames: ci.scriptNames,
    entryScriptFiles: ci.scriptFiles,
    packageScripts,
  });
}

function main() {
  const packageRoot = join(import.meta.dir, "..");
  const unreachable = findUnreachableCheckScriptsInRepo(packageRoot, findRepoRoot(packageRoot));
  // …the rest of main() is unchanged, except `discoverCheckScripts(root)` becomes `discoverCheckScripts(packageRoot)`.
}
```

Add `import { findRepoRoot } from "./lib/repo-root";` to the imports. Update the file's doc comment: entry point 2 is "`.github/workflows/ci.yml` at the repo root".

- [ ] **Step 4: Point rules-drift and artifacts-untracked at the repo root**

`scripts/check-rules-drift.ts`:

```typescript
import { findRepoRoot } from "./lib/repo-root";
// was: const ROOT = join(import.meta.dir, "..");
const ROOT = findRepoRoot(import.meta.dir);
```

Remove the now-unused `join` import if Biome flags it.

`scripts/check-nax-artifacts-untracked.ts`, in `main()`:

```typescript
import { findRepoRoot } from "./lib/repo-root";
// was: const repoRoot = process.cwd();
const repoRoot = findRepoRoot(process.cwd());
```

`scripts/check-no-control-bytes.ts:20`:

```typescript
const SCAN_ROOTS = ["src", "bin"] as const;
```

The `flows/` directory does not exist.

- [ ] **Step 5: Run the affected tests and the checks themselves**

Run: `bun test test/unit/scripts/check-gate-reachability.test.ts test/unit/scripts/check-nax-artifacts-untracked.test.ts test/unit/scripts/check-no-control-bytes.test.ts --timeout=60000 && bun run check:gate-reachability && bun run check:rules-drift && bun run check:nax-artifacts-untracked && bun run check:no-control-bytes`

Expected: all PASS or OK. If `check-no-control-bytes.test.ts` asserts `flows` in `SCAN_ROOTS`, update that assertion to `["src","bin"]`.

- [ ] **Step 6: Commit**

```bash
git add scripts/ test/unit/scripts/
git commit -m "refactor(scripts): repo-wide checks read .nax/.claude/.github from the repo root"
```

### Task 5: Tests that read repo-root resources

**Files:**
- Modify: `test/unit/context/rules/rules-frontmatter.test.ts:608-658`: every `loadCanonicalRules(process.cwd())`
- Modify: `test/unit/context/rules/nax-rules-stage-scoping.test.ts:25-26`: `REPO_ROOT`
- Modify: `test/unit/agents/retry/parse-retry.test.ts:393`: `ruleFilePath`
- Modify: `test/unit/scripts/biome-test-severity.test.ts:46-52`: the config copy

**Interfaces:**
- Consumes: `findRepoRoot` (Task 3).

- [ ] **Step 1: Make the edits**

`rules-frontmatter.test.ts`: add `import { findRepoRoot } from "@scripts/lib/repo-root";` and replace every `loadCanonicalRules(process.cwd())` in the `US-006` describe block with `loadCanonicalRules(findRepoRoot(import.meta.dir))`.

`nax-rules-stage-scoping.test.ts`:

```typescript
import { findRepoRoot } from "@scripts/lib/repo-root";
// was: const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const REPO_ROOT = findRepoRoot(import.meta.dir);
```

Drop the stale "four levels up" comment and remove `join` if it becomes unused.

`parse-retry.test.ts:393`:

```typescript
const ruleFilePath = join(findRepoRoot(import.meta.dir), "docs", "guides", "retry-strategy.md");
```

Add the `findRepoRoot` import.

`biome-test-severity.test.ts`: widen the parsed type with `root?: boolean;`. Right after `config.assist = …`, add:

```typescript
    // The package config is nested under a root biome.json after the monorepo move
    // (`"root": false`); a standalone copy must be a root config or biome rejects it.
    delete config.root;
```

Deleting a key from the local parse result is the one mutation here, and it is local to the test.

- [ ] **Step 2: Run the four files**

Run: `bun test test/unit/context/rules/rules-frontmatter.test.ts test/unit/context/rules/nax-rules-stage-scoping.test.ts test/unit/agents/retry/parse-retry.test.ts test/unit/scripts/biome-test-severity.test.ts --timeout=60000`
Expected: PASS. They behave exactly as before, because today repo root and package root are the same.

- [ ] **Step 3: Commit**

```bash
git add test/
git commit -m "test: read repo-wide resources via findRepoRoot"
```

### Task 6: Conversion library (pure functions, TDD)

**Files:**
- Create: `tools/monorepo/lib/constants.ts`, `lib/move-plan.ts`, `lib/gitignore-split.ts`, `lib/rule-frontmatter.ts`, `lib/lock-resolutions.ts`
- Test: `tools/monorepo/test/move-plan.test.ts`, `gitignore-split.test.ts`, `rule-frontmatter.test.ts`, `lock-resolutions.test.ts`

These tests are **not** part of nax's suite. Run them with an explicit path: `bun test tools/monorepo/test --timeout=60000`.

**Interfaces (produced):**

```typescript
// constants.ts
export const PKG_DIR = "packages/nax";
export const KEEP_AT_ROOT: ReadonlySet<string>; // top-level tracked entries that stay
export const COPY_TO_PKG: readonly string[];    // ["LICENSE"]
export const GITIGNORE_MOVE: readonly string[]; // ["test/tmp/", "test/integration/tmp/", "tmp/.ci-test-output.txt"]
export const MOVED_TOP_DIRS: ReadonlySet<string>; // first path segments that move, for the gitignore guard
// move-plan.ts
export function planMoves(trackedTopLevel: readonly string[]): { move: string[]; keep: string[] };
// gitignore-split.ts
export function splitGitignore(text: string): { root: string; pkg: string; moved: string[] };
// rule-frontmatter.ts
export function rewriteRuleFrontmatter(text: string, pkgDir: string): string;
// lock-resolutions.ts
export function externalResolutions(lockText: string): string[];
export function diffExternalResolutions(before: string[], after: string[]): { added: string[]; removed: string[] };
```

- [ ] **Step 1: Write `constants.ts`**

```typescript
// tools/monorepo/lib/constants.ts
export const PKG_DIR = "packages/nax";

/** Tracked top-level entries that stay at the repo root (spec §3). Everything else moves. */
export const KEEP_AT_ROOT: ReadonlySet<string> = new Set([
  ".github", ".gitignore", ".git-blame-ignore-revs", ".semgrepignore",
  "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "LICENSE",
  "docs", ".nax", ".claude", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "codex.md",
  "bun.lock", "tools",
]);

/** Kept at root AND copied into the package (npm tarball needs it). */
export const COPY_TO_PKG: readonly string[] = ["LICENSE"];

/** Root .gitignore entries anchored under moved dirs (spec §3.3). */
export const GITIGNORE_MOVE: readonly string[] = ["test/tmp/", "test/integration/tmp/", "tmp/.ci-test-output.txt"];

/** First path segments that move into the package; an anchored ignore entry under one of these must be in GITIGNORE_MOVE. */
export const MOVED_TOP_DIRS: ReadonlySet<string> = new Set([
  "src", "bin", "test", "scripts", "stubs", "examples", "biome-plugins", ".reports", "tmp",
]);
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tools/monorepo/test/move-plan.test.ts
import { describe, expect, test } from "bun:test";
import { planMoves } from "../lib/move-plan";

describe("planMoves", () => {
  test("moves everything except KEEP_AT_ROOT, sorted", () => {
    const r = planMoves(["src", ".github", "package.json", "docs", "README.md", "bun.lock", "bin"]);
    expect(r.move).toEqual(["README.md", "bin", "package.json", "src"]);
    expect(r.keep).toEqual([".github", "bun.lock", "docs"]);
  });
  test("refuses to move 'packages' (already converted)", () => {
    expect(() => planMoves(["packages", "src"])).toThrow(/already has a packages\/ entry/);
  });
});
```

```typescript
// tools/monorepo/test/gitignore-split.test.ts
import { describe, expect, test } from "bun:test";
import { splitGitignore } from "../lib/gitignore-split";

describe("splitGitignore", () => {
  test("moves only the explicit anchored entries, keeps comments/unanchored/.nax at root", () => {
    const input = ["# Testing", "coverage", "test/tmp/", ".nax/features/*/runs/", "**/.nax/cache/", "tmp/.ci-test-output.txt", "dist"].join("\n");
    const r = splitGitignore(`${input}\n`);
    expect(r.moved).toEqual(["test/tmp/", "tmp/.ci-test-output.txt"]);
    expect(r.root).toBe(["# Testing", "coverage", ".nax/features/*/runs/", "**/.nax/cache/", "dist"].join("\n") + "\n");
    expect(r.pkg).toBe("# Moved from the repo root by the monorepo conversion (package-anchored)\ntest/tmp/\ntmp/.ci-test-output.txt\n");
  });
  test("throws on an anchored entry under a moved dir that is not in the move list", () => {
    expect(() => splitGitignore("src/generated/\n")).toThrow(/src\/generated\/.*not in GITIGNORE_MOVE/);
  });
  test("a leading-slash entry is anchored too", () => {
    expect(() => splitGitignore("/bin/out\n")).toThrow(/\/bin\/out/);
  });
});
```

```typescript
// tools/monorepo/test/rule-frontmatter.test.ts
import { describe, expect, test } from "bun:test";
import { rewriteRuleFrontmatter } from "../lib/rule-frontmatter";

const RULE = `---
priority: 35
appliesTo:
  - "src/agents/**/*.ts"
  - "src/session/session-keeper.ts"
stages:
  - "context"
---

# Body mentions src/agents/ and stays as-is
`;

describe("rewriteRuleFrontmatter", () => {
  test("prefixes appliesTo entries (globs and literals) and adds a paths filter after priority", () => {
    const out = rewriteRuleFrontmatter(RULE, "packages/nax");
    expect(out).toBe(`---
priority: 35
paths:
  - "packages/nax/*"
appliesTo:
  - "packages/nax/src/agents/**/*.ts"
  - "packages/nax/src/session/session-keeper.ts"
stages:
  - "context"
---

# Body mentions src/agents/ and stays as-is
`);
  });
  test("is idempotent on appliesTo but refuses an existing paths key", () => {
    const once = rewriteRuleFrontmatter(RULE, "packages/nax");
    expect(() => rewriteRuleFrontmatter(once, "packages/nax")).toThrow(/already declares paths/);
  });
  test("an already-prefixed appliesTo entry is not double-prefixed", () => {
    const pre = RULE.replace('"src/agents/**/*.ts"', '"packages/nax/src/agents/**/*.ts"');
    expect(rewriteRuleFrontmatter(pre, "packages/nax")).toContain('  - "packages/nax/src/agents/**/*.ts"\n');
    expect(rewriteRuleFrontmatter(pre, "packages/nax")).not.toContain("packages/nax/packages/nax");
  });
  test("throws when there is no frontmatter or no appliesTo", () => {
    expect(() => rewriteRuleFrontmatter("# no frontmatter\n", "packages/nax")).toThrow(/no frontmatter/);
    expect(() => rewriteRuleFrontmatter("---\npriority: 1\n---\nx\n", "packages/nax")).toThrow(/no appliesTo/);
  });
});
```

```typescript
// tools/monorepo/test/lock-resolutions.test.ts
import { describe, expect, test } from "bun:test";
import { diffExternalResolutions, externalResolutions } from "../lib/lock-resolutions";

const LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": { "": { "name": "@nathapp/nax" } },
  "packages": {
    "zod": ["zod@4.1.0", "", {}, "sha512-x"],
    "@nathapp/nax-ai": ["@nathapp/nax-ai@workspace:packages/nax-ai"],
    "react": ["react@19.1.0", "", {}, "sha512-y"],
  }
}
`;

describe("lock resolutions", () => {
  test("extracts non-workspace name@version, sorted", () => {
    expect(externalResolutions(LOCK)).toEqual(["react@19.1.0", "zod@4.1.0"]);
  });
  test("diff reports added and removed", () => {
    expect(diffExternalResolutions(["a@1", "b@1"], ["b@1", "c@2"])).toEqual({ added: ["c@2"], removed: ["a@1"] });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test tools/monorepo/test --timeout=60000`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the four modules**

```typescript
// tools/monorepo/lib/move-plan.ts
import { KEEP_AT_ROOT } from "./constants";

export function planMoves(trackedTopLevel: readonly string[]): { move: string[]; keep: string[] } {
  if (trackedTopLevel.includes("packages")) throw new Error("planMoves: repo already has a packages/ entry");
  const sorted = [...trackedTopLevel].sort();
  return {
    move: sorted.filter((e) => !KEEP_AT_ROOT.has(e)),
    keep: sorted.filter((e) => KEEP_AT_ROOT.has(e)),
  };
}
```

```typescript
// tools/monorepo/lib/gitignore-split.ts
import { GITIGNORE_MOVE, MOVED_TOP_DIRS } from "./constants";

const PKG_HEADER = "# Moved from the repo root by the monorepo conversion (package-anchored)";

/** An entry is anchored when it has a slash before its last character (git rule). */
function anchoredFirstSegment(entry: string): string | undefined {
  const bare = entry.startsWith("!") ? entry.slice(1) : entry;
  const trimmed = bare.endsWith("/") ? bare.slice(0, -1) : bare;
  if (!trimmed.includes("/") || trimmed.startsWith("**/")) return undefined;
  return trimmed.replace(/^\//, "").split("/")[0];
}

export function splitGitignore(text: string): { root: string; pkg: string; moved: string[] } {
  const lines = text.replace(/\n$/, "").split("\n");
  const moved = lines.filter((l) => GITIGNORE_MOVE.includes(l.trim()));
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || GITIGNORE_MOVE.includes(t)) continue;
    const seg = anchoredFirstSegment(t);
    if (seg !== undefined && MOVED_TOP_DIRS.has(seg)) {
      throw new Error(`splitGitignore: "${t}" is anchored under moved dir "${seg}" but not in GITIGNORE_MOVE`);
    }
  }
  const root = lines.filter((l) => !GITIGNORE_MOVE.includes(l.trim())).join("\n");
  const pkg = [PKG_HEADER, ...moved.map((l) => l.trim())].join("\n");
  return { root: `${root}\n`, pkg: `${pkg}\n`, moved: moved.map((l) => l.trim()) };
}
```

```typescript
// tools/monorepo/lib/rule-frontmatter.ts
/** Spec §6.1: prefix appliesTo with the package dir and add a package `paths:` filter. */
export function rewriteRuleFrontmatter(text: string, pkgDir: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("rewriteRuleFrontmatter: no frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("rewriteRuleFrontmatter: no frontmatter");
  const fm = lines.slice(1, end);
  if (fm.some((l) => /^paths:/.test(l))) throw new Error("rewriteRuleFrontmatter: rule already declares paths:");
  const appliesIdx = fm.findIndex((l) => /^appliesTo:/.test(l));
  if (appliesIdx === -1) throw new Error("rewriteRuleFrontmatter: no appliesTo");

  const prefix = `${pkgDir}/`;
  let inApplies = false;
  const rewritten = fm.map((line) => {
    if (/^\S/.test(line)) inApplies = /^appliesTo:/.test(line);
    const m = inApplies ? /^(\s+-\s+)"([^"]+)"\s*$/.exec(line) : null;
    if (!m) return line;
    const value = m[2] as string;
    return value.startsWith(prefix) ? line : `${m[1]}"${prefix}${value}"`;
  });

  const pathsBlock = ["paths:", `  - "${pkgDir}/*"`];
  const priorityIdx = rewritten.findIndex((l) => /^priority:/.test(l));
  const insertAt = priorityIdx === -1 ? 0 : priorityIdx + 1;
  const withPaths = [...rewritten.slice(0, insertAt), ...pathsBlock, ...rewritten.slice(insertAt)];
  return [lines[0], ...withPaths, ...lines.slice(end)].join("\n");
}
```

```typescript
// tools/monorepo/lib/lock-resolutions.ts
const PACKAGE_ENTRY = /^\s{4}"[^"]+":\s*\["([^"]+)"/gm;

/** Non-workspace `name@version` resolutions from a bun.lock (text form), sorted. */
export function externalResolutions(lockText: string): string[] {
  const start = lockText.indexOf('"packages"');
  if (start === -1) throw new Error("externalResolutions: no packages section");
  const found = [...lockText.slice(start).matchAll(PACKAGE_ENTRY)].map((m) => m[1] as string);
  return found.filter((r) => !r.includes("@workspace:")).sort();
}

export function diffExternalResolutions(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)).sort(), removed: before.filter((x) => !a.has(x)).sort() };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun test tools/monorepo/test --timeout=60000`
Expected: PASS, 11 tests.

- [ ] **Step 6: Check against the real repo files (dry, read-only)**

Run:
```bash
bun -e 'import {splitGitignore} from "./tools/monorepo/lib/gitignore-split"; const r=splitGitignore(await Bun.file(".gitignore").text()); console.log(r.moved)'
bun -e 'import {rewriteRuleFrontmatter} from "./tools/monorepo/lib/rule-frontmatter"; import {readdirSync} from "node:fs"; for (const f of readdirSync(".nax/rules")) rewriteRuleFrontmatter(await Bun.file(`.nax/rules/${f}`).text(),"packages/nax"); console.log("13 rules OK")'
bun -e 'import {externalResolutions} from "./tools/monorepo/lib/lock-resolutions"; console.log(externalResolutions(await Bun.file("bun.lock").text()).length)'
```
Expected:
- the first prints `[ "test/tmp/", "test/integration/tmp/", "tmp/.ci-test-output.txt" ]`;
- the second prints `13 rules OK`;
- the third prints a count greater than 100.

If `.gitignore` has gained a new anchored line under a moved dir, the classifier throws. Add that line to `GITIGNORE_MOVE` and to a test case.

- [ ] **Step 7: Commit**

```bash
git add tools/monorepo/lib tools/monorepo/test
git commit -m "chore(tools): monorepo conversion library (moves, gitignore, rules, lock)"
```

### Task 7: Templates, edits and preconditions

**Files:**
- Create: `tools/monorepo/lib/sh.ts`, `lib/preconditions.ts`, `lib/edits.ts`
- Create: `tools/monorepo/templates/{package.json,bunfig.toml,biome.json,README.md,root-context.md,ci.yml,release.yml}`
- Test: `tools/monorepo/test/preconditions.test.ts`, `tools/monorepo/test/edits.test.ts`

**Interfaces (produced):**

```typescript
// sh.ts
export function run(cmd: string[], cwd: string, env?: Record<string, string>): string; // stdout; throws with stderr on non-zero
// preconditions.ts
export interface RepoState { branch: string; dirty: boolean; hasPackagesDir: boolean; hasPrepareScript: boolean }
export function assertPreconditions(s: RepoState, expectedBranch: string): void;
// edits.ts
export function editNaxPackageJson(text: string): string;               // adds repository.directory; throws if prepare exists
export function splitNaxConfig(text: string): { root: string; mono: string }; // root quality.commands = root scripts; mono = old quality block
export function editClaudeSettings(text: string): string;               // hook command -> cd packages/nax && …
export function editContributing(text: string): string;                 // package-command note + `bun test` -> `bun run test`
export function markBiomeNested(text: string): string;                  // adds "root": false as the first key
```

- [ ] **Step 1: Write the failing tests**

```typescript
// tools/monorepo/test/preconditions.test.ts
import { describe, expect, test } from "bun:test";
import { assertPreconditions } from "../lib/preconditions";

const ok = { branch: "refactor/nax-monorepo", dirty: false, hasPackagesDir: false, hasPrepareScript: false };

describe("assertPreconditions", () => {
  test("passes on a clean, unconverted tree on the working branch", () => {
    expect(() => assertPreconditions(ok, "refactor/nax-monorepo")).not.toThrow();
  });
  test.each([
    [{ ...ok, branch: "main" }, /on branch main/],
    [{ ...ok, dirty: true }, /working tree is dirty/],
    [{ ...ok, hasPackagesDir: true }, /already converted/],
    [{ ...ok, hasPrepareScript: true }, /prepare script still present/],
  ])("refuses %#", (state, msg) => {
    expect(() => assertPreconditions(state, "refactor/nax-monorepo")).toThrow(msg);
  });
});
```

```typescript
// tools/monorepo/test/edits.test.ts
import { describe, expect, test } from "bun:test";
import { editClaudeSettings, editContributing, editNaxPackageJson, markBiomeNested, splitNaxConfig } from "../lib/edits";

describe("edits", () => {
  test("editNaxPackageJson adds repository.directory and keeps key order", () => {
    const out = JSON.parse(editNaxPackageJson(JSON.stringify({ name: "@nathapp/nax", repository: { type: "git", url: "u" }, scripts: {} }, null, 2)));
    expect(out.repository).toEqual({ type: "git", url: "u", directory: "packages/nax" });
    expect(Object.keys(out)).toEqual(["name", "repository", "scripts"]);
  });
  test("editNaxPackageJson refuses a prepare script", () => {
    expect(() => editNaxPackageJson(JSON.stringify({ scripts: { prepare: "x" }, repository: {} }))).toThrow(/prepare/);
  });
  test("splitNaxConfig moves quality.commands to mono and puts root scripts at root", () => {
    const cfg = { name: "nax", quality: { commands: { test: "bun run test", typecheck: ["a", "b"] }, forceExit: false }, review: { enabled: true } };
    const { root, mono } = splitNaxConfig(JSON.stringify(cfg, null, 2));
    expect(JSON.parse(mono)).toEqual({ quality: { commands: { test: "bun run test", typecheck: ["a", "b"] } } });
    const r = JSON.parse(root);
    expect(r.quality.commands).toEqual({ test: "bun run test", typecheck: "bun run typecheck", lint: "bun run check:all", build: "bun run build" });
    expect(r.quality.forceExit).toBe(false);
    expect(r.review).toEqual({ enabled: true });
    expect(r.name).toBe("nax");
  });
  test("editClaudeSettings rewrites the biome hook to run inside the package", () => {
    const s = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "bun x biome lint --write src/ bin/" }] }] } });
    expect(JSON.parse(editClaudeSettings(s)).hooks.PostToolUse[0].hooks[0].command).toBe("cd packages/nax && bun x biome lint --write src/ bin/");
  });
  test("editContributing adds the package note once and fixes the bare bun test line", () => {
    const src = "## Development Setup\n\n```bash\nbun install\n```\n\n3. Ensure the full test suite passes: `bun test`\n";
    const out = editContributing(src);
    expect(out).toContain("Package commands below run from `packages/nax/`");
    expect(out).toContain("`bun run test`");
    expect(editContributing(out)).toBe(out);
  });
  test("markBiomeNested puts root:false first", () => {
    expect(Object.keys(JSON.parse(markBiomeNested('{"$schema":"s","linter":{}}')))).toEqual(["root", "$schema", "linter"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tools/monorepo/test --timeout=60000`
Expected: the new files FAIL with modules not found.

- [ ] **Step 3: Implement `sh.ts`, `preconditions.ts`, `edits.ts`**

```typescript
// tools/monorepo/lib/sh.ts
export function run(cmd: string[], cwd: string, env?: Record<string, string>): string {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} (cwd ${cwd}) exited ${proc.exitCode}:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}
```

```typescript
// tools/monorepo/lib/preconditions.ts
export interface RepoState { branch: string; dirty: boolean; hasPackagesDir: boolean; hasPrepareScript: boolean }

export function assertPreconditions(s: RepoState, expectedBranch: string): void {
  if (s.branch !== expectedBranch) throw new Error(`convert-s0a: on branch ${s.branch}, expected ${expectedBranch}`);
  if (s.dirty) throw new Error("convert-s0a: working tree is dirty; commit or stash first");
  if (s.hasPackagesDir) throw new Error("convert-s0a: packages/ exists — repo already converted");
  if (s.hasPrepareScript) throw new Error("convert-s0a: prepare script still present — merge PR 1 (hook removal) first");
}
```

```typescript
// tools/monorepo/lib/edits.ts
const ROOT_QUALITY_COMMANDS = {
  test: "bun run test",
  typecheck: "bun run typecheck",
  lint: "bun run check:all",
  build: "bun run build",
} as const;

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export function editNaxPackageJson(text: string): string {
  const pkg = JSON.parse(text) as { scripts?: Record<string, string>; repository?: Record<string, string> };
  if (pkg.scripts?.prepare !== undefined) throw new Error("editNaxPackageJson: prepare script still present");
  return json({ ...pkg, repository: { ...pkg.repository, directory: "packages/nax" } });
}

export function splitNaxConfig(text: string): { root: string; mono: string } {
  const cfg = JSON.parse(text) as { quality?: { commands?: Record<string, unknown> } & Record<string, unknown> };
  const commands = cfg.quality?.commands;
  if (!commands) throw new Error("splitNaxConfig: .nax/config.json has no quality.commands");
  return {
    root: json({ ...cfg, quality: { ...cfg.quality, commands: ROOT_QUALITY_COMMANDS } }),
    mono: json({ quality: { commands } }),
  };
}

export function editClaudeSettings(text: string): string {
  const OLD = "bun x biome lint --write src/ bin/";
  if (!text.includes(OLD)) throw new Error("editClaudeSettings: expected hook command not found");
  return text.replace(OLD, `cd packages/nax && ${OLD}`);
}

const PKG_NOTE =
  "> Package commands below run from `packages/nax/` (`cd packages/nax`). From the repo root, `bun run build|typecheck|lint|check:all|test` run every package in dependency order.\n";

export function editContributing(text: string): string {
  const withNote = text.includes(PKG_NOTE) ? text : text.replace("## Development Setup\n", `## Development Setup\n\n${PKG_NOTE}`);
  return withNote.replace("Ensure the full test suite passes: `bun test`", "Ensure the full test suite passes: `bun run test`");
}

export function markBiomeNested(text: string): string {
  const cfg = JSON.parse(text) as Record<string, unknown>;
  const { root: _drop, ...rest } = cfg;
  return json({ root: false, ...rest });
}
```

If `CONTRIBUTING.md`'s setup heading is not exactly `## Development Setup`, read the file and use its real heading in both `editContributing` and the test.

- [ ] **Step 4: Write the templates**

`tools/monorepo/templates/package.json`:

```json
{
  "name": "nax-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "bun run --filter '*' build",
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "bun run --filter '*' lint",
    "check:all": "bun run --filter '*' check:all",
    "test": "bun run --filter '*' test",
    "release:nax": "bun run --cwd packages/nax release",
    "release:nax-ai": "bun run --cwd packages/nax-ai release"
  }
}
```

`templates/bunfig.toml`:

```toml
# Workspace install settings. Package test settings live in packages/<pkg>/bunfig.toml.
[install]
linker = "isolated"
```

`templates/biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.10/schema.json",
  "root": true,
  "files": {
    "includes": ["packages/**", "!**/.worktrees/**", "!**/.claude/worktrees/**", "!**/.nax-wt/**", "!**/node_modules/**", "!**/dist/**"]
  }
}
```

`templates/README.md`:

```markdown
# nax monorepo

| Package | Path | npm |
|---|---|---|
| nax (CLI orchestrator) | [`packages/nax`](packages/nax) | `@nathapp/nax` |

Bun workspaces (isolated linker). From the root, `bun install` then `bun run build | typecheck | lint | check:all | test`
run every package in dependency order. Package docs: [`packages/nax/README.md`](packages/nax/README.md).
Releases are tag-driven: `vX.Y.Z` publishes `@nathapp/nax`.
```

`templates/root-context.md`: the slim repo-wide context. Its content, word for word:

```markdown
# nax monorepo — repo-wide context

This repository is a Bun-workspace monorepo. Package-specific context lives in
`.nax/mono/packages/<pkg>/context.md` and is generated into `packages/<pkg>/CLAUDE.md`.

## Layout

| Path | Package | Notes |
|:-----|:--------|:------|
| `packages/nax` | `@nathapp/nax` | CLI orchestrator (Bun bundle, `dist/nax.js`) |

Dependency direction: `nax-ai` → `nax-agent` → `nax` (a package never imports one to its right).

## Tooling

- Bun 1.4.0 (pinned in CI). Workspaces with `linker = "isolated"` (root `bunfig.toml`).
- Root scripts run every package in dependency order: `bun run build | typecheck | lint | check:all | test`.
- Package commands run from the package directory (`cd packages/nax`).
- Never run bare `bun test` (no path) and never `bun run nax`.

## Releases

Tag-driven, one `release.yml`: `vX.Y.Z` publishes `@nathapp/nax`; `nax-ai-vX.Y.Z` publishes `@nathapp/nax-ai`.
Releases are maintainer-initiated only.
```

`templates/ci.yml`: today's `.github/workflows/ci.yml` with exactly these changes, and nothing else changed:
- Both `paths:` lists become:

  ```yaml
      paths:
        - 'packages/**'
        - 'package.json'
        - 'bunfig.toml'
        - 'bun.lock'
        - 'biome.json'
        - '.github/workflows/**'
        - '.nax/**'
  ```
- The job id and name `test` become `nax`.
- Add `defaults: { run: { working-directory: packages/nax } }` to the job, as YAML block style, directly under `timeout-minutes: 15`.
- Give the `Install dependencies` step its own `working-directory: .`, so the install runs at the root.
- Leave every other step byte-identical.

Produce the file by copying the current `ci.yml` and applying these edits by hand, once, when writing the template. The template is then static.

`templates/release.yml`: today's `release.yml` with exactly these changes:
- A new `Resolve package` step, placed immediately after `actions/checkout`:

  ```yaml
      - name: Resolve package
        id: pkg
        env:
          TAG: ${{ github.event.inputs.tag || github.ref_name }}
        run: |
          case "$TAG" in
            v*) echo "dir=packages/nax" >> "$GITHUB_OUTPUT"; echo "name=@nathapp/nax" >> "$GITHUB_OUTPUT"; echo "version=${TAG#v}" >> "$GITHUB_OUTPUT" ;;
            *) echo "Unrecognised tag $TAG"; exit 1 ;;
          esac
  ```
- `Install dependencies` stays at the root.
- `Build`, `Validate version`, `Publish to npm` and `Extract release notes` each get `working-directory: ${{ steps.pkg.outputs.dir }}`.
- `Validate version` reads the tag from `env: TAG: …` instead of inline `${{ }}`, with the same check.
- `Set release info` reads `TAG` from `env:` and uses `VERSION="${{ steps.pkg.outputs.version }}"`.
- The `awk` in `Extract release notes` still reads `CHANGELOG.md`, which is now relative to the package dir.
- The npm command stays `npm publish --access public --tag ${{ steps.info.outputs.npm_tag }} --provenance`.
- Leave every other step unchanged.

S0b adds the `nax-ai-v*` arm (Task 15).

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun test tools/monorepo/test --timeout=60000`
Expected: PASS for all tool tests.

- [ ] **Step 6: Validate the YAML templates parse**

Run: `bun -e 'import {YAML} from "bun"; for (const f of ["ci","release"]) { YAML.parse(await Bun.file(`tools/monorepo/templates/${f}.yml`).text()); console.log(f,"ok") }'`
Expected: `ci ok` and `release ok`. If `Bun.YAML` is unavailable in the installed Bun, use `bun x yaml valid <file>` instead.

- [ ] **Step 7: Commit**

```bash
git add tools/monorepo
git commit -m "chore(tools): monorepo conversion edits, preconditions and templates"
```

### Task 8: The conversion entry point

**Files:**
- Create: `tools/monorepo/convert-s0a.ts`

**Interfaces:**
- Consumes: everything from Tasks 6-7.
- Produces: an executable `bun tools/monorepo/convert-s0a.ts`. It exits 0 and prints a report, or exits 1 and names the failing step. Its output is left **uncommitted** for the caller to review and commit.

- [ ] **Step 1: Write the script**

```typescript
#!/usr/bin/env bun
/**
 * S0a monorepo conversion (spec: docs/superpowers/specs/2026-10-01-s0-monorepo-conversion-design.md §8.1).
 * Re-runnable from a clean, unconverted tree on refactor/nax-monorepo. Leaves its output uncommitted.
 */
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPY_TO_PKG, PKG_DIR } from "./lib/constants";
import { editClaudeSettings, editContributing, editNaxPackageJson, markBiomeNested, splitNaxConfig } from "./lib/edits";
import { splitGitignore } from "./lib/gitignore-split";
import { diffExternalResolutions, externalResolutions } from "./lib/lock-resolutions";
import { planMoves } from "./lib/move-plan";
import { assertPreconditions } from "./lib/preconditions";
import { rewriteRuleFrontmatter } from "./lib/rule-frontmatter";
import { run } from "./lib/sh";

const BRANCH = "refactor/nax-monorepo";
const ROOT = run(["git", "rev-parse", "--show-toplevel"], process.cwd()).trim();
const TPL = join(ROOT, "tools", "monorepo", "templates");
const read = (p: string) => Bun.file(join(ROOT, p)).text();
const write = (p: string, s: string) => writeFileSync(join(ROOT, p), s);
const report: string[] = [];
const step = (name: string) => report.push(`\n## ${name}`);

async function main(): Promise<void> {
  step("preconditions");
  const pkg = JSON.parse(await read("package.json")) as { scripts?: Record<string, string> };
  assertPreconditions(
    {
      branch: run(["git", "branch", "--show-current"], ROOT).trim(),
      dirty: run(["git", "status", "--porcelain"], ROOT).trim() !== "",
      hasPackagesDir: existsSync(join(ROOT, "packages")),
      hasPrepareScript: pkg.scripts?.prepare !== undefined,
    },
    BRANCH,
  );
  const lockBefore = externalResolutions(await read("bun.lock"));

  step("git mv");
  const topLevel = [...new Set(run(["git", "ls-files"], ROOT).split("\n").filter(Boolean).map((p) => p.split("/")[0] as string))];
  const { move, keep } = planMoves(topLevel);
  run(["mkdir", "-p", PKG_DIR], ROOT);
  for (const entry of move) run(["git", "mv", entry, `${PKG_DIR}/${entry}`], ROOT);
  for (const f of COPY_TO_PKG) {
    copyFileSync(join(ROOT, f), join(ROOT, PKG_DIR, f));
    run(["git", "add", `${PKG_DIR}/${f}`], ROOT);
  }
  report.push(`moved (${move.length}): ${move.join(", ")}`, `kept at root: ${keep.join(", ")}`);

  step("root files");
  for (const f of ["package.json", "bunfig.toml", "biome.json", "README.md"]) {
    copyFileSync(join(TPL, f), join(ROOT, f));
  }
  write(`${PKG_DIR}/package.json`, editNaxPackageJson(await read(`${PKG_DIR}/package.json`)));
  write(`${PKG_DIR}/biome.json`, markBiomeNested(await read(`${PKG_DIR}/biome.json`)));

  step("lockfile");
  run(["bun", "install"], ROOT);
  const drift = diffExternalResolutions(lockBefore, externalResolutions(await read("bun.lock")));
  if (drift.added.length > 0 || drift.removed.length > 0) {
    throw new Error(`lock drift: +${drift.added.join(",")} -${drift.removed.join(",")}`);
  }
  report.push(`external resolutions unchanged (${lockBefore.length})`);

  step("CI + release");
  copyFileSync(join(TPL, "ci.yml"), join(ROOT, ".github/workflows/ci.yml"));
  copyFileSync(join(TPL, "release.yml"), join(ROOT, ".github/workflows/release.yml"));

  step("editor + docs");
  write(".claude/settings.json", editClaudeSettings(await read(".claude/settings.json")));
  write("CONTRIBUTING.md", editContributing(await read("CONTRIBUTING.md")));

  step(".nax monorepo");
  const { root, mono } = splitNaxConfig(await read(".nax/config.json"));
  run(["mkdir", "-p", ".nax/mono/packages/nax"], ROOT);
  write(".nax/config.json", root);
  write(".nax/mono/packages/nax/config.json", mono);
  run(["git", "mv", ".nax/context.md", ".nax/mono/packages/nax/context.md"], ROOT);
  copyFileSync(join(TPL, "root-context.md"), join(ROOT, ".nax/context.md"));

  step("rules");
  for (const f of readdirSync(join(ROOT, ".nax/rules")).filter((n) => n.endsWith(".md"))) {
    write(`.nax/rules/${f}`, rewriteRuleFrontmatter(await read(`.nax/rules/${f}`), PKG_DIR));
    report.push(`rule rewritten: ${f}`);
  }
  const nax = ["bun", `${PKG_DIR}/bin/nax.ts`];
  run([...nax, "rules", "export", "--agent", "claude"], ROOT);

  step(".gitignore");
  const split = splitGitignore(await read(".gitignore"));
  write(".gitignore", split.root);
  write(`${PKG_DIR}/.gitignore`, split.pkg);
  report.push(`moved to ${PKG_DIR}/.gitignore: ${split.moved.join(", ")}`);

  step("nax generate");
  run([...nax, "generate"], ROOT);
  run([...nax, "generate", "--all-packages"], ROOT);

  run(["git", "add", "-A"], ROOT);
  console.log(`# convert-s0a report${report.join("\n")}\n\nOutput staged, NOT committed. Review, then commit.`);
}

main().catch((err) => {
  console.error(`convert-s0a FAILED at the last step printed above:\n${(err as Error).message}`);
  console.error(report.join("\n"));
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the tool**

Run: `bun x tsc --noEmit --strict --target esnext --module esnext --moduleResolution bundler --types bun-types tools/monorepo/convert-s0a.ts tools/monorepo/lib/*.ts`
Expected: no errors.

- [ ] **Step 3: Commit the script (this is the "script commit")**

```bash
git add tools/monorepo/convert-s0a.ts
git commit -m "chore(tools): convert-s0a entry point"
git log --oneline -1   # record this SHA and the Task 3-7 SHAs: the quiet window cherry-picks all of them
```

### Task 9: Trial conversion and verification (spec §9.1 items 1-8)

**Files:** the generated output only. Fixes go into `tools/monorepo/**` (amend or new commits there, never hand-edit the output). Test fixes of the §5.2 class (a root-resource read) go into a **pre-move** commit, in Task 5 style, and the conversion is re-run.

**Interfaces:** none.

- [ ] **Step 1: Capture baselines before converting**

```bash
mkdir -p /tmp/s0a-baseline   # or the session scratchpad
# Same flags as the package's `build` script, but with a FIXED commit string so the two bundles are comparable.
bun build bin/nax.ts --outdir /tmp/s0a-baseline --target bun --external "@nathapp/nax-ai" --external "@anthropic-ai/sandbox-runtime" --define 'GIT_COMMIT="fixed"'
npm pack --dry-run --json > /tmp/s0a-baseline/pack.json
```

- [ ] **Step 2: Run the conversion**

Run: `bun tools/monorepo/convert-s0a.ts`
Expected: exit 0 and a report listing the moved entries, `external resolutions unchanged`, 13 `rule rewritten` lines, and the three moved `.gitignore` entries.

- [ ] **Step 3: Review the staged output**

Run: `git status --short | head -50; git diff --cached --stat | tail -5; git diff --cached -- .nax/rules/adapter-wiring.md .claude/rules/adapter-wiring.md .nax/config.json .gitignore`

Expected:
- renames `R` into `packages/nax/`;
- prefixed `appliesTo` entries with a `paths:` block;
- `.claude/rules` `paths:` entries starting with `packages/nax/`;
- root `.nax/config.json` quality commands set to the root scripts.

- [ ] **Step 4: Commit the output (no hand edits)**

```bash
git commit -m "refactor: move nax into packages/nax (Bun workspace root, .nax monorepo layout)"
```

- [ ] **Step 5: Item 1, full suite from the package**

Run: `cd packages/nax && bun run typecheck && bun run check:all && bun run build && bun run test && bun run test:e2e && bun run test:full && bun run test:coverage`

Expected: all pass.
- A failure that reads a root resource (`.nax/`, `.claude/`, `.github/`, `docs/`, `CHANGELOG`-at-root, …) is the §5.2 class. Fix it with `findRepoRoot` in a new **pre-move** commit:
  1. `git reset --hard HEAD~1` drops the generated output commit and returns to the pre-move tree.
  2. Make and commit the fix there.
  3. Re-run from Step 1 (fresh baselines, then conversion).
- Any other failure: stop and report it.

- [ ] **Step 6: Item 2, baselines unchanged**

Run: `git diff HEAD~1 --stat -- packages/nax/scripts/baselines`
Expected: only renames (`R100`), no content change.

- [ ] **Step 7: Item 3, same bundle modulo `package.json` and `GIT_COMMIT`**

Run:
```bash
(cd packages/nax && bun build bin/nax.ts --outdir /tmp/s0a-after --target bun --external "@nathapp/nax-ai" --external "@anthropic-ai/sandbox-runtime" --define 'GIT_COMMIT="fixed"')
bun -e '
// The inlined package.json (src/_pkg.ts) now carries repository.directory; strip that one property, however it is quoted.
const norm = (s) => s.replace(/"?directory"?:\s*"packages\/nax",?/g, "");
const a = norm(await Bun.file("/tmp/s0a-baseline/nax.js").text());
const b = norm(await Bun.file("/tmp/s0a-after/nax.js").text());
console.log(a === b ? "BUNDLE SAME" : "BUNDLE DIFFERS");'
```
Expected: `BUNDLE SAME`. If it differs, diff the two normalised strings. Anything beyond the inlined `package.json` object is a finding: stop and report.

- [ ] **Step 8: Items 4-5, package contents and global install**

Run:
```bash
cd packages/nax && npm pack --dry-run --json > /tmp/s0a-after-pack.json && npm pack && cd ../..
bun -e 'const f=(p)=>JSON.parse(require("fs").readFileSync(p,"utf8"))[0].files.map(x=>x.path).sort().join("\n"); console.log(f("/tmp/s0a-baseline/pack.json")===f("/tmp/s0a-after-pack.json")?"FILES SAME":"FILES DIFFER")'
BUN_INSTALL=/tmp/s0a-global bun add -g ./packages/nax/nathapp-nax-*.tgz && /tmp/s0a-global/bin/nax --version && /tmp/s0a-global/bin/nax config >/dev/null && readlink -f /tmp/s0a-global/bin/nax
rm packages/nax/nathapp-nax-*.tgz
```
Expected:
- `FILES SAME`;
- a version string is printed;
- `nax config` exits 0;
- the resolved path ends in `@nathapp/nax/dist/nax.js`.

- [ ] **Step 9: Item 6, rules dry-run**

Create a scratch (not committed) script `/tmp/s0a-rules-probe.ts`:

```typescript
import { loadCanonicalRules } from "./packages/nax/src/context";
import { findRepoRoot } from "./packages/nax/scripts/lib/repo-root";
const root = findRepoRoot(process.cwd());
const rules = await loadCanonicalRules(root);
const glob = (g: string) => new RegExp(`(?:^|/)${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*")}$`);
const hits = (file: string) => rules.filter((r) => (r.appliesTo ?? []).some((g) => g === file || glob(g).test(file))).map((r) => r.fileName).sort();
console.log("nax:", hits("packages/nax/src/agents/x.ts"));
console.log("nax-ai:", hits("packages/nax-ai/src/x.ts"));
console.log("literal:", hits("packages/nax/src/session/session-keeper.ts").includes("retry-strategy.md"));
```

Run: `cp /tmp/s0a-rules-probe.ts ./s0a-rules-probe.ts && bun ./s0a-rules-probe.ts; rm ./s0a-rules-probe.ts`

Expected:
- `nax:` lists the same rule files that `src/agents/**` matched before the move. Compare with `git stash`-free knowledge: `adapter-wiring`, `config-patterns`, `error-handling`, `forbidden-patterns-source`, `monorepo-awareness`, `project-conventions`, `retry-strategy`.
- `nax-ai:` is `[]`.
- `literal:` is `true`.

Also run: `grep -h '^  - "' .claude/rules/*.md | grep -v '"packages/nax/' ; echo "exit=$?"`. Expected: no lines, and `exit=1`.

- [ ] **Step 10: Item 7, tooling**

Run:
```bash
bun x biome check packages/nax/src/version.ts && (cd packages/nax && bun run lint:biome)
bun install --frozen-lockfile
bun run build     # from root: --filter order
```
Expected: all exit 0, and the `lint:biome` file count equals the pre-move count.
- Get the pre-move count by running `bun run lint:biome` on `origin/main` in a scratch worktree if needed.
- On Bun 1.4.0, check the `--filter` order through CI (Step 12).

- [ ] **Step 11: Item 8, rebase across the move**

```bash
git branch s0a-rebase-probe origin/main
git checkout s0a-rebase-probe
printf '\n// probe\n' >> src/version.ts && printf '\n// probe\n' >> scripts/check-file-sizes.ts && printf '\n# probe\n' >> README.md
git commit -qam "probe"
git rebase refactor/nax-monorepo && git show --stat HEAD | grep packages/nax
git checkout refactor/nax-monorepo && git branch -D s0a-rebase-probe
```
Expected: the rebase succeeds with no conflicts, and the probe commit's files are under `packages/nax/`.

- [ ] **Step 12: Open the draft PR (maintainer approval to push)**

Ask the maintainer: "S0a trial passed §9.1 items 1-8. Push and open the draft PR?" **Wait for yes.** Then:

```bash
git push --force-with-lease origin refactor/nax-monorepo
gh pr create --draft --base main --title "refactor: S0a — move nax into packages/nax (Bun workspace)" \
  --body "S0a of the monorepo conversion (spec §8.1). Commits: findRepoRoot prep, the conversion tool, and ONE generated commit (tools/monorepo/convert-s0a.ts output, no hand edits). Trial checks §9.1 items 1-8 passed locally; item 9 (billed nax run smoke) pending approval. Merge: squash, in an agreed quiet window after re-running the script on latest main."
```

Wait for CI to go green, including confirmation that `bun run --filter` ran in dependency order on Bun 1.4.0. The CI log shows the package order for root `build` if you add it to a trial step; otherwise it is covered in S0b, where a real dependency exists.

### Task 10: `nax run` smoke (spec §9.1 item 9), maintainer approval required

**Files:** none in the repo. Work on a copy.

- [ ] **Step 1: Prepare a copy and a one-story feature**

```bash
SMOKE=/tmp/s0a-smoke && rm -rf "$SMOKE" && git clone -q --branch refactor/nax-monorepo "$(git rev-parse --show-toplevel)" "$SMOKE"
cd "$SMOKE" && bun install
```

Change the copy's `.nax/config.json` `name` to `nax-s0a-smoke`, so its artifacts go to `~/.nax/nax-s0a-smoke/` and not the real ledger.

Write `.nax/features/s0a-smoke/spec.md` with one story whose workdir is `packages/nax`:
- Story: "add a unit-tested pure helper `packages/nax/src/utils/clamp.ts` exporting `clamp(n, lo, hi)`";
- Acceptance: "clamp(5,0,3) === 3; clamp(-1,0,3) === 0; clamp(2,0,3) === 2".

- [ ] **Step 2: Ask for approval at launch**

Ask: "Ready to launch the billed S0a smoke: `bun <repo>/packages/nax/bin/nax.ts plan --from .nax/features/s0a-smoke/spec.md -f s0a-smoke` then `… run -f s0a-smoke` in /tmp/s0a-smoke (local build, project name nax-s0a-smoke). Approve?" **Wait for an explicit yes for each billed command.**

- [ ] **Step 3: Run and check**

After the run finishes, check (read the run log and `~/.nax/nax-s0a-smoke/`):

1. The run log reports a monorepo, and the story workdir is `packages/nax`.
2. Quality commands are the ones from `.nax/mono/packages/nax/config.json`: prompt-audit or run log shows `CI=1 AGENT=1 bun test --timeout=60000 <paths>` with **package-relative** paths.
3. The prompt-audit rules section for the story lists the same rules as Task 9 Step 9's `nax:` set, restricted to the story's stage.
4. The acceptance stage ran, and the generated acceptance test's imports resolved (it passed or failed on behaviour, not with `Cannot find module`).
5. `git -C /tmp/s0a-smoke log -2 --stat` shows auto-commits touching only `packages/nax/…` and `.nax/features/s0a-smoke/…`.

nax exits 0 even on failure, so judge by the run summary and artifacts, never by the exit code. If item 4 fails with module resolution, **stop**: the acceptance path needs a spec decision before merge (spec §6.2).

### Task 11: Quiet window and merge of S0a

- [ ] **Step 1: Agree the window with the maintainer**

Ask for a time. During the window there are no merges to `main` and no `nax run` against the repo.

- [ ] **Step 2: Regenerate on the latest main**

```bash
git fetch origin
git log --oneline origin/main..refactor/nax-monorepo   # note the prep + tool commit SHAs (all but the generated one)
git checkout -B refactor/nax-monorepo origin/main
git cherry-pick <Task3 SHA> <Task4 SHA> <Task5 SHA> <Task6 SHA> <Task7 SHA> <Task8 SHA> [<any §5.2 fix SHAs>]
bun tools/monorepo/convert-s0a.ts && git commit -m "refactor: move nax into packages/nax (Bun workspace root, .nax monorepo layout)"
cd packages/nax && bun run typecheck && bun run check:all && bun run test && cd ../..
git push --force-with-lease origin refactor/nax-monorepo
```

If a cherry-pick conflicts, resolve it in the prep or tool commit (not the generated one). Then re-run.

- [ ] **Step 3: Mark ready, wait for green CI, and have the maintainer merge with squash the same day**

Run: `gh pr ready && gh pr checks --watch`

- [ ] **Step 4: Post-merge**

```bash
git fetch origin && git checkout refactor/nax-monorepo && git reset --hard origin/main
rm -rf dist coverage node_modules && bun install
```

Tell the maintainer:
- other clones need `bun install` at the root;
- open branches and worktrees should rebase (`git rebase -X find-renames origin/main`);
- the code-graph index needs a rebuild.

Record the PR number and merge commit in the master plan §5.

---

## PR 3 — S0b

### Task 12: Import nax-ai with history

**Files:** `packages/nax-ai/**` (imported).

- [ ] **Step 1: Check the tool**

Run: `git filter-repo --version`
Expected: a version. If missing, `brew install git-filter-repo` (macOS) or `pip install git-filter-repo`.

- [ ] **Step 2: Rewrite a fresh clone**

```bash
rm -rf /tmp/nax-ai-import && git clone -q https://github.com/nathapp-io/nax-ai.git /tmp/nax-ai-import
cd /tmp/nax-ai-import && git filter-repo --to-subdirectory-filter packages/nax-ai --tag-rename v:nax-ai-v
git tag | sort -V | tail -3        # expect nax-ai-v0.1.14 … nax-ai-v0.1.16
git ls-tree --name-only HEAD       # expect: packages
```

- [ ] **Step 3: Merge into the working branch**

```bash
cd <repo>
git checkout refactor/nax-monorepo && git reset --hard origin/main   # S0a merged
git fetch /tmp/nax-ai-import main --tags
git merge --allow-unrelated-histories --no-ff FETCH_HEAD -m "chore: import nax-ai with history into packages/nax-ai"
git log --oneline --follow packages/nax-ai/src/index.ts | wc -l   # > 1
```

Expected: a clean merge (no path overlap), and history present.

### Task 13: Wire nax-ai into the workspace

**Files:**
- Delete: `packages/nax-ai/bun.lock`, `packages/nax-ai/{CLAUDE,AGENTS,GEMINI,codex}.md`, `packages/nax-ai/.github/`, `tools/monorepo/`
- Move: `packages/nax-ai/.nax/*` → `.nax/mono/packages/nax-ai/` (if nax-ai has a `.nax/`)
- Modify: `packages/nax-ai/package.json` (`prepare`, `repository`, `homepage`, `bugs`)
- Modify: `packages/nax-ai/biome.json` (`"root": false` first)
- Modify: `packages/nax-ai/scripts/release.ts:158` (`const tagName = \`nax-ai-v${version}\``; the branch at `:210` follows automatically)
- Create: `.nax/mono/packages/nax-ai/config.json`, `.nax/mono/packages/nax-ai/context.md` (from nax-ai's `.nax/context.md` if present, else from its old `CLAUDE.md` body)
- Modify: `.nax/mono/packages/nax/config.json` (`typecheck` and `test` prefix)
- Modify: `tools/monorepo/templates/root-context.md` content, now in `.nax/context.md`: add the nax-ai row and the nax-ai-before-nax release note
- Test: `packages/nax-ai/test/package-metadata.test.ts`

**Interfaces:**
- Produces: the nax-ai workspace package, built on install; `.nax` config for nax-ai stories.

- [ ] **Step 1: Write the failing metadata test (vitest, in nax-ai)**

```typescript
// packages/nax-ai/test/package-metadata.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package metadata points at the monorepo (npm provenance checks repository.url)", () => {
  it("repository", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-ai" });
  });
  it("homepage and bugs", () => {
    expect(pkg.homepage).toBe("https://github.com/nathapp-io/nax/tree/main/packages/nax-ai");
    expect(pkg.bugs).toEqual({ url: "https://github.com/nathapp-io/nax/issues" });
  });
  it("builds dist on workspace install", () => {
    expect(pkg.scripts.prepare).toBe("bun run build");
  });
});
```

Run: `cd packages/nax-ai && bun x vitest --run test/package-metadata.test.ts`
Expected: FAIL, 3 tests.

- [ ] **Step 2: Apply the `package.json`, `biome` and release-script edits**

In `packages/nax-ai/package.json`, set:
- `"repository": { "type": "git", "url": "git+https://github.com/nathapp-io/nax.git", "directory": "packages/nax-ai" }`
- `"homepage": "https://github.com/nathapp-io/nax/tree/main/packages/nax-ai"`
- `"bugs": { "url": "https://github.com/nathapp-io/nax/issues" }`
- add `"prepare": "bun run build"` to `scripts`.

In `packages/nax-ai/biome.json`, add `"root": false` as the first key.

In `packages/nax-ai/scripts/release.ts:158`, change `` `v${version}` `` to `` `nax-ai-v${version}` ``. Also update the usage and doc comments that say `v<version>`.

Run: `bun x vitest --run test/package-metadata.test.ts` (still in `packages/nax-ai`)
Expected: PASS.

- [ ] **Step 3: Lockfile and install**

```bash
cd <repo>
before=$(bun -e 'import {externalResolutions} from "./tools/monorepo/lib/lock-resolutions"; console.log(externalResolutions(await Bun.file("bun.lock").text()).join("\n"))')
git rm -q packages/nax-ai/bun.lock
bun install
bun -e 'const t=await Bun.file("bun.lock").text(); for (const r of ["@earendil-works/pi-ai@0.87.1","proper-lockfile@4.1.2","@nathapp/nax-ai@workspace:packages/nax-ai"]) if(!t.includes(`"${r}"`)) throw new Error("missing "+r); console.log("lock OK")'
ls packages/nax-ai/dist/index.js
```
Expected:
- `lock OK`;
- `dist/index.js` exists, built by `prepare`;
- every line of `$before` is still present in the new external resolutions. Check with `diffExternalResolutions`: `removed` is empty.

- [ ] **Step 4: `.nax` for nax-ai, generated files, removals**

- `.nax/mono/packages/nax-ai/config.json`:

  ```json
  {
    "quality": {
      "commands": {
        "test": "bun run test",
        "testScoped": "bun x vitest --run {{files}}",
        "typecheck": "bun run typecheck",
        "lint": "bun run lint",
        "lintFix": "bun run lint:fix",
        "formatFix": "bun run lint:fix",
        "build": "bun run build"
      }
    }
  }
  ```
- In `.nax/mono/packages/nax/config.json`, prefix `typecheck` and `test` with `bun run --cwd ../nax-ai build && `. For the array-form `typecheck`, prepend a first element `bun run --cwd ../nax-ai build`.
- Write `.nax/mono/packages/nax-ai/context.md` from nax-ai's existing context.
- Remove nax-ai's per-agent files and `.github/`.
- Update `.nax/context.md`'s layout table with a `packages/nax-ai` row, and add the sentence: "Bumping nax-ai: bump its version and nax's exact pin in one PR; release `nax-ai-vX.Y.Z` before releasing nax."
- Then: `bun packages/nax/bin/nax.ts generate && bun packages/nax/bin/nax.ts generate --all-packages && git rm -r -q tools/monorepo`

- [ ] **Step 5: Run both packages' gates**

Run: `(cd packages/nax-ai && bun run lint && bun run typecheck && bun x vitest --run) && (cd packages/nax && bun run typecheck && bun run check:all && bun run test)`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: wire nax-ai into the workspace (prepare build, repo metadata, .nax mono config, nax-ai-v tags)"
```

### Task 14: `check:nax-ai-pin`

**Files:**
- Create: `packages/nax/scripts/check-nax-ai-pin.ts`
- Test: `packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts`
- Modify: `packages/nax/package.json`: add `"check:nax-ai-pin": "bun run scripts/check-nax-ai-pin.ts"` and append `&& bun run check:nax-ai-pin` to `lint:checks`.

**Interfaces:**
- Produces: `export function checkNaxAiPin(naxPkg: {dependencies?: Record<string,string>}, naxAiPkg: {version: string}): string | null`. It returns an error message, or `null` when OK.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts
import { describe, expect, test } from "bun:test";
import { checkNaxAiPin } from "@scripts/check-nax-ai-pin";

describe("checkNaxAiPin", () => {
  test("ok when the exact pin equals the workspace version", () => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": "0.1.16" } }, { version: "0.1.16" })).toBeNull();
  });
  test("fails on a mismatch", () => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": "0.1.15" } }, { version: "0.1.16" })).toMatch(/0\.1\.15.*0\.1\.16/);
  });
  test.each(["workspace:*", "^0.1.16", "~0.1.16", "latest"])("fails on non-exact spec %s", (spec) => {
    expect(checkNaxAiPin({ dependencies: { "@nathapp/nax-ai": spec } }, { version: "0.1.16" })).toMatch(/exact/);
  });
  test("fails when the dependency is missing", () => {
    expect(checkNaxAiPin({ dependencies: {} }, { version: "0.1.16" })).toMatch(/missing/);
  });
  test("the real repo passes", async () => {
    const { findRepoRoot } = await import("@scripts/lib/repo-root");
    const root = findRepoRoot(import.meta.dir);
    const nax = await Bun.file(`${root}/packages/nax/package.json`).json();
    const ai = await Bun.file(`${root}/packages/nax-ai/package.json`).json();
    expect(checkNaxAiPin(nax, ai)).toBeNull();
  });
});
```

Run: `cd packages/nax && bun test test/unit/scripts/check-nax-ai-pin.test.ts --timeout=60000`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement**

```typescript
#!/usr/bin/env bun
/**
 * Gate: nax's @nathapp/nax-ai dependency is an EXACT version equal to the workspace
 * package's version. `workspace:*` is not allowed: src/agents/catalog/index.ts reads the
 * spec as NAX_AI_VERSION (catalogVersion on cost rows) and accepts only X.Y.Z.
 * Bun links the workspace package when the exact pin matches its version.
 */
import { join } from "node:path";
import { findRepoRoot } from "./lib/repo-root";

const EXACT = /^\d+\.\d+\.\d+$/;

export function checkNaxAiPin(
  naxPkg: { dependencies?: Record<string, string> },
  naxAiPkg: { version: string },
): string | null {
  const spec = naxPkg.dependencies?.["@nathapp/nax-ai"];
  if (spec === undefined) return "@nathapp/nax-ai is missing from packages/nax dependencies";
  if (!EXACT.test(spec)) return `@nathapp/nax-ai must be an exact X.Y.Z pin, found "${spec}"`;
  if (spec !== naxAiPkg.version) {
    return `@nathapp/nax-ai pin ${spec} != packages/nax-ai version ${naxAiPkg.version} (bump both in one PR)`;
  }
  return null;
}

if (import.meta.main) {
  const root = findRepoRoot(import.meta.dir);
  const err = checkNaxAiPin(
    await Bun.file(join(root, "packages/nax/package.json")).json(),
    await Bun.file(join(root, "packages/nax-ai/package.json")).json(),
  );
  if (err) {
    console.error(`[FAIL] ${err}`);
    process.exit(1);
  }
  console.log("[OK] @nathapp/nax-ai pin matches the workspace version");
}
```

- [ ] **Step 3: Wire it into `check:all` and run**

Add the `check:nax-ai-pin` script and append `&& bun run check:nax-ai-pin` to `lint:checks` in `packages/nax/package.json`.

Run: `cd packages/nax && bun test test/unit/scripts/check-nax-ai-pin.test.ts --timeout=60000 && bun run check:nax-ai-pin && bun run check:gate-reachability`
Expected: PASS; `[OK]`; gate-reachability OK, since the new script is reached through `check:all`.

- [ ] **Step 4: Commit**

```bash
git add packages/nax/scripts/check-nax-ai-pin.ts packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts packages/nax/package.json
git commit -m "feat(scripts): check:nax-ai-pin keeps nax's exact nax-ai pin equal to the workspace version"
```

### Task 15: CI jobs and release mapping for nax-ai

**Files:**
- Modify: `.github/workflows/ci.yml` (add 4 jobs)
- Modify: `.github/workflows/release.yml` (add the `nax-ai-v*` trigger and resolve arm, per-package pre-publish steps, the nax `npm view` guard)

- [ ] **Step 1: Add the nax-ai CI jobs**

In `ci.yml`, add four jobs copied from nax-ai's former `ci.yml` (`static`, `test-node`, `smoke-bun`, `pack`; its text is in the imported history at `git show HEAD~2:packages/nax-ai/.github/workflows/ci.yml`, or the Task 12 merge parent). Apply exactly these edits:
- Rename the job ids to `nax-ai-static`, `nax-ai-test-node`, `nax-ai-smoke-bun`, `nax-ai-pack`, and prefix their names with `nax-ai: `.
- Add `defaults: { run: { working-directory: packages/nax-ai } }` to each job.
- Give each `bun install --frozen-lockfile` step its own `working-directory: .`.
- In `nax-ai-pack`, the tarball path becomes `"$GITHUB_WORKSPACE"/packages/nax-ai/nathapp-nax-ai-*.tgz`.
- Keep `actions/checkout@v4` / `setup-node@v4` as they were, and Bun `1.4.0`.

Also add `packages/nax-ai/**` to nothing: `packages/**` already covers it.

- [ ] **Step 2: Extend the release workflow**

In `release.yml`:
- `on.push.tags`: add `- "nax-ai-v*.*.*"` and `- "nax-ai-v*.*.*-canary.*"`.
- Replace the `Resolve package` case with:

  ```yaml
          case "$TAG" in
            nax-ai-v*) V="${TAG#nax-ai-v}"; echo "dir=packages/nax-ai" >> "$GITHUB_OUTPUT"; echo "name=@nathapp/nax-ai" >> "$GITHUB_OUTPUT" ;;
            v*)        V="${TAG#v}";        echo "dir=packages/nax" >> "$GITHUB_OUTPUT";    echo "name=@nathapp/nax" >> "$GITHUB_OUTPUT" ;;
            *) echo "Unrecognised tag $TAG"; exit 1 ;;
          esac
          echo "version=$V" >> "$GITHUB_OUTPUT"
  ```
- `Validate version`: compare `v$(node -p …)` for nax and `nax-ai-v$(node -p …)` for nax-ai. Equivalently, compare `${{ steps.pkg.outputs.version }}` with `node -p "require('./package.json').version"` in the package dir.
- `Set release info`:
  - nax keeps today's logic;
  - for `@nathapp/nax-ai`, `canary` → npm tag `canary` and prerelease; otherwise npm tag `latest`, with `prerelease=true` when the version starts with `0.` (as its old workflow did); `notify=false` always.
- Replace `Build` with a per-package step:

  ```yaml
      - name: Pre-publish checks
        working-directory: ${{ steps.pkg.outputs.dir }}
        env:
          NAME: ${{ steps.pkg.outputs.name }}
        run: |
          if [ "$NAME" = "@nathapp/nax-ai" ]; then bun run lint && bun run typecheck && bun x vitest --run && bun run build; else bun run build; fi
  ```
- Add a nax-only guard before `Publish to npm`:

  ```yaml
      - name: nax-ai pin is published
        if: steps.pkg.outputs.name == '@nathapp/nax'
        working-directory: packages/nax
        run: |
          PIN=$(node -p "require('./package.json').dependencies['@nathapp/nax-ai']")
          npm view "@nathapp/nax-ai@$PIN" version || { echo "::error::@nathapp/nax-ai@$PIN is not on npm; release nax-ai first"; exit 1; }
  ```
- The Telegram step condition becomes `steps.info.outputs.notify == 'true' && steps.pkg.outputs.name == '@nathapp/nax' && vars.TELEGRAM_CHAT_ID != ''`.

- [ ] **Step 3: Validate and commit**

Run: `bun -e 'import {YAML} from "bun"; for (const f of ["ci","release"]) { YAML.parse(await Bun.file(`.github/workflows/${f}.yml`).text()); console.log(f,"ok") }' && (cd packages/nax && bun run check:gate-reachability)`
Expected: both `ok`, and gate-reachability OK.

```bash
git add .github/workflows
git commit -m "ci: nax-ai jobs and nax-ai-v tag publishing in the monorepo workflows"
```

### Task 16: S0b verification (spec §9.2) and PR 3

- [ ] **Step 1: Items 1-6**

Run:
```bash
git log --oneline --follow packages/nax-ai/src/index.ts | tail -1            # the first nax-ai commit
git tag -l 'nax-ai-v*' | sort -V | tr '\n' ' '                                # nax-ai-v0.1.1 … nax-ai-v0.1.16
(cd packages/nax-ai && npm pack --dry-run --json | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j[0].files.map(f=>f.path).sort().join("\n"))' > /tmp/s0b-files.txt)
(cd /tmp && rm -rf s0b-reg && mkdir s0b-reg && cd s0b-reg && npm pack @nathapp/nax-ai@0.1.16 >/dev/null && tar -tzf nathapp-nax-ai-0.1.16.tgz | sed 's#^package/##' | sort > /tmp/s0b-reg.txt)
diff /tmp/s0b-files.txt /tmp/s0b-reg.txt && echo "FILES SAME"
(cd packages/nax && bun run check:nax-ai-pin && bun test test/unit/version.test.ts --timeout=60000 && bun run build && grep -c '0.1.16' dist/nax.js && bun run check:bundle-externals)
```
Expected: history present; 16 tags; `FILES SAME`; pin OK; the version test passes; `0.1.16` found in the bundle; externals OK.

- [ ] **Step 2: Item 7, clean clone**

```bash
rm -rf /tmp/s0b-clean && git clone -q --branch refactor/nax-monorepo "$(git rev-parse --show-toplevel)" /tmp/s0b-clean
cd /tmp/s0b-clean && bun install && bun run typecheck && bun run --cwd packages/nax test:unit
```
Expected: all pass, with no manual build.

- [ ] **Step 3: Item 8, `catalog:diff`**

Run: `cd packages/nax-ai && bun run catalog:diff`
Expected: a diff report, or "no changes", against npm latest. No provider is called.

- [ ] **Step 4: Open PR 3 (maintainer approval to push the branch; tags need a SEPARATE approval)**

Ask: "S0b verified (§9.2 items 1-8). Push the branch and open PR 3 (merge commit, not squash)?" **Wait for yes.**

```bash
git push --force-with-lease origin refactor/nax-monorepo
gh pr create --base main --title "chore: S0b — import nax-ai with history into packages/nax-ai" \
  --body "S0b of the monorepo conversion (spec §8.2). Imports nathapp-io/nax-ai via git filter-repo (history under packages/nax-ai/, tags renamed nax-ai-v*). Imported commit messages keep their #N references, which now resolve to nax numbers. MERGE WITH A MERGE COMMIT — do not squash. Maintainer steps after merge: move the npm trusted publisher for @nathapp/nax-ai to nathapp-io/nax + release.yml; archive nathapp-io/nax-ai after a README pointer."
```

Ask separately: "Push the 16 renamed `nax-ai-v*` tags to origin? They point at pre-import commits with no root workflows, so nothing publishes." **Wait for yes**, then run `git push origin 'refs/tags/nax-ai-v*'`.

- [ ] **Step 5: After the maintainer merges (merge commit)**

- Record the PR number and merge commit in the master plan §5, and mark S0 complete.
- Remind the maintainer of the two manual steps: the npm trusted publisher and archiving `nathapp-io/nax-ai`, both with a pointer README (ask before touching that repo).
- No release.
