# Lockstep Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` at one shared version (first: **0.84.0**) through one release PR and one `vX.Y.Z` tag.

**Architecture:** A lockstep library in `packages/repo-tooling` owns the package list, the "all versions equal, nax-ai pins equal" rule, and the manifest rewrite. A gate (`check-lockstep.ts`) enforces the rule in nax's `check:all` and in the release workflow. One root `bun run release` command replaces the three per-package release scripts. `release.yml` becomes a `resolve` job plus four publish jobs chained by `needs` (nax-ai → nax-agent → nax-agent-acp → nax), which share one composite action, plus a single GitHub Release job.

**Tech Stack:** Bun 1.4 scripts (`node:*` APIs, `execFileSync`), bun:test, GitHub Actions (composite action, npm trusted publishing over OIDC), `Bun.YAML` for workflow tests.

**Spec:** No separate spec. This plan carries the design, which the user approved on 2026-10-09: one shared version, one tag, sequential publish in dependency order, skip-if-published, first shared version 0.84.0. Background: the S5-4 plan `docs/superpowers/plans/2026-10-09-s5-4-auth-release.md` Tasks 7-9 needed three separate releases, and that friction prompted this plan.

## Global Constraints

- The lockstep set is exactly these four packages, in this publish order: `packages/nax-ai` (`@nathapp/nax-ai`), `packages/nax-agent` (`@nathapp/nax-agent`), `packages/nax-agent-acp` (`@nathapp/nax-agent-acp`), `packages/nax` (`@nathapp/nax`). `test-kit` and `repo-tooling` stay private at `0.0.0`.
- The first shared version is `0.84.0`. Do not pick any other number.
- `@nathapp/nax-ai` stays an **exact** pin (no `^`, no `workspace:*`) in `packages/nax` and `packages/nax-agent`, equal to the shared version. `packages/nax/src/agents/catalog/index.ts:60-63` reads that pin as `CATALOG_VERSION`.
- `nax-agent-acp` keeps `peerDependencies: { "@nathapp/nax-agent": "workspace:*" }`. Its `stage-publish` already rewrites the peer to `^<own version>`.
- Releasable versions are `X.Y.Z` or `X.Y.Z-canary.N` only. Stable versions publish to the `latest` dist-tag and canary versions to `canary`.
- Tags are `vX.Y.Z` / `vX.Y.Z-canary.N` only. The `nax-ai-v*`, `nax-agent-v*` and `nax-agent-acp-v*` prefixes are retired.
- npm trusted publishing must keep working: every publish job stays in `.github/workflows/release.yml`, uses `environment: npm`, and has `id-token: write`. Workflow filename and environment are what npm's trusted-publisher entry matches.
- Release scripts never tag automatically. Pushing a tag is always a separate, confirmed command.
- No emojis in new code or docs. Keep functions small (`check:complexity` in repo-tooling). Use immutable updates: no mutation of manifests that were read in.
- Never edit generated `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `codex.md` by hand. Edit `.nax/context.md` or `.nax/mono/packages/<pkg>/context.md`, then regenerate everything (Task 4).
- Never run bare `bun test`. Run package scripts from the package directory (`cd packages/repo-tooling && bun run test`).

## Review Focus

1. **Trusted-publisher drift.** Moving publishing from one job into four jobs must not change the npm OIDC identity (workflow file `release.yml`, environment `npm`). If any of the four packages' npm trusted-publisher entries names a different workflow or environment, its upload fails with E401/E403 *after* the earlier packages are already public. Task 3's job-graph test pins `environment: npm` on every publish job. Task 5 Step 1 has the maintainer confirm all four npm settings before the first tag.
2. **Registry lag between chained jobs.** nax-agent's job starts seconds after nax-ai's publish, and `npm view` can briefly 404. The "Dependencies are on npm" step retries 8 times; Task 3 tests both the retry count and the final failure.
3. **Partial release then re-run.** If the nax job fails after nax-ai, nax-agent and nax-agent-acp are already published, re-running must skip those three rather than fail on "cannot publish over existing version". The "Already on npm" step and the `if:` guard on every later step are tested in Task 3.
4. **Manifest formatting churn.** The release writer is `JSON.stringify(manifest, null, 2)`. If a real `package.json` is not stringify-stable, every release reformats it. Task 1's real-workspace round-trip test catches that.
5. **A package with no changes.** In lockstep, nax-agent-acp often has no notes. The old helper refused to release ("Missing unreleased changelog notes"). `stampChangelog` must date real notes, turn an empty or missing pending heading into a "No changes" entry, and still refuse an already-dated version. All of this is tested in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/repo-tooling/scripts/lib/lockstep.ts` (create) | Package list in publish order, `lockstepErrors`, `withVersion`, `readManifests`, `writeManifests` |
| `packages/repo-tooling/scripts/check-lockstep.ts` (create) | Gate CLI; `--expect=X.Y.Z` for the workflow |
| `packages/repo-tooling/scripts/lib/release-version.ts` (git mv from nax-agent) | Version arithmetic and changelog dating, plus new `nextSharedVersion` and `stampChangelog` |
| `packages/repo-tooling/scripts/release.ts` (create) | The one release command: bump PR and `tag` |
| `.github/actions/publish-package/action.yml` (create) | Gates, skip-if-published, dependency wait, and publish for one package |
| `.github/workflows/release.yml` (rewrite) | `resolve` → 4 chained publish jobs → `github-release` |
| `packages/repo-tooling/test/helpers/release-shell.ts` (git mv + adapt) | Runs one workflow/action step body under stub `bun`/`npm` |
| `packages/repo-tooling/test/helpers/release-cli-fixture.ts` (create; replaces nax-agent's) | Temp git repo with the four packages and stubbed `git`/`bun`/`gh`/`npm` |
| `packages/repo-tooling/test/unit/scripts/check-lockstep.test.ts` (create) | Gate and lockstep-lib tests |
| `packages/repo-tooling/test/unit/release/release-version.test.ts` (git mv + extend) | Version and changelog tests |
| `packages/repo-tooling/test/unit/release/release-cli.test.ts` (create) | Release command tests |
| `packages/repo-tooling/test/unit/release/release-workflow.test.ts` (create) | Workflow and action tests |
| `RELEASING.md` (create, repo root) | The single release guide |

Deleted: `packages/nax/scripts/release.ts`, `packages/nax-ai/scripts/release.ts`, `packages/nax-agent/scripts/release.ts`, `packages/nax/scripts/check-nax-ai-pin.ts` and its test, `packages/nax-agent/test/helpers/release-cli-fixture.ts`, `packages/nax-agent/test/unit/packaging/release-cli.test.ts`, `packages/nax-agent/test/unit/packaging/release-workflow.test.ts`, `packages/repo-tooling/scripts/verify-bootstrap.ts`, `packages/repo-tooling/scripts/lib/bootstrap-artifact.ts` and their two tests.

---

### Task 1: Lockstep gate and alignment to 0.84.0

**Files:**
- Create: `packages/repo-tooling/scripts/lib/lockstep.ts`
- Create: `packages/repo-tooling/scripts/check-lockstep.ts`
- Create: `packages/repo-tooling/test/unit/scripts/check-lockstep.test.ts`
- Modify: `packages/nax/package.json` (scripts `lint:checks`, `check:nax-ai-pin` → `check:lockstep`)
- Modify (version alignment): `packages/{nax-ai,nax-agent,nax-agent-acp,nax}/package.json`, `bun.lock`
- Delete: `packages/nax/scripts/check-nax-ai-pin.ts`, `packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts`

**Interfaces:**
- Produces (used by Tasks 2 and 3):
  - `LOCKSTEP_PACKAGES: readonly { dir: string; name: string }[]` (publish order)
  - `NAX_AI: "@nathapp/nax-ai"`, `NAX_AI_CONSUMERS: readonly string[]`, `CHANGELOG_PACKAGES: readonly string[]`
  - `interface Manifest { version: string; dependencies?: Readonly<Record<string, string>>; [key: string]: unknown }`
  - `type Manifests = ReadonlyMap<string, Manifest>` (keyed by package dir)
  - `readManifests(root: string): Manifests`
  - `writeManifests(root: string, manifests: Manifests): void`
  - `lockstepErrors(manifests: Manifests, expected?: string): string[]`
  - `withVersion(manifests: Manifests, next: string): Manifests`
  - CLI `bun packages/repo-tooling/scripts/check-lockstep.ts [--expect=X.Y.Z]`; export `expectedVersion(argv: readonly string[]): string | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/repo-tooling/test/unit/scripts/check-lockstep.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectedVersion } from "#scripts/check-lockstep";
import {
  LOCKSTEP_PACKAGES,
  lockstepErrors,
  type Manifest,
  type Manifests,
  readManifests,
  withVersion,
} from "#scripts/lib/lockstep";

const ROOT = resolve(import.meta.dir, "../../../../..");

function manifests(overrides: Record<string, Manifest> = {}): Manifests {
  const base: Record<string, Manifest> = {
    "packages/nax-ai": { name: "@nathapp/nax-ai", version: "0.84.0" },
    "packages/nax-agent": {
      name: "@nathapp/nax-agent",
      version: "0.84.0",
      dependencies: { "@nathapp/nax-ai": "0.84.0", zod: "4.0.0" },
    },
    "packages/nax-agent-acp": {
      name: "@nathapp/nax-agent-acp",
      version: "0.84.0",
      peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
    },
    "packages/nax": { name: "@nathapp/nax", version: "0.84.0", dependencies: { "@nathapp/nax-ai": "0.84.0" } },
  };
  return new Map(Object.entries({ ...base, ...overrides }));
}

describe("lockstepErrors", () => {
  test("passes when every package shares one version and both consumers pin nax-ai to it", () => {
    expect(lockstepErrors(manifests())).toEqual([]);
  });

  test("names every package when the versions differ", () => {
    const errors = lockstepErrors(manifests({ "packages/nax-ai": { name: "@nathapp/nax-ai", version: "0.1.16" } }));
    expect(errors.join("\n")).toContain("packages/nax-ai@0.1.16");
    expect(errors.join("\n")).toContain("packages/nax@0.84.0");
  });

  test.each(["0.83.9", "^0.84.0", "workspace:*", undefined])("rejects a nax-agent nax-ai pin of %p", (pin) => {
    const dependencies = pin === undefined ? {} : { "@nathapp/nax-ai": pin };
    const errors = lockstepErrors(
      manifests({ "packages/nax-agent": { name: "@nathapp/nax-agent", version: "0.84.0", dependencies } }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("packages/nax-agent");
  });

  test("checks the expected version when one is given", () => {
    expect(lockstepErrors(manifests(), "0.84.0")).toEqual([]);
    expect(lockstepErrors(manifests(), "0.84.1")[0]).toContain("0.84.1");
  });

  test("accepts a canary shared version and rejects a malformed one", () => {
    expect(lockstepErrors(withVersion(manifests(), "0.84.1-canary.1"))).toEqual([]);
    expect(lockstepErrors(withVersion(manifests(), "bad")).join("\n")).toContain('invalid shared version "bad"');
  });
});

describe("withVersion", () => {
  test("moves every package and both nax-ai pins, and leaves everything else alone", () => {
    const before = manifests();
    const after = withVersion(before, "0.85.0");
    expect([...after.values()].map((m) => m.version)).toEqual(["0.85.0", "0.85.0", "0.85.0", "0.85.0"]);
    expect(after.get("packages/nax-agent")?.dependencies).toEqual({ "@nathapp/nax-ai": "0.85.0", zod: "4.0.0" });
    expect(after.get("packages/nax-agent-acp")?.peerDependencies).toEqual({ "@nathapp/nax-agent": "workspace:*" });
    expect(lockstepErrors(after)).toEqual([]);
    expect(before.get("packages/nax")?.version).toBe("0.84.0");
  });

  test("keeps key order, so a bump is a one-line diff per field", () => {
    expect(Object.keys(withVersion(manifests(), "0.85.0").get("packages/nax-agent") ?? {})).toEqual([
      "name",
      "version",
      "dependencies",
    ]);
  });
});

describe("the real workspace", () => {
  test("is in lockstep", () => {
    expect(lockstepErrors(readManifests(ROOT))).toEqual([]);
  });

  test("every manifest round-trips through the release writer byte for byte", () => {
    for (const { dir } of LOCKSTEP_PACKAGES) {
      const text = readFileSync(join(ROOT, dir, "package.json"), "utf8");
      expect(`${JSON.stringify(JSON.parse(text), null, 2)}\n`).toBe(text);
    }
  });
});

describe("check-lockstep CLI", () => {
  test("reads --expect", () => {
    expect(expectedVersion(["bun", "check-lockstep.ts", "--expect=0.84.0"])).toBe("0.84.0");
    expect(expectedVersion(["bun", "check-lockstep.ts"])).toBeUndefined();
  });

  test("fails when the expected version is not the shared one", () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "packages/repo-tooling/scripts/check-lockstep.ts"), "--expect=0.0.1"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.0.1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/check-lockstep.test.ts`
Expected: FAIL. `#scripts/check-lockstep` and `#scripts/lib/lockstep` cannot be resolved.

- [ ] **Step 3: Write the lockstep library**

Create `packages/repo-tooling/scripts/lib/lockstep.ts`:

```ts
/**
 * Lockstep versioning: the four published nax packages always share one version,
 * released by one PR and one `vX.Y.Z` tag. LOCKSTEP_PACKAGES is publish order:
 * each package's runtime dependencies come before it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockstepPackage {
  readonly dir: string;
  readonly name: string;
}

export const LOCKSTEP_PACKAGES: readonly LockstepPackage[] = [
  { dir: "packages/nax-ai", name: "@nathapp/nax-ai" },
  { dir: "packages/nax-agent", name: "@nathapp/nax-agent" },
  { dir: "packages/nax-agent-acp", name: "@nathapp/nax-agent-acp" },
  { dir: "packages/nax", name: "@nathapp/nax" },
];

export const NAX_AI = "@nathapp/nax-ai";

/** Exact-pin consumers of nax-ai. nax reads its pin as the catalog version (src/agents/catalog/index.ts). */
export const NAX_AI_CONSUMERS: readonly string[] = ["packages/nax", "packages/nax-agent"];

/** Packages whose CHANGELOG.md holds per-release notes. nax uses GitHub Releases; nax-ai has no changelog. */
export const CHANGELOG_PACKAGES: readonly string[] = ["packages/nax-agent", "packages/nax-agent-acp"];

export interface Manifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

/** Keyed by package dir, in LOCKSTEP_PACKAGES order. */
export type Manifests = ReadonlyMap<string, Manifest>;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function readManifests(root: string): Manifests {
  return new Map(
    LOCKSTEP_PACKAGES.map(({ dir }) => [dir, JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))]),
  );
}

export function writeManifests(root: string, manifests: Manifests): void {
  for (const [dir, manifest] of manifests) {
    writeFileSync(join(root, dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/** Every broken lockstep rule; empty when the workspace is releasable at one version. */
export function lockstepErrors(manifests: Manifests, expected?: string): string[] {
  const shared = manifests.get(LOCKSTEP_PACKAGES[0]?.dir ?? "")?.version ?? "";
  const versions = new Set([...manifests.values()].map((m) => m.version));
  const listed = [...manifests].map(([dir, m]) => `${dir}@${m.version}`).join(", ");
  const errors: string[] = [];
  if (versions.size !== 1) errors.push(`versions differ: ${listed} (bump every package in one PR)`);
  if (!SEMVER.test(shared)) errors.push(`invalid shared version "${shared}"`);
  if (expected !== undefined && shared !== expected) errors.push(`shared version ${shared} != expected ${expected}`);
  for (const dir of NAX_AI_CONSUMERS) {
    const pin = manifests.get(dir)?.dependencies?.[NAX_AI];
    if (pin !== shared) errors.push(`${dir}: ${NAX_AI} must be pinned to exactly ${shared}, found ${pin ?? "nothing"}`);
  }
  return errors;
}

/** New manifests at `next`, with the nax-ai pins moved too. Key order is kept, so the diff stays minimal. */
export function withVersion(manifests: Manifests, next: string): Manifests {
  return new Map([...manifests].map(([dir, manifest]) => [dir, bumped(dir, manifest, next)]));
}

function bumped(dir: string, manifest: Manifest, next: string): Manifest {
  if (!NAX_AI_CONSUMERS.includes(dir)) return { ...manifest, version: next };
  return { ...manifest, version: next, dependencies: { ...manifest.dependencies, [NAX_AI]: next } };
}
```

- [ ] **Step 4: Write the gate CLI**

Create `packages/repo-tooling/scripts/check-lockstep.ts`:

```ts
#!/usr/bin/env bun
/**
 * Gate: nax-ai, nax-agent, nax-agent-acp and nax share one version, and nax and
 * nax-agent pin @nathapp/nax-ai to exactly that version (lockstep versioning,
 * RELEASING.md). `--expect=X.Y.Z` also requires that version; the release
 * workflow passes the tag's version.
 */
import { resolve } from "node:path";
import { lockstepErrors, readManifests } from "#scripts/lib/lockstep";

const EXPECT = "--expect=";

export function expectedVersion(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(EXPECT))?.slice(EXPECT.length);
}

if (import.meta.main) {
  const errors = lockstepErrors(readManifests(resolve(import.meta.dir, "../../..")), expectedVersion(process.argv));
  for (const error of errors) console.error(`[FAIL] ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log("[OK] the published nax packages share one version");
}
```

- [ ] **Step 5: Run the test. Only the real-workspace lockstep test still fails**

Run: `cd packages/repo-tooling && bun test ./test/unit/scripts/check-lockstep.test.ts`
Expected: everything passes except `the real workspace > is in lockstep`. That test fails with `versions differ: packages/nax-ai@0.1.16, packages/nax-agent@0.3.1, ...`.

If `every manifest round-trips` fails, that `package.json` is not stringify-stable. Rewrite it once with `JSON.stringify(parsed, null, 2) + "\n"` as part of this task, and note the file in the commit body. Every earlier per-package release script already wrote manifests this way, so this is not expected to happen.

- [ ] **Step 6: Align the four packages to 0.84.0**

From the repo root:

```bash
bun -e 'import { readManifests, withVersion, writeManifests } from "./packages/repo-tooling/scripts/lib/lockstep.ts"; writeManifests(".", withVersion(readManifests("."), "0.84.0"));'
bun install
git diff --stat
```

Expected: `git diff --stat` lists exactly the four `package.json` files (each with `version`; nax and nax-agent also with the nax-ai pin) and `bun.lock`.

- [ ] **Step 7: Replace the nax-ai pin gate with the lockstep gate**

In `packages/nax/package.json`:
- In `lint:checks`, replace `bun run check:nax-ai-pin` with `bun run check:lockstep`.
- Replace the line `"check:nax-ai-pin": "bun run scripts/check-nax-ai-pin.ts",` with `"check:lockstep": "bun run ../repo-tooling/scripts/check-lockstep.ts",`.

Then:

```bash
git rm packages/nax/scripts/check-nax-ai-pin.ts packages/nax/test/unit/scripts/check-nax-ai-pin.test.ts
git grep -n "nax-ai-pin\|checkNaxAiPin" -- ':!docs/superpowers/**' ':!.superpowers/**'
```

Expected: the grep prints only `.nax/context.md`, the generated agent files and `.github/workflows/release.yml`. Tasks 3 and 4 rewrite those.

- [ ] **Step 8: Run the gates**

```bash
cd packages/repo-tooling && bun test ./test/unit/scripts/check-lockstep.test.ts && bun run typecheck && bun run check:all
cd ../nax && bun run check:lockstep && bun run check:gate-reachability && bun run typecheck
```

Expected: all PASS. `check:lockstep` prints `[OK] the published nax packages share one version`.

- [ ] **Step 9: Commit**

```bash
git add packages/repo-tooling/scripts/lib/lockstep.ts packages/repo-tooling/scripts/check-lockstep.ts \
  packages/repo-tooling/test/unit/scripts/check-lockstep.test.ts packages/nax/package.json \
  packages/nax-ai/package.json packages/nax-agent/package.json packages/nax-agent-acp/package.json bun.lock
git commit -m "chore(release): lockstep gate and align every published package to 0.84.0"
```

---

### Task 2: One release command

**Files:**
- Move: `packages/nax-agent/scripts/lib/release-version.ts` → `packages/repo-tooling/scripts/lib/release-version.ts`
- Move: `packages/nax-agent/test/unit/packaging/release-version.test.ts` → `packages/repo-tooling/test/unit/release/release-version.test.ts`
- Create: `packages/repo-tooling/scripts/release.ts`
- Create: `packages/repo-tooling/test/helpers/release-cli-fixture.ts`
- Create: `packages/repo-tooling/test/unit/release/release-cli.test.ts`
- Modify: root `package.json`; `packages/nax/package.json`, `packages/nax-ai/package.json`, `packages/nax-agent/package.json` (drop `release` scripts)
- Delete: `packages/{nax,nax-ai,nax-agent}/scripts/release.ts`, `packages/nax-agent/test/helpers/release-cli-fixture.ts`, `packages/nax-agent/test/unit/packaging/release-cli.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `release-version.ts` keeps `bumpVersion`, `distTagsFor`, `compareVersions`, `updateChangelog` and adds `NO_CHANGES: string`, `nextSharedVersion(current: string, kind: string): string` and `stampChangelog(text: string, version: string, date: string): string`
  - Root command `bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z|tag>`

- [ ] **Step 1: Move the version library and its test**

```bash
mkdir -p packages/repo-tooling/test/unit/release
git mv packages/nax-agent/scripts/lib/release-version.ts packages/repo-tooling/scripts/lib/release-version.ts
git mv packages/nax-agent/test/unit/packaging/release-version.test.ts packages/repo-tooling/test/unit/release/release-version.test.ts
```

In the moved test, replace these two lines:

```ts
// biome-ignore lint/style/noRestrictedImports: release decisions are script helpers, outside the source surface
import { bumpVersion, compareVersions, distTagsFor, updateChangelog } from "../../../scripts/lib/release-version.ts";
```

with:

```ts
import {
  bumpVersion,
  compareVersions,
  distTagsFor,
  NO_CHANGES,
  nextSharedVersion,
  stampChangelog,
  updateChangelog,
} from "#scripts/lib/release-version";
```

- [ ] **Step 2: Write the failing version and changelog tests**

Append to `packages/repo-tooling/test/unit/release/release-version.test.ts`:

```ts
describe("next shared version", () => {
  test.each([
    ["0.84.0", "patch", "0.84.1"],
    ["0.84.0", "minor", "0.85.0"],
    ["0.84.0", "canary", "0.84.1-canary.1"],
    ["0.84.0", "0.90.0", "0.90.0"],
  ])("%s %s becomes %s", (current, kind, expected) => expect(nextSharedVersion(current, kind)).toBe(expected));

  test.each(["0.84.0", "0.83.9", "0.84.0-canary.1"])("refuses %s, which is not above 0.84.0", (kind) => {
    expect(() => nextSharedVersion("0.84.0", kind)).toThrow(/above/);
  });

  test("refuses a prerelease the release workflow would not accept", () => {
    expect(() => nextSharedVersion("0.84.0", "0.85.0-rc.1")).toThrow(/X\.Y\.Z-canary\.N/);
  });
});

describe("lockstep release notes", () => {
  const dated = `# Changelog\n\n## [0.84.1] - 2026-10-10\n\n${NO_CHANGES}\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n`;

  test("dates real Unreleased notes exactly like updateChangelog", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n- New.\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n";
    expect(stampChangelog(text, "0.84.1", "2026-10-10")).toBe(updateChangelog(text, "0.84.1", "2026-10-10"));
  });

  test("an empty Unreleased heading becomes a dated no-changes entry", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n";
    expect(stampChangelog(text, "0.84.1", "2026-10-10")).toBe(dated);
  });

  test("no pending heading puts the entry above the newest release", () => {
    expect(stampChangelog("# Changelog\n\n## [0.84.0] - 2026-10-09\n\n- Old.\n", "0.84.1", "2026-10-10")).toBe(dated);
  });

  test("a changelog with no releases gets the entry appended", () => {
    expect(stampChangelog("# Changelog\n", "0.84.1", "2026-10-10")).toBe(
      `# Changelog\n\n## [0.84.1] - 2026-10-10\n\n${NO_CHANGES}\n`,
    );
  });

  test("refuses an already-dated version and ambiguous notes", () => {
    expect(() => stampChangelog("## [0.84.1] - 2026-10-09\n\n- x\n", "0.84.1", "2026-10-10")).toThrow(/already/);
    expect(() => stampChangelog("## [Unreleased]\nA\n## [Unreleased]\nB\n", "0.84.1", "2026-10-10")).toThrow();
  });
});
```

Run: `cd packages/repo-tooling && bun test ./test/unit/release/release-version.test.ts`
Expected: FAIL. `NO_CHANGES`, `nextSharedVersion` and `stampChangelog` are not exported.

- [ ] **Step 3: Implement them in `release-version.ts`**

In `packages/repo-tooling/scripts/lib/release-version.ts`, add after the `Version` interface:

```ts
/** The heading shape every changelog uses: `## [<version or Unreleased>]` with an optional ` - <date or Unreleased>`. */
const HEADING = /^## \[([^\]]+)\](?: - ([^\n]+))?$/gm;

/** The release workflow accepts stable and canary versions only (.github/workflows/release.yml, resolve job). */
const RELEASABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-canary\.[1-9]\d*)?$/;

export const NO_CHANGES = "- No changes in this package. Released in lockstep with the other nax packages.";
```

In `updateChangelog`, replace `const headings = [...text.matchAll(/^## \[([^\]]+)\](?: - ([^\n]+))?$/gm)];` with `const headings = [...text.matchAll(HEADING)];`.

Append:

```ts
/** The next lockstep version: releasable by the workflow and above the current shared version. */
export function nextSharedVersion(current: string, kind: string): string {
  const next = bumpVersion(current, kind);
  if (!RELEASABLE.test(next)) throw new Error(`${next} is not releasable: use X.Y.Z or X.Y.Z-canary.N`);
  if (compareVersions(next, current) <= 0) throw new Error(`${next} must be above the current version ${current}`);
  return next;
}

/**
 * Lockstep releases every package, so a package without notes still gets a dated
 * "no changes" entry. Real notes go through updateChangelog, which keeps its
 * ambiguity checks.
 */
export function stampChangelog(text: string, version: string, date: string): string {
  const headings = [...text.matchAll(HEADING)];
  if (headings.some((h) => h[1] === version && h[2] !== "Unreleased")) {
    throw new Error(`Changelog already has a dated ${version} entry`);
  }
  const pending = headings.filter((h) => h[1] === "Unreleased" || h[1] === version);
  if (pending.length > 1) return updateChangelog(text, version, date);
  const heading = pending[0];
  if (heading === undefined) return insertEntry(text, headings[0]?.index, version, date);
  const end = headings.find((h) => h.index > heading.index)?.index;
  if (text.slice(heading.index + heading[0].length, end ?? text.length).trim()) {
    return updateChangelog(text, version, date);
  }
  const without = text.slice(0, heading.index) + text.slice(end ?? text.length);
  return insertEntry(without, end === undefined ? undefined : heading.index, version, date);
}

function insertEntry(text: string, at: number | undefined, version: string, date: string): string {
  const entry = `## [${version}] - ${date}\n\n${NO_CHANGES}\n`;
  if (at === undefined) return `${text.trimEnd()}\n\n${entry}`;
  return `${text.slice(0, at)}${entry}\n${text.slice(at)}`;
}
```

Run: `cd packages/repo-tooling && bun test ./test/unit/release/release-version.test.ts`
Expected: PASS (old and new tests).

- [ ] **Step 4: Write the release CLI fixture**

Create `packages/repo-tooling/test/helpers/release-cli-fixture.ts`:

```ts
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const TOOLING = new URL("../../", import.meta.url);
const VERSION = "0.84.0";

const MANIFESTS: Record<string, Record<string, unknown>> = {
  "packages/nax-ai": { name: "@nathapp/nax-ai", version: VERSION },
  "packages/nax-agent": { name: "@nathapp/nax-agent", version: VERSION, dependencies: { "@nathapp/nax-ai": VERSION } },
  "packages/nax-agent-acp": {
    name: "@nathapp/nax-agent-acp",
    version: VERSION,
    peerDependencies: { "@nathapp/nax-agent": "workspace:*" },
  },
  "packages/nax": { name: "@nathapp/nax", version: VERSION, dependencies: { "@nathapp/nax-ai": VERSION } },
};

const STUBS: Record<string, string> = {
  git: `case "$1" in
  pull) exit 0 ;;
  push) exit "\${FAIL_PUSH:-0}" ;;
  *) exec /usr/bin/git "$@" ;;
esac`,
  bun: `if [ "$*" != "install" ]; then exit 1; fi
echo refreshed >> bun.lock`,
  gh: `while [ "$#" -gt 0 ]; do
  if [ "$1" = "--body-file" ]; then cp "$2" "$PR_BODY"; break; fi
  shift
done
echo 'https://example.invalid/pr/1'`,
  npm: `echo "${VERSION}"`,
};

export interface ReleaseCliFixture {
  dir: string;
  git: (...args: string[]) => string;
  write: (path: string, text: string) => void;
  run: (
    args: readonly string[],
    input?: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[] };
}

/** A temp git repo holding the four lockstep packages and a copy of the release command, with git/bun/gh/npm stubbed. */
export function makeReleaseCliFixture(): ReleaseCliFixture {
  const dir = makeTempDir("release-cli-");
  const tooling = join(dir, "packages/repo-tooling");
  mkdirSync(join(tooling, "scripts/lib"), { recursive: true });
  for (const file of ["package.json", "scripts/release.ts", "scripts/lib/lockstep.ts", "scripts/lib/release-version.ts"]) {
    cpSync(new URL(file, TOOLING), join(tooling, file));
  }
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [pkg, manifest] of Object.entries(MANIFESTS)) {
    write(`${pkg}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  write(
    "packages/nax-agent/CHANGELOG.md",
    "# Changelog\n\n## [Unreleased]\n\n- New tools.\n\n## [0.84.0] - 2026-10-09\n\n- Lockstep.\n",
  );
  write("packages/nax-agent-acp/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.84.0] - 2026-10-09\n\n- Lockstep.\n");
  write("bun.lock", "lockfile\n");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
  const bin = join(dir, "ignored-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$CALL_LOG"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  // Runtime logs must not make the fixture repository dirty.
  writeFileSync(join(dir, ".git/info/exclude"), "/ignored-bin/\n/calls\n/pr-body\n");
  return {
    dir,
    git,
    write,
    run(args, input = "", extraEnv = {}) {
      writeFileSync(join(dir, "calls"), "");
      const result = spawnSync(process.execPath, [join(tooling, "scripts/release.ts"), ...args], {
        cwd: dir,
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: bin,
          CALL_LOG: join(dir, "calls"),
          PR_BODY: join(dir, "pr-body"),
          ...extraEnv,
        },
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean),
      };
    },
  };
}
```

- [ ] **Step 5: Write the failing CLI tests**

Create `packages/repo-tooling/test/unit/release/release-cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { NO_CHANGES } from "#scripts/lib/release-version";
import { makeReleaseCliFixture, type ReleaseCliFixture } from "../../helpers/release-cli-fixture";

const MUTATING = /^(gh |bun |npm |git (pull|push|add|commit|checkout)\b|git tag (?!--list))/;

function withFixture(fn: (f: ReleaseCliFixture) => void): void {
  const f = makeReleaseCliFixture();
  try {
    fn(f);
  } finally {
    cleanupTempDir(f.dir);
  }
}

describe("release command", () => {
  test.each([["--dry-run", "patch"], ["--dry-run", "tag"], ["patch"], ["tag"]])(
    "%s %s leaves local and remote state unchanged without confirmation",
    (...args) =>
      withFixture((f) => {
        const before = f.git("rev-parse", "HEAD");
        const result = f.run(args, "n\n");
        expect(result.status).toBe(0);
        expect(f.git("rev-parse", "HEAD")).toBe(before);
        expect(f.git("status", "--porcelain")).toBe("");
        expect(f.git("tag", "--list")).toBe("");
        expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
      }),
  );

  test("a confirmed bump moves all four packages, both pins and both changelogs in one PR, without tagging", () =>
    withFixture((f) => {
      const result = f.run(["patch"], "y\n");
      expect(result.status).toBe(0);
      const branch = "release/v0.84.1";
      expect(f.git("diff", "--name-only", "main", branch).split("\n")).toEqual([
        "bun.lock",
        "packages/nax-agent-acp/CHANGELOG.md",
        "packages/nax-agent-acp/package.json",
        "packages/nax-agent/CHANGELOG.md",
        "packages/nax-agent/package.json",
        "packages/nax-ai/package.json",
        "packages/nax/package.json",
      ]);
      for (const pkg of ["nax-ai", "nax-agent", "nax-agent-acp", "nax"]) {
        expect(JSON.parse(f.git("show", `${branch}:packages/${pkg}/package.json`)).version).toBe("0.84.1");
      }
      for (const pkg of ["nax-agent", "nax"]) {
        const deps = JSON.parse(f.git("show", `${branch}:packages/${pkg}/package.json`)).dependencies;
        expect(deps["@nathapp/nax-ai"]).toBe("0.84.1");
      }
      expect(f.git("show", `${branch}:packages/nax-agent/CHANGELOG.md`)).toMatch(
        /## \[0\.84\.1\] - \d{4}-\d{2}-\d{2}\n\n- New tools\./,
      );
      expect(f.git("show", `${branch}:packages/nax-agent-acp/CHANGELOG.md`)).toContain(NO_CHANGES);
      expect(f.git("tag", "--list")).toBe("");
      expect(f.git("branch", "--show-current")).toBe("main");
      const pr = result.calls.find((call) => call.startsWith("gh pr create"));
      expect(pr).toContain("--head release/v0.84.1");
      expect(readFileSync(join(f.dir, "pr-body"), "utf8")).toContain("0.84.0 -> 0.84.1");
    }));

  test("a failed push stops before the PR is opened", () =>
    withFixture((f) => {
      const result = f.run(["patch"], "y\n", { FAIL_PUSH: "9" });
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => call.startsWith("gh "))).toBe(false);
    }));

  test("refuses to bump a workspace that is out of lockstep, before touching git", () =>
    withFixture((f) => {
      f.write("packages/nax-ai/package.json", `${JSON.stringify({ name: "@nathapp/nax-ai", version: "0.1.16" }, null, 2)}\n`);
      f.git("commit", "-am", "drift");
      const result = f.run(["patch"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("versions differ");
      expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }));

  test.each(["0.84.0", "0.83.9", "0.85.0-rc.1"])("refuses explicit version %s", (version) =>
    withFixture((f) => {
      const result = f.run([version], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }));

  test("dry runs name the tag, the dist-tag and every package", () =>
    withFixture((f) => {
      const minor = f.run(["--dry-run", "minor"]).output;
      expect(minor).toContain("v0.85.0");
      expect(minor).toContain("latest");
      expect(f.run(["--dry-run", "canary"]).output).toContain("canary");
      const tag = f.run(["--dry-run", "tag"]).output;
      for (const name of ["@nathapp/nax-ai", "@nathapp/nax-agent", "@nathapp/nax-agent-acp", "@nathapp/nax"]) {
        expect(tag).toContain(name);
      }
      expect(tag).toContain("v0.84.0");
    }));

  test.each(["dirty", "non-main", "existing-tag"])("tag rejects a %s checkout before creating or pushing a tag", (condition) =>
    withFixture((f) => {
      if (condition === "dirty") writeFileSync(join(f.dir, "untracked"), "changes");
      if (condition === "non-main") f.git("checkout", "-b", "feature");
      if (condition === "existing-tag") f.git("tag", "v0.84.0");
      const result = f.run(["tag"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => /^git (push|tag v)/.test(call))).toBe(false);
    }));

  test("a confirmed tag pushes vX.Y.Z only", () =>
    withFixture((f) => {
      const result = f.run(["tag"], "y\n");
      expect(result.status).toBe(0);
      expect(f.git("tag", "--list")).toBe("v0.84.0");
      expect(result.calls).toContain("git push origin v0.84.0");
    }));
});
```

Run: `cd packages/repo-tooling && bun test ./test/unit/release/release-cli.test.ts`
Expected: FAIL. `scripts/release.ts` does not exist, so the fixture's `cpSync` throws ENOENT.

- [ ] **Step 6: Write the release command**

Create `packages/repo-tooling/scripts/release.ts`:

```ts
#!/usr/bin/env bun
/**
 * release.ts - one release for every published nax package (lockstep versioning).
 *
 * From the repo root:
 *   bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z>
 *     Bumps nax-ai, nax-agent, nax-agent-acp and nax to one version, pins
 *     @nathapp/nax-ai to it, dates the changelogs, refreshes bun.lock, opens a PR.
 *   bun run release [--dry-run] tag
 *     On clean main, pushes vX.Y.Z; .github/workflows/release.yml then publishes
 *     all four packages in dependency order.
 *
 * PR-first: pushing the tag is always a separately confirmed action. See RELEASING.md.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CHANGELOG_PACKAGES,
  LOCKSTEP_PACKAGES,
  lockstepErrors,
  type Manifests,
  readManifests,
  withVersion,
  writeManifests,
} from "#scripts/lib/lockstep";
import { distTagsFor, nextSharedVersion, stampChangelog } from "#scripts/lib/release-version";

const REPO = resolve(import.meta.dir, "../../..");
const NAMES = LOCKSTEP_PACKAGES.map((p) => p.name).join(", ");

interface ReleasePlan {
  readonly current: string;
  readonly next: string;
  readonly tag: string;
  readonly branch: string;
  readonly manifests: Manifests;
  readonly changelogs: ReadonlyMap<string, string>;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requireCleanMain(): void {
  if (git("branch", "--show-current") !== "main") throw new Error("Must be on main to release");
  if (git("status", "--porcelain")) throw new Error("Working tree is dirty; commit or stash changes first");
}

function rejectExistingTag(tag: string): void {
  if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists`);
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.once("close", () => resolveAnswer(false));
    rl.question(`${message} [y/N] `, (answer) => {
      resolveAnswer(answer.trim().toLowerCase() === "y");
      rl.close();
    });
  });
}

/** The current shared version; refuses a workspace that is out of lockstep. */
function sharedVersion(manifests: Manifests): string {
  const errors = lockstepErrors(manifests);
  if (errors.length > 0) throw new Error(`Packages are not in lockstep:\n${errors.join("\n")}`);
  return manifests.get(LOCKSTEP_PACKAGES[0]?.dir ?? "")?.version ?? "";
}

function readChangelogs(): ReadonlyMap<string, string> {
  return new Map(CHANGELOG_PACKAGES.map((dir) => [dir, readFileSync(join(REPO, dir, "CHANGELOG.md"), "utf8")]));
}

function snapshot(manifests: Manifests, changelogs: ReadonlyMap<string, string>): string {
  return JSON.stringify([[...manifests], [...changelogs]]);
}

function planRelease(kind: string): ReleasePlan {
  const manifests = readManifests(REPO);
  const current = sharedVersion(manifests);
  const next = nextSharedVersion(current, kind);
  return { current, next, tag: `v${next}`, branch: `release/v${next}`, manifests, changelogs: readChangelogs() };
}

function describePlan(plan: ReleasePlan): void {
  console.log(
    [
      `nax packages: ${plan.current} -> ${plan.next}`,
      `Packages: ${NAMES}`,
      `Tag: ${plan.tag}`,
      `Branch: ${plan.branch}`,
      `Dist-tag: ${distTagsFor(plan.next).join(" + ")}`,
    ].join("\n"),
  );
}

function writeRelease(plan: ReleasePlan, notes: ReadonlyMap<string, string>): void {
  writeManifests(REPO, withVersion(plan.manifests, plan.next));
  for (const [dir, text] of notes) writeFileSync(join(REPO, dir, "CHANGELOG.md"), text);
  execFileSync("bun", ["install"], { cwd: REPO, stdio: "inherit" });
  git(
    "add",
    "bun.lock",
    ...LOCKSTEP_PACKAGES.map((p) => `${p.dir}/package.json`),
    ...CHANGELOG_PACKAGES.map((dir) => `${dir}/CHANGELOG.md`),
  );
  git("commit", "-m", `chore: release ${plan.tag}`);
}

function openPullRequest(plan: ReleasePlan): void {
  const temp = mkdtempSync(join(tmpdir(), "nax-release-"));
  try {
    const bodyFile = join(temp, "pr-body.md");
    writeFileSync(
      bodyFile,
      `Bumps every published nax package: ${plan.current} -> ${plan.next}\n${LOCKSTEP_PACKAGES.map((p) => `- ${p.name}`).join("\n")}\nPublishes under: ${distTagsFor(plan.next).join(" + ")}\n\nAfter review and merge, run from the repo root on clean main:\n\n\`\`\`sh\nbun run release tag\n\`\`\`\n`,
    );
    execFileSync(
      "gh",
      ["pr", "create", "--title", `chore: release ${plan.tag}`, "--body-file", bodyFile, "--base", "main", "--head", plan.branch, "--label", "skip-changelog"],
      { cwd: REPO, stdio: "inherit" },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function bumpRelease(kind: string, dryRun: boolean): Promise<void> {
  const plan = planRelease(kind);
  describePlan(plan);
  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const notes = new Map([...plan.changelogs].map(([dir, text]) => [dir, stampChangelog(text, plan.next, today)]));
  requireCleanMain();
  rejectExistingTag(plan.tag);
  if (!(await confirm("Prepare and push the release PR? This does not publish."))) {
    console.log("Aborted.");
    return;
  }
  git("pull", "--ff-only", "origin", "main");
  requireCleanMain();
  if (snapshot(readManifests(REPO), readChangelogs()) !== snapshot(plan.manifests, plan.changelogs)) {
    throw new Error("Release inputs changed after pull; rerun to review the new release plan");
  }
  git("checkout", "-b", plan.branch);
  writeRelease(plan, notes);
  git("push", "-u", "origin", plan.branch);
  openPullRequest(plan);
  git("checkout", "main");
  console.log("Review and merge the PR, then separately confirm `bun run release tag` on clean main.");
}

async function tagRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = sharedVersion(readManifests(REPO));
  const tag = `v${version}`;
  rejectExistingTag(tag);
  console.log(`${tag}: publishes ${NAMES} at ${version} under ${distTagsFor(version).join(" + ")}`);
  if (dryRun) {
    console.log("Dry run; no tag created or pushed.");
    return;
  }
  if (!(await confirm(`Push ${tag}? This publishes all four packages to npm.`))) {
    console.log("Aborted.");
    return;
  }
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/nax/actions`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const kinds = args.filter((arg) => arg !== "--dry-run");
  if (kinds.length !== 1) {
    throw new Error("Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>");
  }
  if (kinds[0] === "tag") await tagRelease(dryRun);
  else await bumpRelease(kinds[0] ?? "", dryRun);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

Run `bun x biome check --write scripts/ test/` from `packages/repo-tooling` to apply the repo's line-width formatting to the long `gh` argument array.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/repo-tooling && bun test ./test/unit/release/`
Expected: PASS.

- [ ] **Step 8: Rewire the scripts and delete the per-package release tools**

Root `package.json`: replace

```json
    "release:nax": "bun run --cwd packages/nax release",
    "release:nax-ai": "bun run --cwd packages/nax-ai release"
```

with

```json
    "release": "bun packages/repo-tooling/scripts/release.ts"
```

Delete the line `"release": "bun scripts/release.ts",` from `packages/nax/package.json`, `packages/nax-ai/package.json` and `packages/nax-agent/package.json`. Then:

```bash
git rm packages/nax/scripts/release.ts packages/nax-ai/scripts/release.ts packages/nax-agent/scripts/release.ts \
  packages/nax-agent/test/helpers/release-cli-fixture.ts packages/nax-agent/test/unit/packaging/release-cli.test.ts
git grep -n "release-cli-fixture\|scripts/release.ts\|lib/release-version\|release:nax" -- ':!docs/superpowers/**' ':!.superpowers/**'
```

Expected: the grep shows only the new repo-tooling files and `packages/nax-agent/test/unit/packaging/release-workflow.test.ts`, which imports the deleted `release-cli-fixture`. Delete that test too, so this commit is green on its own. Task 3 writes its replacement in repo-tooling:

```bash
git rm packages/nax-agent/test/unit/packaging/release-workflow.test.ts
```

`packages/nax-agent/test/helpers/release-shell.ts` now has no importer. It stays for Task 3 Step 1, which moves it.

- [ ] **Step 9: Run the gates**

```bash
cd packages/repo-tooling && bun run test && bun run typecheck && bun run check:all
cd ../nax-agent && bun run check:all && bun run typecheck && bun run test
cd ../nax-ai && bun run check:all && bun run typecheck
cd ../nax && bun run check:all
```

Expected: all PASS. If `check:complexity` in repo-tooling flags a function in `release.ts` or `release-version.ts`, split it. Do not add it to the baseline.

- [ ] **Step 10: Commit**

```bash
git add -A packages/repo-tooling package.json packages/nax/package.json packages/nax-ai/package.json packages/nax-agent
git commit -m "chore(release): one lockstep release command replaces the per-package scripts"
```

---

### Task 3: One tag publishes all four packages

**Files:**
- Create: `.github/actions/publish-package/action.yml`
- Rewrite: `.github/workflows/release.yml`
- Move + adapt: `packages/nax-agent/test/helpers/release-shell.ts` → `packages/repo-tooling/test/helpers/release-shell.ts`
- Create: `packages/repo-tooling/test/unit/release/release-workflow.test.ts`
- Delete: `packages/repo-tooling/scripts/verify-bootstrap.ts`, `packages/repo-tooling/scripts/lib/bootstrap-artifact.ts`, `packages/repo-tooling/test/unit/scripts/verify-bootstrap.test.ts`, `packages/repo-tooling/test/unit/scripts/bootstrap-artifact.test.ts`

**Interfaces:**
- Consumes: `LOCKSTEP_PACKAGES` (Task 1); `bun packages/repo-tooling/scripts/check-lockstep.ts --expect=X.Y.Z` (Task 1).
- Produces: composite action inputs `name`, `dir`, `version`, `npm_tag`; `resolve` job outputs `tag`, `version`, `npm_tag`, `prerelease`, `notify`.

Every `run:` body reads its inputs from `env:`, never from an inline `${{ }}` expression. This closes the expression-injection class, and it lets the harness run each body as written.

- [ ] **Step 1: Move and adapt the step harness**

```bash
mkdir -p packages/repo-tooling/test/helpers
git mv packages/nax-agent/test/helpers/release-shell.ts packages/repo-tooling/test/helpers/release-shell.ts
```

Replace the whole file with:

```ts
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

export interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  if?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}

export interface WorkflowJob {
  needs?: string | string[];
  environment?: string;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

const REPO = new URL("../../../../", import.meta.url);

export const releaseWorkflow = Bun.YAML.parse(
  readFileSync(new URL(".github/workflows/release.yml", REPO), "utf8"),
) as { on: { push: { tags: string[] } }; jobs: Record<string, WorkflowJob> };

export const publishAction = Bun.YAML.parse(
  readFileSync(new URL(".github/actions/publish-package/action.yml", REPO), "utf8"),
) as { inputs: Record<string, unknown>; runs: { using: string; steps: WorkflowStep[] } };

export function allSteps(): WorkflowStep[] {
  return [...Object.values(releaseWorkflow.jobs).flatMap((job) => job.steps), ...publishAction.runs.steps];
}

export function releaseStep(name: string): WorkflowStep {
  const step = allSteps().find((candidate) => candidate.name === name);
  if (!step) throw new Error(`No release step ${name}`);
  return step;
}

const STUB = `#!/bin/sh
echo "\${0##*/} $*" >> "$CALL_LOG"
if [ "\${0##*/}" = bun ]; then
  if [ "$*" = "$BUN_FAIL" ]; then exit 7; fi
  exit 0
fi
case "$1" in
  --version) echo "\${NPM_VERSION:-11.5.1}" ;;
  view)
    if [ -n "$NPM_ERROR" ]; then
      echo "{\\"error\\":{\\"code\\":\\"$NPM_ERROR\\"}}"
      exit 1
    fi
    if [ -n "$NPM_VIEW_EMPTY" ]; then exit 0; fi
    echo "\\"\${NPM_VIEW_VERSION:-0.84.0}\\""
    ;;
  publish) exit "\${NPM_PUBLISH_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`;

export interface ReleaseShell {
  dir: string;
  run: (
    name: string,
    env?: Record<string, string>,
  ) => { status: number | null; output: string; calls: string[]; values: string };
}

/** Runs one release step's shell body in a temp package dir, with stub bun and npm on PATH. */
export function makeReleaseShell(opts: { manifest?: Record<string, unknown> } = {}): ReleaseShell {
  const dir = makeTempDir("release-shell-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".publish"));
  const manifest = opts.manifest ?? {
    version: "0.84.0",
    dependencies: { "@nathapp/nax-ai": "0.84.0" },
    publishConfig: { tag: "latest" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, ".publish/package.json"), JSON.stringify(manifest));
  for (const command of ["bun", "npm"]) {
    writeFileSync(join(bin, command), STUB);
    chmodSync(join(bin, command), 0o755);
  }
  return {
    dir,
    run(name, env = {}) {
      const body = releaseStep(name).run;
      if (!body) throw new Error(`No shell body for ${name}`);
      if (body.includes("${{")) throw new Error(`${name} interpolates an expression; read it from env instead`);
      const output = join(dir, "output");
      const calls = join(dir, "calls");
      writeFileSync(output, "");
      writeFileSync(calls, "");
      const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: calls,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: dir,
          NAME: "@nathapp/nax-agent",
          VERSION: "0.84.0",
          TAG: "v0.84.0",
          NPM_TAG: "latest",
          ...env,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
        values: readFileSync(output, "utf8"),
      };
    },
  };
}
```

- [ ] **Step 2: Write the failing workflow tests**

Create `packages/repo-tooling/test/unit/release/release-workflow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { LOCKSTEP_PACKAGES } from "#scripts/lib/lockstep";
import {
  allSteps,
  makeReleaseShell,
  publishAction,
  type ReleaseShell,
  releaseStep,
  releaseWorkflow,
} from "../../helpers/release-shell";

const ACTION = "./.github/actions/publish-package";
const AGENT_GATES = [
  "bun run check:all",
  "bun run typecheck",
  "bun run build",
  "bun run check:api",
  "bun run test:coverage",
  "bun run test:node",
  "bun run stage-publish",
];

function withShell<T>(fn: (shell: ReleaseShell) => T, opts?: { manifest?: Record<string, unknown> }): T {
  const shell = makeReleaseShell(opts);
  try {
    return fn(shell);
  } finally {
    cleanupTempDir(shell.dir);
  }
}

const publishJobs = Object.entries(releaseWorkflow.jobs).filter(([, job]) =>
  job.steps.some((step) => step.uses === ACTION),
);

describe("triggers and job graph", () => {
  test("only vX.Y.Z and vX.Y.Z-canary.N tags trigger a release", () => {
    expect(releaseWorkflow.on.push.tags).toEqual(["v*.*.*", "v*.*.*-canary.*"]);
  });

  test("publish jobs follow lockstep publish order, each needing the previous one", () => {
    const names = publishJobs.map(([, job]) => job.steps.find((step) => step.uses === ACTION)?.with?.name);
    expect(names).toEqual(LOCKSTEP_PACKAGES.map((p) => p.name));
    const ids = publishJobs.map(([id]) => id);
    for (const [i, id] of ids.entries()) {
      const needs = [releaseWorkflow.jobs[id]?.needs].flat();
      expect(needs).toContain("resolve");
      if (i > 0) expect(needs).toContain(ids[i - 1]);
    }
    expect([releaseWorkflow.jobs["github-release"]?.needs].flat()).toContain(ids.at(-1));
  });

  test.each(LOCKSTEP_PACKAGES.map((p) => [p.name, p.dir]))(
    "%s publishes from %s in the npm environment at the tagged commit",
    (name, dir) => {
      const job = publishJobs.find(([, j]) => j.steps.some((step) => step.with?.name === name))?.[1];
      expect(job?.environment).toBe("npm");
      const checkout = job?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("refs/tags/${{ needs.resolve.outputs.tag }}");
      expect(job?.steps.find((step) => step.uses === ACTION)?.with).toEqual({
        name,
        dir,
        version: "${{ needs.resolve.outputs.version }}",
        npm_tag: "${{ needs.resolve.outputs.npm_tag }}",
      });
    },
  );

  test("no run body interpolates an expression, and composite run steps declare bash", () => {
    for (const step of allSteps().filter((s) => s.run !== undefined)) {
      expect(step.run).not.toContain("${{");
    }
    for (const step of publishAction.runs.steps.filter((s) => s.run !== undefined)) {
      expect(step.shell).toBe("bash");
    }
  });

  test("every step after the published check is skipped for a version already on npm", () => {
    const steps = publishAction.runs.steps;
    const at = steps.findIndex((step) => step.id === "published");
    expect(at).toBeGreaterThan(0);
    for (const step of steps.slice(at + 1)) {
      expect(step.if ?? "").toContain("steps.published.outputs.skip != 'true'");
    }
  });
});

describe("resolve", () => {
  test.each([
    ["v0.84.0", "0.84.0", "latest", "false", "true"],
    ["v0.84.1-canary.2", "0.84.1-canary.2", "canary", "true", "false"],
  ])("%s", (tag, version, npmTag, prerelease, notify) =>
    withShell((shell) => {
      const result = shell.run("Set release info", { TAG: tag });
      expect(result.status).toBe(0);
      expect(result.values).toBe(
        `tag=${tag}\nversion=${version}\nnpm_tag=${npmTag}\nprerelease=${prerelease}\nnotify=${notify}\n`,
      );
    }),
  );

  test.each(["nax-ai-v0.1.16", "nax-agent-v0.84.0", "v0.84", "v0.84.0-rc.1", "v0.84.0;echo bad", "0.84.0", "v01.2.3"])(
    "rejects %s",
    (tag) =>
      withShell((shell) => {
        const result = shell.run("Set release info", { TAG: tag });
        expect(result.status).not.toBe(0);
        expect(result.values).toBe("");
      }),
  );

  test("checks every package against the tag's version before any publish job", () => {
    expect(releaseStep("Packages share the tag's version").run).toContain(
      'bun packages/repo-tooling/scripts/check-lockstep.ts --expect="$VERSION"',
    );
  });
});

describe("publish-package action", () => {
  test("a version already on npm is skipped", () =>
    withShell((shell) => {
      const result = shell.run("Already on npm", { NAME: "@nathapp/nax-ai" });
      expect(result.status).toBe(0);
      expect(result.values).toBe("skip=true\n");
    }));

  test.each([{ NPM_VIEW_EMPTY: "1" }, { NPM_ERROR: "E404" }, { NPM_VIEW_VERSION: "0.83.7" }])(
    "an unpublished version is published (%j)",
    (env) =>
      withShell((shell) => {
        const result = shell.run("Already on npm", env);
        expect(result.status).toBe(0);
        expect(result.values).toBe("skip=false\n");
      }),
  );

  test.each(["E401", "ETIMEDOUT"])("a registry error %s stops the job", (code) =>
    withShell((shell) => {
      expect(shell.run("Already on npm", { NPM_ERROR: code }).status).not.toBe(0);
    }),
  );

  test.each([
    ["@nathapp/nax-ai", ["bun run lint", "bun run typecheck", "bun x vitest --run", "bun run build"]],
    ["@nathapp/nax-agent", AGENT_GATES],
    ["@nathapp/nax-agent-acp", AGENT_GATES],
    ["@nathapp/nax", ["bun run build"]],
  ])("%s runs its own gates", (name, gates) =>
    withShell((shell) => {
      const result = shell.run("Pre-publish checks", { NAME: name as string });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(gates as string[]);
    }),
  );

  test("the gates stop at the first failure", () =>
    withShell((shell) => {
      const result = shell.run("Pre-publish checks", { BUN_FAIL: "run build" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual(AGENT_GATES.slice(0, 3));
    }));

  test("nax-ai waits for nothing", () =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-ai" });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
    }));

  test.each(["@nathapp/nax", "@nathapp/nax-agent"])("%s waits for its exact nax-ai pin", (name) =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NAME: name });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["npm view @nathapp/nax-ai@0.84.0 version"]);
    }),
  );

  test("nax-agent-acp waits for the nax-agent version its staged peer names", () =>
    withShell(
      (shell) => {
        const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-agent-acp" });
        expect(result.status).toBe(0);
        expect(result.calls).toEqual(["npm view @nathapp/nax-agent@0.84.0 version"]);
      },
      { manifest: { version: "0.84.0", peerDependencies: { "@nathapp/nax-agent": "^0.84.0" } } },
    ));

  test("a staged acp manifest without a caret peer fails without asking npm", () =>
    withShell(
      (shell) => {
        const result = shell.run("Dependencies are on npm", { NAME: "@nathapp/nax-agent-acp" });
        expect(result.status).not.toBe(0);
        expect(result.calls).toEqual([]);
      },
      { manifest: { version: "0.84.0" } },
    ));

  test("retries while the registry lags, then fails", () =>
    withShell((shell) => {
      const result = shell.run("Dependencies are on npm", { NPM_VIEW_EMPTY: "1", RETRY_DELAY: "0" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toHaveLength(8);
    }));

  test.each(["@nathapp/nax-agent", "@nathapp/nax-agent-acp"])(
    "%s publishes its staged .publish/ with the dist-tag in the manifest too",
    (name) =>
      withShell((shell) => {
        const result = shell.run("Publish to npm", { NAME: name, NPM_TAG: "canary" });
        expect(result.status).toBe(0);
        expect(result.calls).toEqual(["npm publish ./.publish/ --access public --tag canary --provenance"]);
        const staged = JSON.parse(readFileSync(join(shell.dir, ".publish/package.json"), "utf8"));
        expect(staged.publishConfig.tag).toBe("canary");
      }),
  );

  test.each(["@nathapp/nax-ai", "@nathapp/nax"])("%s publishes its package directory", (name) =>
    withShell((shell) => {
      const result = shell.run("Publish to npm", { NAME: name });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["npm publish --access public --tag latest --provenance"]);
    }),
  );

  test("a failed upload fails the job", () =>
    withShell((shell) => {
      expect(shell.run("Publish to npm", { NPM_PUBLISH_EXIT: "1" }).status).not.toBe(0);
    }));

  test("the package version must equal the tag's version", () =>
    withShell((shell) => {
      expect(shell.run("Validate version").status).toBe(0);
      expect(shell.run("Validate version", { VERSION: "0.84.1" }).status).not.toBe(0);
    }));

  test("requires an OIDC-capable npm", () =>
    withShell((shell) => {
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.0" }).status).not.toBe(0);
      expect(shell.run("Validate npm version", { NPM_VERSION: "11.5.1" }).status).toBe(0);
    }));
});

describe("GitHub release", () => {
  test("collects each package's notes for the version and skips packages without any", () =>
    withShell((shell) => {
      mkdirSync(join(shell.dir, "packages/nax-agent"), { recursive: true });
      mkdirSync(join(shell.dir, "packages/nax-agent-acp"), { recursive: true });
      writeFileSync(
        join(shell.dir, "packages/nax-agent/CHANGELOG.md"),
        "# Changelog\n\n## [0.84.0] - 2026-10-10\n\n- Login.\n\n## [0.3.1] - 2026-10-07\n\n- Old.\n",
      );
      writeFileSync(
        join(shell.dir, "packages/nax-agent-acp/CHANGELOG.md"),
        "# Changelog\n\n## [0.3.1] - 2026-10-07\n\n- Old.\n",
      );
      const result = shell.run("Extract release notes");
      expect(result.status).toBe(0);
      expect(readFileSync(join(shell.dir, "release-notes.md"), "utf8")).toBe("## @nathapp/nax-agent\n\n- Login.\n\n");
    }));

  test("one GitHub Release carries the notes plus generated notes", () => {
    expect(releaseStep("Create GitHub Release").with).toEqual({
      tag_name: "${{ needs.resolve.outputs.tag }}",
      name: "${{ needs.resolve.outputs.tag }}",
      body_path: "${{ runner.temp }}/release-notes.md",
      prerelease: "${{ needs.resolve.outputs.prerelease }}",
      generate_release_notes: true,
    });
  });
});
```

Run: `cd packages/repo-tooling && bun test ./test/unit/release/release-workflow.test.ts`
Expected: FAIL. `.github/actions/publish-package/action.yml` does not exist (ENOENT while loading the helper).

- [ ] **Step 3: Write the composite action**

Create `.github/actions/publish-package/action.yml`:

```yaml
name: Publish one nax package
description: >-
  Runs one lockstep package's gates and publishes it to npm with provenance.
  A version already on npm is skipped, so a failed release is resumed by re-running it.
inputs:
  name:
    description: npm package name, e.g. "@nathapp/nax-ai"
    required: true
  dir:
    description: package directory, e.g. packages/nax-ai
    required: true
  version:
    description: the shared release version (the tag without its leading v)
    required: true
  npm_tag:
    description: npm dist-tag, latest or canary
    required: true
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: "1.4.0"

    - uses: actions/setup-node@v5
      with:
        node-version: "24"
        registry-url: "https://registry.npmjs.org"

    - name: Install dependencies
      shell: bash
      run: bun install --frozen-lockfile

    - name: Validate npm version
      shell: bash
      run: |
        NPM_VERSION="$(npm --version)" node -e '
          const v = process.env.NPM_VERSION;
          const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(v || "");
          if (!parts || Number(parts[1]) < 11 || (Number(parts[1]) === 11 && (Number(parts[2]) < 5 || (Number(parts[2]) === 5 && Number(parts[3]) < 1)))) {
            throw new Error("Trusted publishing requires npm >=11.5.1; found " + v);
          }
        '

    - name: Validate version
      shell: bash
      working-directory: ${{ inputs.dir }}
      env:
        VERSION: ${{ inputs.version }}
      run: |
        PKG_VERSION="$(node -p "require('./package.json').version")"
        if [ "$VERSION" != "$PKG_VERSION" ]; then
          echo "::error::Version $VERSION does not match package.json version $PKG_VERSION"
          exit 1
        fi

    - name: Already on npm
      id: published
      shell: bash
      env:
        NAME: ${{ inputs.name }}
        VERSION: ${{ inputs.version }}
      run: |
        if OUT=$(npm view "$NAME@$VERSION" version --json 2>/dev/null); then
          if [ "$OUT" = "\"$VERSION\"" ]; then
            echo "$NAME@$VERSION is already on npm; skipping"
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi
          exit 0
        fi
        CODE=$(OUT="$OUT" node -e 'try { console.log(JSON.parse(process.env.OUT).error.code ?? "") } catch { console.log("") }')
        if [ "$CODE" = "E404" ]; then
          echo "skip=false" >> "$GITHUB_OUTPUT"
          exit 0
        fi
        echo "::error::npm view $NAME@$VERSION failed: $OUT"
        exit 1

    - name: Enable the OS sandbox (bubblewrap)
      if: steps.published.outputs.skip != 'true' && inputs.name == '@nathapp/nax-agent'
      shell: bash
      run: |
        sudo apt-get update -qq
        sudo apt-get install -y -qq bubblewrap socat ripgrep
        sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true

    - name: Pre-publish checks
      if: steps.published.outputs.skip != 'true'
      shell: bash
      working-directory: ${{ inputs.dir }}
      env:
        NAME: ${{ inputs.name }}
      run: |
        case "$NAME" in
          @nathapp/nax-agent|@nathapp/nax-agent-acp)
            bun run check:all
            bun run typecheck
            bun run build
            bun run check:api
            bun run test:coverage
            bun run test:node
            bun run stage-publish
            ;;
          @nathapp/nax-ai)
            bun run lint && bun run typecheck && bun x vitest --run && bun run build
            ;;
          *)
            bun run build
            ;;
        esac

    # The previous job published the dependency seconds ago; the registry can lag.
    - name: Dependencies are on npm
      if: steps.published.outputs.skip != 'true'
      shell: bash
      working-directory: ${{ inputs.dir }}
      env:
        NAME: ${{ inputs.name }}
      run: |
        case "$NAME" in
          @nathapp/nax|@nathapp/nax-agent)
            DEP="@nathapp/nax-ai@$(node -p "require('./package.json').dependencies['@nathapp/nax-ai']")"
            ;;
          @nathapp/nax-agent-acp)
            RANGE=$(node -p "require('./.publish/package.json').peerDependencies?.['@nathapp/nax-agent'] ?? ''")
            PEER="${RANGE#^}"
            if [ -z "$PEER" ] || [ "$PEER" = "$RANGE" ]; then
              echo "::error::staged manifest has no ^X.Y.Z @nathapp/nax-agent peer range"
              exit 1
            fi
            DEP="@nathapp/nax-agent@$PEER"
            ;;
          *)
            exit 0
            ;;
        esac
        for _ in 1 2 3 4 5 6 7 8; do
          if [ -n "$(npm view "$DEP" version 2>/dev/null || true)" ]; then
            echo "$DEP is on npm"
            exit 0
          fi
          sleep "${RETRY_DELAY:-15}"
        done
        echo "::error::$DEP is not on npm"
        exit 1

    # Trusted publishing over OIDC: no token. npm matches this job's workflow
    # file (release.yml) and environment (npm) against each package's settings.
    - name: Publish to npm
      if: steps.published.outputs.skip != 'true'
      shell: bash
      working-directory: ${{ inputs.dir }}
      env:
        NAME: ${{ inputs.name }}
        NPM_TAG: ${{ inputs.npm_tag }}
        NPM_CONFIG_PROVENANCE: "true"
      run: |
        case "$NAME" in
          @nathapp/nax-agent|@nathapp/nax-agent-acp)
            # publishConfig.tag also needs the canary value; do not rely on flag precedence.
            node -e '
              const fs = require("node:fs");
              const path = "./.publish/package.json";
              const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
              pkg.publishConfig = { ...pkg.publishConfig, tag: process.env.NPM_TAG };
              fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
            '
            npm publish ./.publish/ --access public --tag "$NPM_TAG" --provenance
            ;;
          *)
            npm publish --access public --tag "$NPM_TAG" --provenance
            ;;
        esac
```

In the harness, "Validate version" runs with `cwd` set to the temp package dir, which matches `working-directory`. In "Validate npm version", the stub `npm --version` echoes `$NPM_VERSION`.

- [ ] **Step 4: Rewrite the workflow**

Replace `.github/workflows/release.yml` entirely with:

```yaml
name: Release

# One tag publishes every nax package at the shared lockstep version, in
# dependency order: nax-ai -> nax-agent -> nax-agent-acp -> nax. See RELEASING.md.
on:
  push:
    tags:
      - "v*.*.*"
      - "v*.*.*-canary.*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Tag to re-publish (e.g. v0.84.0); packages already on npm are skipped"
        required: true
        type: string

permissions:
  contents: write # GitHub Release creation
  id-token: write # npm OIDC trusted publishing

jobs:
  resolve:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      tag: ${{ steps.info.outputs.tag }}
      version: ${{ steps.info.outputs.version }}
      npm_tag: ${{ steps.info.outputs.npm_tag }}
      prerelease: ${{ steps.info.outputs.prerelease }}
      notify: ${{ steps.info.outputs.notify }}
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ github.event.inputs.tag || github.ref_name }}

      - name: Set release info
        id: info
        env:
          TAG: ${{ github.event.inputs.tag || github.ref_name }}
        run: |
          V="${TAG#v}"
          if [ "$V" = "$TAG" ] || ! [[ "$V" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-canary\.[1-9][0-9]*)?$ ]]; then
            echo "::error::Invalid release tag $TAG (expected vX.Y.Z or vX.Y.Z-canary.N)"
            exit 1
          fi
          if [[ "$V" == *-canary.* ]]; then
            printf 'tag=%s\nversion=%s\nnpm_tag=canary\nprerelease=true\nnotify=false\n' "$TAG" "$V" >> "$GITHUB_OUTPUT"
          else
            printf 'tag=%s\nversion=%s\nnpm_tag=latest\nprerelease=false\nnotify=true\n' "$TAG" "$V" >> "$GITHUB_OUTPUT"
          fi

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - name: Packages share the tag's version
        env:
          VERSION: ${{ steps.info.outputs.version }}
        run: bun packages/repo-tooling/scripts/check-lockstep.ts --expect="$VERSION"

  nax-ai:
    needs: [resolve]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: npm
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.resolve.outputs.tag }}
      - uses: ./.github/actions/publish-package
        with:
          name: "@nathapp/nax-ai"
          dir: packages/nax-ai
          version: ${{ needs.resolve.outputs.version }}
          npm_tag: ${{ needs.resolve.outputs.npm_tag }}

  nax-agent:
    needs: [resolve, nax-ai]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: npm
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.resolve.outputs.tag }}
      - uses: ./.github/actions/publish-package
        with:
          name: "@nathapp/nax-agent"
          dir: packages/nax-agent
          version: ${{ needs.resolve.outputs.version }}
          npm_tag: ${{ needs.resolve.outputs.npm_tag }}

  nax-agent-acp:
    needs: [resolve, nax-agent]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: npm
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.resolve.outputs.tag }}
      - uses: ./.github/actions/publish-package
        with:
          name: "@nathapp/nax-agent-acp"
          dir: packages/nax-agent-acp
          version: ${{ needs.resolve.outputs.version }}
          npm_tag: ${{ needs.resolve.outputs.npm_tag }}

  nax:
    needs: [resolve, nax-agent-acp]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: npm
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.resolve.outputs.tag }}
      - uses: ./.github/actions/publish-package
        with:
          name: "@nathapp/nax"
          dir: packages/nax
          version: ${{ needs.resolve.outputs.version }}
          npm_tag: ${{ needs.resolve.outputs.npm_tag }}

  github-release:
    needs: [resolve, nax]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/tags/${{ needs.resolve.outputs.tag }}

      # nax-agent and nax-agent-acp keep per-release changelogs; nax and nax-ai rely on generated notes.
      - name: Extract release notes
        env:
          VERSION: ${{ needs.resolve.outputs.version }}
        run: |
          NOTES_FILE="$RUNNER_TEMP/release-notes.md"
          : > "$NOTES_FILE"
          for PKG in nax-agent nax-agent-acp; do
            NOTES=$(awk -v v="$VERSION" 'index($0, "## [" v "]") == 1 { found = 1; next } /^## \[/ { if (found) exit } found { print }' "packages/$PKG/CHANGELOG.md" 2>/dev/null || true)
            if [ -n "$(printf '%s' "$NOTES" | tr -d '[:space:]')" ]; then
              printf '## @nathapp/%s\n%s\n\n' "$PKG" "$NOTES" >> "$NOTES_FILE"
            fi
          done

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.resolve.outputs.tag }}
          name: ${{ needs.resolve.outputs.tag }}
          body_path: ${{ runner.temp }}/release-notes.md
          prerelease: ${{ needs.resolve.outputs.prerelease }}
          generate_release_notes: true

      - name: Notify Telegram
        if: needs.resolve.outputs.notify == 'true' && vars.TELEGRAM_CHAT_ID != ''
        env:
          TAG: ${{ needs.resolve.outputs.tag }}
          CHAT_ID: ${{ vars.TELEGRAM_CHAT_ID }}
          BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
        run: |
          NOTES=$(head -20 "$RUNNER_TEMP/release-notes.md" 2>/dev/null || true)
          MSG="*nax ${TAG} released*

          \`\`\`
          npm install -g @nathapp/nax
          \`\`\`

          ${NOTES}"
          curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
            -d chat_id="${CHAT_ID}" \
            -d parse_mode="Markdown" \
            -d text="$MSG" || true
```

Behaviour changes to note in the PR body:
- The per-package bootstrap paths (nax-agent 0.1.0, nax-agent-acp 0.3.0 verify-only uploads) are gone. All four packages already exist on npm, and 0.84.0 is above every bootstrap version.
- Library tags no longer create "0.x = prerelease" GitHub Releases. There is one release per tag: canary is a prerelease, stable is not.
- The Telegram message keeps its wording without the leading emoji (repo rule: no emojis in code).

- [ ] **Step 5: Run the workflow tests**

Run: `cd packages/repo-tooling && bun test ./test/unit/release/release-workflow.test.ts`
Expected: PASS.

- [ ] **Step 6: Delete the bootstrap verifier (orphan pass)**

```bash
git rm packages/repo-tooling/scripts/verify-bootstrap.ts packages/repo-tooling/scripts/lib/bootstrap-artifact.ts \
  packages/repo-tooling/test/unit/scripts/verify-bootstrap.test.ts packages/repo-tooling/test/unit/scripts/bootstrap-artifact.test.ts
git grep -n "verify-bootstrap\|bootstrap-artifact\|assertBootstrapArtifact\|release-shell" -- ':!docs/superpowers/**' ':!.superpowers/**'
```

Expected: the grep shows only `packages/nax-agent/RELEASING.md`, `packages/nax-agent-acp/RELEASING.md` (rewritten in Task 4) and the new `packages/repo-tooling/test/helpers/release-shell.ts` with its importer. If any code file outside those still imports a deleted module, stop and report it. Do not delete further.

- [ ] **Step 7: Run the gates**

```bash
cd packages/repo-tooling && bun run test && bun run typecheck && bun run check:all
cd ../nax-agent && bun run test && bun run typecheck && bun run check:all
cd ../nax && bun run check:gate-reachability
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A .github packages/repo-tooling packages/nax-agent/test
git commit -m "ci(release): one vX.Y.Z tag publishes nax-ai, nax-agent, nax-agent-acp and nax in order"
```

---

### Task 4: Docs, agent guidance and 0.84.0 changelogs

**Files:**
- Create: `RELEASING.md`
- Modify: `packages/nax-agent/RELEASING.md`, `packages/nax-agent-acp/RELEASING.md`, `packages/nax-ai/README.md`
- Modify: `.nax/context.md`, `.nax/mono/packages/nax-agent/context.md`, `.nax/mono/packages/nax-agent-acp/context.md`, then regenerate all generated agent files
- Modify: `packages/nax-agent/CHANGELOG.md`, `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-10-09-s5-4-auth-release.md` (Tasks 7-9)

- [ ] **Step 1: Write the root release guide**

Create `RELEASING.md`:

~~~markdown
# Releasing nax

The four published packages share one version and release together:
`@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax`.
One PR bumps them all and one `vX.Y.Z` tag publishes them all. Releases are
maintainer-initiated only, and every tag push needs its own approval.

## Prepare

On clean, up-to-date main, from the repo root:

```sh
bun run release --dry-run patch
bun run release patch
```

The command accepts `patch`, `minor`, `major`, `canary`, `promote`, or an explicit
`X.Y.Z` / `X.Y.Z-canary.N` above the current version. It sets every package's
version, pins `@nathapp/nax-ai` to it in nax and nax-agent, dates the
`## [Unreleased]` notes in the nax-agent and nax-agent-acp changelogs (a package
with no notes gets a "No changes" entry), refreshes `bun.lock`, and opens a PR from
`release/vX.Y.Z`. It never tags.

`check:lockstep` (part of nax's `check:all`) fails any commit whose packages
disagree on the version, or whose nax-ai pins differ from it. Never bump one
package alone.

## Publish

After the PR merges, on clean main:

```sh
bun run release --dry-run tag
bun run release tag
```

`.github/workflows/release.yml` then runs:

1. `resolve`: validates the tag and runs `check-lockstep.ts --expect=<version>`.
2. One job per package, in dependency order: nax-ai, nax-agent, nax-agent-acp, nax.
   Each runs the package's gates, waits until the packages it depends on are
   visible on npm, and publishes with provenance. A version already on npm is
   skipped, so a failed run is resumed by re-running it (or by dispatching the
   workflow with the tag).
3. `github-release`: one GitHub Release for the tag. Its body is the nax-agent and
   nax-agent-acp changelog sections followed by generated notes. Stable releases
   notify Telegram.

Stable versions publish under `latest` and `-canary.N` versions under `canary`.
A canary pins nax-ai to a prerelease version, so that build's cost rows omit
`catalogVersion`.

## Trusted publishing

Every package publishes through npm trusted publishing (OIDC), with no token. Each
package's npm settings must list this trusted publisher:

| Field | Value |
|---|---|
| Organization | `nathapp-io` |
| Repository | `nax` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

## History

Before 0.84.0 each package had its own version, release script and tag prefix
(`nax-ai-v*`, `nax-agent-v*`, `nax-agent-acp-v*`, and `v*` for nax). Those tags
cannot be re-dispatched: the workflow only accepts lockstep tags. nax-agent's 0.1.0
and nax-agent-acp's 0.3.0 first publishes were manual. Their records are in git
history of `packages/nax-agent/RELEASING.md` and `packages/nax-agent-acp/RELEASING.md`.
~~~

- [ ] **Step 2: Trim the package release guides**

In `packages/nax-agent/RELEASING.md`:
- Delete the sections "Prepare the first release", "Manual publish: maintainer OTP/2FA step", "Configure trusted publishing, then tag 0.1.0" and "Subsequent releases".
- Keep "S3 acceptance (0.2.0)".
- Directly under the `# Releasing nax-agent` title, replace the introduction with: `nax-agent releases in lockstep with the other published nax packages. See the repo-root RELEASING.md. This file keeps the package's acceptance records.`

In `packages/nax-agent-acp/RELEASING.md`:
- Delete "Prepare a release", "Publish nax-agent, then nax-agent-acp" and "First publish: 0.3.0 (manual, maintainer 2FA)".
- Keep "S4 acceptance (0.3.0)". The S5-4 live smoke follows its "pack both at one version" steps.
- In that section, replace the sentence `Before the release PR merges, give the staged nax-agent copy the acp version. After that PR, \`rtk bun run stage-publish\` works for both packages directly.` with `Both packages already share one version (lockstep), so \`rtk bun run stage-publish\` works for both directly.`
- Replace the introduction under the title with the same lockstep pointer sentence as nax-agent's.

In `packages/nax-ai/README.md`, replace the sentence beginning `While the API is unstable, \`latest\` and \`next\` both point at the current 0.x release` with: `Stable releases are published to \`latest\` and canary builds to \`canary\`. The version moves in lockstep with the other nax packages, so a release may contain no nax-ai changes.`

Then:

```bash
git grep -n "verify-bootstrap\|tag-acp\|nax-ai-v\|nax-agent-v\|nax-agent-acp-v" -- ':!docs/superpowers/**' ':!.superpowers/**' ':!*CHANGELOG.md'
```

Expected: only the generated agent files and `.nax/` sources, which Steps 3-4 fix.

- [ ] **Step 3: Update the agent guidance sources**

In `.nax/context.md`, replace the whole `## Releases` section body (the four lines under the heading) with:

```markdown
Lockstep: `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` always share one version. From the repo root, `bun run release <patch|minor|major|canary|promote|X.Y.Z>` bumps all four (and nax/nax-agent's exact `@nathapp/nax-ai` pin) in one PR; `bun run release tag` pushes `vX.Y.Z`, and `release.yml` publishes in order nax-ai → nax-agent → nax-agent-acp → nax, skipping any version already on npm.
`check:lockstep` fails a commit whose versions or nax-ai pins disagree. Never bump one package alone.
Releases are maintainer-initiated only. See `RELEASING.md`.
```

In the same file's Layout table, in the `packages/nax-agent-acp` row, replace `versioned in lockstep with nax-agent` with `versioned in lockstep with every published nax package`.

In `.nax/mono/packages/nax-agent/context.md`:
- Replace `Release preparation and publication follow \`packages/nax-agent/RELEASING.md\`:` and the two lines after it (`manual 0.1.0 publish ...` and `subsequent \`nax-agent-vX.Y.Z\` tags ...`) with: `Releases are lockstep with the other published nax packages (repo-root \`RELEASING.md\`); tags publish through OIDC with provenance.`
- Replace `release helper bumps both, and \`release tag-acp\` publishes it after this package.` with `lockstep release bumps both, and the release workflow publishes it after this package.`
- Delete the three table rows `bun run release --dry-run patch`, `bun run release patch` and `bun run release tag`.

In `.nax/mono/packages/nax-agent-acp/context.md`, replace the two lines under `## Releases` with: `Versioned in lockstep with nax-agent, nax-ai and nax. Released from the repo root (\`bun run release ...\`, then \`bun run release tag\`). See the repo-root \`RELEASING.md\`.`

- [ ] **Step 4: Regenerate every generated agent file**

From the repo root:

```bash
bun packages/nax/bin/nax.ts generate
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
```

Expected: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `codex.md` change at the root and under `packages/nax-agent/` and `packages/nax-agent-acp/`, and nothing else unexpected. Inspect `git diff --stat`. If other packages' generated files change only by generator metadata, keep them. That is the expected full sync.

- [ ] **Step 5: Date the 0.84.0 changelogs**

Add this bullet at the top of the `## [Unreleased]` section in `packages/nax-agent/CHANGELOG.md` and in `packages/nax-agent-acp/CHANGELOG.md`:

```markdown
- Versioning: released in lockstep with `@nathapp/nax`, `@nathapp/nax-ai` and the other agent package at one shared version, starting at 0.84.0 (previously 0.3.x).
```

Then date them with the release library (use today's date):

```bash
bun -e 'import { readFileSync, writeFileSync } from "node:fs"; import { stampChangelog } from "./packages/repo-tooling/scripts/lib/release-version.ts"; const d = new Date().toISOString().slice(0, 10); for (const p of ["packages/nax-agent/CHANGELOG.md", "packages/nax-agent-acp/CHANGELOG.md"]) writeFileSync(p, stampChangelog(readFileSync(p, "utf8"), "0.84.0", d));'
grep -n "^## \[" packages/nax-agent/CHANGELOG.md packages/nax-agent-acp/CHANGELOG.md | head -6
```

Expected: each file's first release heading is `## [0.84.0] - <today>`, with the S5 notes and the lockstep bullet under it. There is no `## [Unreleased]` heading left.

- [ ] **Step 6: Amend the S5-4 plan**

In `docs/superpowers/plans/2026-10-09-s5-4-auth-release.md`:
- Replace the body of `### Task 7: Release nax-ai 0.1.17 (APPROVAL AT LAUNCH)` with: `Superseded by lockstep versioning (docs/superpowers/plans/2026-10-09-lockstep-versioning.md). nax-ai is no longer released on its own; it ships at 0.84.0 with the other three packages.`
- In `### Task 8`, replace `On main after Task 7, follow` with `On main after the lockstep PR merges (all packages at 0.84.0, nothing published yet), follow`, and drop any step that sets a version on the staged nax-agent copy.
- Replace the body of `### Task 9: Release nax-agent and nax-agent-acp 0.4.0 (APPROVAL AT LAUNCH)` with: `Superseded: after Task 8 passes, the maintainer approves and runs \`bun run release tag\` for v0.84.0 (lockstep plan Task 5), which publishes all four packages.`

- [ ] **Step 7: Run every gate once**

```bash
cd packages/repo-tooling && bun run test && bun run check:all && bun run typecheck
cd ../nax && bun run check:all && bun run typecheck
cd ../nax-agent && bun run check:all && bun run test
cd ../nax-agent-acp && bun run check:all && bun run test
cd ../nax-ai && bun run check:all && bun x vitest --run
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A RELEASING.md .nax CLAUDE.md AGENTS.md GEMINI.md codex.md packages docs/superpowers/plans/2026-10-09-s5-4-auth-release.md
git status --short
git commit -m "docs(release): lockstep release guide, agent guidance and 0.84.0 changelogs"
```

Before committing, `git status --short` must show nothing unstaged except files you intentionally left out.

Then open the PR (title `chore(release): lockstep versioning for every published nax package at 0.84.0`). The body lists the behaviour changes from Task 3 Step 4 and says the release itself is Task 5, which is approval-gated. Code review happens before push.

---

### Task 5: First lockstep release, v0.84.0 (APPROVAL AT LAUNCH)

Runs after the Task 1-4 PR is merged, on clean, up-to-date main. Every step that publishes, or that runs a billed check, needs the maintainer's explicit go-ahead at that moment.

- [ ] **Step 1: Confirm the four trusted publishers (maintainer, on npmjs.com)**

For each of `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax`, open Settings → Trusted publishing and confirm: organization `nathapp-io`, repository `nax`, workflow `release.yml`, environment `npm`. A package whose entry has a different or empty environment must be fixed before Step 4. Otherwise its job fails after the packages ahead of it are already public. This is recoverable: fix the entry and re-run the failed job.

- [ ] **Step 2: S5-4 live checks**

Run S5-4 plan Task 8 (billed acpx smoke, Zed walkthrough, login exit check) on main at 0.84.0, with its own approval at launch.

- [ ] **Step 3: Dry run**

```bash
git switch main && git pull --ff-only
bun run release --dry-run tag
```

Expected: `v0.84.0: publishes @nathapp/nax-ai, @nathapp/nax-agent, @nathapp/nax-agent-acp, @nathapp/nax at 0.84.0 under latest`.

- [ ] **Step 4: Tag (approval at launch)**

```bash
bun run release tag
```

Watch the run: `gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"`.

- [ ] **Step 5: Verify**

```bash
for p in nax-ai nax-agent nax-agent-acp nax; do npm view "@nathapp/$p@0.84.0" version dist-tags.latest; done
gh release view v0.84.0 --json name,isPrerelease -q '.name + " prerelease=" + (.isPrerelease|tostring)'
```

Expected: each package prints `0.84.0` twice (version and `latest`), and the release prints `v0.84.0 prerelease=false`. Record the run URL and the tagged commit in the nax-agent master plan's S5 row.

If one job failed, fix the cause and re-run the failed jobs from the Actions page (or `gh workflow run release.yml -f tag=v0.84.0`). Packages already on npm are skipped.
