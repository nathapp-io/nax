# Releasing nax-agent-acp

nax-agent-acp and `@nathapp/nax-agent` share one version and are always released
together (S4 spec R10). Release order: **nax-ai -> nax-agent -> nax-agent-acp -> nax**.
Nothing is released before S4 acceptance (S4-6): a partial `./client` is never published.

All commands run from `packages/nax-agent`, whose release helper bumps both packages.
Every publish and every tag push needs separate maintainer approval.

## Prepare a release

Add notes under `## [Unreleased]` in BOTH `packages/nax-agent/CHANGELOG.md` and
`packages/nax-agent-acp/CHANGELOG.md`. On clean, up-to-date main:

```sh
rtk bun run release --dry-run minor
rtk bun run release minor
```

The helper sets both versions, dates both changelogs, refreshes the lockfile and
opens one PR. Review and merge it.

## Publish nax-agent, then nax-agent-acp

1. `rtk bun run release tag` pushes `nax-agent-vX.Y.Z` (see `packages/nax-agent/RELEASING.md`).
   Wait until `rtk npm view @nathapp/nax-agent@X.Y.Z version` prints the version.
2. `rtk bun run release --dry-run tag-acp`, then `rtk bun run release tag-acp`. It refuses
   while the two versions differ or while nax-agent X.Y.Z is not on npm. The workflow
   reruns the gates, checks the peer again, and publishes `.publish/` (peer `^X.Y.Z`).

## S4 acceptance (0.3.0)

S4 is complete when the four checks of the S4 spec §11 pass on the release
candidate, the S4-6 PR's merged `main` commit. The live smoke is billed and needs
explicit approval **at launch**.

1. **CI.** Green on the candidate: `nax-agent-acp` (unit, fake-agent conformance,
   MCP security tests, coverage, API snapshot) and `nax-agent-acp: node 22/24`
   (Node contract suite and the packed smoke of both tarballs).
2. **Live Claude smoke (billed).** From the repo root on the candidate:

   ```sh
   (cd packages/nax-agent && rtk bun run build && rtk bun run stage-publish)
   (cd packages/nax-agent-acp && rtk bun run build)
   ```

   Then pack both at one version, as `test/node/pack-smoke.test.ts` does. Before the
   release PR merges, give the staged nax-agent copy the acp version. After that PR,
   `rtk bun run stage-publish` works for both packages directly. Install both
   tarballs into a fresh `npm init -y` project, copy
   `packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs` into it, and run:

   ```sh
   node live-claude-smoke.mjs
   ```

   It needs a Claude Code login (or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`).
   `NAX_AGENT_ACP_LIVE_MODEL` picks a model. It must print `live claude smoke ok`.
   Record the printed JSON (model, per-phase usage, whether a question was observed,
   the first resumed turn's cost), the total cost and the commit in the master plan.
   A question that is not observed is recorded, not failed.
3. **Initialize-only smoke.** In the same project, copy
   `test/node/fixtures/init-smoke.mjs` and run `node init-smoke.mjs`. It starts each
   installed non-Claude agent (codex, gemini, opencode, pi), sends `initialize` and
   `session/new`, and prompts nothing. Record the capability lines as the master
   plan's capability matrix.
4. **nax unaffected.** `git diff --exit-code <S4 base> -- packages/nax/` is empty
   apart from the lockfile, and the nax suite and `bun run typecheck` pass. The S4-0
   and S4-6 billed `nax run` S1-recipe smoke results are already recorded.

## First publish: 0.3.0 (manual, maintainer 2FA)

npm trusted publishing needs an existing package, so 0.3.0 follows the D23 procedure
used for nax-agent 0.1.0. After nax-agent 0.3.0 is on npm, from `packages/nax-agent-acp`:

```sh
rtk bun run check:all && rtk bun run typecheck && rtk bun run build
rtk bun run check:api && rtk bun run test:coverage && rtk bun run test:node
rtk bun run stage-publish
rtk npm pack ./.publish/ --dry-run --json
```

Review the staged name, version, `peerDependencies` (`^0.3.0`), exports and file
inventory. Then disable provenance in the staging manifest only, and publish in the
maintainer's own terminal:

```sh
rtk node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const path = ".publish/package.json";
const pkg = JSON.parse(readFileSync(path, "utf8"));
if (pkg.name !== "@nathapp/nax-agent-acp" || pkg.version !== "0.3.0") {
  throw new Error("Expected the approved nax-agent-acp 0.3.0 artifact");
}
pkg.publishConfig.provenance = false;
writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
JS
rtk npm publish ./.publish/ --access public --tag latest --provenance=false
```

Never send an OTP in chat or store it anywhere. If publish errors, check registry
state before retrying, and never republish an existing version:

```sh
rtk npm view @nathapp/nax-agent-acp@0.3.0 version dist.integrity
rtk bun run stage-publish
rtk bun ../repo-tooling/scripts/verify-bootstrap.ts --package=. --version=0.3.0
```

Then add the trusted publisher in the package's npm settings (2FA), with the same values
as nax-agent: organization `nathapp-io`, repository `nax`, workflow `release.yml`,
environment `npm`, allowed action "Enable direct `npm publish`" (`--allow-publish`).
An entry without the publish action fails later uploads with E403 "OIDC permission
denied for this action".

Finally `rtk bun run release tag-acp` from `packages/nax-agent`: the 0.3.0 tag verifies
the already-published artifact, skips the upload and creates the GitHub prerelease.
Later versions publish through OIDC with provenance.
