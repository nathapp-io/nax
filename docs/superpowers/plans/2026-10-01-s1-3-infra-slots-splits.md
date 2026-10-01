# S1-3 Infra Slots and Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land PR S1-3: the move set stops importing nax's logger, `NaxError`, credential config, `utils/git` and the `@/agents/cost` barrel. The infra becomes package-owned slots and in-place splits. The PR is behaviour-neutral, and the boundary ratchet falls from 83 to 20 edges.

**Architecture:** Every change happens in place under `packages/nax/src`. A new move-set directory, `src/agents/infra/` (barrel `@/agents/infra`), holds `NaxError`, an `AgentLogger` slot and a credentials slot. nax's old homes re-export or fill them: `src/errors.ts` re-exports the same class, `initLogger`/`resetLogger` set and clear the logger slot, and `bin/nax.ts` configures credentials before command dispatch. Three files split so that their generic halves can join the move set: `utils/git.ts` (to `utils/git-exec.ts`, which owns the shared `_gitDeps`), `agents/cost/calculate.ts` (to `agents/cost/usage-math.ts`, behind a new `@/agents/cost/core` barrel), and `logger/redact.ts` (relocated to `utils/redact.ts`).

**Tech Stack:** TypeScript (ESM), Bun 1.4.0, `bun:test`, Biome. Package commands run from `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-01-s1-nax-agent-carve-out-design.md`, sections 2 (R2), 4.2 (ports 5 and 8), 4.3, 6 and 8. Read it first. **Two corrections** to the spec are made here (Decisions 2 and 3 below). The spec describes behaviour that the code on `main` does not have, and following the spec literally would break behaviour neutrality.

**Base:** `main` @ `2b2b77bb4` (S1-2 #2320 merged). Branch: `feat/s1-3-infra-slots-splits`. Line numbers below refer to that commit.

## Global Constraints

- Behaviour-neutral: no change to `nax run` output, log lines, cost rows, `metrics.json`, `nax config` output, stream events or any CLI text.
- Run package commands from `packages/nax`. Never run bare `bun test` (no path); single files run as `bun test <path> --timeout=60000`. Never `bun run nax`.
- Full verification: `bun run test`, `bun run typecheck`, `bun run lint`, and `bun run check:all` from the repo root.
- No test is edited to pass unless its subject moved or its port was cut. In this PR that means `NaxError`, the logger slot, `redact`, `git-exec`, the credentials slot and the cost core.
- Source files stay at or under 600 lines and test files at or under 800 (`check:file-sizes`). `src/utils/git.ts` (567) shrinks in this PR. `src/logger/logger.ts` (485) grows by a few lines. Re-check with `wc -l` after editing either.
- Code blocks show content, not final formatting. Before every commit, run `bun x biome check --write <files you touched>`, then `bun run lint`.
- **Import rules** (`check:alias-internals`). In `src/`, a **value** import of `@/<dir>/<internal>` is forbidden when `src/<dir>/index.ts` exists. Use the exact barrel instead (`@/agents/infra`, `@/agents/cost/core`). `src/utils/` has no barrel, so `@/utils/git-exec` and `@/utils/redact` are legal. A **type-only** import may target a leaf. Relative imports may climb one level (`../x`); `../../` is banned by biome `noRestrictedImports`.
- `check:import-cycles` must stay green. `src/agents/infra/` imports nothing from nax, so importing it cannot close a cycle.
- The ratchet (`check:agent-boundary`) may only fall. Every task that lowers it ends with `bun run check:agent-boundary:update`, and the baseline is committed.
- Commit locally as the steps say. **Push and open the PR only after the user approves.**
- nax is a public repo: commit messages and PR text never name private projects.
- Commits use conventional prefixes (`refactor:`, `test:`, `chore:`, `docs:`), no emojis.

## Decisions this plan takes (flag in review if you disagree)

1. **One new move-set directory, `src/agents/infra/`** (manifest `src/agents/infra/` -> `infra/`), with barrel `index.ts`, `nax-error.ts`, `agent-logger.ts` and `credentials-config.ts`. It sits beside the existing `infra/` entries (`utils/errors.ts` -> `infra/errors.ts`, `runtime/spin-breaker/` -> `infra/spin-breaker/`); no destination path collides.
2. **Spec correction (R2, port 5): the slot's `getLogger()` does not throw when unset.** The spec says it throws "as nax's does". It does not: `getLogger()` at `src/logger/logger.ts:450-455` returns a silent `noopLogger` when no logger is initialised. That logger has no sinks (`addSink` throws before `initLogger`, `logger.ts:391-397`), so its output is unobservable. The slot therefore returns a no-op `AgentLogger` from `getLogger()` when unset, and `null` from `getSafeLogger()`. In every observable respect this matches today: a silent logger and a skipped `?.` call both produce nothing. No move-set file branches on a `null` logger (`grep` for `if (!logger)`, `?? `, `|| ` after `getSafeLogger()` finds none).
3. **Spec correction (port 8): the credentials slot holds functions, not values.** The spec says `configureCredentials({ dir, authConfig })`. Today the credential code re-reads both on every call: `globalConfigDir()` is evaluated per call (the store memo at `credentials/index.ts:119-131` is keyed on it because `NAX_GLOBAL_CONFIG_DIR` changes between tests), and `readGlobalAuthConfig()` is re-read per assembly and in `authSourceIsExec()` (`index.ts:55,162`). Capturing values once would change that. The slot is therefore `configureCredentials({ configDir: () => string, readAuthConfig: () => Promise<CredentialAuthConfig> })`. The rest of the spec stands: it is set once per process, nax sets it in `bin/nax.ts` before dispatch, and an unset slot throws `NaxError` with code `CREDENTIALS_NOT_CONFIGURED`.
4. **The test preload configures credentials** with nax's own wiring (`configureNaxCredentials()`), so the existing suite reads credentials exactly as before. Tests of the unset path reset the slot themselves and restore it afterwards.
5. **`redact.ts` relocates to `src/utils/redact.ts`** (`git mv`), not into a nested `logger/redact/` barrel. `src/logger/` has a barrel, so `@/logger/redact` is an illegal value import, while `@/utils/redact` is legal. The manifest entry changes from `src/logger/redact.ts` to `src/utils/redact.ts`; the destination stays `internal/redact.ts`. `@/logger` keeps re-exporting `redactSecrets` and `SECRET_VALUE_PATTERNS`.
6. **The cost core gets a nested barrel, `src/agents/cost/core/index.ts`,** re-exporting `estimate.ts`, `standard-types.ts` and a new `usage-math.ts`. The files stay where S1-1 put them, so no cost test moves. `inputClassTokens` and `addTokenUsage` (with their private `toFiniteTokenCount`) move from `calculate.ts` to `usage-math.ts`. `calculate.ts` keeps `formatCostWithConfidence` and `resolvePricingSource`, which stay in nax permanently (spec section 5.2), and re-exports the two moved functions, so `@/agents/cost` is unchanged.
7. **`_gitDeps` is defined once, in `src/utils/git-exec.ts`.** `src/utils/git.ts` re-exports that same object (spec section 4.3), so the 35 test files that patch `_gitDeps` keep affecting both halves. Its `getSafeLogger` field defaults to the slot's `getSafeLogger`, which returns the same `Logger` instance once `initLogger` has run.
8. **`configureNaxCredentials()` lives in `src/config/auth.ts`** next to `readGlobalAuthConfig`, and is exported from `@/config`. The probe scripts that read credentials call it too.
9. **Spin-breaker clean-up** is its one remaining edge, `@/logger`, which Task 3 retargets. Its other imports (`utils/sort`, `utils/strip-control-chars`) are already in the move set.
10. **Out of scope (S1-4):** the 20 edges left after this PR. They are ports 1, 4, 6 and 7 plus the `runtime/index` import in `session.ts` (port 5, activity mapping). They are listed in Task 6, step 1.

## Review Focus

1. **`NAX_GLOBAL_CONFIG_DIR` changes between two credential reads in one process** (every test that isolates a temp dir does this). Expected: the credential file path, the salt path and the store memo key follow the new directory, exactly as they do today. Pinned by Task 5, step 1 (`configureNaxCredentials follows NAX_GLOBAL_CONFIG_DIR live`).
2. **Move-set code logs before `initLogger` or after `resetLogger`** (CLI paths before logger init, tests). Expected: no throw and no output. `getLogger()` in `transcript-store.ts` must not start throwing. Pinned by Task 3, step 1 (`getLogger returns a silent no-op when unset`).
3. **The logger is reset and re-initialised in one process** (test files do this every time). Expected: the slot serves the new instance, never the closed old one. Pinned by Task 3, step 1 (`re-init replaces the slot`).
4. **`instanceof NaxError` across both import paths, including subclasses** (27 checks in nax; `LockAcquisitionError` and the other subclasses stay in `src/errors.ts`). Expected: one class, so every check keeps matching. Pinned by Task 2, step 1.
5. **A test that patches `_gitDeps.spawn` through `@/utils/git` while the code under test is a move-set tool that imports `@/utils/git-exec`.** Expected: the patch intercepts, because it is the same object. Pinned by Task 4, step 1 (`git.ts re-exports the same _gitDeps object`).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/agents/cost/usage-math.ts` | 1 | `inputClassTokens`, `addTokenUsage` (moved from `calculate.ts`) |
| `src/agents/cost/core/index.ts` | 1 | barrel `@/agents/cost/core`: the move-set cost core |
| `src/agents/cost/calculate.ts`, `src/agents/cost/estimate.ts` | 1 | re-export / import from `usage-math` |
| `src/agents/infra/nax-error.ts` | 2 | `NaxError` (moved from `src/errors.ts`) |
| `src/agents/infra/index.ts` | 2, 3, 5 | barrel `@/agents/infra` |
| `src/errors.ts` | 2 | re-exports `NaxError`; subclasses stay |
| `src/agents/infra/agent-logger.ts` | 3 | `AgentLogger`, `setAgentLogger`, `getSafeLogger`, `getLogger` |
| `src/logger/logger.ts` | 3 | `initLogger`/`resetLogger` fill and clear the slot |
| `src/utils/redact.ts` | 3 | `git mv` of `src/logger/redact.ts` |
| `src/utils/git-exec.ts` | 4 | `_gitDeps`, `GIT_TIMEOUT_MS`, `gitWithTimeout`, `getGitRoot` (from `utils/git.ts`) |
| `src/agents/infra/credentials-config.ts` | 5 | `CredentialAuthConfig`, `configureCredentials`, `credentialsConfig`, `_resetCredentialsConfig` |
| `src/config/auth.ts` | 5 | `configureNaxCredentials()` |
| `bin/nax.ts`, `test/preload.ts`, `scripts/probe-*.ts` | 5 | call `configureNaxCredentials()` |
| `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json` | 1-5 | manifest entries; ratchet baseline |

---

### Task 1: Cost core split (folded in from the unassigned S1-4b)

S1-2 left three move-set files importing the `@/agents/cost` barrel, and `estimate.ts` importing `calculate.ts`. Neither the barrel nor `calculate.ts` moves, because both carry nax-only code (`rate-card.ts`, the reporting helpers).

**Files:**
- Create: `src/agents/cost/usage-math.ts`, `src/agents/cost/core/index.ts`, `test/unit/agents/cost/cost-core-barrel.test.ts`
- Modify: `src/agents/cost/calculate.ts:1-13,54-81,105-119`, `src/agents/cost/estimate.ts:19,27`
- Modify (retarget imports): `src/agents/native/complete.ts:7`, `src/agents/native/session-adapter.ts:10`, `src/agents/native/session/turn-loop-round-trip.ts:36`
- Modify: `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces: `@/agents/cost/core` exports `priceCall`, `estimateCostUsd`, `inputClassTokens`, `addTokenUsage` and `type { Pricing, PricingRates, PricingTier, TokenUsage }`. Each is the same function object that `@/agents/cost` exports.

- [ ] **Step 1: Write the failing test**

`test/unit/agents/cost/cost-core-barrel.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as costBarrel from "@/agents/cost";
import * as costCore from "@/agents/cost/core";

describe("@/agents/cost/core", () => {
  test("serves the same function objects as @/agents/cost", () => {
    expect(costCore.priceCall).toBe(costBarrel.priceCall);
    expect(costCore.estimateCostUsd).toBe(costBarrel.estimateCostUsd);
    expect(costCore.inputClassTokens).toBe(costBarrel.inputClassTokens);
    expect(costCore.addTokenUsage).toBe(costBarrel.addTokenUsage);
  });

  test("inputClassTokens counts input plus both cache classes, not output", () => {
    expect(
      costCore.inputClassTokens({ inputTokens: 10, outputTokens: 99, cacheReadTokens: 5, cacheWriteTokens: 2 }),
    ).toBe(17);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/cost/cost-core-barrel.test.ts --timeout=60000`
Expected: FAIL. `@/agents/cost/core` cannot be resolved.

- [ ] **Step 3: Create `usage-math.ts` and move the two functions**

Create `src/agents/cost/usage-math.ts`. Its header says it holds the pure usage arithmetic shared by the pricing core and nax's reporting helpers. **Cut** (not copy) from `calculate.ts` the private `toFiniteTokenCount` helper and the exported `addTokenUsage` and `inputClassTokens`, with their doc comments, verbatim. Its only import is `import type { TokenUsage } from "./standard-types";`.

In `calculate.ts`, add `export { addTokenUsage, inputClassTokens } from "./usage-math";`, drop the `TokenUsage` import if nothing else uses it, and update the header comment's helper list. In `estimate.ts:19`, change the import to `import { inputClassTokens } from "./usage-math";` (the re-export on line 27 stays).

- [ ] **Step 4: Create the barrel**

`src/agents/cost/core/index.ts`:

```ts
/**
 * The cost core that moves into nax-agent (spec R4, section 5.2): pricing math
 * over nax-ai's usage and pricing types. nax-only cost code (rate-card policy,
 * catalog lookup, reporting helpers) stays behind `@/agents/cost`.
 */
export { estimateCostUsd, priceCall } from "../estimate";
export type { Pricing, PricingRates, PricingTier, TokenUsage } from "../standard-types";
export { addTokenUsage, inputClassTokens } from "../usage-math";
```

- [ ] **Step 5: Retarget the three move-set importers**

In `complete.ts:7` and `session-adapter.ts:10`, use `import { priceCall } from "@/agents/cost/core";`. In `turn-loop-round-trip.ts:36`, use `import { inputClassTokens } from "@/agents/cost/core";`.

- [ ] **Step 6: Add manifest entries**

In `scripts/s1-move-manifest.json`, after the `estimate.ts` entry:

```json
    { "from": "src/agents/cost/usage-math.ts", "to": "cost/usage-math.ts" },
    { "from": "src/agents/cost/core/", "to": "cost/core/" },
```

- [ ] **Step 7: Verify**

Run: `bun test test/unit/agents/cost --timeout=60000`. Expected: PASS, including the new file and `price-call-golden.test.ts`.
Run: `bun run typecheck && bun run check:agent-boundary -- --list | tail -1`. Expected: `79 boundary edge(s)`. These four lines are gone: `estimate.ts -> calculate.ts`, and `complete.ts`, `session-adapter.ts`, `turn-loop-round-trip.ts -> src/agents/cost/index.ts`.
Mutation check: point `turn-loop-round-trip.ts` back at `@/agents/cost`, re-run the ratchet list, and confirm 80. Then revert.

- [ ] **Step 8: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/cost src/agents/native/complete.ts src/agents/native/session-adapter.ts src/agents/native/session/turn-loop-round-trip.ts test/unit/agents/cost/cost-core-barrel.test.ts
bun run lint
git add -A src/agents/cost src/agents/native test/unit/agents/cost scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: split the cost core into a move-set barrel"
```

---

### Task 2: `NaxError` moves into `src/agents/infra/` (R2, errors)

**Files:**
- Create: `src/agents/infra/nax-error.ts`, `src/agents/infra/index.ts`, `test/unit/agents/infra/nax-error.test.ts`
- Modify: `src/errors.ts:1-22`
- Modify (retarget imports, 20 files): `src/agents/coding-tool-sandbox.ts`, `src/agents/coding-tool-support.ts`, `src/agents/native/auth.ts`, `src/agents/native/client.ts`, `src/agents/native/credentials/{chained-store,change-guard,exec-source,index}.ts`, `src/agents/native/errors.ts`, `src/agents/native/models.ts`, `src/agents/native/session/{session,transcript-store,turn-loop}.ts`, `src/sandbox/launcher.ts:14`, `src/sandbox/policy-builder.ts:11`, `src/tools/{provider-adapt,provider-types,read-file,registry}.ts`, `src/utils/file-lock.ts:67`
- Modify: `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Produces: `@/agents/infra` exports `class NaxError extends Error { constructor(message: string, code: string, context?: Record<string, unknown>); readonly code: string; readonly context?: Record<string, unknown> }`, the identical class object that `@/errors` exports.

- [ ] **Step 1: Write the failing test**

`test/unit/agents/infra/nax-error.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NaxError as InfraNaxError } from "@/agents/infra";
import { LockAcquisitionError, NaxError } from "@/errors";

describe("NaxError in the move set", () => {
  test("@/errors re-exports the same class object", () => {
    expect(InfraNaxError).toBe(NaxError);
  });

  test("an error thrown from the move set matches nax's instanceof checks", () => {
    const err = new InfraNaxError("boom", "SOME_CODE", { stage: "x" });
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("NaxError");
    expect(err.code).toBe("SOME_CODE");
    expect(err.context).toEqual({ stage: "x" });
  });

  test("nax's subclasses still extend the moved class", () => {
    const err = new LockAcquisitionError({ workdir: "/w" });
    expect(err).toBeInstanceOf(InfraNaxError);
    expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/infra/nax-error.test.ts --timeout=60000`
Expected: FAIL. `@/agents/infra` cannot be resolved.

- [ ] **Step 3: Move the class**

Create `src/agents/infra/nax-error.ts` with the `NaxError` class cut verbatim from `src/errors.ts:10-21`, including its doc comment. Add a file header: "Base error class for nax and nax-agent. Lives in the move set (spec R2); `src/errors.ts` re-exports it so every `instanceof NaxError` check matches one class."

Replace the class in `src/errors.ts` with:

```ts
import { NaxError } from "./agents/infra";

export { NaxError };
```

Use the relative form: `src/errors.ts` is at the `src/` root, so `./agents/infra` is a one-level path. The subclasses below it are unchanged.

`src/agents/infra/index.ts`:

```ts
/**
 * nax-agent infrastructure (spec R2): the error base class and the process-wide
 * slots nax fills. Imports nothing from nax.
 */
export { NaxError } from "./nax-error";
```

- [ ] **Step 4: Retarget the move-set importers**

In each of the 20 files listed under **Files**, change `import { NaxError } from "@/errors";` (or `"../errors"` in `sandbox/launcher.ts`, `sandbox/policy-builder.ts` and `utils/file-lock.ts`) to `import { NaxError } from "@/agents/infra";`. Find them with:

```bash
bun scripts/check-agent-boundary.ts --list | grep ' -> src/errors.ts'
```

- [ ] **Step 5: Add the manifest entry**

```json
    { "from": "src/agents/infra/", "to": "infra/" },
```

- [ ] **Step 6: Verify**

Run: `bun test test/unit/agents/infra --timeout=60000`. Expected: PASS.
Run: `bun run typecheck && bun run check:import-cycles && bun run check:agent-boundary -- --list | tail -1`. Expected: `59 boundary edge(s)`, and no line ends in `-> src/errors.ts`.

- [ ] **Step 7: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/infra src/errors.ts <the 20 files> test/unit/agents/infra
bun run lint
git add -A src test/unit/agents/infra scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: move NaxError into the nax-agent move set"
```

---

### Task 3: Logger slot and `redact` relocation (R2 logger, port 5)

**Files:**
- Create: `src/agents/infra/agent-logger.ts`, `test/unit/agents/infra/agent-logger.test.ts`, `test/unit/logger/agent-logger-wiring.test.ts`
- Modify: `src/agents/infra/index.ts`, `src/logger/logger.ts:7,414-424,480-485`, `src/logger/index.ts:11-12`
- Move: `git mv src/logger/redact.ts src/utils/redact.ts`; modify `test/unit/logger/redact.test.ts:2` (subject moved)
- Modify (retarget imports, 32 files): every line of `bun scripts/check-agent-boundary.ts --list | grep ' -> src/logger/index.ts'`. Seven use a relative `../logger` specifier: `permissions/approvals-{link,taint}.ts`, `sandbox/{git-guards,launcher,registry}.ts`. `src/agents/native/credentials/helper-process.ts:12` and `src/permissions/secret-spans.ts:14` also import from redact.
- Modify: `scripts/s1-move-manifest.json` (redact entry), `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Consumes: `@/agents/infra` (Task 2).
- Produces, from `@/agents/infra`:
  - `interface AgentLogger { error(stage: string, message: string, data?: Record<string, unknown>): void; warn(...same): void; info(...same): void; debug(...same): void }`
  - `setAgentLogger(logger: AgentLogger | null): void`
  - `getSafeLogger(): AgentLogger | null` (`null` when unset)
  - `getLogger(): AgentLogger` (a silent no-op when unset; never throws)
- Produces: `@/utils/redact` exports `redactSecrets`, `redactEntry`, `SECRET_VALUE_PATTERNS`, `type SecretValuePattern`. These are unchanged; `@/logger` still re-exports the first two plus the type.

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/infra/agent-logger.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { type AgentLogger, getLogger, getSafeLogger, setAgentLogger } from "@/agents/infra";

function recordingLogger(): AgentLogger & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    error: (stage, message) => calls.push(`error:${stage}:${message}`),
    warn: (stage, message) => calls.push(`warn:${stage}:${message}`),
    info: (stage, message) => calls.push(`info:${stage}:${message}`),
    debug: (stage, message) => calls.push(`debug:${stage}:${message}`),
  };
}

describe("agent logger slot", () => {
  afterEach(() => setAgentLogger(null));

  test("getSafeLogger is null when unset", () => {
    setAgentLogger(null);
    expect(getSafeLogger()).toBeNull();
  });

  test("getLogger returns a silent no-op when unset and does not throw", () => {
    setAgentLogger(null);
    expect(() => getLogger().warn("stage", "message", { a: 1 })).not.toThrow();
  });

  test("both accessors serve the installed logger", () => {
    const logger = recordingLogger();
    setAgentLogger(logger);
    getSafeLogger()?.info("s", "one");
    getLogger().debug("s", "two");
    expect(logger.calls).toEqual(["info:s:one", "debug:s:two"]);
  });

  test("re-init replaces the slot", () => {
    const first = recordingLogger();
    const second = recordingLogger();
    setAgentLogger(first);
    setAgentLogger(second);
    getLogger().error("s", "m");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["error:s:m"]);
  });
});
```

`test/unit/logger/agent-logger-wiring.test.ts` (production wiring: `initLogger` must fill the slot):

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { getSafeLogger as agentSafeLogger } from "@/agents/infra";
import { initLogger, resetLogger } from "@/logger";

describe("initLogger fills the agent logger slot", () => {
  afterEach(() => resetLogger());

  test("the slot serves the instance initLogger created", () => {
    resetLogger();
    const logger = initLogger({ level: "silent" });
    expect(agentSafeLogger()).toBe(logger);
  });

  test("resetLogger clears the slot", () => {
    resetLogger();
    initLogger({ level: "silent" });
    resetLogger();
    expect(agentSafeLogger()).toBeNull();
  });

  test("a second init after reset serves the new instance", () => {
    resetLogger();
    initLogger({ level: "silent" });
    resetLogger();
    const second = initLogger({ level: "silent" });
    expect(agentSafeLogger()).toBe(second);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/infra/agent-logger.test.ts test/unit/logger/agent-logger-wiring.test.ts --timeout=60000`
Expected: FAIL. `setAgentLogger` is not exported from `@/agents/infra`.

- [ ] **Step 3: Write the slot**

`src/agents/infra/agent-logger.ts`:

```ts
/**
 * The logger slot (spec R2). nax-agent logs through whatever logger the host
 * installs; nax installs its own from `initLogger` and clears it in
 * `resetLogger`.
 *
 * Unset semantics match nax's logger exactly: `getSafeLogger()` gives `null`
 * (callers use `?.`), and `getLogger()` gives a silent no-op rather than
 * throwing. nax's `getLogger()` returns a sink-less silent logger when
 * uninitialised, so neither form has ever produced output before init.
 */
export interface AgentLogger {
  error(stage: string, message: string, data?: Record<string, unknown>): void;
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
  info(stage: string, message: string, data?: Record<string, unknown>): void;
  debug(stage: string, message: string, data?: Record<string, unknown>): void;
}

const noopLogger: AgentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

let installed: AgentLogger | null = null;

/** Install (or, with `null`, clear) the process-wide logger. */
export function setAgentLogger(logger: AgentLogger | null): void {
  installed = logger;
}

/** The installed logger, or `null` when none is installed. */
export function getSafeLogger(): AgentLogger | null {
  return installed;
}

/** The installed logger, or a silent no-op when none is installed. Never throws. */
export function getLogger(): AgentLogger {
  return installed ?? noopLogger;
}
```

Add to `src/agents/infra/index.ts`:

```ts
export { type AgentLogger, getLogger, getSafeLogger, setAgentLogger } from "./agent-logger";
```

- [ ] **Step 4: Wire nax's logger into the slot**

In `src/logger/logger.ts`, add `import { setAgentLogger } from "../agents/infra";`. Use the one-level relative form: `src/logger/` to `src/agents/infra` is `../agents/infra`. In `initLogger`, immediately after `instance = new Logger(options);` (line 422), add `setAgentLogger(instance);`. In `resetLogger`, after `instance = null;`, add `setAgentLogger(null);`. `instance` is assigned nowhere else (`grep -n 'instance =' src/logger/logger.ts` shows only these two lines), so the slot always mirrors it.

Run the two test files from step 1. Expected: PASS.

- [ ] **Step 5: Relocate `redact.ts`**

```bash
git mv src/logger/redact.ts src/utils/redact.ts
```

- In `src/logger/logger.ts:7`, use `import { redactEntry } from "../utils/redact.js";`.
- In `src/logger/index.ts:11-12`, re-export from `"../utils/redact.js"`.
- In `test/unit/logger/redact.test.ts:2`, use `import { redactEntry, redactSecrets } from "@/utils/redact";` (the subject moved).
- In `scripts/s1-move-manifest.json`, change the entry `"src/logger/redact.ts"` to `"src/utils/redact.ts"` and keep `"to": "internal/redact.ts"`.

- [ ] **Step 6: Retarget the 32 move-set importers**

For each file in `bun scripts/check-agent-boundary.ts --list | grep ' -> src/logger/index.ts'`:
- `import { getSafeLogger } from "@/logger";` or `"../logger"` becomes `import { getSafeLogger } from "@/agents/infra";`
- `import { getLogger } from "@/logger";` (`transcript-store.ts`) becomes `import { getLogger } from "@/agents/infra";`
- `helper-process.ts:12` becomes `import { getSafeLogger } from "@/agents/infra";` plus `import { redactSecrets } from "@/utils/redact";`
- `secret-spans.ts:14` becomes `import { SECRET_VALUE_PATTERNS } from "@/utils/redact";`

Do not touch `src/utils/git.ts` here; Task 4 handles it.

- [ ] **Step 7: Check for tests that spied on nax's logger module to observe move-set code**

Run: `bun run test`.
If a test fails because it used `spyOn(loggerModule, "getSafeLogger")` (where `loggerModule` is `@/logger`) and the code under test is now a move-set file, the subject's port was cut. Change that test to install a capturing logger with `setAgentLogger(...)` and restore it with `setAgentLogger(null)` in `afterEach`. Record each such file in the PR body. A test that observes nax-side code through `@/logger` is unaffected, and must not be edited.

- [ ] **Step 8: Verify**

Run: `bun run typecheck && bun run check:import-cycles && bun run check:alias-internals && bun run check:agent-boundary -- --list | tail -1`
Expected: `27 boundary edge(s)`, and no line ends in `-> src/logger/index.ts`.
Mutation check: delete `setAgentLogger(instance);` from `initLogger`. `agent-logger-wiring.test.ts` must fail. Then revert.

- [ ] **Step 9: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/infra src/logger src/utils/redact.ts <the 32 files> test/unit/agents/infra test/unit/logger
bun run lint
git add -A src test scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: route move-set logging through an agent logger slot"
```

---

### Task 4: `utils/git` split with a shared `_gitDeps` (spec section 4.3)

**Files:**
- Create: `src/utils/git-exec.ts`, `test/unit/utils/git-exec.test.ts`
- Modify: `src/utils/git.ts:1-152` (the exec half leaves; `getGitRoot` leaves)
- Modify (retarget imports): `src/sandbox/policy-inputs.ts:10`, `src/tools/delete.ts:59`, `src/tools/git-commit.ts:16`, `src/tools/git.ts:20`
- Modify: `scripts/s1-move-manifest.json`, `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Consumes: `getSafeLogger` from `@/agents/infra` (Task 3).
- Produces, from `@/utils/git-exec`: `_gitDeps: { spawn; getSafeLogger: () => AgentLogger | null; gitTimeoutMs: number; timeoutRetryGitTimeoutMs: number }`, `GIT_TIMEOUT_MS = 10_000`, `gitWithTimeout(args, workdir, timeoutMs?, maxBytes?, argvOverride?)` with an unchanged signature, and `getGitRoot(workdir): Promise<string | null>`. `@/utils/git` re-exports all four under the same names.

- [ ] **Step 1: Write the failing test**

`test/unit/utils/git-exec.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import * as gitModule from "@/utils/git";
import * as gitExec from "@/utils/git-exec";

describe("utils/git-exec", () => {
  const originalSpawn = gitExec._gitDeps.spawn;
  afterEach(() => {
    gitExec._gitDeps.spawn = originalSpawn;
  });

  test("git.ts re-exports the same _gitDeps object", () => {
    expect(gitModule._gitDeps).toBe(gitExec._gitDeps);
    expect(gitModule.gitWithTimeout).toBe(gitExec.gitWithTimeout);
    expect(gitModule.getGitRoot).toBe(gitExec.getGitRoot);
    expect(gitModule.GIT_TIMEOUT_MS).toBe(gitExec.GIT_TIMEOUT_MS);
  });

  test("a spawn patched through @/utils/git intercepts gitWithTimeout from @/utils/git-exec", async () => {
    const seen: string[][] = [];
    gitModule._gitDeps.spawn = ((argv: string[]) => {
      seen.push(argv);
      return {
        stdout: new Response("abc\n").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as unknown as typeof gitModule._gitDeps.spawn;

    const result = await gitExec.gitWithTimeout(["rev-parse", "HEAD"], "/tmp");
    expect(result).toEqual({ stdout: "abc\n", stderr: "", exitCode: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("rev-parse");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/utils/git-exec.test.ts --timeout=60000`
Expected: FAIL. `@/utils/git-exec` cannot be resolved.

- [ ] **Step 3: Split the file**

Create `src/utils/git-exec.ts`. Cut verbatim from `src/utils/git.ts`: `GIT_TIMEOUT_MS` (line 16), `TIMEOUT_RETRY_GIT_TIMEOUT_MS` (line 24), the `_gitDeps` object and its doc comment (lines 34-49), `getGitRoot` (lines 51-65) and `gitWithTimeout` with its doc comment (lines 67-139). Its imports:

```ts
import { getSafeLogger } from "@/agents/infra";
import { drainBounded } from "./bounded-io";
import { spawn } from "./bun-deps";
import { hardenedGitArgv, hardenedGitEnv } from "./git-env";
```

Add a header: "Generic git subprocess execution, shared by nax and the move set. `_gitDeps` is defined here once; `utils/git.ts` re-exports the same object (spec section 4.3), so a test patch through either path affects both halves."

In `src/utils/git.ts`:
- Remove the moved code, and remove the imports only it used (`spawn`, `hardenedGitArgv`, `hardenedGitEnv`, `drainBounded` at line 275, `getSafeLogger` from `../logger`). Keep any import the remaining story logic still uses; let `bun run typecheck` and biome's unused-import check confirm.
- Add:

```ts
import { _gitDeps, gitWithTimeout } from "./git-exec";

export { _gitDeps, GIT_TIMEOUT_MS, getGitRoot, gitWithTimeout } from "./git-exec";
```

`AUTO_COMMIT_GIT_TIMEOUT_MS` stays in `git.ts` (only `autoCommitIfDirty` uses it). `autoCommitIfDirty` keeps calling `_gitDeps.getSafeLogger()`.

- [ ] **Step 4: Retarget the four move-set importers**

In `policy-inputs.ts:10` (relative `../utils/git`), `delete.ts:59`, `git-commit.ts:16` and `tools/git.ts:20`, use `import { gitWithTimeout } from "@/utils/git-exec";`.

- [ ] **Step 5: Add the manifest entry**

```json
    { "from": "src/utils/git-exec.ts", "to": "internal/git-exec.ts" },
```

- [ ] **Step 6: Verify**

Run: `bun test test/unit/utils --timeout=60000`. Expected: PASS. This includes `git.test.ts` and `git-auto-commit-block.test.ts`, which patch `_gitDeps.getSafeLogger` and `_gitDeps.spawn` through `@/utils/git`.
Run: `bun run typecheck && bun run check:git-spawn-env && bun run check:agent-boundary -- --list | tail -1`. Expected: `23 boundary edge(s)`, and no line ends in `-> src/utils/git.ts`. If `check:git-spawn-env` scans by file path and now misses `git-exec.ts`, widen its scan in this task and say so in the PR body.
Run: `wc -l src/utils/git.ts src/utils/git-exec.ts`. Both must be at or under 600.

- [ ] **Step 7: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/utils/git.ts src/utils/git-exec.ts src/sandbox/policy-inputs.ts src/tools/delete.ts src/tools/git-commit.ts src/tools/git.ts test/unit/utils/git-exec.test.ts
bun run lint
git add -A src test/unit/utils scripts/s1-move-manifest.json scripts/baselines/agent-boundary-baseline.json
git commit -m "refactor: split generic git exec out of utils/git"
```

---

### Task 5: Credentials slot and CLI bootstrap (port 8)

**Files:**
- Create: `src/agents/infra/credentials-config.ts`, `test/unit/agents/infra/credentials-config.test.ts`, `test/unit/config/configure-nax-credentials.test.ts`, `test/integration/cli/cli-credentials-bootstrap.test.ts`
- Modify: `src/agents/infra/index.ts`, `src/agents/native/credentials/index.ts:23,40,55,122,162`, `src/agents/native/credentials/fingerprint.ts:19,49`, `src/agents/native/credentials/change-guard.ts:16,32`
- Modify: `src/config/auth.ts`, `src/config/index.ts:2`
- Modify: `bin/nax.ts` (before `program.parseAsync`, about line 1673), `test/preload.ts`, `scripts/probe-c2-story-loop.ts`, `scripts/probe-native-coding-tools.ts`, `scripts/probe-native-tool-round-trip.ts`
- Modify: `scripts/baselines/agent-boundary-baseline.json`

**Interfaces:**
- Consumes: `NaxError` from `@/agents/infra` (Task 2).
- Produces, from `@/agents/infra`:

```ts
export interface CredentialAuthConfig {
  readonly source: "file" | "exec";
  readonly exec?: { readonly command: readonly string[]; readonly timeoutMs: number };
  readonly onChange: "warn" | "refuse";
}
export interface CredentialsConfig {
  /** The directory holding `credentials`, `config.json` and the fingerprint salt. Read per call. */
  configDir(): string;
  /** The auth section of the global config. Read per call. */
  readAuthConfig(): Promise<CredentialAuthConfig>;
}
export function configureCredentials(config: CredentialsConfig): void;
export function credentialsConfig(): CredentialsConfig; // throws NaxError CREDENTIALS_NOT_CONFIGURED when unset
export function _resetCredentialsConfig(): void; // tests only
```

- Produces, from `@/config`: `configureNaxCredentials(): void`, which calls `configureCredentials({ configDir: globalConfigDir, readAuthConfig: readGlobalAuthConfig })`.

- [ ] **Step 1: Write the failing tests**

`test/unit/agents/infra/credentials-config.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetCredentialsConfig,
  configureCredentials,
  credentialsConfig,
  NaxError,
} from "@/agents/infra";
import { configureNaxCredentials } from "@/config";

describe("credentials slot", () => {
  afterEach(() => configureNaxCredentials());

  test("unset slot throws CREDENTIALS_NOT_CONFIGURED", () => {
    _resetCredentialsConfig();
    let caught: unknown;
    try {
      credentialsConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("CREDENTIALS_NOT_CONFIGURED");
  });

  test("serves the configured functions", async () => {
    configureCredentials({
      configDir: () => "/cfg",
      readAuthConfig: async () => ({ source: "file", onChange: "refuse" }),
    });
    expect(credentialsConfig().configDir()).toBe("/cfg");
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("refuse");
  });
});
```

`test/unit/config/configure-nax-credentials.test.ts` (production wiring, Review Focus 1):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFilePath } from "@/agents/native";
import { configureNaxCredentials } from "@/config";
import { credentialsConfig } from "@/agents/infra";

describe("configureNaxCredentials", () => {
  let previous: string | undefined;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    previous = process.env.NAX_GLOBAL_CONFIG_DIR;
    dirA = mkdtempSync(join(tmpdir(), "nax-cred-a-"));
    dirB = mkdtempSync(join(tmpdir(), "nax-cred-b-"));
    configureNaxCredentials();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = previous;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test("follows NAX_GLOBAL_CONFIG_DIR live", () => {
    process.env.NAX_GLOBAL_CONFIG_DIR = dirA;
    expect(credentialFilePath()).toBe(join(dirA, "credentials"));
    process.env.NAX_GLOBAL_CONFIG_DIR = dirB;
    expect(credentialFilePath()).toBe(join(dirB, "credentials"));
  });

  test("re-reads the auth config on every call", async () => {
    process.env.NAX_GLOBAL_CONFIG_DIR = dirA;
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("warn");
    writeFileSync(join(dirA, "config.json"), JSON.stringify({ auth: { onChange: "refuse" } }));
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("refuse");
  });
});
```

Confirm `credentialFilePath` is exported from `@/agents/native` (`grep -n credentialFilePath src/agents/native/index.ts`). If it is not, import it from `@/agents/native/credentials` (tests may reach internals). Confirm the `config.json` key shape against `src/config/auth.ts` (it reads the `auth` section) before relying on the second test.

`test/integration/cli/cli-credentials-bootstrap.test.ts` (the CLI bootstrap supplies the port). Follow the spawn pattern of `test/integration/cli/cli-trust-gate.test.ts:56-70`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bin/nax.ts configures credentials before dispatch", () => {
  let globalDir: string;
  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "nax-cli-cred-"));
  });
  afterEach(() => rmSync(globalDir, { recursive: true, force: true }));

  test("`nax auth list` reads the credential store without CREDENTIALS_NOT_CONFIGURED", async () => {
    const entrypoint = join(process.cwd(), "bin", "nax.ts");
    const proc = Bun.spawn(["bun", entrypoint, "auth", "list"], {
      cwd: globalDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(`${stdout}${stderr}`).not.toContain("CREDENTIALS_NOT_CONFIGURED");
    expect(`${stdout}${stderr}`).not.toContain("Credentials are not configured");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/agents/infra/credentials-config.test.ts test/unit/config/configure-nax-credentials.test.ts --timeout=60000`
Expected: FAIL. `configureCredentials` and `configureNaxCredentials` are not exported.

- [ ] **Step 3: Write the slot**

`src/agents/infra/credentials-config.ts`:

```ts
import { NaxError } from "./nax-error";

/**
 * The credentials slot (spec port 8). The native credential store reads its
 * directory and auth config through this instead of nax's config module.
 *
 * Both members are functions, read on every use, because the store has always
 * re-read them live: the directory moves between tests, and the auth config is
 * re-read on each store assembly. The host sets the slot once per process
 * before any credential read; there is no silent default.
 */
export interface CredentialAuthConfig {
  readonly source: "file" | "exec";
  readonly exec?: { readonly command: readonly string[]; readonly timeoutMs: number };
  readonly onChange: "warn" | "refuse";
}

export interface CredentialsConfig {
  /** The directory holding `credentials`, `config.json` and the fingerprint salt. Read per call. */
  configDir(): string;
  /** The auth section of the global config. Read per call. */
  readAuthConfig(): Promise<CredentialAuthConfig>;
}

let configured: CredentialsConfig | undefined;

export function configureCredentials(config: CredentialsConfig): void {
  configured = config;
}

export function credentialsConfig(): CredentialsConfig {
  if (configured === undefined) {
    throw new NaxError(
      "Credentials are not configured: call configureCredentials() before reading credentials",
      "CREDENTIALS_NOT_CONFIGURED",
      { stage: "credentials" },
    );
  }
  return configured;
}

/** Clears the slot. Tests only. */
export function _resetCredentialsConfig(): void {
  configured = undefined;
}
```

Add to `src/agents/infra/index.ts`:

```ts
export {
  _resetCredentialsConfig,
  type CredentialAuthConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "./credentials-config";
```

- [ ] **Step 4: Add nax's wiring**

In `src/config/auth.ts`:

```ts
import { configureCredentials } from "../agents/infra";

/**
 * Point nax-agent's credential store at nax's global config. Called once per
 * process before command dispatch (`bin/nax.ts`), and by scripts and the test
 * preload that read credentials outside the CLI.
 */
export function configureNaxCredentials(): void {
  configureCredentials({ configDir: globalConfigDir, readAuthConfig: readGlobalAuthConfig });
}
```

The assignment is the compile-time check that nax's `AuthConfig` satisfies `CredentialAuthConfig`. In `src/config/index.ts:2`, export `configureNaxCredentials` beside `readGlobalAuthConfig`. Then run `bun run check:import-cycles`. If `config/auth.ts -> agents/infra` closes a cycle, stop and report it; do not work around it.

- [ ] **Step 5: Read through the slot in the credential store**

- `credentials/index.ts`: drop `import { globalConfigDir, readGlobalAuthConfig } from "@/config";` and import `credentialsConfig` from `@/agents/infra`. Then:
  - `credentialFilePath()` returns `join(credentialsConfig().configDir(), "credentials")`.
  - `assembleStore` uses `const auth = await credentialsConfig().readAuthConfig();`.
  - `storeKey()` uses `join(credentialsConfig().configDir(), "config.json")`.
  - `authSourceIsExec()` uses `(await credentialsConfig().readAuthConfig()).source === "exec"`.
  - Update the header comment's "`readGlobalAuthConfig()` is not [synchronous]" to name the slot.
- `credentials/fingerprint.ts`: `saltFilePath()` returns `join(credentialsConfig().configDir(), SALT_FILENAME)`. Update the header's `<globalConfigDir>` wording.
- `credentials/change-guard.ts`: use `import type { CredentialAuthConfig } from "@/agents/infra";` and `onChange: CredentialAuthConfig["onChange"];`.

- [ ] **Step 6: Configure at every entry point**

- `bin/nax.ts`: import `configureNaxCredentials` from `"../src/config"` (bin already imports from `../src/...`), and call `configureNaxCredentials();` immediately before the `try { await program.parseAsync(process.argv); }` block, with the comment `// Port 8: nax-agent reads credentials through a slot; set it before any command runs.`
- `test/preload.ts`: after the line that sets `process.env.NAX_GLOBAL_CONFIG_DIR` (line 30), import and call `configureNaxCredentials()` (Decision 4).
- `scripts/probe-c2-story-loop.ts`, `scripts/probe-native-coding-tools.ts`, `scripts/probe-native-tool-round-trip.ts`: call `configureNaxCredentials()` at the top of the script body. Before editing, check each one with `grep -n -E 'naxCredentialStore|createNativeClient|NativeSessionAdapter|nativeComplete|NativeAgentAdapter' <file>`; skip any that never reaches the credential store, and list the skipped ones in the PR body. **Do not run the probes**: they make billed calls.
- Then sweep for any other process entry that reaches the credential store: `grep -rln -E 'naxCredentialStore|readStoredEntries|authSourceIsExec|credentialFilePath' src bin scripts`. Every non-test hit must be reachable only from `bin/nax.ts` or a script you just configured. Report anything else and stop.

- [ ] **Step 7: Verify**

Run: `bun test test/unit/agents/infra test/unit/config/configure-nax-credentials.test.ts test/unit/agents/native/credentials test/unit/cli/auth.test.ts --timeout=60000`. Expected: PASS.
Run: `bun test test/integration/cli/cli-credentials-bootstrap.test.ts --timeout=60000`. Expected: PASS.
Mutation check 1: comment out the `configureNaxCredentials();` call in `bin/nax.ts`. The integration test must fail with `CREDENTIALS_NOT_CONFIGURED` in the output. Revert. If it does not fail, `auth list` swallowed the error without printing its code. Switch the test to a subcommand whose failure surfaces the code (check `src/cli/auth-list.ts` `errorCode`) before going on.
Mutation check 2: in `configureNaxCredentials`, replace `globalConfigDir` with a captured value (`const dir = globalConfigDir(); ... configDir: () => dir`). `follows NAX_GLOBAL_CONFIG_DIR live` must fail. Revert.
Run: `bun run typecheck && bun run check:agent-boundary -- --list | tail -1`. Expected: `20 boundary edge(s)`, and no `src/agents/native/credentials/*` line remains.

- [ ] **Step 8: Commit**

```bash
bun run check:agent-boundary:update
bun x biome check --write src/agents/infra src/agents/native/credentials src/config/auth.ts src/config/index.ts bin/nax.ts test/preload.ts scripts/probe-*.ts test/unit/agents/infra test/unit/config/configure-nax-credentials.test.ts test/integration/cli/cli-credentials-bootstrap.test.ts
bun run lint
git add -A src bin test scripts
git commit -m "refactor: read native credentials through a configured slot"
```

---

### Task 6: Full verification and PR body

- [ ] **Step 1: Confirm the remaining edges are exactly S1-4's**

Run: `bun scripts/check-agent-boundary.ts --list`
Expected: these 20 lines and nothing else:

```
src/agents/coding-tool-extras.ts -> src/quality/index.ts
src/agents/coding-tool-sandbox.ts -> src/trust/index.ts
src/agents/coding-tool-support.ts -> src/agents/coding-tool-support-resolve.ts
src/agents/coding-tool-support.ts -> src/config/index.ts
src/agents/coding-tool-support.ts -> src/config/permissions.ts
src/agents/coding-tool-support.ts -> src/quality/index.ts
src/agents/native/client.ts -> src/config/schema-types.ts
src/agents/native/model-resolver.ts -> src/config/schema-types.ts
src/agents/native/models.ts -> src/config/index.ts
src/agents/native/models.ts -> src/config/schema-types.ts
src/agents/native/session/session.ts -> src/runtime/index.ts
src/agents/native/session/turn-events.ts -> src/config/index.ts
src/agents/native/tier-providers.ts -> src/config/selectors.ts
src/sandbox/policy-inputs.ts -> src/config/paths/index.ts
src/tools/git-commit.ts -> src/utils/gitignore.ts
src/tools/git.ts -> src/utils/nax-owned-paths.ts
src/tools/provider-advertise.ts -> src/config/permissions.ts
src/tools/provider-types.ts -> src/config/permissions.ts
src/tools/run-command.ts -> src/quality/command-spec/index.ts
src/tools/run-command.ts -> src/quality/runner.ts
20 boundary edge(s)
```

If any other line appears, it was introduced by this PR. Fix it before going on.

- [ ] **Step 2: Full suite and gates**

From `packages/nax`: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:coverage`. From the repo root: `bun run check:all`. All must be green. Record the unit and integration pass counts for the PR body.

- [ ] **Step 3: Behaviour-neutrality spot checks**

- `grep -rn 'from "@/logger"' $(jq -r '.entries[].from' scripts/s1-move-manifest.json | sed 's#/$##')` prints nothing.
- `grep -rn 'from "@/errors"' <same set>` prints nothing.
- `git diff main --stat -- src/errors.ts src/logger/index.ts`: only the re-export lines changed. The public names of `@/errors` and `@/logger` are unchanged.

- [ ] **Step 4: Write the PR body draft**

Save it to the scratchpad (not the repo) with these sections:
- **Summary:** slots for the logger and credentials, `NaxError` in the move set, splits of `utils/git`, `cost/calculate` and `logger/redact`. The ratchet goes from 83 to 20 edges.
- **Spec corrections (for the arc SSOT):** Decisions 2 and 3 of this plan, each with its file:line evidence.
- **Folded in:** the cost-barrel edges that S1-2 left unassigned (the proposed S1-4b) are closed here (Task 1).
- **Tests re-pointed because their port was cut** (Task 3, step 7), if any.
- **Remaining for S1-4:** the 20 edges from step 1.
- **Test plan:** the commands from step 2 with their counts, plus each mutation check from Tasks 1, 3 and 5.

- [ ] **Step 5: Stop for approval**

Do not push. Report the branch, the commit list, the ratchet count and the PR body path to the user, and wait for approval to push and open the PR.
