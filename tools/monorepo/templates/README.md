# nax monorepo

| Package | Path | npm |
|---|---|---|
| nax (CLI orchestrator) | [`packages/nax`](packages/nax) | `@nathapp/nax` |

Bun workspaces (isolated linker). From the root, `bun install` then `bun run build | typecheck | lint | check:all | test`
run every package in dependency order. Package docs: [`packages/nax/README.md`](packages/nax/README.md).
Releases are tag-driven: `vX.Y.Z` publishes `@nathapp/nax`.
