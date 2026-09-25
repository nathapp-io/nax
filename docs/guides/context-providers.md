# Context Engine v2 — Built-in Providers

## `context.v2.providers` configuration

These keys live under `context.v2.providers` in `.nax/config.json` (or per-package in `.nax/mono/<pkg>/config.json`).

| Key | Type | Default | Description |
|:----|:-----|:--------|:------------|
| `historyScope` | `"repo" \| "package"` | `"package"` | Scope post-filter for `GitHistoryProvider` (not a workdir switch). `git log` always runs in `repoRoot` against repo-rooted paths; `"package"` filters history to files under the story's package (monorepo-safe default), `"repo"` keeps all story files. |
| `neighborScope` | `"repo" \| "package"` | `"package"` | Working directory scope for `CodeNeighborProvider`. `"package"` scans from `packageDir`, `"repo"` from `repoRoot`. |
| `sourceGlob` | `string?` | _(derived)_ | Override the source-file glob used for reverse-dep scanning. When omitted, derived from `detectLanguage(packageDir)` (TypeScript, Go, Python, Rust each get a narrow glob; unknown packages get the wide fallback). |
| `maxGlobFiles` | `number` | `500` | Maximum files scanned per directory during reverse-dep glob. Truncation logs at `warn` level and appends a note to the context chunk. |

### Language-derived glob defaults

When `sourceGlob` is not set, `CodeNeighborProvider` derives the glob from the detected language:

| Language | Glob |
|:---------|:-----|
| TypeScript | `**/*.{ts,tsx,js,jsx,mjs,cjs}` |
| JavaScript | `**/*.{js,jsx,mjs,cjs}` |
| Go | `**/*.go` |
| Python | `**/*.py` |
| Rust | `**/*.rs` |
| Unknown / polyglot | `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h}` |

### Monorepo per-package override example

A monorepo with a large Go backend package can narrow the scan and raise the cap independently of the TypeScript frontend:

```json
// .nax/mono/packages/api/config.json  (Go package)
{
  "context": {
    "v2": {
      "providers": {
        "sourceGlob": "**/*.go",
        "maxGlobFiles": 1000
      }
    }
  }
}
```

```json
// .nax/mono/packages/web/config.json  (TypeScript package)
{
  "context": {
    "v2": {
      "providers": {
        "maxGlobFiles": 300
      }
    }
  }
}
```

If `sourceGlob` is omitted from the per-package config, the glob is still auto-derived from the package's detected language.

## Provider scope — why there is no `cross-package` scope

Moved out of `.nax/rules/monorepo-awareness.md` §7, which retains the rule itself.

`CodeNeighborProvider`'s sibling scan (and its `crossPackageDepth` key, which now logs a removal warning and is ignored) was removed in nax#2074: it parsed only relative
import specifiers, so it could not find a true cross-package dependent, and it compared
paths across two roots. A provider that must see another package sets its scan root to
`repoRoot` and re-spells every emitted path for the consumer (`src/utils/path-frame.ts`).

`GitHistoryProvider` is repo-scoped even though it serves a package-contained story:
`git log` runs at `repoRoot` against repo-rooted pathspecs (nax#2088), and its
`historyScope` option is a **post-filter** over those entries — `"package"` drops entries
outside the story's package, `"repo"` keeps them — not a workdir switch. A chunk heading is
re-spelled package-relative because it is rendered into the agent's prompt; `scopePaths`
stay repo-rooted to match the repo-framed diff.
