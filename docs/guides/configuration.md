---
title: Configuration
description: How to configure nax
---

## Configuration

Config is layered — project overrides global:

| File | Scope |
|:-----|:------|
| `~/.nax/config.json` | Global (all projects) |
| `.nax/config.json` | Project-level override |

**Key options:**

```json
{
  "execution": {
    "maxIterations": 20,
    "costLimit": 5.0
  },
  "tdd": {
    "strategy": "auto"
  },
  "quality": {
    "commands": {
      "test": "bun test test/ --timeout=60000",
      "testScoped": "bun test --timeout=60000 {{files}}",
      "lint": "bun run lint",
      "typecheck": "bun x tsc --noEmit",
      "lintFix": "bun x biome check --fix src/",
      "formatFix": "bun x biome format --write src/"
    }
  }
}
```

### Shell Operators in Commands

Review commands (`lint`, `typecheck`) are executed directly via `Bun.spawn` — **not** through a shell. This means shell operators like `&&`, `||`, `;`, and `|` are passed as literal arguments and will not work as expected.

**❌ This will NOT work:**
```json
"typecheck": "bun run build && bun run typecheck"
```

**✅ Workaround — wrap in a `package.json` script:**
```json
// package.json
"scripts": {
  "build-and-check": "bun run build && bun run typecheck"
}
```
```json
// .nax/config.json
"quality": {
  "commands": {
    "typecheck": "bun run build-and-check"
  }
}
```

This limitation applies to all `quality.commands` entries (`test`, `lint`, `typecheck`, `lintFix`, `formatFix`).

---

### Scoped Test Command

By default, nax runs scoped tests (per-story verification) by appending discovered test files to the `test` command. This can produce incorrect commands when the base command includes a directory path (e.g. `bun test test/`), since the path is not replaced — it is appended alongside it.

Use `testScoped` to define the exact scoped test command with a `{{files}}` placeholder:

| Runner | `test` | `testScoped` |
|:-------|:-------|:-------------|
| Bun | `bun test test/ --timeout=60000` | `bun test --timeout=60000 {{files}}` |
| Jest | `npx jest` | `npx jest -- {{files}}` |
| pytest | `pytest tests/` | `pytest {{files}}` |
| cargo | `cargo test` | `cargo test {{files}}` |
| go | `go test ./...` | `go test {{files}}` |

If `testScoped` is not configured, nax falls back to a heuristic that replaces the last path-like token in the `test` command. **Recommended:** always configure `testScoped` explicitly to avoid surprises.

**TDD strategy options:** <a name="tdd-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags — simple→`tdd-simple`, security/public-api→`three-session-tdd`, else→`three-session-tdd-lite` |
| `strict` | Always use `three-session-tdd` (strictest — all stories) |
| `lite` | Always use `three-session-tdd-lite` |
| `simple` | Always use `tdd-simple` (1 session) |
| `off` | No TDD — tests written after implementation (`test-after`) |
