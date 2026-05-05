# Context Engine v2 — Built-in Providers

## `context.v2.providers` configuration

These keys live under `context.v2.providers` in `.nax/config.json` (or per-package in `.nax/mono/<pkg>/config.json`).

| Key | Type | Default | Description |
|:----|:-----|:--------|:------------|
| `historyScope` | `"repo" \| "package"` | `"package"` | Working directory scope for `GitHistoryProvider`. `"package"` runs `git log` in `packageDir` (monorepo-safe). |
| `neighborScope` | `"repo" \| "package"` | `"package"` | Working directory scope for `CodeNeighborProvider`. `"package"` scans from `packageDir`. |
| `crossPackageDepth` | `number` | `1` | Cross-package scan depth for `CodeNeighborProvider`. `0` disables; `1` additionally scans workspace siblings. |
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
