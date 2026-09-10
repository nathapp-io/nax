# Deep Code Review: @nathapp/nax

**Date:** 2026-09-10
**Reviewer:** Subrina (AI, opencode)
**Version:** 0.82.0-canary.7 (branch `fix/review-concrete-remediation`, based on `cf8e63fe5`)
**Files:** 977 src (`~156k` LOC) + 1,421 test files (`~355k` LOC) + 49 scripts
**Baseline:** 17,894 pass / 43 skip / 0 fail (17,937 ran) + e2e 33 pass / 0 fail; coverage 96.10% lines / 93.00% functions
**Scope:** Deep review. Static analysis (typecheck, Biome, and repository custom gates), knowledge-graph hotspot analysis, targeted checklist sweeps (universal / node-general / react), dependency audit, and manual inspection of high-risk modules (agent spawn, webhook/telegram, locks, redaction, crash handling, acceptance templates).
**Post-remediation verification:** On branch `fix/review-concrete-remediation`, `bun run typecheck`,
`bun run lint`, `bun run test`, `bun run test:e2e`, and `bun run test:coverage:report` pass;
`bun audit --json` reports no advisories.
The full test command requires an unrestricted subprocess sandbox because
`test/integration/tools/exec-install.test.ts` intentionally performs a real local `bun add`.

---

## Overall Grade: A− (86/100)

A mature, unusually well-instrumented codebase. The verified typecheck, Biome, repository lint
checks, and test suites pass, and the security-sensitive paths I inspected
(secret redaction, env allowlisting, HMAC webhook verification, path traversal, file locking,
process-group kills, crash teardown) are implemented with documented, evidence-backed reasoning.
No critical or high-severity defects were found in first-party code. The deductions come from
dependency hygiene (one critical advisory in an *unused* devDependency; a high advisory in
runtime transitives), a genuine functional bug in the `nax curator commit` editor path, a
blind spot in the file-size gate (`bin/` is not scanned while `bin/nax.ts` is 1,874 lines),
132 modules still in runtime import cycles, 91 remaining `throw new Error` policy violations,
and a few very large/high-complexity functions.

| Dimension | Score | Notes |
|:---|:---:|:---|
| Security | 17/20 | 1 critical + 3 high audits (1 dep unused, rest transitive); first-party controls strong |
| Reliability | 19/20 | 17,894 tests green (+43 skips); one MEDIUM functional bug; careful concurrency everywhere else |
| API Design | 18/20 | Consistent, typed, justified `any`s; complexity hotspots in a few dispatchers |
| Code Quality | 15/20 | 15 oversized files (only 5 src), 132 cyclic modules, 91 error-policy violations |
| Best Practices | 17/20 | Strong gates; file-size gate blind to `bin/`; dependency placement issues |
| **Total** | **86** | **A−** |

Context: the previous full review (`docs/20260829-review-nax.md`, graded A− 86/100) closed most of
its findings. This review confirms the ratchets improved since then (cycles down 135→132,
NaxError violations down 104→91) and focuses on what is still open plus newly found issues.

---

## Findings

### HIGH

#### SEC-1: 5 dependency advisories — 1 critical, 3 high, 1 moderate

**Severity:** HIGH | **Category:** Security / Dependencies
**Status:** RESOLVED — removed `react-devtools-core`, moved test/type-only packages to
`devDependencies`, and updated transitive `ws` to 8.21.3; `bun audit --json` is empty.

```
$ bun audit
shell-quote@1.8.3
  react-devtools-core > shell-quote
  critical: shell-quote quote() does not escape newlines in object .op values (GHSA-w7jw-789q-3m8p)
  high: shell-quote: Quadratic-complexity Denial of Service in `parse()` (GHSA-395f-4hp3-45gv)
ws@7.5.10, 8.19.0
  ink > ws
  react-devtools-core > ws
  @nathapp/nax-ai > @earendil-works/pi-ai > openai > ws
  moderate: ws: Uninitialized memory disclosure (>=8.0.0 <8.20.1)
  high: ws: Memory exhaustion DoS (>=8.0.0 <8.21.0)
  high: ws: Memory exhaustion DoS (>=7.0.0 <7.5.11)
5 vulnerabilities (1 critical, 3 high, 1 moderate)
```

Lockfile proof:

- `bun.lock:311` — `react-devtools-core@7.0.1` → `{ "shell-quote": "^1.6.1", "ws": "^7" }`
- `bun.lock:323` — `shell-quote@1.8.3` (vulnerable range `<=1.8.4` / `<=1.8.3`)
- `bun.lock:357` — root `ws@7.5.10` (vulnerable `>=7.0.0 <7.5.11`)
- `bun.lock:371` — `ink/ws@8.19.0` (vulnerable `>=8.0.0 <8.21.0`)

The critical `shell-quote` path is only reachable through `react-devtools-core`, which is an
**unused** devDependency (see ENH-1): `rg react-devtools-core` matches only `package.json` and
generated agent docs, never `src/` or `bin/`. Exploitability today is therefore low, but the
advisory is critical and removal is free. The `ws` advisories sit in the runtime tree
(`ink` is a runtime dependency; `@nathapp/nax-ai` → `openai` → `ws`).

**Risk:** known-vulnerable code ships in the install tree; any future import of
`react-devtools-core`, or any code path opening a WebSocket, inherits the advisories.
**Fix:** remove `react-devtools-core` (eliminates `shell-quote@1.8.3` and `ws@7.5.10` entirely),
then `bun update ws` / bump `ink` and `@nathapp/nax-ai` so nested `ws` resolves ≥ 8.21.0
(within their existing `^8` ranges). `bun audit fix` is the mechanical option; re-run
`bun audit` to verify zero remaining advisories.

---

### MEDIUM

#### BUG-1: `$EDITOR` containing arguments crashes `nax curator commit` *after* files are modified

**Severity:** MEDIUM | **Category:** Bug
**Status:** RESOLVED — `$EDITOR` is tokenized with `parseCommandToArgv`, and launch failures now
emit a warning instead of aborting after writes.

`src/commands/curator.ts:83-89`:

```ts
openInEditor: async (filePath: string): Promise<void> => {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const proc = Bun.spawnSync([editor, filePath], { stdio: ["inherit", "inherit", "inherit"] });
  if (proc.exitCode !== 0) {
    console.log(`[WARN] Editor exited with code ${proc.exitCode}`);
  }
},
```

Called unconditionally after the proposal writes, `src/commands/curator.ts:456-459`:

```ts
// Open modified files in editor
for (const filePath of modifiedFiles) {
  await _curatorDeps.openInEditor(filePath);
}
```

`$EDITOR` is conventionally a command line, not a bare binary — `EDITOR="code --wait"`,
`vim -p`, `emacsclient -c`. Passing the whole string as `argv[0]` makes Bun throw (no shell is
involved). Verified:

```
$ bun -e 'Bun.spawnSync(["definitely-not-a-cmd-xyz","a"])'
threw: Executable not found in $PATH: "definitely-not-a-cmd-xyz"
```

The throw is uncaught by `curatorCommit`, so it propagates to the CLI handler
(`bin/nax.ts:1444-1448`), which prints `Error: ...` and exits 1 — after every target file has
already been written/appended. Tests never exercise the real implementation: the seam is mocked
in `test/unit/commands/curator.test.ts:144` and `:616`, `curator-gc.test.ts:139`,
`curator-runid.test.ts:58`, and no test sets `EDITOR` (the only match is the test *name* at
`curator.test.ts:597`).

**Risk:** users with an argument-bearing `$EDITOR` see a hard failure and may re-run the command
against already-modified rules; the default `"vi"` fails the same way on minimal images where
neither `vi` nor `$EDITOR` exists.
**Fix:** parse with the repo's existing helper
(`parseCommandToArgv` in `src/utils/command-argv.ts`) before spawning:

```ts
const [cmd, ...args] = parseCommandToArgv(process.env.EDITOR ?? process.env.VISUAL ?? "vi");
Bun.spawnSync([cmd, ...args, filePath], { stdio: ["inherit", "inherit", "inherit"] });
```

and wrap the spawn in try/catch so editor failure is a warning, never a post-write abort.
Add a unit test that sets `EDITOR="my-editor --wait"` and asserts the argv.

#### STYLE-1: File-size hard limit has a `bin/` blind spot — `bin/nax.ts` is 1,874 lines

**Severity:** MEDIUM | **Category:** Style / Maintainability
**Status:** DEFERRED — structural CLI split is outside the concrete remediation batch.

The project rule is a 600-line hard limit for source files
(`.nax/rules/project-conventions.md:42`), enforced by `scripts/check-file-sizes.ts`. But the
gate only scans `src/` and `test/` (`scripts/check-file-sizes.ts:41-44`):

```ts
const SCOPES: Scope[] = [
  { scanDir: "src",  pattern: "**/*.ts", limit: SRC_LIMIT },
  { scanDir: "test", pattern: "**/*.test.ts", limit: TEST_LIMIT },
];
```

`bin/nax.ts` — the shipped CLI entrypoint — is **1,874 lines** with **102 `process.exit` sites**
(`wc -l bin/nax.ts`; `rg -c "process\.exit" bin/nax.ts`). It is the largest file in the
repository and wholly outside the ratchet. Current `--list` output confirms 15 grandfathered
oversized files, of which 5 are src: `rectifier-builder.ts` 899, `unified-executor.ts` 734,
`session/manager.ts` 679, `prd/schema.ts` 629, `telegram.ts` 613.

**Risk:** the entrypoint concentrates argument parsing, command wiring, and exit handling in one
unreviewed-by-ratchet file; merge conflicts and copy-paste drift scale with its size.
**Fix:** add a `{ scanDir: "bin", pattern: "**/*.ts", limit: SRC_LIMIT }` scope with a baseline
entry for `bin/nax.ts`, then split command registration into `src/cli/commands/*` modules
(the repo already has `src/cli/` and `src/commands/`).

#### ARCH-1: 132 modules participate in runtime import cycles

**Severity:** MEDIUM | **Category:** Architecture / Reliability
**Status:** DEFERRED — cycle reduction requires a separate structural-refactor plan.

```
$ bun run scripts/check-import-cycles.ts
[OK] 132 modules in runtime import cycles (baseline: 135) (down 3 since last baseline).
```

The check is a ratchet, so this passes — but 132 modules (out of 977 src files, ~14%) sit inside
a value-import cycle. Examples from `--list`:

```
src/context/engine/providers/feature-context.ts
  in feature-context.ts -> src/context/index.ts -> src/context/engine/index.ts -> feature-context.ts
src/execution/escalation/index.ts
  in index.ts -> tier-escalation.ts -> index.ts
src/operations/verify-scoped.ts
  in verify-scoped.ts -> src/findings/index.ts -> src/findings/cycle.ts -> src/operations/index.ts -> verify-scoped.ts
```

Cyclic ESM evaluation is exactly what makes a module observe a partially-initialised binding of
another (`undefined` at module scope), which the check's own header documents as a crash-on-first-use
hazard — and which the header notes already crashed the test suite once
(`docs/specs/2026-08-20-deep-relatives-migration-runbook.md` §7.2). The dominant cause is barrel
routing (`leaf.ts` importing a sibling through `dir/index.ts`).

**Risk:** latent load-order crashes that tests may not hit; every new barrel edge can pull another
module into a cycle.
**Fix:** keep burning down the ratchet (it is moving: 135 → 132). Prioritise the small, clearly
breakable components surfaced by `--list` (e.g. the 3-module context and 2-module escalation
cycles) by importing leaves directly instead of through the barrel.

#### ENH-1: Dependency placement — test-only and type-only packages shipped as runtime dependencies

**Severity:** MEDIUM | **Category:** Enhancement / Packaging
**Status:** RESOLVED — `ink-testing-library` and `@types/react` now reside in `devDependencies`,
and unused `react-devtools-core` was removed.

`package.json`:

- `dependencies["ink-testing-library"]` (line 77) is imported **only by tests**:
  `test/ui/*.tsx`, `test/unit/ui/*.test.ts`. The two `src/` references
  (`src/acceptance/templates/component.ts:44`, `snapshot.ts:44`) are *inside template literals*
  emitting generated test code for the target project — nax itself never imports it at runtime.
- `dependencies["@types/react"]` (line 72) is a types-only package.
- `devDependencies["react-devtools-core"]` (line 84) is referenced nowhere in `src/`, `bin/`,
  `scripts/`, or `test/` (`rg react-devtools-core` → only `package.json` and generated docs),
  yet it is the sole source of the critical `shell-quote` advisory (SEC-1).

**Risk:** every `bun add -g @nathapp/nax` install downloads test scaffolding and type packages it
will never execute; an unused devDependency carries a critical CVE.
**Fix:** move `ink-testing-library` and `@types/react` to `devDependencies`; delete
`react-devtools-core`. Re-run `bun audit` (expect the critical and the `ws@7` highs to vanish).

#### ENH-2: 91 `throw new Error(...)` sites remain in `src/` against the project's own NaxError rule

**Severity:** MEDIUM | **Category:** Convention / Error Handling
**Status:** DEFERRED — NaxError migration remains a cross-module refactor.

```
$ bun run scripts/check-nax-error.ts
OK: 91 violations (baseline 104).
```

The rule (`.nax/rules/error-handling.md`, enforced by `scripts/check-nax-error.ts`) requires
`NaxError` with an error code and stage. Remaining hot spots by file: `interaction/plugins/telegram.ts`
(8), `config/path-security.ts` (7), `queue/manager.ts` (7), `interaction/plugins/cli.ts` (5),
`interaction/plugins/webhook.ts` (5), `routing/strategies/llm-parsing.ts` (6), `utils/feature-name.ts`
(4), `prd/validate.ts` (4), `worktree/merge.ts` (4). Representative sites:

```
src/config/path-security.ts:53   throw new Error(`Path is outside allowed directory: ...`);
src/interaction/plugins/webhook.ts:280  throw new Error(`Webhook POST failed (${response.status}): ...`);
src/worktree/merge.ts:281        throw new Error(`Circular dependency detected involving ${storyId}`);
```

**Risk:** errors crossing module boundaries lack machine-readable codes and stage/story context,
degrading structured diagnostics and autofix routing; the ratchet also permits the count to grow
up to 104 before failing.
**Fix:** migrate the top offenders file-by-file as their tests are touched, then
`bun run scripts/check-nax-error.ts --update-baseline` to lower the ceiling. Files like
`path-security.ts` and `feature-name.ts` are small and testable in isolation.

#### MAINT-1: Six routines carry high cyclomatic/cognitive complexity

**Severity:** MEDIUM | **Category:** Maintainability
**Status:** DEFERRED — complexity reduction remains a separate refactoring effort.

Knowledge-graph metrics (non-test functions; `complexity` = cyclomatic, `cognitive` = cognitive,
`lines`):

| Function | Location | Complexity | Cognitive | Lines |
|:---|:---|:---:|:---:|:---:|
| `validateStory` | `src/prd/schema.ts:69` | **57** | **128** | 429 |
| `executeUnified` | `src/execution/unified-executor.ts:59` | **50** | **199** | 627 |
| `parseAcpxJsonLine` | `src/agents/acp/parser.ts:82` | 41 | 147 | 241 |
| `callOp` | `src/operations/call.ts:66` | 31 | 80 | 501 |
| `generateCommand` | `src/cli/generate.ts:49` | 34 | 83 | 218 |
| `parseFrontmatter` | `src/context/rules/rules-frontmatter.ts:110` | 33 | 58 | 183 |

These graph metrics are heuristics, not runtime-performance measurements. All six routines are
well commented and tested, so this is change-risk, not observed misbehaviour or a demonstrated
performance defect.

**Risk:** high fan-in validation/execution paths are expensive to change safely; subtle edge cases
hide in the branch matrix.
**Fix:** split `validateStory` into per-field validators (`validateId`, `validateAcceptanceCriteria`,
…) returning a discriminated result; extract `executeUnified` stage dispatch into a table of
handlers; add a cognitive-complexity budget (e.g. `cognitive <= 60`) to an existing ratchet script.

---

### LOW

#### BUG-2: `parseCommandToArgv` silently drops empty quoted arguments

**Severity:** LOW | **Category:** Bug
**Status:** RESOLVED — quoted empty arguments are preserved by `parseCommandToArgv`.

`src/utils/command-argv.ts:23-31,56-58` — a quoted empty segment never sets `current` to a
non-empty string, and the final push is guarded by `current.length > 0`:

```
$ bun -e 'import { parseCommandToArgv } from "./src/utils/command-argv";
           console.log(JSON.stringify(parseCommandToArgv(`echo "" x`)))'
["echo","x"]
```

Correct POSIX-ish parsing yields `["echo","","x"]`. Hook commands and `$EDITOR` strings that rely
on an explicit empty argument are silently mangled.

**Fix:** track a `tokenStarted` flag set on quote entry and push when set, not when `current` is
non-empty.

#### ENH-3: `isWithinDirectory` hardcodes POSIX separators

**Severity:** LOW (Windows-only) | **Category:** Enhancement / Cross-platform
**Status:** RESOLVED — containment now uses `path.relative`, with a Windows-style regression test.

`src/config/path-security.ts:66-81`:

```ts
const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
...
return targetWithSlash.startsWith(baseWithSlash) || normalizedTarget === normalizedBase;
```

On Windows, `node:path.normalize()` returns `\` separators, so `baseWithSlash` never matches a
nested target and *every* containment check fails (fails closed — rejects valid paths, not a
security hole). CI is Ubuntu-only (`.github/workflows/ci.yml:32`), so this would not be caught.
**Fix:** use `path.relative(base, target)` and reject when it starts with `..`/is absolute, which
is separator-agnostic.

#### ENH-4: File-lock liveness is vulnerable to PID reuse

**Severity:** LOW | **Category:** Reliability (theoretical)
**Status:** DEFERRED — theoretical PID-reuse hardening remains out of scope for this batch.

`src/utils/file-lock.ts:144-148` reclaims a lock when `isProcessAlive(holderPid)` is false.
`isProcessAlive` (`src/utils/process-alive.ts:43-55`) correctly fails safe on `EPERM`, but PID
recycling can make an unrelated live process answer "alive" for a dead holder, delaying
reclamation until the caller's timeout (default 5s) — fail-closed, bounded, no data loss.
**Fix:** optionally stamp the lock with a process start time and compare it on reclaim; otherwise
document the limitation next to `EMPTY_LOCK_EVICT_AGE_MS`.

---

## Explicitly Verified as Clean

Checked, not assumed (each is an evidence-backed pass at this revision):

- **Type safety:** `bun run typecheck` clean for both app and test tsconfigs. The handful of
  `any`s (`runner-execution.ts:41`, `runner-completion.ts:55`, `acceptance-setup.ts:180`,
  `phase-state.ts:25`) each carry an explicit `biome-ignore` justification; `@ts-ignore`/
  `@ts-expect-error` count in `src/` is 0.
- **Lint/gates:** Biome (2,520 files) plus all 13 custom checks invoked by `bun run lint` pass,
  including no direct `~/.nax` construction, feature-dir SSOT, alias internals, import-cycle and
  NaxError ratchets, log-format layering, file-size limits, no control bytes, generated review
  prompts, the nax-ai import boundary, bundle externals, and operation tool capability.
- **Tests:** 16,642 unit + 1,154 integration + 98 UI (7 + 36 skips, 0 fail) and 33 e2e pass, 0 fail;
  coverage 96.10% lines / 93.00% functions with 0 files below the per-file floor.
- **Injection:** no `node:child_process` imports, no `eval`/`new Function` (the only `eval(`
  occurrence is a comment in `src/acceptance/generator-helpers.ts:140`), no `shell: true`. All
  first-party spawns are argv arrays. The two `/bin/sh -c` sites run the user's own configured
  quality/test commands from `.nax/config.json` — a trusted file, explicitly documented as such
  (`src/quality/runner.ts:142-143`, `src/verification/executor.ts:93-98`) — and are not reachable
  with agent- or attacker-supplied strings.
- **Secrets:** `.env.test` contains only `CI=1` + `NAX_SKIP_PRECHECK=1`. `src/logger/redact.ts`
  implements key- and pattern-based redaction (PEM blocks, JWTs, GitHub/npm/AWS/Slack/Telegram
  tokens, URL-embedded credentials, Bearer/Basic) with cycle/depth guards. `buildAllowedEnv`
  (`src/agents/shared/env.ts:58`) passes an explicit allowlist to agent subprocesses.
- **Network surfaces:** webhook plugin enforces HMAC-SHA256 with `timingSafeEqual`, pre-auth and
  post-auth rate-limit buckets, and a streaming byte cap that cannot be bypassed by a lying
  `Content-Length` (`src/interaction/plugins/webhook.ts:490-594`). Telegram callbacks are
  request-id + chat-id bound.
- **Lifecycle:** crash handlers remove every listener on teardown
  (`src/execution/crash-signals.ts:300-308`); hook child processes get SIGTERM→SIGKILL with a
  process-group kill and stream-drain deadlines; `otel` batch queue is bounded, teardown cancels
  its re-armed timer and drains in-flight sends; TUI intervals clear on unmount.
- **Locks:** `src/utils/file-lock.ts` uses atomic exclusive-create plus a serialized
  gravedigger claim; `judgeAbandoned` fails closed on inconclusive liveness.

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---:|:---|
| P0 | SEC-1 | S | Remove unused `react-devtools-core`; update `ws`; verify `bun audit` is clean |
| P1 | BUG-1 | S | Parse `$EDITOR` with `parseCommandToArgv`; catch spawn failure after writes |
| P1 | ENH-1 | S | Move `ink-testing-library`, `@types/react` to devDependencies |
| P1 | STYLE-1 | M | Add `bin/` to the file-size gate; start splitting `bin/nax.ts` |
| P2 | ENH-2 | M | Migrate `path-security.ts`, `feature-name.ts`, webhook/telegram errors to NaxError; lower baseline |
| P2 | ARCH-1 | M | Break the small cycle components surfaced by `--list`; keep ratchet falling |
| P2 | MAINT-1 | M | Split `validateStory`; extract `executeUnified`/`callOp` dispatch tables |
| P3 | BUG-2 | S | Preserve empty quoted args in `parseCommandToArgv` |
| P3 | ENH-3 | S | Separator-agnostic containment check in `isWithinDirectory` |
| P3 | ENH-4 | S | Document (or time-stamp) the file-lock PID-reuse limitation |

## Methodology

1. Stack detection → checklists: `universal.md` + `node-general.md` + `react.md` (React/Ink TUI).
2. Automated evidence: `bun run typecheck`, `bun run lint` (Biome + 13 invoked custom checks),
   `bun run test`, `test:e2e`, `test:coverage:report`, `bun audit --json`, ratchet scripts with
   `--list`.
3. Structural analysis: codebase-memory knowledge graph (full index: 37,806 nodes / 149,939 edges) —
   complexity, cognitive, loop-depth, linear-scan-in-loop, recursion, and SCC metrics; prior
   reviews in `docs/` cross-checked to avoid re-filing fixed findings.
4. Manual source review of the highest-risk paths: agent spawn/ACP parsing, webhook/telegram,
   path security, file locks, process liveness, secret redaction, crash signals, TUI timers,
   acceptance code generation, quality runner.
5. Every finding above carries a file:line reference, a command, or both. Reproduction commands
   were executed on this branch, based on `cf8e63fe5`.
