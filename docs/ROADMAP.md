# nax Roadmap

> **Authoritative source** for planned work and the shipped history summary.
> Release notes: git tags (`git tag`) and [`packages/nax/CHANGELOG.md`](../packages/nax/CHANGELOG.md) (the changelog is current only to 0.51.2; newer releases are described by their tags and merged PRs).
> Design records: [`docs/adr/`](adr/) and [`docs/specs/`](specs/).

---

## Current status (2026-10-16)

- **Released:** v0.88.0 (stable, 2026-10-16). `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` share one version and release together.
- **Default execution mode:** workflow ([guide](guides/workflow-mode.md), [ADR-034](adr/ADR-034-workflow-execution-mode.md)). The pipeline mode is deprecated and frozen.
- **Stable is not yet 1.0.0.** The packages are versioned in lockstep and will move to 1.0.0 together.

---

## Shipped

### Recent milestones

| Release | Date | Theme |
|:--------|:-----|:------|
| v0.88.0 | 2026-10-16 | Workflow mode is the default; pipeline mode deprecated. Configurable branch-fix rounds and a final-gate repair pass. Sandboxed Bash for reviewers and ACP Claude implementers. Workflow publish integrity and pre-release hardening. CI time cut |
| v0.87.1 | 2026-10-12 | Config reads gated on a secret scan (writes stay refused). Native session transcripts archived on close. ACP MCP tool delivery |
| v0.87.0 | 2026-10-11 | Finish rebuilt as a branch review that always opens a PR, with no escalation and honest stop reporting |
| v0.86.0 | 2026-10-10 | Advisor rules on judgment calls instead of stopping the run (A1) |
| v0.85.x | 2026-10-09 to 10-10 | Shared MCP connection layer in `@nathapp/nax-agent/mcp`. Compacted conversational sessions by default. Zed walkthrough for the ACP server |
| v0.84.0 | 2026-10-09 | `nax-agent` ACP server: session persistence, settings switch, login and terminal auth methods. Lockstep versioning starts |
| v0.83.6 | 2026-10-08 | ACP SDK transport replaces the acpx transport for `nax run` |
| v0.83.x | 2026-09-30 to 10-08 | ACP SDK adapter behind `agent.acp.transport`. First published `@nathapp/nax-agent` (2026-10-03) and `@nathapp/nax-agent-acp` (2026-10-06) packages |

### Earlier milestones

Releases from v0.52 to v0.80 are recorded in git tags and in the merged PRs for those tags; the milestones below are the ones still referenced by the current docs.

| Release | Date | Theme |
|:--------|:-----|:------|
| v0.51.x | 2026-03-21 to 03-22 | Last release covered by the CHANGELOG |
| v0.49.0 | 2026-03-18 | Per-package config override for monorepos (`.nax/mono/<pkg>/config.json`) |
| v0.47.0 | 2026-03-17 | Monorepo workdir support: per-story working directory, per-package context |
| v0.44.0 | 2026-03-16 | ACP session lifecycle |
| v0.40.0 | 2026-03-12 | Acceptance test pipeline |
| v0.39.0 | 2026-03-12 | Init enhancement (auto-detect, context generation) |
| v0.36.0 | 2026-03-10 | Multi-agent adapters |
| v0.35.0 | 2026-03-09 | Agent abstraction layer |
| v0.34.0 | 2026-03-09 | Run lifecycle hooks and smart regression |
| v0.33.0 | 2026-03-09 | Story decomposer (`nax plan --decompose`) |
| v0.25.0 | 2026-03-07 | Trigger completion (interaction triggers) |
| v0.24.0 | 2026-03-07 | Central run registry |
| v0.23.0 | 2026-03-07 | Status file consolidation |
| v0.22.1 | 2026-03-07 | Pipeline re-architecture |
| v0.20.0 | 2026-03-06 | Verification architecture v2 |
| v0.18.0 | 2026-03-03 | Orchestration quality |
| v0.17.0 | 2026-03-02 | Config management |

### Items from the earlier backlog that have shipped

- **Scoped permissions** — `execution.permissions` per-stage `allow` / `deny` / `ask` rules and the `scoped` permission profile. See [Permissions](guides/permissions.md).
- **CI speed** — nax CI job time was cut (#2560, in v0.88.0): duplicate suite runs dropped and tests confined for parallel execution.

---

## Planned

- **Pipeline removal** — `execution.mode: "pipeline"` is deprecated and will be removed in a future release. Workflow mode is the only path that receives new work.
- **Auto-decompose oversized stories** — `nax plan --decompose <storyId>` is manual today. Offer or perform decomposition automatically when the precheck story-size gate triggers.
- **Cost tracking view across features and agents** — `nax status` shows per-run cost. A dedicated view that aggregates spend across features and agents is not built.
- **Fire plugin hooks on plan failure** — load plugins before the plan phase and emit `onRunEnd` with a failure status when `nax run --plan` fails.
- **`nax diagnose --ai`** — an LLM-assisted diagnostics command. No CLI command exists yet.
- **VitePress documentation site** — full CLI reference hosted as a standalone docs site. The docs are Markdown in `docs/` only.

---

## Versioning

- All four published packages share one version (lockstep). Never bump one package alone.
- From the repo root: `bun run release <patch|minor|major|canary|promote|X.Y.Z>` opens one release PR that bumps them all. `bun run release tag` pushes `vX.Y.Z`, and `release.yml` publishes in order: nax-ai, nax-agent, nax-agent-acp, nax.
- Canary: `vX.Y.Z-canary.N`, published under the `canary` npm tag. Stable: published under `latest`.
- Releases are maintainer-initiated. See [`RELEASING.md`](../RELEASING.md).
