# Releasing nax-agent

Release preparation is PR-first. A merged preparation PR does not publish; the
maintainer separately approves each npm publish and tag push. `0.1.0` is bootstrapped
manually, then later versions use GitHub Actions trusted publishing (OIDC).

Use Bun 1.4.0 and Node 24 with npm >=11.5.1 for preparation. Release order is
**nax-ai → nax-agent → nax**. The agent workspace manifest remains `private: true`
and resolves TypeScript source; npm receives the generated `.publish/` manifest.

## Prepare the first release

Merge the release-wiring PR after review and green CI. On clean, up-to-date main,
obtain approval for the concrete `0.1.0` release. From `packages/nax-agent`:

```sh
rtk bun run release --dry-run 0.1.0
rtk bun run release 0.1.0
```

The second command requires confirmation and opens a PR dating the existing
0.1.0 changelog notes. Review and merge it, then update main. Do not bump to
0.1.1 to perform the first publish. Build the artifact from this exact merged
commit and record its SHA.

The S2 acceptance smoke reuses the maintainer's S1 clamp-helper PRD and native
provider on a fresh fixture copy, with the PRD status reset and no new `nax plan`.
See the [S1 acceptance contract](../../docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md#9-acceptance).
The fixture copy needs `nax trust add <fixture-dir> --yes` first. This run is billed
and needs explicit approval **at launch**. Compare story outcome, tool-audit keys
and per-tool record shapes, cost-row schema including `catalogVersion`, and the
`run.start` commit stamp. Record the result before calling S2 acceptance complete.

From repository root, run:

```sh
rtk bun run typecheck
rtk bun run check:all
rtk bun run test
rtk bun run build
```

From `packages/nax-agent`, run:

```sh
rtk bun run check:api
rtk bun run test:coverage
rtk bun run test:node
rtk npm view @nathapp/nax-ai@0.1.16 version
rtk bun run stage-publish
rtk npm pack ./.publish/ --dry-run --json
```

Use the manifest's actual exact nax-ai pin if it changes. Own coverage must pass
with an empty `scripts/baselines/coverage-per-file-baseline.json` `byFile` object.
The supported API snapshot must match. CI must pass Node 22/24 contract and packed
smokes; Linux installs bubblewrap, socat and ripgrep and must exercise the sandbox.
The exact Node 22.19.0/macOS job separately proves glob behavior, not the full pack smoke.

## Manual publish: maintainer OTP/2FA step

The maintainer runs this step in their own interactive terminal. First review the
staged name, version, dependency pins, exports and file inventory. Then disable
provenance **only in the generated staging manifest**, from `packages/nax-agent`:

```sh
rtk node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const path = ".publish/package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));
if (pkg.name !== "@nathapp/nax-agent" || pkg.version !== "0.1.0") {
  throw new Error("Expected the approved nax-agent 0.1.0 artifact");
}
pkg.publishConfig.provenance = false;
writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
JS
rtk npm login
rtk npm publish ./.publish/ --access public --tag latest --provenance=false
```

Complete npm's OTP/2FA challenge in the terminal or browser as prompted. Do not
send an OTP in chat or store it in a script, repository file, CI secret or agent
tool call. Disabling provenance does not disable authentication or 2FA.

If the prompt expires or publish returns an error, check registry state before
retrying. Once a version exists, do not try to publish it again:

```sh
rtk npm view @nathapp/nax-agent@0.1.0 version dist.integrity
rtk npm view @nathapp/nax-agent dist-tags --json
rtk bun run stage-publish
rtk bun scripts/verify-bootstrap.ts
```

Restaging restores provenance `true`. The verifier fetches the registry tarball
and compares its complete file inventory, payload bytes and manifest, allowing
only the intended provenance metadata difference. A mismatch must be investigated;
it is never permission to overwrite or republish 0.1.0.

## Configure trusted publishing, then tag 0.1.0

Only after npm confirms the first publish, the maintainer opens the package's
npm settings, completes settings 2FA, and adds a GitHub Actions trusted publisher:

| Field | Value |
|---|---|
| Organization | `nathapp-io` |
| Repository | `nax` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | Enable direct `npm publish` |

The workflow uses GitHub-hosted runners and `id-token: write`. Its staged
`repository.url` points to `git+https://github.com/nathapp-io/nax.git` with
`directory: packages/nax-agent`.

After separate maintainer approval for the tag push, from `packages/nax-agent`
on clean main:

```sh
rtk bun run release --dry-run tag
rtk bun run release tag
```

The helper asks for confirmation before pushing `nax-agent-v0.1.0`. Its workflow
checks the tagged commit, reruns gates, verifies the already-published 0.1.0
artifact and skips the upload. It then creates the GitHub prerelease. The
upload-skip exception applies to agent 0.1.0 only. Registry/authentication errors
and payload mismatches fail the workflow.

Verify the registry version, latest dist-tag and GitHub prerelease. Install
`@nathapp/nax-agent@0.1.0` into a fresh temporary Node project and copy
`test/node/fixtures/packed-smoke.mjs` into it. Run `node packed-smoke.mjs` with
Node 22 and 24 (Linux sandbox prerequisites apply). The fixture uses a stub
provider, configures credentials and tests a tool round-trip and native turn.
Confirm the installed package contains dist and documentation only, no source,
tests or workspace-private dependencies. Record release URLs, tagged commit,
registry integrity and acceptance results in the arc tracking document. S2 is
complete only when publication and its acceptance requirements are fulfilled.

## S3 acceptance (0.2.0)

S3 is complete when the three checks of the S3 spec §10 pass on the release
candidate, the feature PR's merged `main` commit. Both real-provider runs are
billed and need explicit approval **at launch**.

1. **Packed chat smoke, stub provider.** CI's Node 22/24 contract job runs
   `test/node/pack-smoke.test.ts`, which now includes the S3 chat round-trip.
   Green CI on the release candidate is the evidence.
2. **Real-provider chat smoke on Node.** From `packages/nax-agent`:

   ```sh
   rtk bun run build && rtk bun run stage-publish
   PACK=$(mktemp -d) && CONSUMER=$(mktemp -d)
   rtk npm pack ./.publish/ --pack-destination "$PACK"
   cd "$CONSUMER" && npm init -y >/dev/null
   npm install --no-audit --no-fund "$PACK"/nathapp-nax-agent-*.tgz
   cp <repo>/packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs .
   node live-chat-smoke.mjs
   ```

   The script reads provider credentials from `~/.nax` (override with
   `NAX_GLOBAL_CONFIG_DIR`). Its model defaults to `minimax/MiniMax-M2.7`;
   override it with `NAX_AGENT_LIVE_MODEL`. It must print `live chat smoke ok`.
   Record the model, the cost line and the commit.
3. **`nax run` unchanged.** The billed S1-recipe smoke (see "Prepare the first
   release" above) on a fresh fixture copy at the release candidate: same story
   outcome, tool-audit keys and per-tool record shapes, cost-row schema, and a
   `run.start` `naxCommit` equal to the candidate.

## Subsequent releases

Add meaningful notes under a single `## [Unreleased]` heading. From
`packages/nax-agent` on clean main:

```sh
rtk bun run release --dry-run patch
rtk bun run release patch
```

The helper supports `canary`, `promote`, `patch`, `minor`, `major` or an explicit
version. It bumps package/changelog metadata, refreshes the root lockfile, commits
those files and opens a PR. Review and merge it; separately approve and run
`release tag`. The helper never tags automatically after preparing a PR.

Subsequent tags publish `.publish/` using OIDC with provenance and need no
maintainer OTP for each CI upload. Canary versions use the `canary` dist-tag;
stable versions use `latest`. Library 0.x versions are GitHub prereleases and
do not send nax's Telegram notification. The first subsequent approved publish
also verifies actual OIDC publication and provenance; configuring trust alone
does not prove that upload. Do not publish an extra version just to test it.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[publishing 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/).
