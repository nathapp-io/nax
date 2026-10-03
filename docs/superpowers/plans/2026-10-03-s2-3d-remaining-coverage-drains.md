# S2-3d — Remaining coverage drains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empty nax-agent's per-file coverage baseline. The 14 files still under 80% lines on nax-agent's own tests all reach 80% and their entries are removed, so S2-9 (publish) is unblocked on the coverage criterion.

**Architecture:** Port-first, as in S2-3b/S2-3c. 103 nax tests that already exercise these files move into nax-agent (five whole-file moves of loop-event and compaction tests, one tool-mapping move, and three splits of nax files where only the part that never touches the nax shell moves). The seven files nax never covered directly get 31 new tests written for nax-agent. Nothing in `src/` changes. No assertion is edited except the logger-capture tokens (Rule L).

**Tech Stack:** Bun 1.4 workspaces (`linker = "isolated"`), TypeScript 7.0.2, `bun:test`, the repo-tooling coverage gate.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§7.2, R2) · split table in `docs/superpowers/plans/2026-10-02-s2-3a-nax-agent-coverage-gate.md` · rules reused from `2026-10-02-s2-3b-credential-coverage-drains.md` (Rule L) and `2026-10-03-s2-3c-tools-coverage-drains.md` (Rule I).

## Global Constraints

- Repo: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax`. Branch `feat/s2-3d-remaining-drains` cut from `origin/main`. Package commands run from the package directory. Never run bare `bun test` (no path) and never `bun run nax`.
- Floors (spec §7.2): **80% lines, 80% functions, 80% per file. "The gap is closed with new tests in nax-agent, never by lowering a floor."** After this PR the baseline is EMPTY (`"byFile": {}`).
- `packages/nax/package.json` **`dependencies` must stay byte-identical** to `main`. No `src/` file in any package is edited.
- **No ported test is edited to make it pass.** A ported file changes only (a) its location, (b) import specifiers per Rule I, (c) the logger-capture tokens in Rule L. Every other line is byte-identical (`git diff -M` shows renames).
- **Test counts are conserved per moved block**: the counts Task 0 records are the counts that must run green in the new location, and the remainder must run green in nax. Repo total changes only by the 31 new tests this plan lists (Task 1: 4 + 9 + 10 + 2 + 3 + 3).
- No nax or nax-agent `src/` file may newly fall below its per-file floor or below its baseline because a test left nax. The exposures: `src/logger/` (the loop-event ports no longer log through it), `src/agents/native-agent/index.ts`, `src/agents/cost/`. If any drops, stop and report; do not baseline it.
- Every commit leaves `bun run check:all` (repo root) and the touched unit suites green. Conventional commits, no emojis, no push and no PR without the maintainer's approval.
- Max 2 fix rounds per task review.
- Use the `S` scratch directory your session provides (Task 0 Step 1) for the two helper scripts; do not write them into the repo.

## Measured baseline (main @ `1eabf9d18`, this plan's work list)

nax-agent own gate: 2827 tests, 95.36% lines / 94.34% functions, 14 baselined files. Uncovered lines are from the gate's own lcov; "nax covers" was measured by running every one of the 156 nax test files that import `@nathapp/nax-agent` ALONE with `--coverage` and intersecting with the 14 files' uncovered lines.

| File | Now | Drain |
|---|---|---|
| `src/config/bash-approval.ts` | 42.86% | new `test/unit/config/bash-approval.test.ts` (4). nax's `bash-approval.test.ts` is nax config wiring (`makeNaxConfig`, `resolvePermissions`) and stays whole |
| `src/cost/estimate.ts` | 75.76% | new `test/unit/cost/estimate.test.ts` (9). nax's equivalents build rates with nax's config `toPricing`, so they stay |
| `src/cost/usage-math.ts` | 19.05% | port the `addTokenUsage` x3 and `inputClassTokens` describes of `calculate.test.ts` (16); `resolvePricingSource` and `formatCostWithConfidence` are nax-owned and stay (24 remain) |
| `src/internal/agent-output-env.ts` | 62.50% | +3 tests in the existing `test/unit/internal/agent-output-env.test.ts` (`withAgentOutputEnv`) |
| `src/internal/command-spec/index.ts` | 61.11% | new `test/unit/internal/command-spec.test.ts` (10) |
| `src/session/no-op-interaction-handler.ts` | 50.00% | new `test/unit/session/no-op-interaction-handler.test.ts` (2) |
| `src/session/session-types.ts` | 5.71% (`SessionTurnError`, 366-398) | new `test/unit/session/session-turn-error.test.ts` (3) |
| `src/native/session/tool-mapping.ts` | 66.67% | port `tool-mapping.test.ts` whole (3) |
| `src/native/session/loop-events/cache-boundary.ts` | 68.00% | port `transform-context.test.ts` (5) |
| `src/native/session/loop-events/payload-guard.ts` | 62.50% | port `payload-guard.test.ts` (6) |
| `src/native/session/loop-events/external-handler.ts` | 79.59% | port `external-handler.test.ts` (39) |
| `src/native/session/turn-compaction-step.ts` | 55.00% | port `turn-loop-compaction.test.ts` (21) + `before-compaction.test.ts` (3) + `transform-context.test.ts` |
| `src/native/session/turn-complete-step.ts` | 79.05% | same three ports |
| `src/native/session-adapter.ts` | 73.66% | new `test/unit/native/session-adapter.test.ts` (10): the session-method describes of nax's `adapter.test.ts` (4), the context-window describe of `adapter-complete-rates.test.ts` (4) and two `closePhysicalSession` tests of `adapter-close-physical-session.test.ts` (2), rebuilt on `NativeSessionAdapter`. The `summarize` closure (231-256) is reached only by the compaction-firing context-window case |

Per-file result with all of this applied (measured on a scratch build of exactly this plan): 2961 tests, 97.61% lines / 95.55% functions, **0 files below the floor**, 0 unreported src files.

Measured side effects the tasks pin:

- Two nax-agent escape-hatch counts grow because moved code carries them: `ratchetAllow` +4 (the BUG-10 malformed-operand cases in `usage-math.test.ts`) and `looseCast` +1 (`transform-context.test.ts`). Same mechanism as S2-3b's `auth-store-ops` move: nax's counts fall by the same amounts and both baselines are updated in the commit that moves the file.
- The lcov line numbers of some entries point at comment lines (Bun source-map noise, e.g. `usage-math.ts` 20-23); the per-file percentage the gate reports is what counts.

## Review Focus

1. **Logger slot restore leaks across files**: a ported test that calls `setAgentLogger(logger)` and fails before restoring leaves a mock logger installed for later files, and every later `getSafeLogger()` assertion then reads the wrong sink. Pinned in Task 4: every `resetLogger()` becomes `setAgentLogger(originalLogger)` in the SAME `finally`/`afterEach` position (Rule L), and Task 4 Step 5 runs the five ported files together with the rest of `test/unit/native` in one process.
2. **A split strands a helper**: cutting a describe out of a nax file leaves its private helper (`seedOversizedTranscript`, `sendCtxWin`, `openOpts`) behind, and Biome's unsafe fix renames it with a leading underscore instead of deleting it. Pinned in Tasks 2 and 5: the helpers are deleted by an explicit step and a grep proves none remains.
3. **nax loses coverage when 103 tests leave**: the loop-event ports were nax's only coverage of `src/logger/` paths in some cases, and the three splits shrink the files covering `src/agents/native-agent/index.ts`. Pinned in Task 6 Step 3: nax's own `test:coverage` stays green with no file newly below floor or baseline.
4. **The baseline update swallows a regression**: `--update-baseline` rewrites whatever it measures. Pinned in Task 6 Step 1: the gate is run GREEN on the old baseline first; the diff of the new baseline removes keys only and adds none; the escape-hatch baselines may only change by exactly the +4/+1 (nax-agent) and the matching decreases (nax).
5. **`withAgentOutputEnv` accepts an env with a marker and must return the SAME object, not a copy**: a caller compares by identity to skip a clone. Pinned in Task 1: `toBe(env)` for every marker and for the stripped-AGENT case, `toEqual` plus input-unmutated for the add case.

---

## Rule L — the logger-capture rewrite (Task 4, and nothing else changes)

Four of the five ported loop-event files capture log entries through nax's logger (`initLogger` / `addSink` / `resetLogger`). The mechanical replacement is the script in Task 4 Step 2, token by token:

1. `import { addSink, initLogger, resetLogger } from "@/logger"; import type { LogEntry } from "@/logger/types";` becomes
   ```ts
   import { getSafeLogger, setAgentLogger } from "#src/infra/index";
   import { type LogCall, makeLogger } from "#test/helpers/index";
   ```
   (`type LogCall,` is dropped from the import in files that never name it).
2. `const originalLogger = getSafeLogger();` is added at module scope after the imports.
3. Capture: `resetLogger(); const logCalls: LogEntry[] = []; initLogger({ level: "info", suppressConsole: true }); addSink((entry) => logCalls.push(entry));` becomes `const logger = makeLogger(); setAgentLogger(logger);`. The describe-scoped form in `turn-loop-compaction.test.ts` (`let logCalls: LogEntry[]` in a `beforeEach`) becomes `let logger: ReturnType<typeof makeLogger>;` and `logger = makeLogger(); setAgentLogger(logger);`.
4. Every remaining `resetLogger();` becomes `setAgentLogger(originalLogger);` in the same position.
5. `logCalls` becomes `logger.calls`; `LogEntry[]` becomes `LogCall[]`. `e.level`, `e.message`, `e.data` keep their names (`LogCall` carries the same fields).
6. `external-handler.test.ts` does not capture by sink: `from "@test/helpers"` becomes `from "#test/helpers/index"` (it already uses `withDebugSpy`/`withWarnSpy`/`withTimerSpy`, which nax-agent's helpers export under the same names) and the `Logger` type becomes `AgentLogger` from `#src/infra/index`.

`makeLogger`, `LogCall` and the spies are the existing exports of `packages/nax-agent/test/helpers/agent-logger.ts`; `getSafeLogger`/`setAgentLogger` the existing infra slot.

## Rule I — the import rewrite

- `from "@nathapp/nax-agent"` and `from "@nathapp/nax-agent/internal"`: **unchanged** (in-package self-imports are established practice).
- `from "@/context/engine"` (`ToolDescriptor`) becomes `from "#src/session/tool-descriptor"` (nax's `@/context/engine` re-exports it).
- `@/agents/cost` (the cost barrel) becomes the deep module `#src/cost/usage-math`, because nax's barrel is a nax-side re-export.
- `from "@/errors"` becomes the `/internal` entry (`NaxError` is the same class).
- Anything else that names `@/` or `@test/` is a nax-owned dependency: the test stays in nax (Rule S).

## Rule S — the split rule

A test stays in nax when its subject is nax wiring or nax data, not the nax-agent file being drained:

| Source file | Moves | Stays in nax | Reason |
|---|---|---|---|
| `agents/cost/calculate.test.ts` | `addTokenUsage`, `addTokenUsage — BUG-10 malformed operand guard`, `inputClassTokens`, `addTokenUsage key presence (S1-1)` (16 tests) | `resolvePricingSource`, `formatCostWithConfidence` (24) | nax-owned functions |
| `agents/native/adapter.test.ts` | `NativeAgentAdapter.sendTurn pricingSource`, `NativeAgentAdapter.closeSession after a failed turn` (4) | the `complete()` describes, shape, session identity (28) | the nax shell `NativeAgentAdapter` |
| `agents/native/adapter-complete-rates.test.ts` | `NativeAgentAdapter.sendTurn contextWindow override` (4) | everything else, including the config pricing override (`toPricing`, nax config) (18) | nax shell and nax config |
| `agents/native/adapter-close-physical-session.test.ts` | `physical close removes a successful session's transcript`, `a throwing transcript retain still clears every native map` (2) | `a keepOpen session's story close clears every native map` (1) | needs nax's `SessionManager` and `closeStorySessions` |

---

### Task 0: Branch, helpers and baseline records

**Files:** none in the repo (two helper scripts go in `$S`).

- [ ] **Step 1: Branch, install, scratch directory**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
git fetch origin && git switch -c feat/s2-3d-remaining-drains origin/main 2>/dev/null || git switch feat/s2-3d-remaining-drains
git rebase origin/main
bun install
S="<your session scratchpad directory>"; mkdir -p "$S"
```

Expected: clean tree on the branch. If `git log origin/main..HEAD` shows anything but the plan commit, stop.

- [ ] **Step 2: Write the two helper scripts to `$S`**

`cut_describe.py` (removes top-level `describe(...)` blocks and, with `--emit`, appends them to a new file; used by Tasks 2 and 5):

```bash
cat > "$S/cut_describe.py" <<'EOF'
#!/usr/bin/env python3
"""cut_describe.py FILE [--emit OUT] NAME...

Remove each top-level describe("NAME" ...) block (plus the comment block
directly above it and one trailing blank line) from FILE. With --emit, the
removed blocks are appended to OUT in the order given, separated by a blank
line, so a split is one command.
"""
import re
import sys

args = sys.argv[1:]
path = args.pop(0)
emit = None
if args and args[0] == "--emit":
    args.pop(0)
    emit = args.pop(0)


def cut(lines, name):
    start = next((i for i, l in enumerate(lines) if l.startswith(f'describe("{name}"')), None)
    if start is None:
        sys.exit(f"describe not found: {name}")
    end = next(i for i in range(start, len(lines)) if lines[i] == "});")
    top = start
    while top > 0 and re.match(r"^(//|/\*\*| \*)", lines[top - 1]):
        top -= 1
    block = lines[top : end + 1]
    if end + 1 < len(lines) and lines[end + 1] == "":
        end += 1
    return lines[:top] + lines[end + 1 :], block


lines = open(path).read().split("\n")
removed = []
for name in args:
    lines, block = cut(lines, name)
    removed.append("\n".join(block))
open(path, "w").write("\n".join(lines))
if emit:
    with open(emit, "a") as out:
        out.write("\n\n".join(removed) + "\n")
EOF
```

`port_loop_events.py` (Rule L; used by Task 4):

```bash
cat > "$S/port_loop_events.py" <<'EOF'
#!/usr/bin/env python3
"""Rule L: rewrite nax logger capture to the nax-agent logger slot in the four
ported loop-event files and turn-loop-compaction. Run from packages/nax-agent/test/unit/native."""
import re

CAPTURE_FILES = [
    "session/loop-events/payload-guard.test.ts",
    "session/loop-events/transform-context.test.ts",
    "session/loop-events/before-compaction.test.ts",
    "turn-loop-compaction.test.ts",
]
for f in CAPTURE_FILES:
    s = open(f).read()
    s = s.replace(
        'import { addSink, initLogger, resetLogger } from "@/logger";\nimport type { LogEntry } from "@/logger/types";\n',
        'import { getSafeLogger, setAgentLogger } from "#src/infra/index";\nimport { type LogCall, makeLogger } from "#test/helpers/index";\n',
    )
    lines = s.split("\n")
    last = max(i for i, l in enumerate(lines) if l.startswith("import ") or l.startswith("} from "))
    lines.insert(last + 1, "\nconst originalLogger = getSafeLogger();")
    s = "\n".join(lines)
    # inline capture inside a test body
    s = re.sub(
        r'resetLogger\(\);\n(\s*)const logCalls: LogEntry\[\] = \[\];\n\s*initLogger\(\{ level: "info", suppressConsole: true \}\);\n\s*addSink\(\(entry\) => logCalls\.push\(entry\)\);',
        r"const logger = makeLogger();\n\1setAgentLogger(logger);",
        s,
    )
    # payload-guard's captureWarnings helper
    s = re.sub(
        r'const logCalls: LogEntry\[\] = \[\];\n  resetLogger\(\);\n  initLogger\(\{ level: "info", suppressConsole: true \}\);\n  addSink\(\(entry\) => logCalls\.push\(entry\)\);',
        "const logger = makeLogger();\n  setAgentLogger(logger);",
        s,
    )
    s = s.replace("Promise<LogEntry[]>", "Promise<LogCall[]>")
    # describe-scoped capture in turn-loop-compaction
    s = s.replace("let logCalls: LogEntry[];", "let logger: ReturnType<typeof makeLogger>;")
    s = re.sub(
        r'resetLogger\(\);\n(\s*)logCalls = \[\];\n\s*initLogger\(\{ level: "info", suppressConsole: true \}\);\n\s*addSink\(\(entry\) => logCalls\.push\(entry\)\);',
        r"logger = makeLogger();\n\1setAgentLogger(logger);",
        s,
    )
    s = s.replace("resetLogger();", "setAgentLogger(originalLogger);")
    s = s.replace("logCalls", "logger.calls")
    if "LogCall" not in s.replace("import { type LogCall, makeLogger }", ""):
        s = s.replace("import { type LogCall, makeLogger }", "import { makeLogger }")
    open(f, "w").write(s)

f = "session/loop-events/external-handler.test.ts"
s = open(f).read()
s = s.replace('from "@test/helpers";', 'from "#test/helpers/index";')
s = s.replace('import type { Logger } from "@/logger";\n', 'import type { AgentLogger } from "#src/infra/index";\n')
s = s.replace('Mock<Logger["warn"]>', 'Mock<AgentLogger["warn"]>')
open(f, "w").write(s)
EOF
```

- [ ] **Step 3: Record the before counts**

```bash
cd packages/nax-agent && bun run test 2>&1 | grep -E "^ [0-9]+ (pass|fail)"   # expect 2827 pass (unit + integration lines)
bun run test:coverage:list 2>&1 | tail -22                                   # expect 14 baselined, lines 95.36%
cd ../nax
for f in agents/cost/calculate agents/native/adapter agents/native/adapter-complete-rates agents/native/adapter-close-physical-session agents/native/tool-mapping agents/native/turn-loop-compaction agents/native/session/loop-events/payload-guard agents/native/session/loop-events/transform-context agents/native/session/loop-events/before-compaction agents/native/session/loop-events/external-handler; do
  echo "$f $(bun test ./test/unit/$f.test.ts 2>&1 | grep -E '^ [0-9]+ pass')"; done
```

Expected nax per-file counts: calculate 40, adapter 32, adapter-complete-rates 22, adapter-close-physical-session 3, tool-mapping 3, turn-loop-compaction 21, payload-guard 6, transform-context 5, before-compaction 3, external-handler 39. If any differs, the base moved: recompute Rule S counts and the Global Constraints total before continuing.

- [ ] **Step 4: Record the nax escape-hatch baseline**

```bash
cd ../nax && cat scripts/baselines/test-escape-hatches-baseline.json | head -8
cd ../nax-agent && cat scripts/baselines/test-escape-hatches-baseline.json | head -8
```

Note the `ratchetAllow` and `looseCast` counts of both (nax-agent: `ratchetAllow` 0, `looseCast` 8 at plan time).

---

### Task 1: Six small drains with new tests

**Files:**
- Create: `packages/nax-agent/test/unit/config/bash-approval.test.ts`
- Create: `packages/nax-agent/test/unit/cost/estimate.test.ts`
- Create: `packages/nax-agent/test/unit/internal/command-spec.test.ts`
- Create: `packages/nax-agent/test/unit/session/no-op-interaction-handler.test.ts`
- Create: `packages/nax-agent/test/unit/session/session-turn-error.test.ts`
- Modify: `packages/nax-agent/test/unit/internal/agent-output-env.test.ts`

**Interfaces:**
- Consumes: `resolveBashApproval`, `BashApprovalModeSchema`, `DEFAULT_BASH_APPROVAL_MODE` (`#src/config/bash-approval`); `estimateCostUsd`, `priceCall` (`#src/cost/estimate`); `normalizeCommandSpec`, `containsShellChain`, `commandSpecIncludes`, `replaceInCommandSpec`, `renderCommandSpec` (`#src/internal/command-spec/index`); `NO_OP_INTERACTION_HANDLER` (`#src/session/no-op-interaction-handler`, also exported from `@nathapp/nax-agent`); `SessionTurnError` (`#src/session/session-types`); `AdapterFailure` (`#src/session/adapter-failure`, requires `retriable`); `AGENT_OUTPUT_MARKERS`, `withAgentOutputEnv` (`#src/internal/agent-output-env`).
- Produces: nothing later tasks use.

Each file below was run green on a scratch build of this plan (Biome-formatted, typechecked). `Pricing` and `PricingTier` require all four rate fields, so the estimate tests state them explicitly; nax's `toPricing` fill-in does not exist here.

- [ ] **Step 1: Write the five new files**

`test/unit/config/bash-approval.test.ts`:

```ts
/**
 * resolveBashApproval: per-stage mode wins over the global mode, which wins
 * over the schema default (ADR-030). Pure function, so no config is built.
 */

import { describe, expect, test } from "bun:test";
import { BashApprovalModeSchema, DEFAULT_BASH_APPROVAL_MODE, resolveBashApproval } from "#src/config/bash-approval";

describe("resolveBashApproval", () => {
  test("the per-stage mode wins over the global mode", () => {
    expect(resolveBashApproval("raw", "gated")).toBe("gated");
  });

  test("the global mode applies when the stage sets none", () => {
    expect(resolveBashApproval("escalate", undefined)).toBe("escalate");
  });

  test("the default applies when neither is set", () => {
    expect(resolveBashApproval(undefined, undefined)).toBe(DEFAULT_BASH_APPROVAL_MODE);
  });

  test("the default is raw and is a member of the schema", () => {
    expect(DEFAULT_BASH_APPROVAL_MODE).toBe("raw");
    expect(BashApprovalModeSchema.options).toContain(DEFAULT_BASH_APPROVAL_MODE);
  });
});
```

`test/unit/cost/estimate.test.ts`:

```ts
/**
 * priceCall / estimateCostUsd: tier selection, cache-rate fallback and the
 * rates recorded with each cost. Written for nax-agent in S2-3d: nax's
 * equivalent tests build their rates through nax's config `toPricing`, which
 * does not exist here, so these state `Pricing` directly.
 */

import { describe, expect, test } from "bun:test";
import type { Pricing, TokenUsage } from "@nathapp/nax-ai";
import { estimateCostUsd, priceCall } from "#src/cost/estimate";

const TIERED: Pricing = {
  input: 2,
  output: 12,
  cacheRead: 2,
  cacheWrite: 2,
  tiers: [
    { inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 4, cacheWrite: 4 },
    { inputTokensAbove: 500_000, input: 8, output: 24, cacheRead: 8, cacheWrite: 8 },
  ],
};

describe("estimateCostUsd", () => {
  test("1M input + 1M output at 2/10 per 1M costs 12", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 2, cacheWrite: 2 })).toBeCloseTo(12, 6);
  });

  test("cache reads and writes price at their own rates", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 })).toBeCloseTo(3, 6);
  });

  test("a call with no cache tokens costs only its input and output", () => {
    const usage: TokenUsage = { inputTokens: 500_000, outputTokens: 100_000 };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 99, cacheWrite: 99 })).toBeCloseTo(2, 6);
  });
});

describe("priceCall tier selection", () => {
  test("stays on the base rates when input-class usage does not exceed the first threshold", () => {
    const { costUsd, resolvedRates } = priceCall({ inputTokens: 100_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(2);
    expect(costUsd).toBeCloseTo(0.2, 6);
  });

  test("a threshold is exclusive: usage exactly at it keeps the lower rates", () => {
    const { resolvedRates } = priceCall({ inputTokens: 200_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(2);
  });

  test("the tier applies to the whole request, fresh input included", () => {
    const { costUsd, resolvedRates } = priceCall({ inputTokens: 250_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(4);
    expect(costUsd).toBeCloseTo(1, 6);
  });

  test("the greatest exceeded threshold wins, however the tiers are ordered", () => {
    const reversed: Pricing = { ...TIERED, tiers: [...(TIERED.tiers ?? [])].reverse() };
    const { resolvedRates } = priceCall({ inputTokens: 600_000, outputTokens: 0 }, reversed);
    expect(resolvedRates.input).toBe(8);
    expect(resolvedRates.output).toBe(24);
  });

  test("cache tokens count toward the threshold", () => {
    const { resolvedRates } = priceCall({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 150_000 }, TIERED);
    expect(resolvedRates.input).toBe(4);
  });

  test("the recorded rates are the rates that priced the call", () => {
    const rates: Pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const { resolvedRates } = priceCall({ inputTokens: 1, outputTokens: 1 }, rates);
    expect(resolvedRates).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });
});
```

`test/unit/internal/command-spec.test.ts`:

```ts
/**
 * Quality command specs: a string is one command, a list is run-all.
 */

import { describe, expect, test } from "bun:test";
import {
  commandSpecIncludes,
  containsShellChain,
  normalizeCommandSpec,
  renderCommandSpec,
  replaceInCommandSpec,
} from "#src/internal/command-spec/index";

describe("normalizeCommandSpec", () => {
  test("an undefined spec is no commands", () => {
    expect(normalizeCommandSpec(undefined)).toEqual([]);
  });

  test("a string is one trimmed command", () => {
    expect(normalizeCommandSpec("  bun test  ")).toEqual(["bun test"]);
  });

  test("blank entries are dropped from a list", () => {
    expect(normalizeCommandSpec(["a", "  ", "", "b"])).toEqual(["a", "b"]);
  });
});

describe("containsShellChain", () => {
  test("is true when any entry chains with &&", () => {
    expect(containsShellChain(["lint", "build && test"])).toBe(true);
  });

  test("is false for a plain command, a list without a chain, and an undefined spec", () => {
    expect(containsShellChain("bun test")).toBe(false);
    expect(containsShellChain(["a", "b"])).toBe(false);
    expect(containsShellChain(undefined)).toBe(false);
  });
});

describe("commandSpecIncludes", () => {
  test("matches a literal fragment in any entry", () => {
    expect(commandSpecIncludes(["lint", "bun test --bail"], "--bail")).toBe(true);
    expect(commandSpecIncludes("lint", "--bail")).toBe(false);
    expect(commandSpecIncludes(undefined, "--bail")).toBe(false);
  });
});

describe("replaceInCommandSpec", () => {
  test("replaces every occurrence and keeps the string shape", () => {
    expect(replaceInCommandSpec("a X b X", "X", "y")).toBe("a y b y");
  });

  test("replaces in every entry and keeps the list shape", () => {
    expect(replaceInCommandSpec(["X one", "two X"], "X", "y")).toEqual(["y one", "two y"]);
  });
});

describe("renderCommandSpec", () => {
  test("joins the normalized entries with ' && '", () => {
    expect(renderCommandSpec(["a", "", "b"])).toBe("a && b");
  });

  test("renders a fully blank or undefined spec as undefined", () => {
    expect(renderCommandSpec(["", " "])).toBeUndefined();
    expect(renderCommandSpec(undefined)).toBeUndefined();
  });
});
```

`test/unit/session/no-op-interaction-handler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "#src/session/no-op-interaction-handler";

describe("NO_OP_INTERACTION_HANDLER", () => {
  test("answers every interaction with null", async () => {
    expect(await NO_OP_INTERACTION_HANDLER.onInteraction()).toBeNull();
  });

  test("is the same object the package barrel exports", async () => {
    const barrel = await import("@nathapp/nax-agent");
    expect(barrel.NO_OP_INTERACTION_HANDLER).toBe(NO_OP_INTERACTION_HANDLER);
  });
});
```

`test/unit/session/session-turn-error.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "#src/session/adapter-failure";
import { SessionTurnError } from "#src/session/session-types";

describe("SessionTurnError", () => {
  test("is a named Error carrying the message and the cancelled flag", () => {
    const err = new SessionTurnError("turn failed", true);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionTurnError");
    expect(err.message).toBe("turn failed");
    expect(err.cancelled).toBe(true);
  });

  test("defaults retryable to false and leaves every cost and failure field absent", () => {
    const err = new SessionTurnError("turn failed", false);

    expect(err.retryable).toBe(false);
    expect(err.tokenUsage).toBeUndefined();
    expect(err.estimatedCostUsd).toBeUndefined();
    expect(err.exactCostUsd).toBeUndefined();
    expect(err.pricingSource).toBeUndefined();
    expect(err.adapterFailure).toBeUndefined();
  });

  test("carries the spend of the failed turn and the typed failure unchanged", () => {
    const adapterFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      message: "slow down",
      retriable: true,
    };
    const err = new SessionTurnError(
      "rate limited",
      false,
      true,
      { inputTokens: 10, outputTokens: 2 },
      0.5,
      0.4,
      "catalog-rates",
      adapterFailure,
    );

    expect(err.retryable).toBe(true);
    expect(err.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(err.estimatedCostUsd).toBe(0.5);
    expect(err.exactCostUsd).toBe(0.4);
    expect(err.pricingSource).toBe("catalog-rates");
    expect(err.adapterFailure).toBe(adapterFailure);
  });
});
```

- [ ] **Step 2: Extend `agent-output-env.test.ts`**

Apply this diff exactly (it adds the `withAgentOutputEnv` describe and widens the import):

```diff
diff --git a/packages/nax-agent/test/unit/internal/agent-output-env.test.ts b/packages/nax-agent/test/unit/internal/agent-output-env.test.ts
index 83f1395f0..ba24a994a 100644
--- a/packages/nax-agent/test/unit/internal/agent-output-env.test.ts
+++ b/packages/nax-agent/test/unit/internal/agent-output-env.test.ts
@@ -8,7 +8,12 @@
  */
 
 import { describe, expect, test } from "bun:test";
-import { _agentOutputEnvDeps, agentOutputOverlay } from "#src/internal/agent-output-env";
+import {
+  _agentOutputEnvDeps,
+  AGENT_OUTPUT_MARKERS,
+  agentOutputOverlay,
+  withAgentOutputEnv,
+} from "#src/internal/agent-output-env";
 import { withDepsRestore } from "#test/helpers/index";
 
 const MARKER_FREE = { PATH: "/usr/bin", HOME: "/home/x" };
@@ -64,3 +69,26 @@ describe("agentOutputOverlay (US-004)", () => {
     }
   });
 });
+
+describe("withAgentOutputEnv", () => {
+  test("adds AGENT=1 to an env with no marker, leaving the input untouched", () => {
+    const env = { ...MARKER_FREE };
+
+    expect(withAgentOutputEnv(env)).toEqual({ ...MARKER_FREE, AGENT: "1" });
+    expect(env).toEqual(MARKER_FREE);
+  });
+
+  test("returns the same env when any marker is present", () => {
+    for (const marker of AGENT_OUTPUT_MARKERS) {
+      const env = { ...MARKER_FREE, [marker]: "1" };
+
+      expect(withAgentOutputEnv(env)).toBe(env);
+    }
+  });
+
+  test("returns the same env when the caller stripped AGENT", () => {
+    const env = { ...MARKER_FREE };
+
+    expect(withAgentOutputEnv(env, ["AGENT"])).toBe(env);
+  });
+});
```

- [ ] **Step 3: Run and gate**

```bash
cd packages/nax-agent
bun test ./test/unit/config ./test/unit/cost ./test/unit/internal/command-spec.test.ts ./test/unit/internal/agent-output-env.test.ts ./test/unit/session/no-op-interaction-handler.test.ts ./test/unit/session/session-turn-error.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)"
bun run typecheck && bun run lint
bun run test:coverage:list 2>&1 | tail -20
```

Expected: 31 pass (4 + 9 + 10 + 3 + 2 + 3), 0 fail; typecheck and lint exit 0; the `--list` output no longer names `config/bash-approval.ts`, `cost/estimate.ts`, `internal/agent-output-env.ts`, `internal/command-spec/index.ts`, `session/no-op-interaction-handler.ts`, `session/session-types.ts` (the baseline still lists the other 8). If `lint` reports a Biome format diff, run `bun x biome check --write test/` and re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent/test
git commit -m "test: S2-3d drains — config, cost estimate, command-spec, session contract (6 files)"
```

---

### Task 2: Port the usage-math describes out of nax's `calculate.test.ts`

**Files:**
- Create: `packages/nax-agent/test/unit/cost/usage-math.test.ts`
- Modify: `packages/nax/test/unit/agents/cost/calculate.test.ts`
- Modify (baselines): `packages/nax-agent/scripts/baselines/test-escape-hatches-baseline.json`, `packages/nax/scripts/baselines/test-escape-hatches-baseline.json`

**Interfaces:**
- Consumes: `addTokenUsage`, `inputClassTokens` (`#src/cost/usage-math`), `TokenUsage` (`@nathapp/nax-ai`), Rule S row 1, `cut_describe.py` (Task 0).
- Produces: nothing later tasks use.

- [ ] **Step 1: Create the file header and move the four describes with the helper**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
OUT=packages/nax-agent/test/unit/cost/usage-math.test.ts
cat > "$OUT" <<'EOF'
/**
 * Tests for cost/usage-math.ts: addTokenUsage and inputClassTokens.
 *
 * Ported from nax's test/unit/agents/cost/calculate.test.ts (S2-3d). The
 * resolvePricingSource and formatCostWithConfidence describes stay in nax.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@nathapp/nax-ai";
import { addTokenUsage, inputClassTokens } from "#src/cost/usage-math";

EOF
python3 "$S/cut_describe.py" packages/nax/test/unit/agents/cost/calculate.test.ts --emit "$OUT" \
  "addTokenUsage" "addTokenUsage — BUG-10 malformed operand guard" "inputClassTokens" "addTokenUsage key presence (S1-1)"
```

- [ ] **Step 2: Tidy both sides**

```bash
(cd packages/nax-agent && bun x biome check --write test/unit/cost/usage-math.test.ts)
(cd packages/nax && bun x biome check --write --unsafe test/unit/agents/cost/calculate.test.ts)
```

`--unsafe` removes the imports `calculate.test.ts` no longer uses (`addTokenUsage`, `inputClassTokens`, `TokenUsage`). It is scoped to the one file.

- [ ] **Step 3: Verify counts, and that the nax half is the exact remainder**

```bash
(cd packages/nax-agent && bun test ./test/unit/cost/usage-math.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)")   # 16 pass
(cd packages/nax && bun test ./test/unit/agents/cost/calculate.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)")   # 24 pass
git diff -M --stat
```

Expected: 16 + 24 = 40 (the Task 0 count). Read the full `git diff packages/nax/test/unit/agents/cost/calculate.test.ts`: it must show only deleted describes, their comment blocks and the now-unused import names.

- [ ] **Step 4: Escape-hatch baselines**

The moved BUG-10 block carries four `test-ratchet-allow: as-unknown-as` markers, which move with it.

```bash
(cd packages/nax-agent && bun ../repo-tooling/scripts/check-test-escape-hatches.ts --package=. 2>&1 | tail -6)   # FAIL: ratchetAllow 0 -> 4 in usage-math.test.ts
(cd packages/nax-agent && bun ../repo-tooling/scripts/check-test-escape-hatches.ts --package=. --update-baseline)
(cd packages/nax && bun run check:test-escape-hatches:update)
git diff packages/*/scripts/baselines/test-escape-hatches-baseline.json
```

Expected diff: nax-agent `ratchetAllow` +4 with one new `byFile` entry for `usage-math.test.ts` and nothing else changed; nax `ratchetAllow` -4 with the `calculate.test.ts` entry removed or lowered by 4, nothing raised. If any count grew anywhere else, stop: that is a regression, not this move.

- [ ] **Step 5: Gate and commit**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
bun run check:all
(cd packages/nax-agent && bun run test:coverage:list 2>&1 | tail -16)
git add -A packages
git commit -m "test: S2-3d — port usage-math tests into nax-agent"
```

Expected: `check:all` exit 0; `--list` no longer names `cost/usage-math.ts`.

---

### Task 3: Port `tool-mapping.test.ts`

**Files:**
- Move: `packages/nax/test/unit/agents/native/tool-mapping.test.ts` to `packages/nax-agent/test/unit/native/session/tool-mapping.test.ts`

**Interfaces:**
- Consumes: Rule I. The file imports `toToolDefinitions` from `@nathapp/nax-agent/internal` (unchanged) and `ToolDescriptor` from `@/context/engine` (rewritten).
- Produces: nothing later tasks use.

- [ ] **Step 1: Move and rewrite the one import**

```bash
git mv packages/nax/test/unit/agents/native/tool-mapping.test.ts packages/nax-agent/test/unit/native/session/tool-mapping.test.ts
```

In the moved file replace `import type { ToolDescriptor } from "@/context/engine";` with `import type { ToolDescriptor } from "#src/session/tool-descriptor";`. Nothing else changes (the `// RE-ARCH: keep` first line moves with it).

- [ ] **Step 2: Verify**

```bash
cd packages/nax-agent && bun test ./test/unit/native/session/tool-mapping.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)"   # 3 pass
git diff -M HEAD --stat | tail -3
bun run typecheck && bun run lint && cd ../nax && bun run typecheck
```

Expected: 3 pass, git reports a rename with a 1-line change; all exit 0.

- [ ] **Step 3: Commit**

```bash
cd ../.. && git add -A packages && git commit -m "test: S2-3d — port tool-mapping tests into nax-agent"
```

---

### Task 4: Port the loop-event and compaction tests (Rule L)

**Files:**
- Move (all five, `git mv`):
  - `packages/nax/test/unit/agents/native/session/loop-events/{payload-guard,transform-context,before-compaction,external-handler}.test.ts` to `packages/nax-agent/test/unit/native/session/loop-events/`
  - `packages/nax/test/unit/agents/native/turn-loop-compaction.test.ts` to `packages/nax-agent/test/unit/native/turn-loop-compaction.test.ts`
- Modify (baselines): both `test-escape-hatches-baseline.json`

**Interfaces:**
- Consumes: Rule L (`port_loop_events.py`), `makeLogger`/`LogCall` (`#test/helpers/index`), `getSafeLogger`/`setAgentLogger`/`AgentLogger` (`#src/infra/index`).
- Produces: nothing later tasks use.

- [ ] **Step 1: Move**

```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
for f in payload-guard transform-context before-compaction external-handler; do
  git mv packages/nax/test/unit/agents/native/session/loop-events/$f.test.ts packages/nax-agent/test/unit/native/session/loop-events/$f.test.ts
done
git mv packages/nax/test/unit/agents/native/turn-loop-compaction.test.ts packages/nax-agent/test/unit/native/turn-loop-compaction.test.ts
```

- [ ] **Step 2: Apply Rule L**

```bash
cd packages/nax-agent/test/unit/native && python3 "$S/port_loop_events.py" && cd ../../..
bun x biome check --write test/unit/native
```

- [ ] **Step 3: Read the diff**

```bash
git diff -M HEAD -- test/unit/native | head -250
```

Expected for each logger file: only the import swap, the `originalLogger` line, the capture lines, `resetLogger()` becoming `setAgentLogger(originalLogger)`, and `logCalls` becoming `logger.calls`. In `external-handler.test.ts`: the `#test/helpers/index` import and the `AgentLogger` type. Any other changed line is a Rule violation: revert it.

- [ ] **Step 4: Verify counts and typecheck**

```bash
bun test ./test/unit/native/session/loop-events ./test/unit/native/turn-loop-compaction.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)"
bun run typecheck && bun run lint:biome
```

Expected: 104 pass (74 ported: 6 + 5 + 3 + 39 + 21, plus the 30 that already lived in `loop-events/`), 0 fail. No leftover nax import: `grep -rn '@/logger\|@test/helpers"' test/unit/native/session/loop-events test/unit/native/turn-loop-compaction.test.ts` prints nothing.

- [ ] **Step 5: Cross-file logger-slot check** (Review Focus 1)

```bash
bun test ./test/unit/native 2>&1 | grep -E "^ [0-9]+ (pass|fail)"
```

Expected: 0 fail. The directory runs in one process, so a leaked `setAgentLogger` would fail a later file.

- [ ] **Step 6: Escape-hatch baselines**

`transform-context.test.ts` carries one `looseCast`.

```bash
(bun ../repo-tooling/scripts/check-test-escape-hatches.ts --package=. --update-baseline)
(cd ../nax && bun run check:test-escape-hatches:update)
git diff ../*/scripts/baselines/test-escape-hatches-baseline.json
```

Expected: nax-agent `looseCast` +1 (new `transform-context.test.ts` entry), nax `looseCast` -1; nothing else moves.

- [ ] **Step 7: Gate and commit**

```bash
cd ../.. && bun run check:all
(cd packages/nax-agent && bun run test:coverage:list 2>&1 | tail -12)
git add -A packages && git commit -m "test: S2-3d — port loop-event and compaction tests into nax-agent"
```

Expected: `check:all` exit 0; `--list` names only `native/session-adapter.ts` among the 14 (everything else drained).

---

### Task 5: `session-adapter.test.ts` (ports on `NativeSessionAdapter` plus the split)

**Files:**
- Create: `packages/nax-agent/test/unit/native/session-adapter.test.ts`
- Modify: `packages/nax/test/unit/agents/native/adapter.test.ts`, `adapter-complete-rates.test.ts`, `adapter-close-physical-session.test.ts`

**Interfaces:**
- Consumes: `NativeSessionAdapter` (`#src/native/session-adapter`); `_clientDeps`, `_resetNativeClient`, `byCodePoint`, `DEFAULT_SPIN_BREAKER_SETTINGS`, `loadTranscript`, `NaxError`, `openNativeSession`, `saveTranscript`, `sessionModule`, `transcriptStoreModule` (`@nathapp/nax-agent/internal`); `OpenSessionOpts`, `SessionModel` (`@nathapp/nax-agent`). Rule S rows 2-4.
- Produces: nothing later tasks use.

The new file is the port with exactly three mechanical differences from its nax sources, each deliberate: it builds `NativeSessionAdapter` instead of the nax shell `NativeAgentAdapter`, it states `SessionModel` literals instead of calling nax's `toSessionModel(ModelDef)`, and it factors the four context-window cases through one helper `sendOverOversized` so they fit one file. Every assertion is the nax assertion.

- [ ] **Step 1: Write the new file**

`test/unit/native/session-adapter.test.ts`:

```ts
/**
 * NativeSessionAdapter: the session surface (open, sendTurn, close) against a
 * stub client.
 *
 * Ported from nax's test/unit/agents/native/{adapter,adapter-complete-rates,
 * adapter-close-physical-session}.test.ts (S2-3d). Those suites drive the nax
 * shell `NativeAgentAdapter`; the session methods are the package's, so these
 * cases build `NativeSessionAdapter` directly. The `complete()`, shape, config
 * pricing and SessionManager cases stay in nax with the shell.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenSessionOpts, SessionModel } from "@nathapp/nax-agent";
import {
  _clientDeps,
  _resetNativeClient,
  byCodePoint,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  loadTranscript,
  NaxError,
  openNativeSession,
  saveTranscript,
  sessionModule as sessionState,
  transcriptStoreModule as transcriptStore,
} from "@nathapp/nax-agent/internal";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { NativeSessionAdapter } from "#src/native/session-adapter";

const REAL_BUILD = _clientDeps.build;
const REAL_WINDOW = 128_000;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function catalogModel(): ResolvedModel {
  return {
    id: "gpt-5.4-mini",
    provider: "openai",
    protocol: "openai-responses",
    pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    contextWindow: REAL_WINDOW,
    supportsTools: true,
    thinkingLevels: [],
  };
}

function countingClient(
  model: ResolvedModel,
  complete?: Client["complete"],
): { client: Client; completeCalls: () => number } {
  let calls = 0;
  const client: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete:
      complete ??
      (async (_m: ResolvedModel, _req: ClientRequest) => {
        calls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      }),
    validate: () => {},
  };
  return { client, completeCalls: () => calls };
}

const turn = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
const DEFAULT_MODEL: SessionModel = { provider: "unknown", model: "openai/gpt-5.4-mini" };

async function openIn(
  adapter: NativeSessionAdapter,
  name: string,
  over: Partial<OpenSessionOpts> = {},
): Promise<{ handle: Awaited<ReturnType<NativeSessionAdapter["openSession"]>>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `nax-session-adapter-${name}-`));
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: DEFAULT_MODEL,
    timeoutSeconds: 60,
    transcriptDir: dir,
    ...over,
  });
  return { handle, dir };
}

// US-003 AC6: sendTurn() stamps pricingSource on TurnResult the same way
// complete() stamps it on CompleteResult.
describe("NativeSessionAdapter.sendTurn pricingSource", () => {
  test("US-003 AC6: sendTurn() with no modelDef.pricing stamps pricingSource=catalog-rates on TurnResult", async () => {
    _clientDeps.build = async () => countingClient(catalogModel()).client;
    const adapter = new NativeSessionAdapter();
    const { handle } = await openIn(adapter, "sess-pricing-source");

    const result = await adapter.sendTurn(handle, "hi", turn);

    expect(result.pricingSource).toBe("catalog-rates");
  });
});

/**
 * nax#1838: the adapter interface carries no failure signal, so the native
 * adapter passed failed:false unconditionally and every close deleted the
 * transcript -- including the close after a failed turn, whose history the
 * retry needs and a human would read.
 */
describe("NativeSessionAdapter.closeSession after a failed turn", () => {
  test("keeps the transcript when the last turn failed", async () => {
    _clientDeps.build = async () =>
      countingClient(catalogModel(), async () => {
        throw new Error("upstream exploded");
      }).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-keep");

    await adapter.sendTurn(handle, "hi", turn).catch(() => {});
    await adapter.closeSession(handle);

    // nax#1877: kept for a human to read, under a name the next session of
    // this name cannot load.
    const kept = (await readdir(dir)).filter((n) => n.startsWith("sess-keep.transcript.failed-"));
    expect(kept).toHaveLength(1);
    expect(await loadTranscript(dir, "sess-keep")).toEqual([]);
  });

  test("still deletes it when every turn succeeded", async () => {
    _clientDeps.build = async () => countingClient(catalogModel()).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-drop");

    await adapter.sendTurn(handle, "hi", turn);
    await adapter.closeSession(handle);

    expect(await loadTranscript(dir, "sess-drop")).toEqual([]);
  });

  test("a turn that recovers clears the mark, so a finished session is still cleaned up", async () => {
    let calls = 0;
    _clientDeps.build = async () =>
      countingClient(catalogModel(), async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      }).client;
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await openIn(adapter, "sess-recover");

    await adapter.sendTurn(handle, "hi", turn).catch(() => {});
    await adapter.sendTurn(handle, "again", turn);
    await adapter.closeSession(handle);

    expect(await loadTranscript(dir, "sess-recover")).toEqual([]);
  });
});

const COMPACTION = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

async function seedOversizedTranscript(dir: string, sessionName: string): Promise<void> {
  await saveTranscript(dir, sessionName, [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

async function sendOverOversized(contextWindow: number | undefined, name: string): Promise<number> {
  const { client, completeCalls } = countingClient(catalogModel());
  _clientDeps.build = async () => client;
  const adapter = new NativeSessionAdapter();
  const modelDef: SessionModel = contextWindow === undefined ? DEFAULT_MODEL : { ...DEFAULT_MODEL, contextWindow };
  const { handle, dir } = await openIn(adapter, name, { modelDef, compaction: COMPACTION });
  await seedOversizedTranscript(dir, handle.id);
  await adapter.sendTurn(handle, "next", turn);
  return completeCalls();
}

describe("NativeSessionAdapter.sendTurn contextWindow override", () => {
  test("an override below the real window reaches runNativeTurn's deps and fires compaction", async () => {
    // summarize + the real turn: compaction fired only because the override
    // (8,000) reached the turn deps -- the catalog window (128,000) would not
    // have triggered it on this transcript.
    expect(await sendOverOversized(8_000, "ctxwin-below")).toBe(2);
  });

  test("no override falls back to the catalog's resolved.contextWindow, so compaction does not fire", async () => {
    expect(await sendOverOversized(undefined, "ctxwin-fallback")).toBe(1);
  });

  test("an override above the real window is rejected, naming both numbers", async () => {
    const err = await sendOverOversized(200_000, "ctxwin-above").catch((e: unknown) => e);
    if (!(err instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(err)}`);
    expect(err.message).toContain("200000");
    expect(err.message).toContain(String(REAL_WINDOW));
  });

  test("an override exactly equal to the real window is accepted", async () => {
    expect(await sendOverOversized(REAL_WINDOW, "ctxwin-equal")).toBe(1);
  });
});

describe("NativeSessionAdapter closePhysicalSession -- run teardown reaches the session maps", () => {
  let closeDir: string;
  beforeEach(async () => {
    closeDir = await mkdtemp(join(tmpdir(), "nax-native-close-"));
  });
  afterEach(async () => {
    await rm(closeDir, { recursive: true, force: true });
  });

  function exportedCollections(): string[] {
    return Object.entries(sessionState)
      .filter(([, value]) => value instanceof Map || value instanceof Set)
      .map(([exportName]) => exportName)
      .sort(byCodePoint);
  }

  function collectionsHolding(name: string): string[] {
    const holding: string[] = [];
    for (const [exportName, value] of Object.entries(sessionState)) {
      if (value instanceof Map && value.has(name)) holding.push(exportName);
      else if (value instanceof Set && value.has(name)) holding.push(exportName);
    }
    return holding.sort(byCodePoint);
  }

  const openOpts = (): OpenSessionOpts => ({
    agentName: "native",
    workdir: closeDir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "unknown", model: "openrouter/deepseek/deepseek-v4-flash" },
    timeoutSeconds: 60,
    transcriptDir: closeDir,
    transcriptOwner: "call-1",
    compaction: COMPACTION,
    transportRetry: { maxAttempts: 3, baseDelayMs: 2000 },
    spinBreaker: DEFAULT_SPIN_BREAKER_SETTINGS,
  });

  test("physical close removes a successful session's transcript", async () => {
    const adapter = new NativeSessionAdapter();
    const name = "nax-teardown-us-003-success";
    await openNativeSession(name, openOpts());
    await transcriptStore.saveTranscript(closeDir, name, []);
    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(true);

    await adapter.closePhysicalSession(name, closeDir);

    expect(await Bun.file(transcriptStore.transcriptPath(closeDir, name)).exists()).toBe(false);
  });

  test("a throwing transcript retain still clears every native map", async () => {
    const adapter = new NativeSessionAdapter();
    const name = "nax-throw-us-002-implementer";
    const handle = await openNativeSession(name, openOpts());
    sessionState.nativeSessionFailed.add(name);
    sessionState.nativeSessionLastUsage.set(name, { promptTokens: 10, anchorIndex: 0 });
    expect(collectionsHolding(name)).toEqual(exportedCollections());
    const retainSpy = spyOn(transcriptStore, "retainTranscript").mockRejectedValue(new Error("retain boom"));
    try {
      await expect(adapter.closeSession(handle)).rejects.toThrow("retain boom");
    } finally {
      retainSpy.mockRestore();
    }
    expect(collectionsHolding(name)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd packages/nax-agent && bun test ./test/unit/native/session-adapter.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)"   # 10 pass
bun run typecheck && bun run lint:biome
```

Expected: 10 pass (1 pricingSource + 3 closeSession + 4 context-window + 2 closePhysicalSession).

- [ ] **Step 3: Cut the moved parts out of nax**

```bash
cd ../.. 
N=packages/nax/test/unit/agents/native
python3 "$S/cut_describe.py" $N/adapter.test.ts \
  "NativeAgentAdapter.sendTurn pricingSource" "NativeAgentAdapter.closeSession after a failed turn"
python3 "$S/cut_describe.py" $N/adapter-complete-rates.test.ts "NativeAgentAdapter.sendTurn contextWindow override"
python3 - <<'EOF'
import re
base = "packages/nax/test/unit/agents/native/"
# the context-window describe's two private helpers
f = base + "adapter-complete-rates.test.ts"
s = open(f).read()
s = re.sub(r'async function seedOversizedTranscript\(.*?\n\}\n\n', '', s, flags=re.S)
s = re.sub(r'const sendCtxWin = .*?\n  adapter\.sendTurn\(.*?\n\n', '', s, flags=re.S)
open(f, "w").write(s)
# the two tests that need no SessionManager, and the helper only they use
f = base + "adapter-close-physical-session.test.ts"
s = open(f).read()
s = re.sub(r'const openOpts = .*?\n\}\);\n\n', '', s, flags=re.S)
i = s.index('  test("physical close removes a successful session')
j = s.rindex('});')
s = s[:i].rstrip('\n') + '\n' + s[j:]
open(f, "w").write(s)
EOF
(cd packages/nax && bun x biome check --write --unsafe test/unit/agents/native/adapter.test.ts test/unit/agents/native/adapter-complete-rates.test.ts test/unit/agents/native/adapter-close-physical-session.test.ts)
grep -n "seedOversizedTranscript\|sendCtxWin\|openOpts\|_seed\|_send" $N/adapter-complete-rates.test.ts $N/adapter-close-physical-session.test.ts || echo "no stranded helpers"
```

Expected: `no stranded helpers`. If Biome renamed anything with a leading underscore, a helper was stranded: delete it by hand.

- [ ] **Step 4: Verify the remainder in nax**

```bash
cd packages/nax
for f in adapter adapter-complete-rates adapter-close-physical-session; do echo "$f $(bun test ./test/unit/agents/native/$f.test.ts 2>&1 | grep -E '^ [0-9]+ (pass|fail)' | tr '\n' ' ')"; done
bun run typecheck
```

Expected: adapter 28, adapter-complete-rates 18, adapter-close-physical-session 1 (each 0 fail). Conservation: before 32 + 22 + 3 = 57; after 28 + 18 + 1 in nax plus the new file's 10 = 57. Read `git diff` for the three nax files: only deleted describes/tests, deleted private helpers, and removed imports.

- [ ] **Step 5: Gate and commit**

```bash
cd ../.. && bun run check:all
(cd packages/nax-agent && bun run test:coverage:list 2>&1 | tail -10)
git add -A packages && git commit -m "test: S2-3d — session-adapter tests on NativeSessionAdapter"
```

Expected: `check:all` exit 0; `--list` prints `Total below 80% floor: 0`.

---

### Task 6: Empty the baseline, verify, record

**Files:**
- Modify: `packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json`

- [ ] **Step 1: Empty the baseline** (Review Focus 4)

```bash
cd packages/nax-agent
bun run test:coverage 2>&1 | tail -6                      # GREEN on the OLD baseline first
cp scripts/baselines/coverage-per-file-baseline.json "$S/cov-before.json"
bun run test:coverage:update 2>&1 | tail -4
git diff scripts/baselines/coverage-per-file-baseline.json
```

Expected: the old-baseline run exits 0 with `0 files below floor (baseline 14)`; after the update `byFile` is `{}`; the diff removes the 14 keys and adds none. If any key remains or appears, stop and name the file.

- [ ] **Step 2: Totals and gates**

```bash
cd ../.. 
bun run typecheck && bun run check:all
(cd packages/nax-agent && bun run test && bun run test:coverage 2>&1 | tail -10)
(cd packages/nax && bun run test 2>&1 | grep -E "^ [0-9]+ (pass|fail)")
git diff origin/main -- packages/nax/package.json | grep -A3 '"dependencies"' || echo "nax dependencies untouched"
```

Expected:
- nax-agent: tests = 2827 + 103 + 31 = **2961**, 0 fail; coverage exit 0; `0 files below floor (baseline 0)`; `unreported src/ files with code: 0`; lines about 97.6%, functions about 95.5%.
- nax: tests = (Task 0 nax total) - 103, 0 fail.
- Repo sum = before + 31 exactly.
- `nax dependencies untouched`.

- [ ] **Step 3: nax's own coverage held** (Review Focus 3)

```bash
cd packages/nax && bun run test:coverage 2>&1 | tail -12
```

Expected: exit 0; no file named below floor or newly baselined that Task 0 did not already name; in particular none of `src/logger/*`, `src/agents/native-agent/index.ts`, `src/agents/cost/*`. If one appears, stop and report; do not baseline it.

- [ ] **Step 4: Commit the baseline**

```bash
cd ../.. && git add packages/nax-agent/scripts/baselines/coverage-per-file-baseline.json
git commit -m "test: S2-3d coverage drains — remaining files (baseline 14 → 0)"
```

- [ ] **Step 5: PR body record** (no PR without the maintainer's approval)

Put in the draft: nax-agent before/after overall numbers; the 14 before/after per-file rows from the table above; baseline 14 → 0 (S2-9 coverage criterion met); per-split moved vs stayed counts (Rule S); the +4/+1 escape-hatch moves and the matching nax decreases; the lcov comment-line note; and the follow-ups that remain for the S2-9 publish gate (the other S2 items: smoke script, vitest contract suite, `/internal` surface review).

- [ ] **Step 6: Master plan**

Update `S2` in `nax-agent-master-plan.md` §5: S2-3d plan written and executed, PR number, baseline 14 → 0, then the next just-in-time plan. Memory notes point at the master plan and do not restate it.

---

## Self-review notes

- Spec §7.2 / R2 coverage: the gap closes with 103 ported tests and 31 new ones; no floor moves; the baseline reaches EMPTY, which the spec requires before S2-9. `--require-all-files` stays at 0 unreported (Task 6 Step 2).
- Placeholder scan: every new test is a complete file, every nax cut is a command with named describes, every port is rule-driven by a script that was run green on a scratch build of this plan. The one environment-dependent value is `S` (your scratchpad), set in Task 0 Step 1.
- Interface consistency: Task 1's imports resolve against the barrels listed in its Interfaces block; `session-adapter.test.ts` imports only names `internal.ts` already exports (the same list nax's sources import); `makeLogger`/`LogCall`/`setAgentLogger` are the existing helper exports.
- Review Focus: each line maps to a pinning step (Task 4 Steps 3 and 5; Tasks 2 and 5 helper-strand greps; Task 6 Step 3; Task 6 Step 1 baseline discipline; Task 1 identity assertions).
- Order: Tasks 2 and 4 update escape-hatch baselines in the same commit as the move, so every commit passes `check:all`. Task 4 leaves exactly `session-adapter.ts` baselined; Task 5 empties the list; Task 6 only records it.
