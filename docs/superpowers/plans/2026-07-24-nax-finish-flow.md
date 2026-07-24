# nax-finish Flow + Post-Run Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-express the interactive `nax-finish` skill as an autonomous **acpx flow**, fired automatically after a `nax run` by a built-in **post-run plugin**, that drives acceptance → phased review → quality gates to green and opens a ready PR — or escalates (PR comment + Telegram) on anything needing human judgment.

**Architecture:** A thin acpx flow declaration (`flows/nax-finish/nax-finish.flow.ts`) wires `compute`/`action`/`acp` nodes to pure, unit-tested helper modules under `flows/nax-finish/steps/`. Review is two isolated `acp` nodes, each pinned to an acpx `profile` from config. A built-in `IPostRunAction` (`src/plugins/builtin/nax-finish/`) gates on config + run success + feature branch, shells `acpx flow run`, reads the flow's result file, and delivers Telegram escalation in-process.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome, Zod (config), acpx `flow` (already supported in nax's acpx dependency).

## Global Constraints

- **Bun-native only** — `Bun.file()`/`Bun.write()`/`Bun.spawn()`/`Bun.sleep()`. No Node `fs`/`child_process`/`setTimeout`-for-delay.
- **`_deps` injection pattern** for every side effect (spawn, fetch, fs). No `mock.module()` anywhere.
- **No real subprocess in tests** — never spawn real `acpx`/`nax`/`gh`/`glab`/git; inject fakes via `_deps`.
- **Config SSOT** — new defaults live in the Zod schema (`src/config/schemas.ts`) via `.default()`; never a hand-maintained literal.
- **600-line source / 800-line test hard limit**; split by concern.
- **Structured logging** via `src/logger`; no `console.log` in source. (`storyId` field N/A — this is post-run, not per-story.)
- **Barrel imports** — import from a module's `index.ts`, never internal paths, inside `src/`. (`flows/` is outside `src/` and exempt from the prompt-builder/barrel rules.)
- **Conventional commits**; one logical change per commit; never include `[run-release]`.
- **acpx profile pinning** — an `acp` node selects its reviewer via `profile?: string` (an acpx agent-profile name), and runs isolated via `session: { isolated: true }`. Unpinned `acp` nodes use `acpx --default-agent`.
- **Escalation is durable-first** — the flow always writes a PR/MR comment on escalate; Telegram is an additional channel delivered by the plugin.
- Reference design: `docs/superpowers/specs/2026-07-24-nax-finish-flow-design.md`.

---

## File Structure

**Create:**
- `flows/nax-finish/types.ts` — shared types (`FinishInput`, `Finding`, `ReviewVerdict`, `FinishResult`, `RunResult`, `RunFn`).
- `flows/nax-finish/review-prompts.ts` — review prompt text copied **verbatim** from the `post-impl-review` skill + the escalate-vs-proceed classifier + builders.
- `flows/nax-finish/steps/context.ts` — `detectBaseBranch`, `resolveSpec`, `preflight`.
- `flows/nax-finish/steps/acceptance.ts` — `runAcceptanceGate`.
- `flows/nax-finish/steps/quality.ts` — `runQualityGates`.
- `flows/nax-finish/steps/escalate.ts` — `buildEscalationComment`, `postEscalation`.
- `flows/nax-finish/steps/pr.ts` — `openOrPromotePr`.
- `flows/nax-finish/steps/result.ts` — `writeResult`, `resultPath`.
- `flows/nax-finish/steps/index.ts` — barrel re-export of the step functions (for the flow file to import one path).
- `flows/nax-finish/nax-finish.flow.ts` — `defineFlow(...)` declaration (thin wiring).
- `src/plugins/builtin/nax-finish/index.ts` — the `IPostRunAction` + `NaxPlugin` export.
- `src/plugins/builtin/nax-finish/config.ts` — `getFinishAutoFlowConfig(context)` loose reader + `isTelegramConfigured`.
- `src/plugins/builtin/nax-finish/telegram.ts` — `sendTelegramNotify` (fetch-based).
- Tests mirroring each under `test/unit/flows/nax-finish/**` and `test/unit/plugins/builtin/nax-finish/**`.

**Modify:**
- `src/config/schemas.ts` — add the `finish.autoFlow` block.
- `src/plugins/loader.ts` — register `naxFinishPlugin` in the `builtinPostRunActions` side-channel.
- `tsconfig.json` — ensure `flows/**` is in `include` (type-checked and importable by tests).

**Shared types (defined in Task 2, referenced everywhere):**
```ts
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export interface Finding { severity: Severity; title: string; problem: string; fix: string; }
export interface ReviewVerdict { route: "proceed" | "escalate"; findings: Finding[]; escalationReason?: string; }
export interface FinishInput {
  feature: string; workdir: string; branch: string; prdPath: string;
  reviewers: { spec: string | null; quality: string | null };
  escalateTelegram: boolean;
}
export interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string; escalationReason?: string;
}
export interface RunResult { exitCode: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string[], opts: { cwd: string }) => Promise<RunResult>;
```

---

## Task 1: Config schema — `finish.autoFlow`

**Files:**
- Modify: `src/config/schemas.ts` (add the `finish` key alongside `autoPr`, ~line 422)
- Test: `test/unit/config/finish-autoflow-schema.test.ts`

**Interfaces:**
- Produces: config path `config.finish.autoFlow` with fields `enabled: boolean`, `flowPath: string`, `defaultAgent: string | null`, `reviewers: { spec: string | null; quality: string | null }`, `escalate: { telegram: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config/finish-autoflow-schema.test.ts
import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

describe("finish.autoFlow schema", () => {
  test("defaults: disabled, canonical flow path, telegram on", () => {
    const c = NaxConfigSchema.parse({ version: 1 });
    expect(c.finish.autoFlow.enabled).toBe(false);
    expect(c.finish.autoFlow.flowPath).toBe("flows/nax-finish/nax-finish.flow.ts");
    expect(c.finish.autoFlow.defaultAgent).toBeNull();
    expect(c.finish.autoFlow.reviewers).toEqual({ spec: null, quality: null });
    expect(c.finish.autoFlow.escalate.telegram).toBe(true);
  });

  test("accepts overrides", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { autoFlow: { enabled: true, reviewers: { spec: "adversarial", quality: "balanced" }, escalate: { telegram: false } } },
    });
    expect(c.finish.autoFlow.enabled).toBe(true);
    expect(c.finish.autoFlow.reviewers.spec).toBe("adversarial");
    expect(c.finish.autoFlow.escalate.telegram).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/config/finish-autoflow-schema.test.ts --timeout=5000`
Expected: FAIL — `c.finish` is undefined.

- [ ] **Step 3: Add the schema block**

In `src/config/schemas.ts`, immediately after the `autoPr: z.object({...}).optional().default({...}),` block, add:

```ts
    finish: z
      .object({
        autoFlow: z
          .object({
            enabled: z.boolean().default(false),
            flowPath: z.string().default("flows/nax-finish/nax-finish.flow.ts"),
            defaultAgent: z.string().nullable().default(null),
            reviewers: z
              .object({
                spec: z.string().nullable().default(null),
                quality: z.string().nullable().default(null),
              })
              .default({ spec: null, quality: null }),
            escalate: z.object({ telegram: z.boolean().default(true) }).default({ telegram: true }),
          })
          .default({}),
      })
      .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/config/finish-autoflow-schema.test.ts --timeout=5000`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/schemas.ts test/unit/config/finish-autoflow-schema.test.ts
git commit -m "feat(config): add finish.autoFlow schema block"
```

---

## Task 2: Shared types + verbatim review prompts

**Files:**
- Create: `flows/nax-finish/types.ts`, `flows/nax-finish/review-prompts.ts`
- Test: `test/unit/flows/nax-finish/review-prompts.test.ts`

**Interfaces:**
- Produces (`types.ts`): the shared types block from **File Structure** above.
- Produces (`review-prompts.ts`):
  - `SPEC_REVIEW_DIMENSIONS: string` — exact contents of the `post-impl-review` skill file `references/spec-review.md`.
  - `QUALITY_REVIEW_DIMENSIONS: string` — exact contents of `references/code-quality.md`.
  - `WORKER_PROTOCOL: string` — exact contents of `references/worker-protocol.md`.
  - `buildReviewPrompt(phase: "spec" | "quality", args: { base: string; specPath: string }): string`

- [ ] **Step 1: Create the types file**

```ts
// flows/nax-finish/types.ts
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export interface Finding { severity: Severity; title: string; problem: string; fix: string; }
export interface ReviewVerdict { route: "proceed" | "escalate"; findings: Finding[]; escalationReason?: string; }
export interface FinishInput {
  feature: string; workdir: string; branch: string; prdPath: string;
  reviewers: { spec: string | null; quality: string | null };
  escalateTelegram: boolean;
}
export interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string; escalationReason?: string;
}
export interface RunResult { exitCode: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string[], opts: { cwd: string }) => Promise<RunResult>;
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/flows/nax-finish/review-prompts.test.ts
import { describe, expect, test } from "bun:test";
import { buildReviewPrompt, SPEC_REVIEW_DIMENSIONS, QUALITY_REVIEW_DIMENSIONS } from "../../../../flows/nax-finish/review-prompts";

describe("review prompts", () => {
  test("spec dimensions copied verbatim (key markers present)", () => {
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Map external touchpoints first");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Convention Compliance");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("≥80% confident");
  });

  test("quality dimensions copied verbatim (key markers present)", () => {
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("enumerate before you conclude");
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("≥60% confident");
  });

  test("spec prompt carries the classifier + strict JSON contract", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: ".nax/features/x/prd.json" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain(".nax/features/x/prd.json");
    expect(p).toContain('"route": "proceed" | "escalate"');
    expect(p).toContain("spec conflict"); // escalate trigger
    expect(p).toContain("recommended fix"); // proceed trigger
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/flows/nax-finish/review-prompts.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `review-prompts.ts`**

Copy the three source files **verbatim** into template literals (exact byte-for-byte, so the flow never drifts from the skill):
- `SPEC_REVIEW_DIMENSIONS` ← the entire body of the `post-impl-review` skill's `references/spec-review.md`.
- `QUALITY_REVIEW_DIMENSIONS` ← the entire body of `references/code-quality.md`.
- `WORKER_PROTOCOL` ← the entire body of `references/worker-protocol.md`.

Source paths on this machine: `~/.claude/plugins/marketplaces/nax-toolkit/plugins/nax-toolkit/skills/post-impl-review/references/{spec-review,code-quality,worker-protocol}.md`.

Then add the builder that layers the escalate-vs-proceed classifier and the strict-JSON contract on top:

```ts
// flows/nax-finish/review-prompts.ts
export const SPEC_REVIEW_DIMENSIONS = `<<verbatim contents of references/spec-review.md>>`;
export const QUALITY_REVIEW_DIMENSIONS = `<<verbatim contents of references/code-quality.md>>`;
export const WORKER_PROTOCOL = `<<verbatim contents of references/worker-protocol.md>>`;

const CLASSIFIER = [
  "After producing findings, classify the OVERALL route for this phase:",
  '- Route "proceed" when every finding has a clear RECOMMENDED FIX you can apply now',
  "  (CRITICAL/HIGH, or MEDIUM whose fix is clear and low-risk) — you will fix them and re-verify.",
  '- Route "escalate" when ANY finding is a spec conflict, a contradiction with the spec,',
  "  or a design/judgment concern with no safe mechanical fix. Do not attempt to fix those.",
].join("\n");

const JSON_CONTRACT = [
  "Return exactly one JSON object and nothing else. First char `{`, last char `}`.",
  "Shape:",
  "{",
  '  "route": "proceed" | "escalate",',
  '  "findings": [{ "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "title": string, "problem": string, "fix": string }],',
  '  "escalationReason": string   // required when route is "escalate"; omit otherwise',
  "}",
].join("\n");

export function buildReviewPrompt(phase: "spec" | "quality", args: { base: string; specPath: string }): string {
  const dims = phase === "spec" ? SPEC_REVIEW_DIMENSIONS : QUALITY_REVIEW_DIMENSIONS;
  return [
    `You are the ${phase.toUpperCase()} reviewer for a completed feature.`,
    `The spec/requirements source is: ${args.specPath}. Read it in full.`,
    `Fetch and review the diff: \`git diff ${args.base}...HEAD\` (also \`--name-only\` for the file list).`,
    WORKER_PROTOCOL,
    dims,
    CLASSIFIER,
    JSON_CONTRACT,
  ].join("\n\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/flows/nax-finish/review-prompts.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add flows/nax-finish/types.ts flows/nax-finish/review-prompts.ts test/unit/flows/nax-finish/review-prompts.test.ts
git commit -m "feat(flow): shared types + verbatim post-impl-review prompts for nax-finish flow"
```

---

## Task 3: Steps — context (base branch, spec resolution, preflight)

**Files:**
- Create: `flows/nax-finish/steps/context.ts`
- Test: `test/unit/flows/nax-finish/steps/context.test.ts`

**Interfaces:**
- Consumes: `RunFn`, `FinishInput` from `../types`.
- Produces:
  - `_contextDeps: { run: RunFn }` (injectable).
  - `detectBaseBranch(workdir: string): Promise<string>` → e.g. `"origin/main"` (parse `git remote show origin`; fall back `origin/main` → `origin/master`).
  - `resolveSpec(feature: string, workdir: string): Promise<{ specPath: string; specKind: "markdown" | "prd" }>` (runs `nax features resolve <feature> --json`, reads `specSource`).
  - `preflight(workdir: string, base: string): Promise<{ commitsAhead: number; route: "proceed" | "nothing-to-finish" }>` (runs `git rev-list --count <base>..HEAD`).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/flows/nax-finish/steps/context.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _contextDeps, detectBaseBranch, resolveSpec, preflight } from "../../../../../flows/nax-finish/steps/context";
import type { RunResult } from "../../../../../flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
afterEach(() => { _contextDeps.run = _contextDeps.run; });

describe("context steps", () => {
  test("detectBaseBranch parses 'HEAD branch'", async () => {
    _contextDeps.run = async () => ok("  HEAD branch: main\n");
    expect(await detectBaseBranch("/w")).toBe("origin/main");
  });

  test("resolveSpec reads specSource from nax features resolve --json", async () => {
    _contextDeps.run = async () => ok(JSON.stringify({ status: "ok", featureName: "x", specSource: { kind: "prd", path: ".nax/features/x/prd.json" } }));
    expect(await resolveSpec("x", "/w")).toEqual({ specPath: ".nax/features/x/prd.json", specKind: "prd" });
  });

  test("preflight routes nothing-to-finish at 0 commits ahead", async () => {
    _contextDeps.run = async () => ok("0\n");
    expect(await preflight("/w", "origin/main")).toEqual({ commitsAhead: 0, route: "nothing-to-finish" });
  });

  test("preflight routes proceed when ahead", async () => {
    _contextDeps.run = async () => ok("3\n");
    expect(await preflight("/w", "origin/main")).toEqual({ commitsAhead: 3, route: "proceed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/context.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `context.ts`**

```ts
// flows/nax-finish/steps/context.ts
import type { RunFn } from "../types";

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

export const _contextDeps: { run: RunFn } = { run: defaultRun };

export async function detectBaseBranch(workdir: string): Promise<string> {
  const res = await _contextDeps.run(["git", "remote", "show", "origin"], { cwd: workdir });
  const m = res.stdout.match(/HEAD branch:\s*(\S+)/);
  if (m) return `origin/${m[1]}`;
  const main = await _contextDeps.run(["git", "rev-parse", "--verify", "origin/main"], { cwd: workdir });
  return main.exitCode === 0 ? "origin/main" : "origin/master";
}

export async function resolveSpec(feature: string, workdir: string): Promise<{ specPath: string; specKind: "markdown" | "prd" }> {
  const res = await _contextDeps.run(["nax", "features", "resolve", feature, "--json"], { cwd: workdir });
  const parsed = JSON.parse(res.stdout) as { specSource?: { kind: "markdown" | "prd"; path: string } };
  if (!parsed.specSource) throw new Error(`nax features resolve returned no specSource for "${feature}"`);
  return { specPath: parsed.specSource.path, specKind: parsed.specSource.kind };
}

export async function preflight(workdir: string, base: string): Promise<{ commitsAhead: number; route: "proceed" | "nothing-to-finish" }> {
  const res = await _contextDeps.run(["git", "rev-list", "--count", `${base}..HEAD`], { cwd: workdir });
  const commitsAhead = Number.parseInt(res.stdout.trim(), 10) || 0;
  return { commitsAhead, route: commitsAhead > 0 ? "proceed" : "nothing-to-finish" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/context.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/steps/context.ts test/unit/flows/nax-finish/steps/context.test.ts
git commit -m "feat(flow): nax-finish context steps (base branch, spec resolve, preflight)"
```

---

## Task 4: Steps — acceptance gate

**Files:**
- Create: `flows/nax-finish/steps/acceptance.ts`
- Test: `test/unit/flows/nax-finish/steps/acceptance.test.ts`

**Interfaces:**
- Consumes: `RunFn`.
- Produces:
  - `_acceptanceDeps: { run: RunFn }`
  - `AcceptanceGroup = { packageDir: string; testPath: string; exists: boolean; command?: string; language: string }`
  - `parseAcceptanceGroups(resolveJson: string): { status: string; groups: AcceptanceGroup[] }` (reads the `acceptance` block from `nax features resolve --json`).
  - `runAcceptanceGate(repoRoot: string, groups: AcceptanceGroup[]): Promise<{ passed: boolean; output: string }>` — runs each `exists` group with **cwd = `<repoRoot>/<packageDir>`** and the **absolute** `{{FILE}}` = `<repoRoot>/<testPath>`, mirroring the runtime (the same trap the skill documents).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/flows/nax-finish/steps/acceptance.test.ts
import { describe, expect, test } from "bun:test";
import { _acceptanceDeps, parseAcceptanceGroups, runAcceptanceGate } from "../../../../../flows/nax-finish/steps/acceptance";

describe("acceptance steps", () => {
  test("parseAcceptanceGroups pulls the acceptance block", () => {
    const json = JSON.stringify({ acceptance: { status: "ok", groups: [{ packageDir: "apps/web", testPath: "apps/web/.nax/features/x/.nax-acceptance.test.tsx", exists: true, command: "bun vitest run {{FILE}}", language: "typescript" }] } });
    const r = parseAcceptanceGroups(json);
    expect(r.status).toBe("ok");
    expect(r.groups[0].packageDir).toBe("apps/web");
  });

  test("runAcceptanceGate runs each existing group at cwd=repoRoot/packageDir with absolute FILE", async () => {
    const calls: { cmd: string[]; cwd: string }[] = [];
    _acceptanceDeps.run = async (cmd, opts) => { calls.push({ cmd, cwd: opts.cwd }); return { exitCode: 0, stdout: "ok", stderr: "" }; };
    const groups = [{ packageDir: "apps/web", testPath: "apps/web/.nax/features/x/a.test.tsx", exists: true, command: "bun vitest run {{FILE}}", language: "typescript" }];
    const r = await runAcceptanceGate("/repo", groups);
    expect(r.passed).toBe(true);
    expect(calls[0].cwd).toBe("/repo/apps/web");
    expect(calls[0].cmd.join(" ")).toContain("/repo/apps/web/.nax/features/x/a.test.tsx"); // absolute FILE
  });

  test("runAcceptanceGate fails when a group exits non-zero", async () => {
    _acceptanceDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const groups = [{ packageDir: "", testPath: ".nax/features/x/a.test.ts", exists: true, command: "bun test {{FILE}}", language: "typescript" }];
    const r = await runAcceptanceGate("/repo", groups);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/acceptance.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `acceptance.ts`**

```ts
// flows/nax-finish/steps/acceptance.ts
import type { RunFn } from "../types";

export interface AcceptanceGroup { packageDir: string; testPath: string; exists: boolean; command?: string; language: string; }

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}
export const _acceptanceDeps: { run: RunFn } = { run: defaultRun };

export function parseAcceptanceGroups(resolveJson: string): { status: string; groups: AcceptanceGroup[] } {
  const parsed = JSON.parse(resolveJson) as { acceptance?: { status?: string; groups?: AcceptanceGroup[] } };
  return { status: parsed.acceptance?.status ?? "no-prd", groups: parsed.acceptance?.groups ?? [] };
}

export async function runAcceptanceGate(repoRoot: string, groups: AcceptanceGroup[]): Promise<{ passed: boolean; output: string }> {
  const chunks: string[] = [];
  for (const g of groups) {
    if (!g.exists) continue;
    const cwd = g.packageDir ? `${repoRoot}/${g.packageDir}` : repoRoot;
    const absFile = `${repoRoot}/${g.testPath}`;
    const template = g.command ?? `${languageRunner(g.language)} {{FILE}}`;
    const cmd = template.replace(/\{\{FILE\}\}|\{\{file\}\}|\{\{files\}\}/g, absFile).split(/\s+/).filter(Boolean);
    const res = await _acceptanceDeps.run(cmd, { cwd });
    chunks.push(`[${g.packageDir || "root"}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) return { passed: false, output: chunks.join("\n\n") };
  }
  return { passed: true, output: chunks.join("\n\n") };
}

function languageRunner(language: string): string {
  switch (language) {
    case "python": return "uv run pytest";
    case "go": return "go test";
    default: return "bun test";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/acceptance.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/steps/acceptance.ts test/unit/flows/nax-finish/steps/acceptance.test.ts
git commit -m "feat(flow): nax-finish acceptance gate step (per-package cwd + absolute FILE)"
```

---

## Task 5: Steps — quality gates

**Files:**
- Create: `flows/nax-finish/steps/quality.ts`
- Test: `test/unit/flows/nax-finish/steps/quality.test.ts`

**Interfaces:**
- Consumes: `RunFn`.
- Produces:
  - `_qualityDeps: { run: RunFn }`
  - `QualityCommands = { build?: string; typecheck?: string; lint?: string; test?: string; format?: string }`
  - `runQualityGates(repoRoot: string, commands: QualityCommands): Promise<{ passed: boolean; failing: string[]; output: string }>` — runs each **set** command from `repoRoot`, capturing exit codes; `passed` iff all green.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/flows/nax-finish/steps/quality.test.ts
import { describe, expect, test } from "bun:test";
import { _qualityDeps, runQualityGates } from "../../../../../flows/nax-finish/steps/quality";

describe("quality gates", () => {
  test("passes when all set commands exit 0; skips unset", async () => {
    _qualityDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const r = await runQualityGates("/repo", { typecheck: "bun run typecheck", test: "bun run test" });
    expect(r.passed).toBe(true);
    expect(r.failing).toEqual([]);
  });

  test("collects failing gates by name", async () => {
    _qualityDeps.run = async (cmd) => ({ exitCode: cmd.join(" ").includes("lint") ? 1 : 0, stdout: "", stderr: "lint bad" });
    const r = await runQualityGates("/repo", { lint: "bun run lint", test: "bun run test" });
    expect(r.passed).toBe(false);
    expect(r.failing).toEqual(["lint"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/quality.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `quality.ts`**

```ts
// flows/nax-finish/steps/quality.ts
import type { RunFn } from "../types";

export interface QualityCommands { build?: string; typecheck?: string; lint?: string; test?: string; format?: string; }

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}
export const _qualityDeps: { run: RunFn } = { run: defaultRun };

const GATE_ORDER: (keyof QualityCommands)[] = ["build", "typecheck", "lint", "test", "format"];

export async function runQualityGates(repoRoot: string, commands: QualityCommands): Promise<{ passed: boolean; failing: string[]; output: string }> {
  const failing: string[] = [];
  const chunks: string[] = [];
  for (const gate of GATE_ORDER) {
    const command = commands[gate];
    if (!command) continue;
    const res = await _qualityDeps.run(command.split(/\s+/).filter(Boolean), { cwd: repoRoot });
    chunks.push(`[${gate}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) failing.push(gate);
  }
  return { passed: failing.length === 0, failing, output: chunks.join("\n\n") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/quality.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/steps/quality.ts test/unit/flows/nax-finish/steps/quality.test.ts
git commit -m "feat(flow): nax-finish quality-gates step (config-driven, per-gate results)"
```

---

## Task 6: Steps — escalate, open/promote PR, write result

**Files:**
- Create: `flows/nax-finish/steps/escalate.ts`, `flows/nax-finish/steps/pr.ts`, `flows/nax-finish/steps/result.ts`, `flows/nax-finish/steps/index.ts`
- Test: `test/unit/flows/nax-finish/steps/escalate.test.ts`, `test/unit/flows/nax-finish/steps/pr.test.ts`, `test/unit/flows/nax-finish/steps/result.test.ts`

**Interfaces:**
- Consumes: `RunFn`, `Finding`, `FinishResult`.
- Produces:
  - `buildEscalationComment(feature: string, escalationReason: string, findings: Finding[]): string` (pure).
  - `_escalateDeps: { run: RunFn }`; `postEscalation(repoRoot: string, branch: string, comment: string): Promise<{ url?: string }>` (comment on the branch's existing PR/MR via `gh pr comment` / `glab mr note`; open a draft to hold it if none — detect forge from remote).
  - `_prDeps: { run: RunFn }`; `openOrPromotePr(repoRoot: string, branch: string, title: string, body: string): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }>` (detect existing PR; create ready if none, promote draft→ready if draft, no-op if ready).
  - `resultPath(repoRoot: string): string` → `<repoRoot>/.nax/nax-finish-result.json`; `_resultDeps: { writeText: (p: string, s: string) => Promise<void> }`; `writeResult(repoRoot: string, result: FinishResult): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (one file per module — shown together)

```ts
// test/unit/flows/nax-finish/steps/escalate.test.ts
import { describe, expect, test } from "bun:test";
import { buildEscalationComment } from "../../../../../flows/nax-finish/steps/escalate";

describe("buildEscalationComment", () => {
  test("names the reason and lists findings", () => {
    const c = buildEscalationComment("my-feat", "AC-3 contradicts the response shape", [
      { severity: "HIGH", title: "wrong status code", problem: "returns 200 not 201", fix: "note intentional deviation" },
    ]);
    expect(c).toContain("nax-finish escalation");
    expect(c).toContain("AC-3 contradicts the response shape");
    expect(c).toContain("[HIGH] wrong status code");
  });
});
```

```ts
// test/unit/flows/nax-finish/steps/result.test.ts
import { describe, expect, test } from "bun:test";
import { _resultDeps, resultPath, writeResult } from "../../../../../flows/nax-finish/steps/result";

describe("writeResult", () => {
  test("writes the result JSON to .nax/nax-finish-result.json", async () => {
    let wrote: { p: string; s: string } | null = null;
    _resultDeps.writeText = async (p, s) => { wrote = { p, s }; };
    await writeResult("/repo", { feature: "x", status: "escalated", escalationReason: "design call" });
    expect(wrote!.p).toBe(resultPath("/repo"));
    expect(JSON.parse(wrote!.s)).toMatchObject({ feature: "x", status: "escalated", escalationReason: "design call" });
  });
});
```

```ts
// test/unit/flows/nax-finish/steps/pr.test.ts
import { describe, expect, test } from "bun:test";
import { _prDeps, openOrPromotePr } from "../../../../../flows/nax-finish/steps/pr";

describe("openOrPromotePr", () => {
  test("promotes an existing draft to ready", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
    expect(calls.some((c) => c.includes("ready"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/ --timeout=5000`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three modules + barrel**

`escalate.ts` — `buildEscalationComment` (pure) and `postEscalation` (forge-detect via `git remote get-url origin`; `gh pr comment <branch> --body <c>` or `glab mr note`; if no PR/MR exists, `gh pr create --draft` first, then comment; return `{ url }`). Mirror the forge/gh/glab argv shape used by `src/plugins/builtin/auto-pr/forge.ts`.

```ts
// flows/nax-finish/steps/escalate.ts  (buildEscalationComment shown; postEscalation follows the forge pattern)
import type { Finding, RunFn } from "../types";
export function buildEscalationComment(feature: string, escalationReason: string, findings: Finding[]): string {
  const lines = [
    `## nax-finish escalation — \`${feature}\``,
    "",
    "This feature needs human judgment before it can ship. nax-finish stopped rather than guess.",
    "",
    `**Needs judgment:** ${escalationReason}`,
    "",
    "### Findings",
    ...findings.map((f) => `- **[${f.severity}] ${f.title}** — ${f.problem}\n  - Suggested: ${f.fix}`),
  ];
  return lines.join("\n");
}
// export const _escalateDeps = { run: defaultRun };  // + postEscalation(repoRoot, branch, comment)
```

`pr.ts` — `openOrPromotePr` (detect forge; `gh pr view <branch> --json isDraft,url` / `glab mr view`; none → `gh pr create --fill --head <branch>` (ready); draft → `gh pr ready <branch>` → status `promoted`; ready → status `already-ready`).

`result.ts`:
```ts
// flows/nax-finish/steps/result.ts
import type { FinishResult } from "../types";
export function resultPath(repoRoot: string): string { return `${repoRoot}/.nax/nax-finish-result.json`; }
export const _resultDeps: { writeText: (p: string, s: string) => Promise<void> } = {
  writeText: async (p, s) => { await Bun.write(p, s); },
};
export async function writeResult(repoRoot: string, result: FinishResult): Promise<void> {
  await _resultDeps.writeText(resultPath(repoRoot), `${JSON.stringify(result, null, 2)}\n`);
}
```

`index.ts` — barrel: `export * from "./context"; export * from "./acceptance"; export * from "./quality"; export * from "./escalate"; export * from "./pr"; export * from "./result";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/flows/nax-finish/steps/ --timeout=5000`
Expected: PASS (all step tests).

- [ ] **Step 5: Commit**

```bash
git add flows/nax-finish/steps/ test/unit/flows/nax-finish/steps/
git commit -m "feat(flow): nax-finish escalate + open/promote PR + result steps"
```

---

## Task 7: The flow declaration (`nax-finish.flow.ts`)

**Files:**
- Create: `flows/nax-finish/nax-finish.flow.ts`
- Test: `test/unit/flows/nax-finish/flow-graph.test.ts`

**Interfaces:**
- Consumes: `defineFlow`, `extractJsonObject` from `acpx/flows`; the step barrel `./steps`; `buildReviewPrompt` from `./review-prompts`; `FinishInput` from `./types`.
- Produces: `export default` a `FlowDefinition` named `"nax-finish"` with `permissions.requiredMode = "approve-all"`, `startAt: "load_ctx"`, and nodes: `load_ctx` (compute), `resolve_spec`/`preflight`/`acceptance`/`quality_gates`/`open_pr`/`escalate` (action), `review_spec`/`review_quality` (acp, isolated, profile from input), `fix_spec`/`fix_quality`/`fix_gate` (acp), plus `switch` edges on `$.route`.

- [ ] **Step 1: Write the failing test** (graph shape — no acpx runtime needed)

```ts
// test/unit/flows/nax-finish/flow-graph.test.ts
import { describe, expect, test } from "bun:test";
import flow from "../../../../flows/nax-finish/nax-finish.flow";

describe("nax-finish flow graph", () => {
  test("declares approve-all + starts at load_ctx", () => {
    expect(flow.name).toBe("nax-finish");
    expect(flow.permissions?.requiredMode).toBe("approve-all");
    expect(flow.startAt).toBe("load_ctx");
  });

  test("has the review + escalate + pr nodes and routes review_spec on $.route", () => {
    for (const n of ["review_spec", "review_quality", "acceptance", "quality_gates", "open_pr", "escalate"]) {
      expect(flow.nodes[n]).toBeDefined();
    }
    expect(flow.nodes.review_spec.nodeType).toBe("acp");
    const specEdge = flow.edges.find((e) => e.from === "review_spec" && "switch" in e);
    expect(specEdge && "switch" in specEdge && specEdge.switch.on).toBe("$.route");
  });

  test("review nodes are isolated and pin their profile from input", () => {
    const specNode = flow.nodes.review_spec as { session?: { isolated?: boolean } };
    expect(specNode.session?.isolated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/flows/nax-finish/flow-graph.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `nax-finish.flow.ts`** (thin wiring; logic delegates to `./steps`)

```ts
// flows/nax-finish/nax-finish.flow.ts
import { defineFlow, extractJsonObject } from "acpx/flows";
import { buildReviewPrompt } from "./review-prompts";
import type { FinishInput, ReviewVerdict } from "./types";
import {
  detectBaseBranch, resolveSpec, preflight,
  parseAcceptanceGroups, runAcceptanceGate,
  runQualityGates, buildEscalationComment, postEscalation,
  openOrPromotePr, writeResult, _contextDeps,
} from "./steps";

const inputOf = (ctx: { input: unknown }) => ctx.input as FinishInput;

export default defineFlow({
  name: "nax-finish",
  permissions: {
    requiredMode: "approve-all",
    requireExplicitGrant: true,
    reason: "This flow edits files, pushes commits, runs quality gates, comments on and opens/promotes PRs.",
  },
  startAt: "load_ctx",
  nodes: {
    load_ctx: {
      nodeType: "compute",
      async run(ctx) {
        const i = inputOf(ctx);
        const base = await detectBaseBranch(i.workdir);
        const { specPath } = await resolveSpec(i.feature, i.workdir);
        const pf = await preflight(i.workdir, base);
        return { base, specPath, route: pf.route };
      },
    },
    acceptance: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const res = await _contextDeps.run(["nax", "features", "resolve", i.feature, "--json"], { cwd: i.workdir });
        const { groups } = parseAcceptanceGroups(res.stdout);
        const r = await runAcceptanceGate(i.workdir, groups);
        return { route: r.passed ? "proceed" : "fix", output: r.output };
      },
    },
    review_spec: {
      nodeType: "acp",
      session: { isolated: true },
      profile: undefined, // set at runtime from input.reviewers.spec via --default-agent/profile resolution
      prompt(ctx) {
        const outs = ctx.outputs as Record<string, { base?: string; specPath?: string }>;
        return buildReviewPrompt("spec", { base: outs.load_ctx?.base ?? "origin/main", specPath: outs.load_ctx?.specPath ?? "" });
      },
      parse: (text) => extractJsonObject(text) as ReviewVerdict,
    },
    review_quality: {
      nodeType: "acp",
      session: { isolated: true },
      prompt(ctx) {
        const outs = ctx.outputs as Record<string, { base?: string; specPath?: string }>;
        return buildReviewPrompt("quality", { base: outs.load_ctx?.base ?? "origin/main", specPath: outs.load_ctx?.specPath ?? "" });
      },
      parse: (text) => extractJsonObject(text) as ReviewVerdict,
    },
    fix_spec: { nodeType: "acp", prompt: (ctx) => fixPrompt("spec", ctx), parse: (t) => extractJsonObject(t) },
    fix_quality: { nodeType: "acp", prompt: (ctx) => fixPrompt("quality", ctx), parse: (t) => extractJsonObject(t) },
    fix_gate: { nodeType: "acp", prompt: (ctx) => fixPrompt("gate", ctx), parse: (t) => extractJsonObject(t) },
    quality_gates: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const cmds = await loadQualityCommands(i.workdir); // reads .nax/config.json quality.commands
        const r = await runQualityGates(i.workdir, cmds);
        return { route: r.passed ? "green" : "fix", failing: r.failing, output: r.output };
      },
    },
    open_pr: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const r = await openOrPromotePr(i.workdir, i.branch, `nax-finish: ${i.feature}`, `Automated finish of \`${i.feature}\`.`);
        await writeResult(i.workdir, { feature: i.feature, status: r.status, url: r.url });
        return { route: "done", ...r };
      },
    },
    escalate: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const outs = ctx.outputs as Record<string, ReviewVerdict | undefined>;
        const verdict = outs.review_spec?.route === "escalate" ? outs.review_spec : outs.review_quality;
        const reason = verdict?.escalationReason ?? "nax-finish could not reach a green, shippable state";
        const comment = buildEscalationComment(i.feature, reason, verdict?.findings ?? []);
        const { url } = await postEscalation(i.workdir, i.branch, comment);
        await writeResult(i.workdir, { feature: i.feature, status: "escalated", url, escalationReason: reason });
        return { route: "done", url, escalationReason: reason };
      },
    },
  },
  edges: [
    { from: "load_ctx", switch: { on: "$.route", cases: { proceed: "acceptance", "nothing-to-finish": "open_pr" } } },
    { from: "acceptance", switch: { on: "$.route", cases: { proceed: "review_spec", fix: "fix_spec" } } },
    { from: "review_spec", switch: { on: "$.route", cases: { proceed: "fix_spec", escalate: "escalate" } } },
    { from: "fix_spec", to: "review_quality" },
    { from: "review_quality", switch: { on: "$.route", cases: { proceed: "fix_quality", escalate: "escalate" } } },
    { from: "fix_quality", to: "quality_gates" },
    { from: "quality_gates", switch: { on: "$.route", cases: { green: "open_pr", fix: "fix_gate" } } },
    { from: "fix_gate", to: "quality_gates" },
  ],
});

function fixPrompt(phase: "spec" | "quality" | "gate", ctx: { outputs: Record<string, unknown> }): string {
  const outs = ctx.outputs as Record<string, { findings?: unknown; output?: string }>;
  const detail = phase === "gate" ? (outs.quality_gates?.output ?? "") : JSON.stringify(outs[`review_${phase}`]?.findings ?? []);
  return [
    `Apply the recommended fixes for the ${phase} phase, then re-verify.`,
    `Context:\n${detail}`,
    "Fix directly in the repo; do not open PRs. Return {\"route\":\"proceed\"} when done.",
  ].join("\n\n");
}

async function loadQualityCommands(workdir: string) {
  const file = Bun.file(`${workdir}/.nax/config.json`);
  const cfg = (await file.exists()) ? (JSON.parse(await file.text()) as { quality?: { commands?: Record<string, string> } }) : {};
  return cfg.quality?.commands ?? {};
}
```

> **Note on `profile`:** the plugin passes `input.reviewers.spec`/`.quality` and the acpx `--default-agent`. If a reviewer profile is set, the flow file reads it into the node's `profile` at module init from a captured input is not possible (input arrives per-run) — so pin the reviewer by passing `--default-agent <profile>` for the common case, and, if per-node distinct profiles are required, set `profile` from `ctx` is unavailable (it's a static field). Track distinct-per-node profiles as a follow-up; v1 uses one reviewer profile via `--default-agent`. Document this limitation in the flow header comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/flows/nax-finish/flow-graph.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Typecheck the flow imports resolve**

Run: `bun run typecheck`
Expected: no errors referencing `flows/nax-finish/**` (confirms `acpx/flows` subpath + `flows/**` in tsconfig — see Task 9).

- [ ] **Step 6: Commit**

```bash
git add flows/nax-finish/nax-finish.flow.ts test/unit/flows/nax-finish/flow-graph.test.ts
git commit -m "feat(flow): nax-finish.flow.ts declaration wiring steps + review nodes"
```

---

## Task 8: Post-run plugin — shouldRun / execute / Telegram

**Files:**
- Create: `src/plugins/builtin/nax-finish/index.ts`, `src/plugins/builtin/nax-finish/config.ts`, `src/plugins/builtin/nax-finish/telegram.ts`
- Test: `test/unit/plugins/builtin/nax-finish/plugin.test.ts`

**Interfaces:**
- Consumes: `IPostRunAction`, `NaxPlugin`, `PostRunContext`, `PostRunActionResult` from `@/plugins/types`; `resolveDefaultAgent` from `@/agents`.
- Produces:
  - `config.ts`: `getFinishAutoFlowConfig(ctx): { enabled; flowPath; defaultAgent; reviewers; escalate }` (loose read of `ctx.config.finish.autoFlow`, defaults matching the schema); `isTelegramConfigured(config): boolean` (checks `config.interaction` for a telegram plugin with a bot token).
  - `telegram.ts`: `_telegramDeps: { fetch }`; `sendTelegramNotify(config, text): Promise<boolean>` (POST to `https://api.telegram.org/bot<token>/sendMessage`).
  - `index.ts`: `naxFinishPlugin: NaxPlugin` (`provides: ["post-run-action"]`, `extensions.postRunAction`), and `_naxFinishDeps: { run; readResult }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/plugins/builtin/nax-finish/plugin.test.ts
import { describe, expect, test } from "bun:test";
import { naxFinishPlugin, _naxFinishDeps } from "@/plugins/builtin/nax-finish";
import type { PostRunContext } from "@/plugins/types";

const action = naxFinishPlugin.extensions.postRunAction!;
const baseCtx = (over: Partial<PostRunContext> = {}): PostRunContext => ({
  runId: "r", feature: "x", workdir: "/repo", prdPath: "/repo/.nax/features/x/prd.json",
  branch: "feat/x", totalDurationMs: 1, totalCost: 0,
  storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
  stories: [], config: { finish: { autoFlow: { enabled: true } } },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  ...over,
} as unknown as PostRunContext);

describe("nax-finish post-run action", () => {
  test("shouldRun=false when disabled", async () => {
    expect(await action.shouldRun(baseCtx({ config: { finish: { autoFlow: { enabled: false } } } } as never))).toBe(false);
  });
  test("shouldRun=false on main branch", async () => {
    expect(await action.shouldRun(baseCtx({ branch: "main" }))).toBe(false);
  });
  test("shouldRun=false when a story failed", async () => {
    expect(await action.shouldRun(baseCtx({ storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 } }))).toBe(false);
  });
  test("shouldRun=true when enabled + clean + feature branch", async () => {
    expect(await action.shouldRun(baseCtx())).toBe(true);
  });
  test("execute shells acpx flow run and maps the escalated result", async () => {
    const calls: string[][] = [];
    _naxFinishDeps.run = async (cmd) => { calls.push(cmd); return { exitCode: 0, stdout: "", stderr: "" }; };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "escalated", escalationReason: "design call" });
    const r = await action.execute(baseCtx());
    expect(calls[0].join(" ")).toContain("acpx");
    expect(calls[0].join(" ")).toContain("flow run");
    expect(calls[0].join(" ")).toContain("--input-json");
    expect(r.success).toBe(true);
    expect(r.message).toContain("escalated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/builtin/nax-finish/plugin.test.ts --timeout=5000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.ts`, `telegram.ts`, `index.ts`**

`config.ts` — loose reader mirroring `auto-pr`'s `getAutoPrConfig`, plus `isTelegramConfigured`.

`telegram.ts`:
```ts
// src/plugins/builtin/nax-finish/telegram.ts
export const _telegramDeps: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };
export async function sendTelegramNotify(cfg: { token: string; chatId: string }, text: string): Promise<boolean> {
  const res = await _telegramDeps.fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "Markdown" }),
  });
  return res.ok;
}
```

`index.ts` — the action:
```ts
// src/plugins/builtin/nax-finish/index.ts (execute skeleton)
import * as path from "node:path";
import type { IPostRunAction, NaxPlugin, PostRunActionResult, PostRunContext } from "@/plugins/types";
import { getFinishAutoFlowConfig, isTelegramConfigured, telegramCreds } from "./config";
import { sendTelegramNotify } from "./telegram";
import type { FinishResult, RunFn } from "../../../../flows/nax-finish/types";

async function defaultRun(cmd: string[], opts: { cwd: string }) { /* Bun.spawn concurrent-read, as auto-pr defaultRun */ return { exitCode: 0, stdout: "", stderr: "" }; }
async function defaultReadResult(workdir: string): Promise<FinishResult | null> {
  const f = Bun.file(path.join(workdir, ".nax", "nax-finish-result.json"));
  return (await f.exists()) ? (JSON.parse(await f.text()) as FinishResult) : null;
}
export const _naxFinishDeps: { run: RunFn; readResult: (workdir: string) => Promise<FinishResult | null> } = { run: defaultRun, readResult: defaultReadResult };

const PLUGIN_NAME = "nax-finish";
function isFeatureBranch(b: string): boolean { return b !== "main" && b !== "master" && b.length > 0; }

const naxFinishAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description: "Autonomously finishes a feature (acceptance → review → gates → PR) via an acpx flow after a successful run",
  async shouldRun(ctx: PostRunContext): Promise<boolean> {
    const cfg = getFinishAutoFlowConfig(ctx);
    if (!cfg.enabled) return false;
    const s = ctx.storySummary;
    if (s.completed === 0 || s.failed > 0 || s.paused > 0) return false;
    return isFeatureBranch(ctx.branch);
  },
  async execute(ctx: PostRunContext): Promise<PostRunActionResult> {
    try {
      const cfg = getFinishAutoFlowConfig(ctx);
      const flowPath = path.resolve(ctx.workdir, cfg.flowPath);
      const input = { feature: ctx.feature, workdir: ctx.workdir, branch: ctx.branch, prdPath: ctx.prdPath,
        reviewers: cfg.reviewers, escalateTelegram: cfg.escalate.telegram };
      const cmd = ["acpx", "--approve-all", ...(cfg.defaultAgent ? ["--default-agent", cfg.defaultAgent] : []),
        "flow", "run", flowPath, "--input-json", JSON.stringify(input)];
      const res = await _naxFinishDeps.run(cmd, { cwd: ctx.workdir });
      const result = await _naxFinishDeps.readResult(ctx.workdir);
      if (!result) return { success: res.exitCode === 0, message: `nax-finish flow exited ${res.exitCode} (no result file)` };

      if (result.status === "escalated" && cfg.escalate.telegram && isTelegramConfigured(ctx.config)) {
        await sendTelegramNotify(telegramCreds(ctx.config), `nax-finish escalated *${result.feature}*: ${result.escalationReason ?? ""}`);
      }
      return { success: true, message: `nax-finish: ${result.status}`, url: result.url };
    } catch (err) {
      ctx.logger.warn("nax-finish execute failed", { error: String(err) });
      return { success: false, message: `nax-finish failed: ${String(err)}` };
    }
  },
};

export const naxFinishPlugin: NaxPlugin = {
  name: PLUGIN_NAME, version: "0.1.0", provides: ["post-run-action"],
  async setup() {}, async teardown() {},
  extensions: { postRunAction: naxFinishAction },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/plugins/builtin/nax-finish/plugin.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/builtin/nax-finish/ test/unit/plugins/builtin/nax-finish/
git commit -m "feat(plugins): nax-finish post-run action (acpx flow trigger + telegram escalation)"
```

---

## Task 9: Register the plugin + wire `flows/` into the build

**Files:**
- Modify: `src/plugins/loader.ts` (side-channel registration, near the `autoPrPlugin` block ~line 140)
- Modify: `tsconfig.json` (ensure `flows/**` in `include`)
- Test: `test/unit/plugins/loader-nax-finish.test.ts`

**Interfaces:**
- Consumes: `naxFinishPlugin` from `@/plugins/builtin/nax-finish`.
- Produces: `loadPlugins(...)` returns a registry whose `getPostRunActions()` includes the `nax-finish` action (unless `disabledPlugins` names it).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/plugins/loader-nax-finish.test.ts
import { describe, expect, test } from "bun:test";
import { loadPlugins } from "@/plugins/loader";

describe("loader registers nax-finish post-run action", () => {
  test("present by default", async () => {
    const reg = await loadPlugins("/tmp/g", "/tmp/p", [], "/tmp/p", []);
    expect(reg.getPostRunActions().some((a) => a.name === "nax-finish")).toBe(true);
  });
  test("absent when disabled", async () => {
    const reg = await loadPlugins("/tmp/g", "/tmp/p", [], "/tmp/p", ["nax-finish"]);
    expect(reg.getPostRunActions().some((a) => a.name === "nax-finish")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/plugins/loader-nax-finish.test.ts --timeout=5000`
Expected: FAIL — action not registered.

- [ ] **Step 3: Register in `loader.ts`**

Add the import at the top (with the other builtin imports): `import { naxFinishPlugin } from "@/plugins/builtin/nax-finish";`

After the `autoPrPlugin` side-channel block, add the same-shape block:

```ts
  if (!disabledSet.has(naxFinishPlugin.name)) {
    if (naxFinishPlugin.setup) {
      const pluginLogger = createPluginLogger(naxFinishPlugin.name);
      await naxFinishPlugin.setup({}, pluginLogger);
    }
    // Side-channel action only (same layout as auto-pr) — not added to loadedPlugins.
    const action = naxFinishPlugin.extensions.postRunAction;
    if (action) builtinPostRunActions.push(action);
  } else {
    logger?.info("plugins", `Skipping disabled plugin: '${naxFinishPlugin.name}' (built-in)`);
  }
```

- [ ] **Step 4: Ensure `flows/**` is type-checked**

Confirm `tsconfig.json` `include` covers `flows` (add `"flows/**/*.ts"` if absent). Then:

Run: `bun run typecheck`
Expected: PASS — `flows/nax-finish/**` and the plugin's cross-import from `../../../../flows/nax-finish/types` resolve.

- [ ] **Step 5: Run the loader test + full lint**

Run: `timeout 30 bun test test/unit/plugins/loader-nax-finish.test.ts --timeout=5000 && bun run lint`
Expected: test PASS; lint clean (Biome, file-size, alias checks).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/loader.ts tsconfig.json test/unit/plugins/loader-nax-finish.test.ts
git commit -m "feat(plugins): register nax-finish built-in post-run action + type-check flows/"
```

---

## Task 10: Full-suite gate + docs pointer

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-nax-finish-flow-design.md` (add "Status: implemented" note + link to this plan)

- [ ] **Step 1: Run the whole suite**

Run: `bun run test`
Expected: green. Investigate any failure before proceeding (exit 124/134/132 are terminal — do not retry).

- [ ] **Step 2: Run the coverage gate**

Run: `bun run test:coverage`
Expected: overall line + function coverage ≥ 80% (the new `flows/nax-finish/steps/**`, `review-prompts.ts`, and `src/plugins/builtin/nax-finish/**` carry unit tests; the thin `nax-finish.flow.ts` is covered by the graph-shape test).

- [ ] **Step 3: Manual end-to-end smoke (optional, gated on a real branch)**

On a scratch feature branch with `finish.autoFlow.enabled: true` in `.nax/config.json`, run a small `nax run`, then confirm the post-run log line `[post-run] nax-finish: <status>` and that `.nax/nax-finish-result.json` was written. (Not part of the unit gate.)

- [ ] **Step 4: Commit the docs pointer**

```bash
git add docs/superpowers/specs/2026-07-24-nax-finish-flow-design.md
git commit -m "docs: mark nax-finish-flow design implemented; link plan"
```

---

## Self-Review

**Spec coverage:**
- Autonomous+escalate flow → Tasks 3–7 (graph + steps), escalation in Task 6.
- Fix-all-recommended / escalate-on-judgment → the classifier in Task 2's `buildReviewPrompt`; routing in Task 7 edges.
- Two isolated agent/model-pinned reviews → Task 7 `review_spec`/`review_quality` (`session.isolated`, `profile`). **Known v1 limitation** (see Task 7 note): per-node distinct `profile` can't be set from per-run input on a static field — v1 uses one reviewer profile via `--default-agent`; distinct-per-phase profiles are a tracked follow-up.
- Deterministic quality gate + LLM only in loop-fix → Task 5 (`runQualityGates` action) + Task 7 `quality_gates`→`fix_gate`→`quality_gates` loop.
- All-green opens a **ready** PR → Task 6 `openOrPromotePr` + Task 7 `open_pr`.
- Escalate via Telegram else PR comment → Task 6 `postEscalation` (durable PR comment) + Task 8 `sendTelegramNotify` (in-process).
- Opt-in, off by default → Task 1 (`enabled: false`) + Task 8 `shouldRun`.
- Config shape / flow location / test strategy → Tasks 1, 7, and every task's tests.

**Placeholder scan:** the only intentional "fill from source" is Task 2's verbatim copy of three named skill files — a precise instruction with exact source paths, not a vague placeholder.

**Type consistency:** `FinishInput`/`Finding`/`ReviewVerdict`/`FinishResult`/`RunFn` are defined once (Task 2 `types.ts`) and imported by Tasks 3–8; the plugin reads the same `FinishResult` the flow writes (Task 6 `writeResult` ↔ Task 8 `readResult`). Node/route names match between Task 7 nodes/edges and the step return `route` values (Tasks 3–5).
