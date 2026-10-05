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
