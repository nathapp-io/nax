# SPEC: review 0b834ecc fixes: release tag target and retry, CI paths for release inputs, legacy model-map detection, impossible schedule dates

## Summary

Five fixes from the verified code review of `0b834ecc1` (findings 2, 19, 20, 21 and 22), each reproduced by a proof script:

1. **Release tag target (finding 2, High).** After the push is confirmed, `bun run release tag` reads `origin`'s `main` and the release tag with `git ls-remote`. It refuses to tag or push when local `HEAD` is not the commit `origin/main` points at, or when `origin` already holds the tag.
2. **Release tag retry (finding 21).** A local tag left by a failed push no longer blocks a rerun. When the local tag points at `HEAD` and `origin` does not hold it yet, the rerun pushes that tag without recreating it. A local tag at any other commit is still refused.
3. **CI paths for release inputs (finding 22).** Ordinary CI also runs when a change touches only the publish composite action (`.github/actions/**`) or a dependency patch (`patches/**`). A test derives the release inputs from `release.yml` and the root `package.json`, so a new input that ordinary CI skips fails the test.
4. **Legacy model-map detection (finding 19).** A per-agent tier map may use `model` or `provider` as a tier name. A value counts as a legacy model definition only when it is a string, or an object whose `provider` and `model` are both strings.
5. **Impossible schedule dates (finding 20).** `--schedule` rejects a date or time that does not exist, for example `2027-02-29T02:00`, with or without a UTC offset.

## Motivation

The review (`review-0b834ecc/REVIEW.md`) reproduced each defect through its production entry point, with a passing control:

- **Finding 2.** The real release CLI pushed to a bare Git remote. With local and remote `main` aligned, the remote tag matched remote `main`. After one local-only commit to a package source file, the CLI exited 0 again, and the remote tag held that commit while remote `main` still pointed at its parent. `release.yml` checks out the tag and publishes it, so an unmerged commit can reach npm. `tagRelease` checks only the branch name and a clean tree before `git tag` and `git push origin <tag>`.
- **Finding 21.** With the push URL pointing at a missing path, the first `bun run release tag` failed after creating the local tag. With the remote restored, the rerun failed on `Tag v0.84.0 already exists`, while pushing that same tag by hand delivered it. `RELEASING.md` documents rerunning the publish workflow after the tag is delivered, but nothing covers recovering before delivery.
- **Finding 22.** Matching the real `push` and `pull_request` path lists in `ci.yml` against tracked files left out `.github/actions/publish-package/action.yml`, which every publish job in `release.yml` runs, and `patches/ink@6.7.0.patch`, which the root `package.json` lists under `patchedDependencies`. A change touching only those files ran no ordinary CI.
- **Finding 19.** The built `nax config` command loaded `{"models":{"native":{"speed":"openai/one"}}}` and exited 0. With the tier renamed `model` or `provider`, it exited 1 with `Invalid configuration`. `isLegacyFlatModels` treats any object value holding a `provider` or `model` key as a legacy flat entry, so it moved the whole map under `claude`, and `native` was then parsed as a model definition.
- **Finding 20.** With one fixed reference clock, `2028-02-29T02:00` stayed February 29, but `2027-02-29T02:00` became March 1 and was accepted. `parseIso` builds the date with `new Date(year, month - 1, day, ...)`, which rolls an out-of-range day into the next month. The offset form rolls over too: under Bun, `new Date("2027-02-29T02:00Z")` is March 1.

## Design

### Integration

Symbols this feature only reads:

- `packages/repo-tooling/scripts/release.ts`: `git(...args)`, `requireCleanMain()`, `sharedVersion(manifests)`, `confirm(message)`, `distTagsFor(version)`. `bumpRelease` and its `rejectExistingTag(plan.tag)` call are unchanged.
- `packages/repo-tooling/test/helpers/release-cli-fixture.ts`: `makeReleaseCliFixture()`. It returns `{ dir, git, write, run(args, input?, env?) }`. `run` puts stub `git`/`bun`/`gh` scripts first on `PATH`. The `git` stub fakes `pull` and `push` (`exit ${FAIL_PUSH:-0}`) and passes every other subcommand to `/usr/bin/git`. Passing `{ PATH: "/usr/bin:/bin" }` as `env` replaces the stubs with real git, which is how the review proof pushed to a bare remote.
- `packages/repo-tooling/test/helpers/release-shell.ts`: loads workflow YAML with `Bun.YAML.parse(readFileSync(new URL(".github/workflows/release.yml", REPO), "utf8"))`. The CI-paths test loads `ci.yml`, `release.yml` and the root `package.json` the same way, and matches paths against the `paths` globs with `Bun.Glob`, as the review proof did.
- `packages/nax/src/config/schemas-model.ts`: `ModelDefSchema` (`provider` and `model` required non-empty strings), `TierMapSchema`, `PerAgentModelMapSchema`.
- `packages/nax/src/config/loader.ts`: `loadConfig(startDir?, cliOverrides?)`. Its tests isolate the global layer with `NAX_GLOBAL_CONFIG_DIR` and `_clearRootConfigCache()` (`test/unit/config/loader-mcp-literal.test.ts`).
- `packages/nax/src/schedule/parse.ts`: `resolveScheduleGate(input, now)`, which `resolveRunScheduleAndPlanFlags` in `packages/nax/bin/run-action.ts` calls before any setup. Unchanged.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `tagRelease(dryRun)` (`packages/repo-tooling/scripts/release.ts`).
  - Baseline: `requireCleanMain()`, `rejectExistingTag(tag)`, print, dry-run return, `confirm`, then `git("tag", tag)` and `git("push", "origin", tag)`.
  - Target, in this order:
    1. `requireCleanMain()` and the shared version, as today.
    2. Local tag check, with no network call. `git tag --list <tag>` tells whether the local tag exists; only when it does, `git rev-list -n 1 <tag>` gives its commit. (The `git()` helper throws on any non-zero exit, so a probe that exits 1 for a missing tag must not be used uncaught.) If the tag exists and its commit is not `git rev-parse HEAD`, throw `Tag <tag> already exists at <sha>, not at HEAD`.
    3. Print the plan line. On `--dry-run`, return. No network call happens before this point or on a declined confirmation.
    4. `confirm(...)`, unchanged. A declined confirmation prints `Aborted.` and returns.
    5. Remote check, after confirmation: `git ls-remote origin refs/heads/main refs/tags/<tag>`. `ls-remote` patterns match ref-name suffixes, so the output is read by exact ref name: only a line whose ref is exactly `refs/heads/main` or exactly `refs/tags/<tag>` counts. If the output has the `refs/tags/<tag>` line, throw `Tag <tag> already exists on origin`. If `refs/heads/main` is missing, or its commit is not `HEAD`, throw `Local main <head> does not match origin/main <remote>; pull or push main before tagging`. A failing `ls-remote` throws its error. In each case nothing is tagged or pushed.
    6. Create the tag only when step 2 found none, then `git("push", "origin", tag)`. When step 2 found the tag at `HEAD`, skip `git tag` and push the existing tag.
  - `release.ts` is 206 lines. Keep the checks in `release.ts`. If the project's function-size limits force a helper into a new `packages/repo-tooling/scripts/lib/` file, `makeReleaseCliFixture` must also copy that file, because the fixture runs a copy of `release.ts` with only the files it lists (see Modifies).
- `RELEASING.md`, the `bun run release tag` section.
  - Target: one sentence says that after a failed tag push, rerunning `bun run release tag` on the same clean `main` pushes the existing local tag, and that the command refuses when local `main` differs from `origin/main`.
- `.github/workflows/ci.yml`, `on.push.paths` and `on.pull_request.paths`.
  - Baseline: `packages/**`, `package.json`, `bunfig.toml`, `bun.lock`, `biome.json`, `.github/workflows/**`, `.nax/**`.
  - Target: both lists also hold `.github/actions/**` and `patches/**`.
- `isLegacyFlatModels(val)` (`packages/nax/src/config/schemas-model.ts`).
  - Baseline: returns `true` when any top-level value is a string, or an object with a `provider` or `model` key.
  - Target: returns `true` when any top-level value is a string, or a non-null object whose `provider` and `model` are both strings. An object holding only one of them, or holding a non-string `model` or `provider` (a tier mapped to a model definition object), does not count as legacy. The doc comment states the new rule.
- `parseIso(input, now)` (`packages/nax/src/schedule/parse.ts`).
  - Baseline: builds the naive form with `new Date(y, mo - 1, d, h, mi, s)` and the offset form with `new Date(input)`, and rejects only an `Invalid Date`.
  - Target: before building the date, any input matching the naive or offset form has its leading `YYYY-MM-DDTHH:MM(:SS)?` checked. The month must be 1-12. The day must be from 1 to the number of days in that month of that year under the Gregorian leap rule (divisible by 4, except centuries not divisible by 400). The hour must be 0-23, and the minute and second 0-59. When a component is out of range, return `{ ok: false, error: \`Schedule "${input}" names a date or time that does not exist.\` }`. Valid inputs take today's path unchanged. An input that matches neither form keeps today's path too, ending in the `Unrecognized schedule` error. An input that matches the offset form but does not start with `YYYY-MM-DDTHH:MM` also skips the calendar check and keeps today's path.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `git ls-remote origin` fails (no `origin`, network error) | The error propagates and the CLI exits 1. Nothing is tagged or pushed. |
| `origin` has no `main` branch | Refused with the `does not match origin/main` error. Nothing is tagged or pushed. |
| The tag push fails after the local tag was created | Exits 1, as today. The local tag stays at `HEAD`, so a rerun pushes it. |
| A tier map value is an object holding only `provider` (no `model`) | Read as a per-agent tier map. Before this feature it was migrated as legacy and then failed `ModelDefSchema`. |
| A schedule names a nonexistent date or time | `parseSchedule` and `resolveScheduleGate` return `ok: false` with the `does not exist` error. `nax run --schedule` prints `Invalid --schedule: ...` and exits 1, as for any rejected value. |

## Out of Scope

- Findings 1 and 3-17 of review 0b834ecc belong to the other review-0b834 features (agent-acp, which is merged, provider-credentials, and workflow-verification); finding 18 was withdrawn as a CLI defect.
- US-001 only: `bun run release --dry-run tag` and a declined confirmation make no network call; the remote checks run only after the push is confirmed.
- US-001 only: the bump path (`bun run release <canary|promote|patch|minor|major|X.Y.Z>`) is unchanged; it already pulls with `--ff-only` and re-checks the release inputs.
- US-001 only: release tags stay lightweight; annotated or signed tags are not introduced.
- US-001 only: a remote tag that already exists is refused even when it points at `HEAD`; the CLI does not report it as delivered.
- US-001 only: the tag-time gates in `.github/workflows/release.yml` are unchanged.
- US-001 only: the `RELEASING.md` retry sentence is a documentation change that no test verifies.
- US-001 only: the CI-paths invariant covers the local actions that `release.yml` steps use and the root `package.json` `patchedDependencies` files; other files that workflows reference are not enumerated.
- US-002 only: a per-agent tier map whose tiers are `provider` and `model`, both with string values, is still read as one legacy model definition, because that shape cannot be told apart from a legacy entry.
- US-002 only: a model map that mixes a legacy model definition with a per-agent entry is migrated as legacy, as today.
- US-002 only: a naive local time inside a daylight-saving gap keeps today's behaviour, where the platform shifts it.
- US-002 only: the range of an explicit UTC offset (for example `+25:00`) is not newly validated.

## Stories

**US-001: the release tag targets origin/main, a failed push can be retried, and CI covers release inputs (findings 2, 21 and 22).** Workdir: `packages/repo-tooling`. No dependencies. `tagRelease` refuses a local tag at a commit other than `HEAD` before confirmation. After confirmation it reads `origin` with one `git ls-remote`: it refuses when `origin` already holds the tag or when `HEAD` is not `origin/main`, and it pushes an existing local tag at `HEAD` without recreating it. `RELEASING.md` gains the retry sentence. `.github/workflows/ci.yml` adds `.github/actions/**` and `patches/**` to both path lists, and a new test derives the release inputs from `release.yml` and the root `package.json`.

**US-002: model maps accept `model` and `provider` tier names, and schedules reject impossible dates (findings 19 and 20).** Workdir: `packages/nax`. No dependencies. `isLegacyFlatModels` counts an object value as legacy only when both `provider` and `model` are strings. `parseIso` checks the calendar components of the naive and offset forms before building the date.

### Context Files

**US-001**
- `packages/repo-tooling/scripts/release.ts` — `tagRelease`, `rejectExistingTag`, `requireCleanMain`, `git`
- `packages/repo-tooling/test/helpers/release-cli-fixture.ts` — `makeReleaseCliFixture`, the stubbed `git push`, the `env` override
- `packages/repo-tooling/test/unit/release/release-cli.test.ts` — the existing `tag` tests
- `packages/repo-tooling/test/helpers/release-shell.ts` — how workflow YAML is loaded in this package's tests
- `.github/workflows/ci.yml` — `on.push.paths`, `on.pull_request.paths`

**US-002**
- `packages/nax/src/config/schemas-model.ts` — `isLegacyFlatModels`, `ModelMapSchema`, `ModelDefSchema`
- `packages/nax/test/unit/config/schemas.test.ts` — `baseConfig(models)` and the legacy-migration tests
- `packages/nax/test/unit/config/loader-mcp-literal.test.ts` — `loadConfig` isolation with `NAX_GLOBAL_CONFIG_DIR`
- `packages/nax/src/schedule/parse.ts` — `parseIso`, `parseSchedule`, `resolveScheduleGate`
- `packages/nax/test/unit/schedule/parse.test.ts` — the ISO datetime tests

### Creates

**US-001**
- `packages/repo-tooling/test/unit/release/release-tag-remote.test.ts` — tag tests against a bare `origin` with real git
- `packages/repo-tooling/test/unit/release/ci-paths.test.ts` — the release-inputs-in-CI-paths test

**US-002**
- `packages/nax/test/unit/config/model-map-tier-names.test.ts` — the `model` and `provider` tier-name tests
- `packages/nax/test/unit/schedule/parse-calendar.test.ts` — the impossible-date tests

### Modifies

**US-001**
- `packages/repo-tooling/test/helpers/release-cli-fixture.ts` — the fixture repository has no `origin` remote, so the new post-confirmation `git ls-remote origin` fails every confirmed `tag` run. After the fixture commit, the fixture creates a bare repository named origin.git inside its temp directory, adds /origin.git/ to the same single write that sets the repository's info/exclude entries for the stub directory and logs, or appends it after that write, never before it, because that write replaces the file (so `requireCleanMain` still sees a clean tree, and `cleanupTempDir(dir)` still removes everything), adds it as `origin`, and seeds it with the fixture's `main` through the real git binary (never the stub). If the release script imports a new scripts/lib file, the fixture's copy list gains that file. The invariant: in a fresh fixture, origin's main equals the local `HEAD`, `origin` holds no tags, the stubbed `push` still records calls, and the fixture tree stays clean.
- `packages/repo-tooling/test/unit/release/release-cli.test.ts` — the `existing-tag` case of `tag rejects a %s checkout before creating or pushing a tag` creates `v0.84.0` at `HEAD`, which is now the retry case and pushes. The invariant becomes: the case tags `HEAD`, then adds one more commit so the tag points at a commit other than `HEAD`, and `tag` still exits non-zero with no `git push` or `git tag v` call.

**US-002**

None. The existing legacy-migration tests use values with both `provider` and `model`, or string values, which stay legacy. The existing schedule tests use dates that exist.

### Seams

None. Neither story adds an exported symbol. US-001 drives `bun run release tag`, and US-002 drives `NaxConfigSchema`, `loadConfig`, `parseSchedule` and `resolveScheduleGate`, all existing entry points.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

Setup for ACs 1-11, 18 and 19: a fixture from `makeReleaseCliFixture()` with its bare `origin`. "Run `tag` with real git" means `run(["tag"], "y\n", { PATH: "/usr/bin:/bin" })`, so the push really reaches `origin`. "Origin's X" means `git rev-parse X` run in the bare repository.

1. [integration] (control) With `origin/main` equal to local `HEAD`, running `tag` with real git exits 0 and origin's `v0.84.0` resolves to the same commit as origin's `main`.
2. [integration] After one local-only commit on `main`, with `origin/main` still at its parent, running `tag` with real git exits non-zero, and its output contains `does not match origin/main`.
3. [integration] In that case `origin` holds no `v0.84.0` tag.
4. [integration] In that case the fixture has no local `v0.84.0` tag.
5. [integration] When `origin`'s `main` has a commit that local `main` lacks (pushed to the bare repository from a second clone), running `tag` with real git exits non-zero, and `origin` holds no `v0.84.0` tag.
6. [integration] (control) With `origin`'s push URL set to a missing path, running `tag` with real git exits non-zero, and the fixture's local `v0.84.0` resolves to `HEAD`.
7. [integration] After that failed push, with the push URL restored, a second run of `tag` with real git exits 0.
8. [integration] In that case origin's `v0.84.0` resolves to the fixture's `HEAD`.
9. [integration] When `origin` already holds `v0.84.0` at the parent of `HEAD`, the fixture holds no local tag, and `origin/main` equals `HEAD`, running `tag` with real git exits non-zero, and its output contains `already exists on origin`.
10. [integration] In that case the fixture has no local `v0.84.0` tag, and origin's `v0.84.0` still resolves to the parent commit.
11. [integration] (control) A local `v0.84.0` at a commit other than `HEAD` makes `run(["tag"], "n\n")` exit non-zero, and the local tag still resolves to its original commit.
12. [integration] (control) With `origin`'s fetch URL set to a missing path, `run(["--dry-run", "tag"])` exits 0 and its output contains `v0.84.0`.
13. [integration] (control) With `origin`'s fetch URL set to a missing path, `run(["tag"], "n\n")` exits 0 and its output contains `Aborted.`.
14. [unit] Every `uses:` value beginning with `./` in any step of any job in `.github/workflows/release.yml` names a directory whose `action.yml` path, relative to the repo root, matches at least one glob in `.github/workflows/ci.yml` `on.push.paths`.
15. [unit] Every such `action.yml` path matches at least one glob in `.github/workflows/ci.yml` `on.pull_request.paths`.
16. [unit] Every file path listed as a value under `patchedDependencies` in the root `package.json` matches at least one glob in `on.push.paths`, and at least one in `on.pull_request.paths`.
17. [unit] (control) `.github/workflows/release.yml` and `package.json` each match at least one glob in `on.push.paths`, and at least one in `on.pull_request.paths`.
18. [integration] With `origin`'s fetch URL set to a missing path, running `tag` with real git exits non-zero, and the fixture has no local `v0.84.0` tag.
19. [integration] When `origin` is an empty bare repository with no `main` branch, running `tag` with real git exits non-zero, its output contains `does not match origin/main`, and the fixture has no local `v0.84.0` tag.

### US-002

ACs 1-6 parse `baseConfig(models)` (the helper shape in `test/unit/config/schemas.test.ts`) with `NaxConfigSchema.safeParse`.

1. [unit] `models` `{ native: { model: "openai/one" } }` parses successfully, and the parsed `models.native.model` is `"openai/one"`.
2. [unit] `models` `{ native: { provider: "openai/one" } }` parses successfully, the parsed `models.native.provider` is `"openai/one"`, and the parsed `models` has no `claude` key.
3. [unit] `models` `{ native: { model: { provider: "openai", model: "openai/one" } } }` parses successfully, and the parsed `models.native.model` deep-equals `{ provider: "openai", model: "openai/one" }`. (Native model ids must be written `provider/model`, per `validateNativeModelIds`.)
4. [unit] (control) `models` `{ fast: { provider: "anthropic", model: "haiku" } }` parses successfully with `models.claude.fast` deep-equal to `{ provider: "anthropic", model: "haiku" }` and no top-level `fast` key.
5. [unit] (control) `models` `{ fast: "claude-haiku" }` parses successfully with `models.claude.fast` equal to `"claude-haiku"`.
6. [unit] (control) `models` `{ native: { speed: "openai/one" } }` parses successfully with `models.native.speed` equal to `"openai/one"`.
7. [integration] `loadConfig(dir)`, on a temp project whose `.nax/config.json` is `{ "name": "p", "models": { "native": { "model": "openai/one" } } }` and with `NAX_GLOBAL_CONFIG_DIR` set to an empty directory, resolves with `config.models.native.model` equal to `"openai/one"`.

ACs 8-19 use `now = new Date(2026, 0, 1, 0, 0, 0)`.

8. [unit] `parseSchedule("2027-02-29T02:00", now)` returns `ok: false`, with an error containing `does not exist`.
9. [unit] (control) `parseSchedule("2028-02-29T02:00", now)` returns `ok: true`, with a target whose local month is February (index 1), local day 29 and local hour 2.
10. [unit] `parseSchedule("2027-04-31T02:00", now)` returns `ok: false`, with an error containing `does not exist`.
11. [unit] `parseSchedule("2027-13-01T02:00", now)` returns `ok: false`, with an error containing `does not exist`.
12. [unit] `parseSchedule("2027-03-01T24:00", now)` returns `ok: false`, with an error containing `does not exist`.
13. [unit] `parseSchedule("2027-03-01T02:60", now)` returns `ok: false`, with an error containing `does not exist`.
14. [unit] `parseSchedule("2027-02-29T02:00Z", now)` returns `ok: false`, with an error containing `does not exist`.
15. [unit] (control) `parseSchedule("2027-03-01T02:00Z", now)` returns `ok: true`, with a target whose epoch milliseconds equal `Date.UTC(2027, 2, 1, 2, 0)`.
16. [unit] `resolveScheduleGate("2027-02-29T02:00", now)` returns `ok: false`, with an error containing `does not exist`.
17. [unit] (control) `parseSchedule("2027-02-29", now)` returns `ok: false`, with an error containing `Date-only`.
18. [unit] `parseSchedule("2100-02-29T02:00", now)` returns `ok: false`, with an error containing `does not exist`.
19. [unit] `parseSchedule("2027-03-01T02:00:60", now)` returns `ok: false`, with an error containing `does not exist`.
