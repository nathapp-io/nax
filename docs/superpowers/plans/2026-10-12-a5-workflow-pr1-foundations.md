# A5 Workflow Mode — PR1 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the config surface and the normalisation for workflow mode, make quota faults sticky per provider, and give the advisor a model ladder. Nothing in this PR changes how a run executes stories.

**Architecture:**
- New schema files (`schemas-workflow.ts`, `runtime-types-workflow.ts`) with one-line hooks into `schemas.ts` / `runtime-types.ts`.
- A pure `applyWorkflowMode(config)` runs after the final `safeParse` in both loader exit paths (root and per-package), so no config layer can undo it.
- A new `"quota"` `AgentError` type maps token-plan / usage-limit 429s to `fail-quota`. `fail-quota` gets a new cooldown scope, `"provider"`.
- `advisor/ladder.ts` picks the advisor's usable models in order.

**Tech Stack:** TypeScript, Bun 1.4, Zod 4, bun:test.

**Spec:** `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (rev 2). This plan covers §4 and §12 PR1. The quota and ladder rows come from §8 and §10.

**Plan series:** PR1 (this plan) → PR2 story loop → PR3 advisor kinds → PR4 feature workflow. Each plan lives in its own file in `docs/superpowers/plans/2026-10-12-a5-workflow-pr*.md`.

## Global Constraints

- Work in `packages/nax`. Run commands from `packages/nax`. Never run bare `bun test` with no path, and never `bun run nax`.
- Single test file: `bun test <path> --timeout=60000`. Full gate before push: `bun run check:all` (package) **and** repo-root `bun run check:all`, plus `bun run typecheck`.
- Source files ≤ 600 lines, test files ≤ 800 lines (file-size gate). `config/schemas.ts` (551) and `config/runtime-types.ts` (582) get **one-line** additions only. `agents/manager.ts` (600) must **not grow**.
- Zod 4: nested objects use `.prefault({})`, never `.default({})`.
- Immutability: never mutate a config object. Return new objects.
- `execution.mode` default `"pipeline"`. With `"pipeline"`, behaviour is byte-for-byte unchanged.
- `workflow.*` and `execution.mode` are **root-only** (`config/root-only-keys.ts`).
- `workflow.maxFixRounds` is an int ≥ 1, default 5. Timeouts default: implement 3,600,000 · fix 3,600,000 · review 1,800,000 · ciWait 1,200,000 · ciPoll 30,000 (ms).
- `advisor.fallbackModels` is a `ConfiguredModel[]`, default `[]`.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`). No emojis.

## Review Focus

1. **A package `.nax/mono/<pkg>/config.json` that sets `acceptance.enabled: true` in workflow mode.** Expect it to resolve `false`, with a warning. Pinned by Task 3's package-path test.
2. **A non-quota rate limit** (the plain `rate_limit_error` "slow down" message). It must stay `fail-rate-limit` with a transient cooldown, not become run-long. Pinned in Task 4.
3. **A quota fault on a model id with no provider prefix** (e.g. claude `"sonnet"`). Expect it to fall back to an agent-wide cooldown, the same as today's `fail-quota`. Pinned in Task 5.
4. **Every advisor model in quota cooldown, or failing.** Expect `advise` to return the existing failure result (`decision: null` path), not throw. Pinned in Task 6.
5. **`execution.mode: "workflow"` combined with the `--parallel 4` CLI flag.** Expect a warning and a run that's effectively sequential. Pinned in Task 3's runner test.

---

### Task 1: `workflow` config block + `execution.mode` + `advisor.fallbackModels`

**Files:**
- Create: `src/config/schemas-workflow.ts`
- Create: `src/config/runtime-types-workflow.ts`
- Modify: `src/config/schemas.ts` (import + one line in `NaxConfigSchema`, next to `advisor:` at ~:483)
- Modify: `src/config/schemas-execution.ts:250` (`ExecutionConfigSchema`: add `mode`)
- Modify: `src/config/runtime-types.ts:105` (`ExecutionConfig.mode`) and `:543` (one line, `workflow?:`)
- Modify: `src/config/schemas-advisor.ts` (`fallbackModels`)
- Modify: `src/config/runtime-types-advisor.ts` (`fallbackModels`)
- Modify: `src/config/root-only-keys.ts` (pin `workflow` and `execution.mode`)
- Modify: `src/cli/config-descriptions.ts` (descriptions for every new key)
- Modify: `src/config/index.ts` (export the new symbols)
- Test: `test/unit/config/workflow-config.test.ts`, extend `test/unit/config/advisor-config.test.ts`

**Interfaces:**
- Produces:
  - `WorkflowConfig` (type), `WorkflowConfigObjectSchema`, `WORKFLOW_DEFAULTS`
  - `resolveWorkflowConfig(config: { workflow?: WorkflowConfig } | undefined): WorkflowConfig`
  - `isWorkflowMode(config: { execution?: { mode?: "pipeline" | "workflow" } } | undefined): boolean`
  - `ExecutionConfig.mode: "pipeline" | "workflow"`, `AdvisorConfig.fallbackModels: ConfiguredModel[]`

- [ ] **Step 1: Write the failing test**

`test/unit/config/workflow-config.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { isWorkflowMode, NaxConfigSchema, resolveWorkflowConfig, WORKFLOW_DEFAULTS } from "@/config";

describe("workflow config", () => {
  test("defaults: pipeline mode, every workflow default filled (Zod 4 prefault)", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.execution.mode).toBe("pipeline");
    expect(parsed.workflow).toEqual({
      models: {},
      maxFixRounds: 5,
      preflight: true,
      timeouts: { implementMs: 3_600_000, fixMs: 3_600_000, reviewMs: 1_800_000, ciWaitMs: 1_200_000, ciPollMs: 30_000 },
    });
  });

  test("a partial block keeps the other defaults", () => {
    const parsed = NaxConfigSchema.parse({ workflow: { timeouts: { reviewMs: 60_000 } } });
    expect(parsed.workflow?.timeouts.reviewMs).toBe(60_000);
    expect(parsed.workflow?.timeouts.fixMs).toBe(3_600_000);
    expect(parsed.workflow?.maxFixRounds).toBe(5);
  });

  test("role models accept a ConfiguredModel", () => {
    const parsed = NaxConfigSchema.parse({
      workflow: { models: { storyReview: { agent: "native", model: "opencode-go/x[high]" }, branchReview: "powerful" } },
    });
    expect(parsed.workflow?.models.storyReview).toEqual({ agent: "native", model: "opencode-go/x[high]" });
    expect(parsed.workflow?.models.branchReview).toBe("powerful");
  });

  test("maxFixRounds must be an integer >= 1", () => {
    expect(() => NaxConfigSchema.parse({ workflow: { maxFixRounds: 0 } })).toThrow();
    expect(() => NaxConfigSchema.parse({ workflow: { maxFixRounds: 2.5 } })).toThrow();
  });

  test("execution.mode rejects unknown values", () => {
    expect(() => NaxConfigSchema.parse({ execution: { mode: "turbo" } })).toThrow();
  });

  test("resolveWorkflowConfig / isWorkflowMode tolerate absent blocks", () => {
    expect(resolveWorkflowConfig(undefined)).toEqual(WORKFLOW_DEFAULTS);
    expect(isWorkflowMode(undefined)).toBe(false);
    expect(isWorkflowMode({ execution: { mode: "workflow" } })).toBe(true);
  });
});
```

Add to `test/unit/config/advisor-config.test.ts` (and update the first test's expected object with `fallbackModels: []`):
```ts
  test("fallbackModels defaults to [] and accepts tiers and literal pins", () => {
    expect(NaxConfigSchema.parse({}).advisor?.fallbackModels).toEqual([]);
    const parsed = NaxConfigSchema.parse({
      advisor: { fallbackModels: ["powerful", { agent: "claude", model: "sonnet[medium]" }] },
    });
    expect(parsed.advisor?.fallbackModels).toEqual(["powerful", { agent: "claude", model: "sonnet[medium]" }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/config/workflow-config.test.ts test/unit/config/advisor-config.test.ts --timeout=60000`
Expected: FAIL. `isWorkflowMode` and `WORKFLOW_DEFAULTS` are not exported, and `advisor.fallbackModels` is undefined.

- [ ] **Step 3: Implement**

`src/config/runtime-types-workflow.ts`:
```ts
/**
 * `workflow` config types — A5 workflow mode (single implementer + bounded review loop).
 * Split out of `runtime-types.ts`, which is at its file-size limit. Root-only (pinned in `root-only-keys.ts`).
 */
import type { ConfiguredModel } from "./schema-types";

export interface WorkflowModelsConfig {
  /** Falls back to review.semantic.model. */
  storyReview?: ConfiguredModel;
  /** Falls back to finish.reviewers.quality. */
  branchReview?: ConfiguredModel;
  /** Falls back to finish.reviewers.fix. */
  branchFix?: ConfiguredModel;
}

export interface WorkflowTimeoutsConfig {
  implementMs: number;
  fixMs: number;
  reviewMs: number;
  ciWaitMs: number;
  ciPollMs: number;
}

/** `workflow` block. Read only when `execution.mode === "workflow"`. */
export interface WorkflowConfig {
  models: WorkflowModelsConfig;
  /** Rounds 1..min(3, max) reuse the warm implementer session; later rounds are fresh, one tier up. */
  maxFixRounds: number;
  preflight: boolean;
  timeouts: WorkflowTimeoutsConfig;
}

export type ExecutionMode = "pipeline" | "workflow";
```

`src/config/schemas-workflow.ts`:
```ts
/**
 * `workflow` config schema (A5). Zod 4: nested objects use `.prefault({})` so their own
 * field defaults apply — `.default({})` would short-circuit to a bare `{}`.
 */
import { z } from "zod";
import type { ExecutionMode, WorkflowConfig } from "./runtime-types-workflow";
import { ConfiguredModelSchema } from "./schemas-model";

export const ExecutionModeSchema = z.enum(["pipeline", "workflow"]);

export const WorkflowConfigObjectSchema = z.object({
  models: z
    .object({
      storyReview: ConfiguredModelSchema.optional(),
      branchReview: ConfiguredModelSchema.optional(),
      branchFix: ConfiguredModelSchema.optional(),
    })
    .prefault({}),
  maxFixRounds: z.number().int().min(1).default(5),
  preflight: z.boolean().default(true),
  timeouts: z
    .object({
      implementMs: z.number().int().positive().default(3_600_000),
      fixMs: z.number().int().positive().default(3_600_000),
      reviewMs: z.number().int().positive().default(1_800_000),
      ciWaitMs: z.number().int().positive().default(1_200_000),
      ciPollMs: z.number().int().positive().default(30_000),
    })
    .prefault({}),
});

export const WORKFLOW_DEFAULTS: WorkflowConfig = WorkflowConfigObjectSchema.parse({}) as WorkflowConfig;

/** The effective workflow config; an absent block (hand-built test configs) reads as the defaults. */
export function resolveWorkflowConfig(config: { workflow?: WorkflowConfig } | undefined): WorkflowConfig {
  return config?.workflow ?? WORKFLOW_DEFAULTS;
}

export function isWorkflowMode(config: { execution?: { mode?: ExecutionMode } } | undefined): boolean {
  return config?.execution?.mode === "workflow";
}
```

Then:
- `schemas.ts`: `import { WorkflowConfigObjectSchema } from "./schemas-workflow";`, and next to `advisor:` add `workflow: WorkflowConfigObjectSchema.prefault({}),`.
- `schemas-execution.ts`: inside `ExecutionConfigSchema` add `mode: ExecutionModeSchema.default("pipeline"),` (import from `./schemas-workflow`).
- `runtime-types.ts`: in `ExecutionConfig` add `/** A5: "workflow" swaps the story pipeline for the workflow loop. */ mode: import("./runtime-types-workflow").ExecutionMode;`. Next to `advisor?:` add `workflow?: import("./runtime-types-workflow").WorkflowConfig;`.
- `schemas-advisor.ts`: add `fallbackModels: z.array(ConfiguredModelSchema).default([]),`.
- `runtime-types-advisor.ts`: add `/** Tried in order after \`model\` fails (quota, error, timeout, unparseable). */ fallbackModels: ConfiguredModel[];`.
- `root-only-keys.ts`: add `"mode"` to `ROOT_ONLY_EXECUTION_KEYS`. In both `pinRootOnlyKeys` and `pinRootOnlyKeysRaw`, handle `workflow` exactly like `advisor` (destructure it out, re-add `root.workflow`, and warn `"workflow is root-only; …"` in the raw form). In `pinRootOnlyKeys`, add `mode: root.execution.mode` to the pinned execution keys.
- `config-descriptions.ts`: add entries for `execution.mode`, `workflow`, `workflow.models.storyReview`, `workflow.models.branchReview`, `workflow.models.branchFix`, `workflow.maxFixRounds`, `workflow.preflight`, `workflow.timeouts.*`, `advisor.fallbackModels`. Match the file's existing style: one sentence each, stating the default and the fallback key.
- `index.ts`: export `WORKFLOW_DEFAULTS`, `WorkflowConfigObjectSchema`, `resolveWorkflowConfig`, `isWorkflowMode` and the types.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/config/workflow-config.test.ts test/unit/config/advisor-config.test.ts test/unit/config/defaults.test.ts --timeout=60000`
Expected: PASS. If `defaults.test.ts` snapshots the full default config, update its expected object with the new keys. Don't loosen the assertion.

- [ ] **Step 5: Root-only test**

Add to `test/unit/config/workflow-config.test.ts`:
```ts
import { pinRootOnlyKeysRaw } from "@/config/root-only-keys";

test("workflow and execution.mode are root-only: a package value is ignored with a warning", () => {
  const root = NaxConfigSchema.parse({ execution: { mode: "workflow" }, workflow: { maxFixRounds: 3 } });
  const warnings: string[] = [];
  const out = pinRootOnlyKeysRaw(
    { execution: { mode: "pipeline" }, workflow: { maxFixRounds: 9 } },
    root,
    "apps/api",
    (m) => warnings.push(m),
  );
  expect((out.execution as Record<string, unknown>).mode).toBe("workflow");
  expect((out.workflow as { maxFixRounds: number }).maxFixRounds).toBe(3);
  expect(warnings.some((w) => w.includes("execution.mode is root-only"))).toBe(true);
  expect(warnings.some((w) => w.includes("workflow is root-only"))).toBe(true);
});
```
Run the file and expect PASS.

- [ ] **Step 6: Commit**
```bash
git add src/config test/unit/config src/cli/config-descriptions.ts
git commit -m "feat(config): workflow mode config surface (execution.mode, workflow.*, advisor.fallbackModels)"
```

---

### Task 2: `applyWorkflowMode` normalisation at both loader exits

**Files:**
- Create: `src/config/workflow-mode.ts`
- Modify: `src/config/loader.ts`: `finalizeAndValidateRootConfig` (~:267-282) returns `applyWorkflowMode(result.data as NaxConfig, defaultConfigWarn)`. The per-package path (~:561-575) sets `merged = applyWorkflowMode(result.data as NaxConfig, warnDedupe.warn)`.
- Test: `test/unit/config/workflow-mode-normalise.test.ts`

**Interfaces:**
- Consumes: `isWorkflowMode` (Task 1).
- Produces: `applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig`. It's pure, returns the same object when nothing changes, and otherwise returns a new object.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import { applyWorkflowMode } from "@/config/workflow-mode";

const parse = (raw: Record<string, unknown>) => NaxConfigSchema.parse(raw);

describe("applyWorkflowMode", () => {
  test("pipeline mode returns the same object untouched and never warns", () => {
    const cfg = parse({ acceptance: { enabled: true } });
    const warnings: string[] = [];
    expect(applyWorkflowMode(cfg, (m) => warnings.push(m))).toBe(cfg);
    expect(warnings).toEqual([]);
  });

  test("workflow mode forces acceptance off and the advisor on, with ONE warning naming both", () => {
    const cfg = parse({ execution: { mode: "workflow" }, acceptance: { enabled: true }, advisor: { enabled: false } });
    const warnings: string[] = [];
    const out = applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(out.acceptance.enabled).toBe(false);
    expect(out.advisor?.enabled).toBe(true);
    expect(cfg.acceptance.enabled).toBe(true); // input not mutated
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acceptance.enabled");
    expect(warnings[0]).toContain("advisor.enabled");
  });

  test("workflow mode with keys already at their forced values does not warn", () => {
    const cfg = parse({ execution: { mode: "workflow" }, acceptance: { enabled: false }, advisor: { enabled: true } });
    const warnings: string[] = [];
    applyWorkflowMode(cfg, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/config/workflow-mode-normalise.test.ts --timeout=60000`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** `src/config/workflow-mode.ts`:
```ts
/**
 * A5 workflow-mode normalisation (spec §4). Runs once on every fully merged config — the root
 * chain and each per-package overlay — so no layer can re-enable what workflow mode turns off.
 * Parallel is NOT a config key (it comes from the --parallel CLI flag); the runner forces it off.
 */
import type { NaxConfig } from "./types";
import { isWorkflowMode } from "./schemas-workflow";

export function applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig {
  if (!isWorkflowMode(config)) return config;
  const overridden: string[] = [];
  if (config.acceptance.enabled) overridden.push("acceptance.enabled=false");
  if (config.advisor && !config.advisor.enabled) overridden.push("advisor.enabled=true");
  if (overridden.length === 0) return config;
  warn(`execution.mode "workflow" overrides: ${overridden.join(", ")}`);
  return {
    ...config,
    acceptance: { ...config.acceptance, enabled: false },
    ...(config.advisor ? { advisor: { ...config.advisor, enabled: true } } : {}),
  };
}
```
Wire it into both loader exits as listed under **Files**.

- [ ] **Step 4: Package-path test (Review Focus 1)**

Add to the same test file. It uses a temp repo with a root config and a package override. Follow the temp-dir helper pattern of an existing loader test (look for `mkdtemp` usage under `test/unit/config/`, e.g. the per-package profile tests), and clean the dir up in `afterEach`.
```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  _clearRootConfigCache();
});

test("a package override cannot re-enable acceptance in workflow mode", async () => {
  dir = mkdtempSync(join(tmpdir(), "nax-wf-"));
  mkdirSync(join(dir, ".nax", "mono", "apps", "api"), { recursive: true });
  writeFileSync(join(dir, ".nax", "config.json"), JSON.stringify({ execution: { mode: "workflow" } }));
  writeFileSync(join(dir, ".nax", "mono", "apps", "api", "config.json"), JSON.stringify({ acceptance: { enabled: true } }));
  const cfg = await loadConfigForWorkdir(join(dir, ".nax", "config.json"), "apps/api");
  expect(cfg.acceptance.enabled).toBe(false);
});
```
If `loadConfigForWorkdir` needs the global layer isolated, follow how the neighbouring loader tests isolate `~/.nax` (env override or the existing test preload). Copy that exact mechanism.

- [ ] **Step 5: Run and verify**

Run: `bun test test/unit/config/workflow-mode-normalise.test.ts test/unit/config --timeout=60000`
Expected: PASS, with no regressions in `test/unit/config`.

- [ ] **Step 6: Commit**
```bash
git add src/config/workflow-mode.ts src/config/loader.ts test/unit/config/workflow-mode-normalise.test.ts
git commit -m "feat(config): workflow mode forces acceptance off and the advisor on at both loader exits"
```

---

### Task 3: The runner forces parallel off in workflow mode

**Files:**
- Modify: `src/execution/runner-execution.ts:228` (`parallelCount: options.parallel`)
- Test: `test/unit/execution/runner-execution-workflow-parallel.test.ts`

**Interfaces:**
- Produces: `effectiveParallelCount(config: NaxConfig, requested: number | undefined, warn: (m: string) => void): number | undefined`, exported from `src/execution/workflow-parallel.ts` (a new 20-line file, so `runner-execution.ts` grows by about 2 lines).

- [ ] **Step 1: Failing test**
```ts
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import { effectiveParallelCount } from "@/execution/workflow-parallel";

describe("effectiveParallelCount", () => {
  test("pipeline mode passes the CLI value through", () => {
    expect(effectiveParallelCount(NaxConfigSchema.parse({}), 4, () => {})).toBe(4);
  });
  test("workflow mode forces 0 and warns once when parallel was requested", () => {
    const warnings: string[] = [];
    const cfg = NaxConfigSchema.parse({ execution: { mode: "workflow" } });
    expect(effectiveParallelCount(cfg, 4, (m) => warnings.push(m))).toBe(0);
    expect(warnings).toEqual(['execution.mode "workflow" runs stories one at a time; --parallel 4 ignored']);
  });
  test("workflow mode without --parallel stays undefined and silent", () => {
    const warnings: string[] = [];
    const cfg = NaxConfigSchema.parse({ execution: { mode: "workflow" } });
    expect(effectiveParallelCount(cfg, undefined, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
```
- [ ] **Step 2: Run to verify it fails.** Run: `bun test test/unit/execution/runner-execution-workflow-parallel.test.ts --timeout=60000`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/execution/workflow-parallel.ts`:
```ts
import type { NaxConfig } from "../config";
import { isWorkflowMode } from "../config";

/** A5 W-R11: workflow mode runs stories one at a time. `--parallel` is a CLI flag, not config, so it is clamped here. */
export function effectiveParallelCount(
  config: NaxConfig,
  requested: number | undefined,
  warn: (msg: string) => void,
): number | undefined {
  if (!isWorkflowMode(config) || !requested) return requested;
  warn(`execution.mode "workflow" runs stories one at a time; --parallel ${requested} ignored`);
  return 0;
}
```
In `runner-execution.ts`, replace `parallelCount: options.parallel,` with `parallelCount: effectiveParallelCount(options.config, options.parallel, (m) => logger?.warn("execution", m, { storyId: "_run" })),`. Use whichever logger variable is already in scope there.
- [ ] **Step 4: Run and verify.** Expect PASS, then run `bun test test/unit/execution --timeout=60000` and expect no regressions.
- [ ] **Step 5: Commit**
```bash
git add src/execution/workflow-parallel.ts src/execution/runner-execution.ts test/unit/execution/runner-execution-workflow-parallel.test.ts
git commit -m "feat(execution): workflow mode clamps --parallel to sequential"
```

---

### Task 4: Classify token-plan / usage-limit 429s as `fail-quota`

**Files:**
- Modify: `src/agents/types.ts:527` (`AgentError.type`: add `"quota"`)
- Modify: `src/agents/errors/parse-agent-error.ts`: `classifyNestedAnthropicError` (~:186-201), the generic 429 path (~:388-396), and `classifyParsedAgentError` (~:73-96)
- Modify: `src/agents/errors/parse-agent-error.ts:310` (the type guard list)
- Test: `test/unit/agents/errors/parse-agent-error-quota.test.ts`

**Interfaces:**
- Produces: `isQuotaMessage(message: string): boolean`, exported from `parse-agent-error.ts`. `AgentError.type` gains `"quota"`, and `classifyParsedAgentError` maps `"quota"` → `adapterFailure.outcome: "fail-quota"`, `retriable: false`.

- [ ] **Step 1: Failing test**

The fixture is the exact live error from 2026-10-12. Check the import paths against `parse-agent-error.ts`'s exports, and use the module's existing exported entry point that takes a raw error message (the name the neighbouring `test/unit/agents/errors/*` tests import).
```ts
import { describe, expect, test } from "bun:test";
import { classifyParsedAgentError, isQuotaMessage, parseAgentError } from "@/agents/errors/parse-agent-error";

const MINIMAX_2056 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"},"request_id":"071bcc0b16aa41f1df8e44bb58fc234e"}';
const SLOW_DOWN = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded, please slow down"}}';

describe("quota classification", () => {
  test("isQuotaMessage matches usage-limit / quota / credits wording, not plain rate limits", () => {
    expect(isQuotaMessage("Token Plan usage limit reached")).toBe(true);
    expect(isQuotaMessage("You exceeded your current quota, please check your plan")).toBe(true);
    expect(isQuotaMessage("insufficient credits")).toBe(true);
    expect(isQuotaMessage("Rate limit exceeded, please slow down")).toBe(false);
  });

  test("the MiniMax 2056 token-plan 429 parses as quota and maps to fail-quota", () => {
    const parsed = parseAgentError(MINIMAX_2056);
    expect(parsed?.type).toBe("quota");
    const result = classifyParsedAgentError(parsed!, MINIMAX_2056);
    expect(result?.adapterFailure?.outcome).toBe("fail-quota");
    expect(result?.adapterFailure?.retriable).toBe(false);
  });

  test("a plain rate-limit 429 stays fail-rate-limit (Review Focus 2)", () => {
    const parsed = parseAgentError(SLOW_DOWN);
    expect(parsed?.type).toBe("rate-limit");
    expect(classifyParsedAgentError(parsed!, SLOW_DOWN)?.adapterFailure?.outcome).toBe("fail-rate-limit");
  });
});
```
- [ ] **Step 2: Run to verify it fails.** Run: `bun test test/unit/agents/errors/parse-agent-error-quota.test.ts --timeout=60000`. Expected: FAIL (`isQuotaMessage` not exported; MiniMax parses as `rate-limit`).
- [ ] **Step 3: Implement**
```ts
/** Account/plan exhaustion wording: the fault lasts for the run, unlike a transient rate limit. */
const QUOTA_PATTERN = /usage limit reached|token plan|exceeded your current quota|insufficient (credits|quota|balance)|quota exceeded|purchase credits/i;

export function isQuotaMessage(message: string): boolean {
  return QUOTA_PATTERN.test(message);
}
```
- In `classifyNestedAnthropicError`'s `rate_limit_error` / `overloaded_error` branch: read `(inner as Record<string, unknown>).message`, and if it's a string matching `isQuotaMessage`, return `{ type: "quota" }` before the rate-limit return.
- Do the same for the generic `429` token path at ~:388: test the whole message with `isQuotaMessage` first.
- Add `"quota"` to the type guard at ~:310.
- In `classifyParsedAgentError`, add:
```ts
    case "quota":
      return {
        ...base,
        adapterFailure: { category: "availability", outcome: "fail-quota", retriable: false, message: truncated },
      };
```
- [ ] **Step 4: Run and verify.** Run: `bun test test/unit/agents/errors --timeout=60000`. Expected: PASS, including the existing parse tests unchanged.
- [ ] **Step 5: Commit**
```bash
git add src/agents/types.ts src/agents/errors/parse-agent-error.ts test/unit/agents/errors/parse-agent-error-quota.test.ts
git commit -m "fix(agents): classify token-plan and usage-limit 429s as fail-quota"
```

---

### Task 5: Provider-scoped quota cooldown

**Files:**
- Modify: `src/agents/retry/failure-policy.ts:38` (`cooldownScope: "agent" | "model" | "provider"`) and `:62-67` (`fail-quota` → `cooldownScope: "provider"`)
- Modify: `src/agents/cooldown-store.ts` (`mark`, `_live`, `identityKey` + a new `providerKey`)
- Test: extend `test/unit/agents/cooldown-store.test.ts`

**Interfaces:**
- Consumes: `fail-quota` outcomes (Task 4).
- Produces: a cooldown key `` `${agent}::provider::${provider}` ``, where `provider = modelId.split("/")[0]` when `modelId` contains `/`. Without a provider it falls back to the bare agent key (today's behaviour). `isCooling(agent, tier, modelId)` returns true for any model of that provider on that agent.

- [ ] **Step 1: Failing tests** (append to `cooldown-store.test.ts`, reusing its `failure` and `fakeClock` helpers)
```ts
  test("fail-quota on a native provider cools only that provider, for the whole run", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("native", failure("fail-quota"), "balanced", "minimax/MiniMax-M3");

    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true);
    expect(store.isCooling("native", "fast", "minimax/MiniMax-M2.7")).toBe(true); // same provider
    expect(store.isCooling("native", "powerful", "opencode-go/deepseek-v4.1-flash")).toBe(false); // other provider
    clock.advance(24 * 3_600_000);
    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true);
    store.sweepTransient();
    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true); // run-long survives the sweep
  });

  test("fail-quota with no provider in the model id falls back to agent-wide (Review Focus 3)", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-quota"), "balanced", "sonnet");
    expect(store.isCooling("claude", "fast", "haiku")).toBe(true);
  });
```
- [ ] **Step 2: Run to verify it fails.** Run: `bun test test/unit/agents/cooldown-store.test.ts --timeout=60000`. Expected: the first new test FAILS, because today `fail-quota` keys on the bare agent and cools the opencode-go model too.
- [ ] **Step 3: Implement**
  - `failure-policy.ts`: widen the `cooldownScope` union and set `fail-quota` to `"provider"`. Update the doc comment.
  - `cooldown-store.ts`:
```ts
function providerOf(modelId?: string): string | undefined {
  const slash = modelId?.indexOf("/") ?? -1;
  return slash > 0 ? modelId!.slice(0, slash) : undefined;
}

function providerKey(agent: string, modelId?: string): string {
  const provider = providerOf(modelId);
  return provider ? `${agent}::provider::${provider}` : agent;
}
```
  - In `mark`, choose the key by scope: `agent` → `agent`; `provider` → `providerKey(agent, modelId)`; `model` → `identityKey(agent, tier, modelId)`.
  - In `_live`, check the narrow key, then `providerKey(agent, modelId)` (counted only when the entry's policy scope is `"provider"`), then the agent-wide key (counted only when the scope is `"agent"`, or when the scope is `"provider"` and the key equals the bare agent, i.e. no provider). Keep the existing early return for `narrow === agent`.
  - Keep the class under its current size plus about 25 lines.
- [ ] **Step 4: Run and verify.** Run: `bun test test/unit/agents --timeout=60000`. Expected: PASS, including `cooldown-integration.test.ts` and the existing `fail-auth` / `fail-rate-limit` cases.
- [ ] **Step 5: Commit**
```bash
git add src/agents/retry/failure-policy.ts src/agents/cooldown-store.ts test/unit/agents/cooldown-store.test.ts
git commit -m "fix(agents): fail-quota cools down the provider for the run, not the whole native agent"
```

---

### Task 6: Advisor model ladder

**Files:**
- Create: `src/advisor/ladder.ts`
- Modify: `src/advisor/service.ts`:
  - `callOnce` (~:100-122) takes a `model` argument;
  - `runOp` (~:124-143) iterates the ladder for stateless memory;
  - `buildDraft` and `writeAuditSafe` record the answering model;
  - the audit gains an `attempts` list.
- Modify: `src/advisor/types.ts` (`AdviceAuditRecord.attempts?: Array<{ model: string; error: string }>`)
- Test: `test/unit/advisor/ladder.test.ts`, extend `test/unit/advisor/service.test.ts`

**Interfaces:**
- Consumes: `AdvisorConfig.fallbackModels` (Task 1), and `agentManager.isUnavailable(agent, tier?, model?)` (`src/agents/manager.ts:145`), reached through `actx.callCtx.runtime.agentManager`. Check the exact path in `CallContext`, and gate it with optional chaining.
- Produces:
  - `advisorLadder(config: AdvisorConfig): ConfiguredModel[]`, returning `[config.model, ...config.fallbackModels]` with duplicates (deep-equal) removed;
  - `usableAdvisorModels(config: AdvisorConfig, isCooling: (m: ConfiguredModel) => boolean): ConfiguredModel[]`.

- [ ] **Step 1: Failing unit test** (`test/unit/advisor/ladder.test.ts`)
```ts
import { describe, expect, test } from "bun:test";
import { ADVISOR_DEFAULTS } from "@/config";
import { advisorLadder, usableAdvisorModels } from "@/advisor/ladder";

const ds = { agent: "native", model: "opencode-go/deepseek-v4.1-flash[high]" } as const;
const sol = { agent: "native", model: "openai-codex/gpt-6.1-sol[medium]" } as const;
const sonnet = { agent: "claude", model: "sonnet[medium]" } as const;

describe("advisor ladder", () => {
  test("primary first, then fallbacks in order, duplicates dropped", () => {
    const cfg = { ...ADVISOR_DEFAULTS, model: ds, fallbackModels: [sol, ds, sonnet] };
    expect(advisorLadder(cfg)).toEqual([ds, sol, sonnet]);
  });
  test("cooling entries are skipped", () => {
    const cfg = { ...ADVISOR_DEFAULTS, model: ds, fallbackModels: [sol, sonnet] };
    expect(usableAdvisorModels(cfg, (m) => m === ds)).toEqual([sol, sonnet]);
  });
  test("an empty fallback list keeps today's single-model behaviour", () => {
    expect(advisorLadder({ ...ADVISOR_DEFAULTS, model: ds })).toEqual([ds]);
  });
});
```
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/advisor/ladder.ts`:
```ts
/** A5 W-R10: the advisor tries `model`, then each `fallbackModels` entry, skipping any in cooldown. */
import type { AdvisorConfig } from "../config/runtime-types-advisor";
import type { ConfiguredModel } from "../config/schema-types";

export function advisorLadder(config: AdvisorConfig): ConfiguredModel[] {
  const all = [config.model, ...(config.fallbackModels ?? [])];
  return all.filter((m, i) => all.findIndex((o) => Bun.deepEquals(o, m)) === i);
}

export function usableAdvisorModels(
  config: AdvisorConfig,
  isCooling: (model: ConfiguredModel) => boolean,
): ConfiguredModel[] {
  return advisorLadder(config).filter((m) => !isCooling(m));
}
```
- [ ] **Step 4: Failing service tests** (append to `test/unit/advisor/service.test.ts`, reusing its `stubDeps`, `actx`, `judgment`, `reply` and `withTempDir` helpers)
```ts
const ds = { agent: "native", model: "opencode-go/deepseek-v4.1-flash[high]" } as const;
const sol = { agent: "native", model: "openai-codex/gpt-6.1-sol[medium]" } as const;

function ladderActx(dir: string) {
  const a = actx(dir);
  const config = makeNaxConfig({ advisor: { ...ADVISOR_DEFAULTS, enabled: true, model: ds, fallbackModels: [sol] } });
  return { ...a, callCtx: { ...a.callCtx, config } };
}

test("stateless advisor falls through the ladder: primary dispatch error, fallback answers", async () => {
  await withTempDir(async (dir) => {
    const { inputs } = stubDeps(reply("A", { instruction: "fix it" }));
    _advisorServiceDeps.callOp = (async (_c: unknown, _o: unknown, input: { model: unknown }) => {
      inputs.push(input);
      if (Bun.deepEquals(input.model, ds)) throw new Error("429 Token Plan usage limit reached");
      return reply("A", { instruction: "fix it" });
    }) as typeof _advisorServiceDeps.callOp;
    const out = await createAdvisor(ladderActx(dir)).advise(judgment);
    expect(out.decision?.model).toBe("native:openai-codex/gpt-6.1-sol[medium]");
    expect(inputs).toHaveLength(2);
    const audit = JSON.parse(await Bun.file(join(dir, "out", "advisor-audit", "feat", "D-1.json")).text());
    expect(audit.model).toBe("native:openai-codex/gpt-6.1-sol[medium]");
    expect(audit.attempts).toEqual([
      { model: "native:opencode-go/deepseek-v4.1-flash[high]", error: expect.stringContaining("dispatch:") },
    ]);
  });
});

test("every ladder entry failing returns the existing no-decision result (Review Focus 4)", async () => {
  await withTempDir(async (dir) => {
    stubDeps(async () => {
      throw new Error("boom");
    });
    const out = await createAdvisor(ladderActx(dir)).advise(judgment);
    expect(out.decision).toBeNull();
    expect(out.fallbackReason?.startsWith("dispatch:")).toBe(true);
    const files = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: join(dir, "out", "advisor-audit", "feat") }));
    const audit = JSON.parse(await Bun.file(join(dir, "out", "advisor-audit", "feat", files[0]!)).text());
    expect(audit.attempts).toHaveLength(2);
  });
});
```
Run: `bun test test/unit/advisor/service.test.ts --timeout=60000`. Expected: both new tests FAIL. Only the primary is tried, and `attempts` is absent.

- [ ] **Step 5: Implement the service changes.**
  - `callOnce(actx, asked, continuation, keepOpen, model)` puts `model` on the input in place of `config.model`.
  - In `runOp`, for `memory !== "warm"`: compute `usableAdvisorModels(config, isCooling)` and call `callOnce` per model until `out?.ok`, collecting `{ model: describeModel(m), error }` for each failure into `OpRun.attempts`. A non-ok `out` (invalid reply) also counts as a failure and moves on. The last attempt's `out` / `error` is what the existing fallback path reports. The audit's `attempts` lists every attempt before the answering one, or all of them when none answered. If the list is empty, fall back to `advisorLadder(config)` so a cooled-down primary still gets one attempt rather than none.
  - The warm path keeps the primary only. Warm memory is bound to one session (spec §8). Note that in a comment.
  - `buildDraft` and `writeAuditSafe` use the answering model, not `config.model`.
  - `isCooling(m)`: for an object model, `agentManager?.isUnavailable(m.agent, undefined, m.model) ?? false`. For a tier string, `false`.
  - Keep `service.ts` under 600 lines.
- [ ] **Step 6: Run and verify.** Run: `bun test test/unit/advisor --timeout=60000`. Expected: PASS.
- [ ] **Step 7: Commit**
```bash
git add src/advisor test/unit/advisor
git commit -m "feat(advisor): model ladder with cooldown-aware fallback and per-attempt audit"
```

---

### Task 7: PR1 gate, docs, and the PR

**Files:**
- Modify: `docs/` config reference if `config-descriptions.ts` doesn't feed it automatically (check the docs generator: `grep -rn "config-descriptions" scripts docs | head`)
- Modify: `CHANGELOG.md` (nax package, `## [Unreleased]`)

- [ ] **Step 1:** From `packages/nax`, run `bun run typecheck`, then `bun run check:all`, then from the repo root `bun run check:all`. Fix anything red: file sizes, import cycles, the config-profile-threading check, test-cast ratchets.
- [ ] **Step 2:** Run the full unit suite: `bun run test`. Expected: green.
- [ ] **Step 3:** Under `## [Unreleased]`, add CHANGELOG entries for: workflow mode config (inert until PR2), provider-scoped quota cooldown, token-plan 429 classification, and the advisor `fallbackModels` ladder.
- [ ] **Step 4: Commit**
```bash
git add CHANGELOG.md docs
git commit -m "docs: changelog for workflow-mode foundations"
```
- [ ] **Step 5:** Code review before push (user rule), using a single reviewer. After fixes, push the branch and open a PR titled `feat: workflow mode foundations (A5 PR1)`. The body links the spec and lists the 4-PR series. **Pushing and opening the PR are outward-facing: confirm with the user first.**
