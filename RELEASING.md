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
