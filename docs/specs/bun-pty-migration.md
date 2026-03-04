# BUN-001: Bun PTY Migration

**Version:** v0.18.5  
**Status:** Planned  
**Author:** Nax Dev  
**Date:** 2026-03-04

---

## Problem

nax uses `node-pty` (a native C++ addon) to spawn interactive Claude Code sessions and drive the TUI. This creates several pain points:

| Pain Point | Impact |
|:---|:---|
| Requires `python`, `make`, `g++` at build time | CI `before_script` must `apk add python3 make g++`; `--ignore-scripts` is a fragile workaround |
| Native build fails on Alpine if workaround is removed | Blocks moving to 1GB runners (CI-001) |
| Not Bun-native — `require("node-pty")` uses CJS | Inconsistent with Bun-first codebase |
| No type safety without `@types/node-pty` | Interface `IPty` lives in node-pty types |

---

## Solution

Replace `node-pty` with **`Bun.spawn`** configured with `stdin: "pipe"` and `stdout: "pipe"` for interactive mode, OR `Bun.Terminal` API if it provides PTY semantics in Bun 1.3.7+.

### Research Gate (first task)

Before writing any code, verify Bun PTY support:

```bash
# Check if Bun.Terminal exists
bun -e "console.log(typeof Bun.Terminal)"

# Check for any PTY-related Bun APIs
bun -e "console.log(Object.keys(Bun).filter(k => k.toLowerCase().includes('pty') || k.toLowerCase().includes('term')))"
```

**If `Bun.Terminal` is available:** Use it directly for full PTY semantics.  
**If not available:** Use `Bun.spawn` with piped stdio. Claude Code works headlessly — no raw TTY required for nax's use case.

---

## Scope

### Files to change

| File | Change |
|:---|:---|
| `src/agents/claude.ts` | `runInteractive()` — replace `nodePty.spawn()` with Bun equivalent |
| `src/agents/types.ts` | `PtyHandle` interface — remove dependency on `IPty` |
| `src/tui/hooks/usePty.ts` | Replace `nodePty.spawn()` + `pty.IPty` state with Bun equivalent |
| `package.json` | Remove `node-pty` from `dependencies` |
| `.gitlab-ci.yml` | Remove `--ignore-scripts` from both `bun install` calls |
| `.gitlab-ci.yml` | Remove `python3 make g++` from `apk add` in `before_script` |

### Files NOT to change

- `src/agents/adapters/` — use `runInteractive()` via interface only
- `src/pipeline/` — no pty usage
- Test files — `_deps` pattern already covers mocking

---

## Implementation Plan

### Phase 1 — Research

1. Run research gate on Mac01 (Bun 1.3.9) to confirm `Bun.Terminal` availability
2. Test `claude -p "hello"` with `Bun.spawn` piped stdio to confirm headless operation
3. Determine if `resize()` is actually called during nax runs (check execution logs)

### Phase 2 — `src/agents/claude.ts`

Replace `runInteractive()`:

```typescript
// BEFORE (node-pty)
const ptyProc = nodePty.spawn(cmd[0], cmd.slice(1), {
  name: "xterm-256color", cols: 80, rows: 24,
  cwd: options.workdir, env: this.buildAllowedEnv(options),
});
ptyProc.onData((data) => options.onOutput(Buffer.from(data)));
ptyProc.onExit((e) => options.onExit(e.exitCode));

// AFTER (Bun.spawn)
const proc = Bun.spawn(cmd, {
  cwd: options.workdir,
  env: { ...this.buildAllowedEnv(options), TERM: "xterm-256color" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
// Stream stdout chunks to onOutput
(async () => {
  for await (const chunk of proc.stdout) {
    options.onOutput(Buffer.from(chunk));
  }
})();
proc.exited.then((code) => options.onExit(code ?? 1));
```

New `PtyHandle` mapping:

| `IPty` API | Bun equivalent |
|:---|:---|
| `ptyProc.write(data)` | `proc.stdin.write(data)` |
| `ptyProc.kill()` | `proc.kill()` |
| `ptyProc.pid` | `proc.pid` |
| `ptyProc.resize(c, r)` | no-op (or `Bun.Terminal.resize()` if available) |

### Phase 3 — `src/tui/hooks/usePty.ts`

Replace `pty.IPty` state with `Bun.Subprocess`:

```typescript
// Remove:
import type * as pty from "node-pty";
const [ptyProcess, setPtyProcess] = useState<pty.IPty | null>(null);

// Replace with:
const [proc, setProc] = useState<ReturnType<typeof Bun.spawn> | null>(null);
```

All `ptyProc.*` calls map directly to Bun subprocess equivalents.

### Phase 4 — CI cleanup

```yaml
# before_script: remove python3 make g++
- apk add --no-cache git

# bun install: remove --ignore-scripts
- bun install --frozen-lockfile
```

### Phase 5 — package.json

Remove `"node-pty": "^1.1.0"` from `dependencies`.

---

## Acceptance Criteria

| # | Criteria |
|:---|:---|
| AC1 | `node-pty` removed — `bun install` completes without native build |
| AC2 | `bun run typecheck` passes — no `IPty` or `node-pty` references |
| AC3 | CI `before_script` no longer installs `python3 make g++` |
| AC4 | CI `bun install` runs without `--ignore-scripts` |
| AC5 | `runInteractive()` spawns Claude Code via `Bun.spawn` — sessions complete |
| AC6 | `usePty` hook — output streams and lifecycle work correctly |
| AC7 | All existing tests pass (2126 pass, 0 fail) |
| AC8 | `nax run` works end-to-end on Mac01 with a real story |

---

## Risks

| Risk | Mitigation |
|:---|:---|
| `Bun.Terminal` not available/stable in 1.3.9 | Fall back to `Bun.spawn` pipe mode (test first) |
| Claude Code requires a real PTY | Test `claude -p "hello"` piped before committing |
| TUI rendering degrades without PTY | Acceptable — TUI is rarely used in headless nax runs |
| `resize()` breaks | nax doesn't actively call resize during agent sessions; safe no-op |

---

## Out of Scope

- `Bun.Terminal` advanced features (if not stable)
- CI-001 memory sharding (separate item)
- Windows PTY support
