# S2-9 — Release wiring and first publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `@nathapp/nax-agent` 0.1.0 for a maintainer-approved first npm publish and wire subsequent releases into the monorepo release workflow.

**Architecture:** Keep the source-pointing workspace manifest private; publish the generated `.publish/` manifest and Node ESM build. Extend the existing tag-driven workflow with a nax-agent arm, add a package-local release helper modelled on nax-ai's, and document the one-off manual bootstrap followed by OIDC releases. Release preparation and external publication are separate gates.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2, Node 24 for release checks, npm >=11.5.1 for OIDC, GitHub Actions, existing bun:test and vitest 4.1.9 suites. No added dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§5.2, §8, §9 S2-9, §10). Arc decisions and status live only in `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md`; read D10, D17–D22 and §7.

## Global Constraints

- Node floor: `engines.node: ">=22.19.0"`.
- TypeScript: `7.0.2`, pinned exactly.
- Workspace `private: true` and source-pointing `exports`/`imports` stay; the staged manifest omits `private`, scripts and devDependencies.
- `.` stays curated, exports no `_` name; `/internal` remains unstable and nax-only. No API snapshot changes.
- Own coverage: >=80% lines and functions overall, >=80% per file, empty baseline, no unreported executable source files. Do not update coverage exceptions to pass.
- nax-agent ships no Bun code; its no-Bun gate has no exceptions.
- `packages/nax/package.json` dependencies stay byte-identical; nax-agent remains bundled into nax.
- Release order: nax-ai, then nax-agent, then nax. nax continues using `vX.Y.Z`; agent uses `nax-agent-vX.Y.Z`.
- No release, tag push, npm account changes or billed agent smoke without explicit maintainer approval for that action. Preparing files and running offline release tests do not publish.
- Run package commands from their package directory. Never bare `bun test` and never `bun run nax`.
- Before execution, record any approved bootstrap deviation in arc §2. All progress/PR/merge/publish records go in arc §5 only.

## Review Focus

1. A dispatched tag must build the tagged commit, even when main has advanced; an unknown prefix or tag/version mismatch must fail before publication (Task 2).
2. Registry outage/authentication errors must not be treated as an unpublished pin or a successful bootstrap; a wrong nax-ai pin must stop release (Task 2).
3. Canary publication must override `.publish/package.json`'s default `latest`; `0.x` stable uses latest and a GitHub prerelease (Task 2).
4. Dry runs and declined confirmations must leave files, branches, tags and remote state untouched; existing tags and a dirty tree must stop tagging (Task 3).
5. First-publish provenance must be disabled only for bootstrap; the normal staged manifest and CI releases retain provenance (Tasks 1, 2 and 4).

---

## Grounding and proposed bootstrap handling

Planning base: `main` at `ff59f61255e0710950906b5956219f541b05914a`. The workspace agent version is `0.0.0`; the changelog already contains `[0.1.0] - Unreleased`. `.github/workflows/release.yml` handles nax and nax-ai only. Agent coverage baseline has an empty `byFile`. S2-8's existing contract suite builds, stages, packs and installs the package; do not duplicate it.

The nax-ai release helper provides version bumps, confirmations, a PR-first flow and prefixed tags, but does **not** update the changelog or lockfile and performs `git pull` before a bump dry run. Copy its approach with the corrections below; do not refactor either existing releaser.

Official npm documentation checked 2026-10-03:

- [Trusted publishing](https://docs.npmjs.com/trusted-publishers/): npm >=11.5.1, hosted runners, package-settings configuration. Configure organization `nathapp-io`, repository `nax`, filename `release.yml`, environment `npm`, and enable direct `npm publish` for the new connection.
- [Provenance](https://docs.npmjs.com/generating-provenance-statements/): CI provenance needs a supported CI identity. The local bootstrap explicitly disables provenance; later CI releases enable it.
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/): use an explicit relative folder `./.publish/`; an existing name/version cannot be republished.
- [npm publishing 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/): interactive publication requires a 2FA prompt; changing package settings also requires 2FA. The maintainer completes these challenges locally during bootstrap and trusted-publisher setup.

The docs describe trust configuration through package settings; they do not explicitly assert that every possible first-publish path requires a manual publish. Retain the spec's expected manual bootstrap rather than claim a stronger npm limitation. npm now also documents staged publishing for new packages; adopting that is a separate design change, outside this plan.

**Proposed bootstrap exception for plan review:** after the manual 0.1.0 publish, configure its trusted publisher and push `nax-agent-v0.1.0`. That tag runs all checks, verifies the registry artifact against the prepared artifact (normalizing only the deliberately changed provenance setting), skips the already-completed npm upload, and creates the GitHub prerelease. No subsequent version gets this exception. This resolves the manual-bootstrap/tag-trigger collision without releasing an unrequested 0.1.1 just to test OIDC. OIDC is configured after bootstrap; its first actual upload remains a later maintainer-approved release.

## File map

| File | Responsibility |
|---|---|
| `packages/nax-agent/package.json`, `bun.lock` | 0.1.0 preparation, release script, workspace metadata consistency |
| `.github/workflows/release.yml` | agent tags, tagged checkout, checks, pin validation, publish route and release metadata |
| `packages/nax-agent/scripts/lib/bootstrap-artifact.ts` | compare the existing 0.1.0 tarball to the staged artifact, with one documented metadata exception |
| `packages/nax-agent/scripts/verify-bootstrap.ts` | fetch/unpack registry 0.1.0 into a temporary directory and invoke that comparison |
| `packages/nax-agent/scripts/lib/release-version.ts` | pure version/tag/changelog decisions |
| `packages/nax-agent/scripts/release.ts` | maintainer-facing PR-first release preparation and explicit tag confirmation |
| `packages/nax-agent/test/unit/packaging/{release-metadata,release-workflow,bootstrap-artifact,release-version,release-cli}.test.ts` | offline tests of real release decisions and shell branches |
| `packages/nax-agent/RELEASING.md`, `README.md`, `CHANGELOG.md` | first-publish procedure, discoverability and release notes |
| `.nax/context.md`, `.nax/mono/packages/nax-agent/context.md` | authoritative root/package agent context |
| Generated agent files from `nax generate` | reflect context sources; never edit manually |

### Task 1: Prepare the 0.1.0 manifest

**Files:** Modify `packages/nax-agent/package.json`, `bun.lock`; create `packages/nax-agent/test/unit/packaging/release-metadata.test.ts`.

**Interfaces:** Consume `buildStagedManifest(source, opts)` from `scripts/lib/stage-manifest.ts`. Produce workspace and staged version `0.1.0`, with existing dependency pins and exports preserved.

- [ ] **Step 1: Write `release-metadata.test.ts`**: read the real workspace manifest; assert version `0.1.0`, `private === true`, source `.`/`./internal` exports unchanged, nax-ai pin `0.1.16`. Feed it to `buildStagedManifest`; assert staged version `0.1.0`, no `private`, no scripts/devDependencies, Node floor `>=22.19.0`, provenance `true`, and exactly the two shipped entries.
- [ ] **Step 2: Run** `rtk bun test ./test/unit/packaging/release-metadata.test.ts --timeout=60000`. Expected: FAIL on current `0.0.0`.
- [ ] **Step 3: Set agent version to `0.1.0`**, retain `private: true`, run `rtk bun install` from root to update workspace metadata. Review lockfile changes: no unrelated resolved package upgrades. Leave the changelog Unreleased until the maintainer approves the actual release.
- [ ] **Step 4: Run the test again**, then `rtk bun run build` and `rtk bun run stage-publish`. Expected: PASS; staged version is `0.1.0`, workspace still resolves source.
- [ ] **Step 5: Commit** the manifest, lockfile and test as `chore(nax-agent): prepare 0.1.0 publish metadata`.

### Task 2: Wire agent releases into the workflow

**Files:** Modify `.github/workflows/release.yml`; create `scripts/lib/bootstrap-artifact.ts`, `scripts/verify-bootstrap.ts`, `test/unit/packaging/release-workflow.test.ts`, `test/unit/packaging/bootstrap-artifact.test.ts` under `packages/nax-agent`.

**Interfaces:** Workflow package outputs remain `dir`, `name`, `version`. Add pure `assertBootstrapArtifact(stagedDir: string, unpackedDir: string): void`; throw on any missing/extra file or differing bytes, except compare package manifests structurally after removing only `publishConfig.provenance`. Add CLI `bun scripts/verify-bootstrap.ts`: compare `.publish/` with registry `@nathapp/nax-agent@0.1.0`; fail on download/unpack/verification errors and clean temporary files in `finally`.

- [ ] **Step 1: Write failing workflow and artifact tests.** Extract the actual named shell `run: |` blocks from the workflow and execute them under Bash with temporary `GITHUB_OUTPUT` and fake `bun`/`npm` executables recording argv. Test:
  - `nax-agent-v0.1.0` resolves to agent/0.1.0; `nax-agent-v0.1.1-canary.1` resolves to agent/canary; existing nax/nax-ai routes unchanged; unknown prefix exits nonzero.
  - Stable agent 0.1.0 = latest/prerelease/notify=false; agent 1.0.0 = latest/not-prerelease; canary = canary/prerelease/notify=false.
  - Agent checks invoke `check:all`, `typecheck`, `build`, `check:api`, `test:coverage`, real-Node `test:node`, and final `stage-publish`. Any failed check prevents later commands.
  - Pin step reads the selected package's exact nax-ai pin; npm view failure stops release, including non-404 failures. Version mismatch stops release.
  - Agent publish targets `./.publish/`; nax/nax-ai target their existing directory. Canary sets the effective staged `publishConfig.tag` to `canary` as well as passing the CLI tag, so default latest cannot win.
  - Only agent 0.1.0 may bypass upload, and only after successful bootstrap verification. A genuine E404 follows normal publish; timeout/E401 never imply absence. Agent 0.1.1 existing-version failure is preserved.
  - Workflow checkout `ref` uses the dispatch tag or pushed tag, with full history; validate the selected tag before checks. Avoid executing any external action in these tests.
  - Artifact comparator accepts only provenance true/false difference; differing JS, declaration, README, missing/extra file, dependency, version, repository, export or engine fails. Reordered JSON object keys do not fail.
- [ ] **Step 2: Run** `rtk bun test ./test/unit/packaging/release-workflow.test.ts ./test/unit/packaging/bootstrap-artifact.test.ts --timeout=60000`. Expected: FAIL for missing agent arm/comparator.
- [ ] **Step 3: Implement the workflow arms and bootstrap verifier.** Add pushed tag patterns `nax-agent-v*.*.*` and `nax-agent-v*.*.*-canary.*`; resolve that prefix before generic `v*`. Keep Node 24, Bun 1.4.0, environment `npm`, `id-token: write` and contents permission. Verify installed npm satisfies >=11.5.1 (fail clearly otherwise). Install `bubblewrap`, `socat`, `ripgrep` for the Linux sandbox smoke, matching CI. Pin lookup runs for nax and agent using `steps.pkg.outputs.dir`. Add the 0.1.0-only existing-artifact branch before upload, retaining the normal GitHub Release steps. Use subprocess argv arrays and an isolated temporary pack directory in the bootstrap verifier; no shell interpolation of registry content. Bound registry/subprocess operations so failures exit within the workflow timeout; increase the current 15-minute timeout only if measured checks require it.
- [ ] **Step 4: Run both tests again** plus `rtk bun run typecheck` and `rtk bun run check:all`. Expected: PASS. Inspect the workflow diff: existing nax/nax-ai publication paths, release-note extraction and notification routing retain their behavior.
- [ ] **Step 5: Commit** as `feat(nax-agent): wire tagged releases and bootstrap verification`.

### Task 3: Add the maintainer release helper

**Files:** Create `packages/nax-agent/scripts/lib/release-version.ts`, `scripts/release.ts`, `test/unit/packaging/release-version.test.ts`, `test/unit/packaging/release-cli.test.ts`; modify agent `package.json` with `release: "bun scripts/release.ts"`.

**Interfaces:** Pure exports: `bumpVersion(current: string, kind: string): string`, `distTagsFor(version: string): string[]`, `updateChangelog(text: string, version: string, date: string): string`. CLI: `bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>`. Tag prefix `nax-agent-v`; release branch `release/nax-agent-v<version>`.

- [ ] **Step 1: Write failing version and CLI tests.** Assert 0.1.0 → patch 0.1.1/minor 0.2.0/major 1.0.0/canary 0.1.1-canary.1; canary.1 → canary.2; promote strips canary only; malformed versions and invalid promote throw; explicit 0.2.0 works. Stable dist tag = latest, canary = canary. Changelog dates the matching Unreleased heading while preserving its notes; subsequent bumps promote a `[Unreleased]` section, and absent/duplicate target notes fail before mutation. Spawn the copied CLI in a temporary local git repo with fake git/gh commands that log calls: dry-run patch/tag must not pull/write/commit/push/create a PR; declined prompt leaves everything untouched; dirty/non-main/existing-tag checks fail before side effects; confirmed bump stages package.json, CHANGELOG.md and root bun.lock only; failed git push prevents PR creation. Ensure fake commands cannot reach a real remote.
- [ ] **Step 2: Run** `rtk bun test ./test/unit/packaging/release-version.test.ts ./test/unit/packaging/release-cli.test.ts --timeout=60000`. Expected: FAIL, helpers/CLI absent.
- [ ] **Step 3: Implement the pure helpers and CLI**, following nax-ai's PR-first workflow with those tests' corrections. Resolve package/root paths from the script, validate all input before mutations, and perform mutation only after confirmation. Real bump updates version/changelog then runs `bun install` at root before staging the exact three files. Use `execFileSync` argv arrays. Write PR body to a temporary file and pass `gh pr create --body-file`; clean it. Tagging checks main and clean tree, rejects an existing tag, and requires a separate confirmation explaining publication. Dry-run tag reports the bootstrap behavior for 0.1.0 and normal OIDC for later versions. No automatic tag after bump/merge.
- [ ] **Step 4: Rerun both tests**, `rtk bun run typecheck`, `rtk bun run check:all`, and `rtk bun run release --dry-run minor`. Expected: PASS; dry run reports 0.2.0, `nax-agent-v0.2.0`, latest and no changes. Test tag dry-run through the isolated fixture if the working branch is not main.
- [ ] **Step 5: Commit** as `feat(nax-agent): add PR-first release helper`.

### Task 4: Document bootstrap and regenerate context

**Files:** Create `packages/nax-agent/RELEASING.md`; modify agent `README.md`, root/package `.nax/context.md` sources; regenerate configured agent files. Actual release approval later permits dating `CHANGELOG.md`.

**Interfaces:** Consume existing `build`, `stage-publish`, `test:node` and Task 3 release CLI. Produce a maintainer runbook distinguishing preparation, approved bootstrap, and future tagged releases.

- [ ] **Step 1: Write `RELEASING.md`** with these exact phases and commands (every package command prefixed `rtk`, cwd explicitly stated):
  1. Merge preparation only after its review and CI. On clean main, verify release version/changelog, own empty coverage baseline, Node matrix and published nax-ai pin. Obtain separate approval for the billed S1-recipe smoke before launching it; locate the actual S1 acceptance recipe rather than invent a substitute. Record its result or leave final acceptance pending.
  2. Ask the maintainer to approve publication of the concrete 0.1.0 artifact. Date its changelog and merge that release preparation before building the final artifact. Run agent gates/build/Node pack smoke, then `stage-publish` from that exact clean merged commit. Inspect `rtk npm pack ./.publish/ --dry-run --json`.
  3. **Maintainer-operated publish and OTP/2FA checkpoint:** prepare the artifact and exact command first, then hand off to the maintainer's interactive local terminal. For the local bootstrap, change **only** `.publish/package.json`'s `publishConfig.provenance` to `false` with a small Node command (read/parse/write, no workspace edit). Verify name/version/dependencies/exports unchanged. The maintainer authenticates with npm and runs `rtk npm publish ./.publish/ --access public --tag latest --provenance=false`, completing npm's OTP/2FA challenge directly in the terminal or browser as prompted. Do not ask for an OTP in chat or put an OTP/token into a script, committed file, CI secret or agent tool call. If the prompt expires or publication fails, verify registry state before retrying; do not proceed to trust setup until 0.1.0 is confirmed published. Re-run `stage-publish` afterward to restore its normal provenance setting.
  4. **Maintainer-operated settings checkpoint:** configure the trusted publisher with exact fields from the sources above, including direct publish permission, and complete npm's settings 2FA challenge. Verify registry 0.1.0/version/dist-tag, then run the bootstrap comparator. After maintainer tag approval, `rtk bun run release tag` triggers checks and the verified upload skip, then creates the GitHub prerelease. Do not rerun a normal upload of 0.1.0; a mismatch stops for investigation. Subsequent OIDC publishes use the configured CI identity without the maintainer supplying an OTP for each publish.
  5. Install registry `@nathapp/nax-agent@0.1.0` into a fresh temporary Node project and run the existing `test/node/fixtures/packed-smoke.mjs` against it on Node 22 and 24 (Linux must exercise sandbox). Confirm supported exports and no source/test payload. Record registry URL, GitHub Release/tag, artifact integrity and acceptance evidence in arc §5; S2 is complete only after required acceptance and publish, not after the wiring PR.
  6. Future releases use bump PR → review/merge → explicit tag confirmation. Maintain release order; configure a `[Unreleased]` notes section before the next bump. The first future OIDC upload verifies provenance; it is not authorized just to test this plan.
- [ ] **Step 2: Update context sources and README.** Root layout calls agent a published Node library also bundled into nax; release table lists all three prefixes and order. Package context explains workspace-private versus published staged manifest, adds `stage-publish`, `test:node`, release commands and Node contract testing, removes “nothing to publish,” and corrects stale “node:/bun builtins” language for shipped source. Link `RELEASING.md` from README; do not add the runbook to the shipped payload (stage currently copies only README/CHANGELOG/LICENSE/dist).
- [ ] **Step 3: Regenerate**, from root: `rtk bun packages/nax/bin/nax.ts generate` (allowed equivalent of `nax generate`; never `bun run nax`). Inspect generated root/package agent-file diffs. Run generator again and confirm no second-run diff. Do not edit generated files by hand or include unrelated generated churn.
- [ ] **Step 4: Verify the documented bootstrap transformation** against a temporary copy of the staged manifest: only provenance changes; regeneration restores true. Verify documentation links and remove stale private-only wording from the affected context. No production test required for prose.
- [ ] **Step 5: Commit** as `docs(nax-agent): document bootstrap and public package releases`.

### Task 5: Verify preparation and hand off the approved release

**Files:** No product changes anticipated. Record progress and evidence in arc §5; fixes remain in the owning task's files.

**Interfaces:** Consume Tasks 1–4; produce a reviewable wiring PR and a separate release approval checkpoint.

- [ ] **Step 1: Run root gates**, from root: `rtk bun run typecheck`, `rtk bun run check:all`, `rtk bun run test`, `rtk bun run build`. Expected: exit 0 for each. From agent run `rtk bun run check:api`, `rtk bun run test:coverage`; expected unchanged API and empty baseline. Run `rtk bun run test:node` under real Node 22 and 24 with existing CI sandbox prerequisites; retain matrix evidence. Do not claim the whole floor pack smoke runs at 22.19.0: D22's exact-floor job covers glob only.
- [ ] **Step 2: Check CLI preservation** against planning base: nax dependency object byte-identical, agent bundled via `check:bundle-externals`, existing `--help`, `--version`, `config`, `auth list`, `agents` smokes as applicable. Spec's `models` entry is stale (not a nax CLI command); retain the previously recorded correction. Run stateful/auth commands with hermetic fixtures.
- [ ] **Step 3: Review the stabilized diff** against S2 §8 and acceptance. Re-run only gates affected by fixes. Prepare title/body around release wiring and maintainer bootstrap; user approval precedes push/PR where the arc requires it. Preserve any supplied execution method.
- [ ] **Step 4: Update arc §5** with plan, implementation branch/commits, PR and merge evidence. Record “release-ready; first publish pending approval” once preparation is merged. Do not mark S2 complete yet.
- [ ] **Step 5: Present the concrete release checkpoint**: exact merged commit, version 0.1.0, pack inventory, dependency pin, CI/coverage/API evidence, billed-smoke result or pending approval, bootstrap command and follow-up trust/tag procedure. Execute Task 4's external steps only once the required maintainer approvals arrive, then record final release/acceptance in arc §5.

## Coverage and handoff

Spec §8 maps to Tasks 1–4 (tags, metadata, checks, pin, staged publication, helper, first-publish runbook and contexts). Spec §10 maps to Task 5 and the post-publish smoke in Task 4. The five review risks have tests in their owning tasks. No runtime/session/API behavior changes are planned.

Recommended execution: native/inline, because the workflow and release helper share a small set of decisions and can be tested without live publication. Plan review must approve the proposed 0.1.0 bootstrap exception before implementation; publication and billed-smoke approval remain separate.
