# nax monorepo

Bun-workspaces monorepo for **nax**, an AI coding-agent orchestrator, and the packages it is built from. Requires Bun (CI pins 1.4.3).

| Package | Path | npm | Published | Purpose |
|---|---|---|---|---|
| `@nathapp/nax` | [`packages/nax`](packages/nax) | `@nathapp/nax` | yes | The `nax` CLI: plans a feature into a PRD and runs agent sessions until the work is done. |
| `@nathapp/nax-ai` | [`packages/nax-ai`](packages/nax-ai) | `@nathapp/nax-ai` | yes | Provider-agnostic LLM client: completions, streaming, tool calls, usage and auth. |
| `@nathapp/nax-agent` | [`packages/nax-agent`](packages/nax-agent) | `@nathapp/nax-agent` | yes (staged manifest) | nax's native coding agent as a Node library: session contract, tools, permissions, sandbox. |
| `@nathapp/nax-agent-acp` | [`packages/nax-agent-acp`](packages/nax-agent-acp) | `@nathapp/nax-agent-acp` | yes (staged manifest) | ACP backend for nax-agent sessions (`./client`) and the `nax-agent` ACP server (`./server`). |
| `@nathapp/nax-repo-tooling` | [`packages/repo-tooling`](packages/repo-tooling) | none | no (private) | Check scripts and the release script shared by the packages. |
| `@nathapp/nax-test-kit` | [`packages/test-kit`](packages/test-kit) | none | no (private) | Shared `bun:test` helpers. |

`nax-agent` and `nax-agent-acp` are `private` in the workspace; their npm packages are generated into `.publish/` by `stage-publish`.

**Dependency direction.** `nax-ai` is used by `nax-agent`. `nax-agent` is used by `nax`, which bundles it, and by `nax-agent-acp` as a peer dependency. `nax` imports `nax-agent-acp` only through `@nathapp/nax-agent-acp/client`. `check:package-boundaries` (in `packages/nax`) enforces these rules.

**Root scripts** (run from the repo root; each runs the matching script in every package):

```bash
bun install
bun run build | typecheck | lint | check:all | test
bun run release [--dry-run] <patch|minor|major|canary|promote|X.Y.Z>   # opens the release PR
bun run release [--dry-run] tag                                        # pushes vX.Y.Z after the PR merges
```

**Releases are lockstep.** `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` share one version and publish together from one `vX.Y.Z` tag. Releases are maintainer-initiated. See [`RELEASING.md`](RELEASING.md).

**Start here**

- [`packages/nax/README.md`](packages/nax/README.md): the CLI.
- [`docs/README.md`](docs/README.md): the documentation index.
- [`docs/guides/workflow-mode.md`](docs/guides/workflow-mode.md): workflow mode, the default execution mode since v0.88.0.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md).
