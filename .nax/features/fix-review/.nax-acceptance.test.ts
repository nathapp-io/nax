/**
 * Acceptance satellite for the "fix-review" feature (ADR-033).
 *
 * One test per acceptance criterion. Everything behavioural: modules are
 * imported and called, the US-002 git ACs use real temporary repositories, and
 * the plan-level ACs drive the real `buildPlanForStrategy` + `ExecutionPlan.run`
 * so the wiring under test is production wiring.
 *
 * Modules that do not exist until the feature lands are imported dynamically
 * (literal specifiers only) so a partially-implemented feature still runs the
 * ACs whose modules are present. `mock.module()` is forbidden project-wide, so
 * external calls are stubbed through the module-level `_`-prefixed deps object
 * the repo uses everywhere; `injectableDeps()` locates those objects by the
 * method names they expose rather than by a guessed identifier.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";
import { NaxError } from "@/errors";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import { runNonBlockingFix } from "@/execution/non-blocking-fix";
import { _nonBlockingFixDeps } from "@/execution/non-blocking-fix";
import { emitReviewDecision } from "@/execution/story-orchestrator/review-decision";
import { dispatchStrategy } from "@/findings/cycle-dispatch";
import { initLogger, resetLogger } from "@/logger";
import { findingsToFailedChecks } from "@/operations";
import { collectConfiguredModelPins } from "@/precheck/checks-model-resolution-walk";
import { truncateDiff } from "@/review/diff-utils";
import { ReviewAuditor } from "@/review/review-audit";
import { createRuntime } from "@/runtime";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachReviewAuditSubscriber } from "@/runtime/middleware/review-audit";
import { KNOWN_SESSION_ROLES } from "@/runtime/session-role";
import { _rollbackDeps } from "@/tdd";

// ─── local helpers (the satellite stays self-contained) ─────────────────────

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown): AnyRecord {
  if (!isRecord(value)) throw new Error(`expected a record, got ${String(value)}`);
  return value;
}

/** `ResolvedTestPatterns` with no test patterns — `isTestFile` is always false. */
const NO_TEST_PATTERNS = {
  globs: [] as string[],
  pathspec: [] as string[],
  regex: [] as RegExp[],
  testDirs: [] as string[],
  resolution: "detected" as const,
};

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const runtimes: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spy on one logger level for the duration of `fn` (same contract as @test/helpers' withWarnSpy). */
async function withLogSpy<T>(level: "info" | "warn", fn: (spy: AnySpy) => Promise<T>): Promise<T> {
  type AnySpy = ReturnType<typeof spyOn>;
  resetLogger();
  const logger = initLogger({ level: "silent" });
  const spy = spyOn(logger, level);
  try {
    return await fn(spy as AnySpy);
  } finally {
    spy.mockRestore();
    resetLogger();
  }
}

/** Every argument tuple of every call made through a bun spy. */
function spyCalls(spy: unknown): unknown[][] {
  const mock = (spy as { mock?: { calls?: unknown[][] } }).mock;
  if (mock === undefined || !Array.isArray(mock.calls)) throw new Error("expected a spy function with mock.calls");
  return mock.calls;
}

function firstCallMatching(spy: unknown, message: string): unknown[] | undefined {
  return spyCalls(spy).find((args) => args[1] === message);
}

function storyFixture(over: AnyRecord = {}): AnyRecord {
  return {
    id: "US-001",
    title: "Test story",
    description: "A test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...over,
  };
}

function findingFixture(over: AnyRecord = {}): AnyRecord {
  return { source: "lint", severity: "warning", category: "", message: "", ...over };
}

/**
 * A `CallContext` stand-in for the non-plan ACs: enough surface for the fix
 * cycle's ledger read, the review-decision emitter and the wrapper's logging,
 * without booting a runtime.
 */
function makeLightCtx(over: AnyRecord = {}): AnyRecord {
  return {
    runtime: {
      runId: "run-1",
      projectDir: "/tmp/nax-fix-review-project",
      outputDir: "/tmp/nax-fix-review-output",
      costAggregator: { byCall: () => ({}) },
      dispatchEvents: { emitReviewDecision: () => {} },
      quarantineMemo: undefined,
      dirtyWorktrees: new Set<string>(),
    },
    packageView: { config: DEFAULT_CONFIG, select: () => ({}) },
    packageDir: "/tmp/nax-fix-review-project",
    config: DEFAULT_CONFIG,
    agentName: "native",
    storyId: "US-001",
    featureName: "feat",
    ...over,
  };
}

/** A plan-level `CallContext`: real runtime, real package view, effective config. */
function makeCallCtx(config: unknown = DEFAULT_CONFIG, over: AnyRecord = {}): AnyRecord {
  const runtime = createRuntime(config as never, "/tmp/nax-fix-review-project", {
    featureName: "_fix_review_acceptance",
  });
  runtimes.push(runtime);
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/nax-fix-review-project",
    config,
    agentName: "native",
    storyId: "US-001",
    featureName: "_fix_review_acceptance",
    ...over,
  };
}

/** Minimal `FixCycleContext`: the light context with `storyId` made required. */
function makeFixCtx(over: AnyRecord = {}): AnyRecord {
  return { ...makeLightCtx(), storyId: "US-001", ...over };
}

/** A review config slice: DEFAULT_CONFIG's review block plus the overrides given. */
function reviewConfig(over: AnyRecord = {}): AnyRecord {
  const base = rec(DEFAULT_CONFIG.review);
  return {
    ...base,
    ...over,
    adversarial: { ...rec(base.adversarial), ...(over.adversarial as AnyRecord) },
  };
}

// ─── dynamic module loading ────────────────────────────────────────────────

async function loadFixReviewConfig(): Promise<AnyRecord> {
  return (await import("@/review/fix-review/config")) as unknown as AnyRecord;
}
async function loadFixReviewScope(): Promise<AnyRecord> {
  return (await import("@/review/fix-review/scope")) as unknown as AnyRecord;
}
async function loadTreeSnapshot(): Promise<AnyRecord> {
  return (await import("@/review/fix-review/tree-snapshot")) as unknown as AnyRecord;
}
async function loadFixReviewRun(): Promise<AnyRecord> {
  return (await import("@/review/fix-review/run")) as unknown as AnyRecord;
}
async function loadFixReviewStrategy(): Promise<AnyRecord> {
  return (await import("@/execution/story-orchestrator/fix-review-strategy")) as unknown as AnyRecord;
}
async function loadNbfDeps(): Promise<AnyRecord> {
  return (await import("@/execution/story-orchestrator/nbf-deps")) as unknown as AnyRecord;
}

/**
 * The first candidate module that actually exports `symbol`.
 *
 * Every candidate is a literal `import()` so the resolver sees the specifier at
 * build time; a module that does not exist yet simply throws and the next
 * candidate is tried.
 */
async function firstExported(
  symbol: string,
  candidates: readonly (() => Promise<AnyRecord>)[],
): Promise<AnyRecord> {
  for (const load of candidates) {
    let mod: AnyRecord | undefined;
    try {
      mod = await load();
    } catch {
      mod = undefined;
    }
    if (mod !== undefined && mod[symbol] !== undefined) return mod;
  }
  throw new Error(`no candidate module exports ${symbol}`);
}

async function loadFixReviewOpModule(): Promise<AnyRecord> {
  return firstExported("fixReviewOp", [
    async () => (await import("@/operations/fix-review")) as unknown as AnyRecord,
    async () => (await import("@/operations")) as unknown as AnyRecord,
  ]);
}

async function loadFixReviewPromptModule(): Promise<AnyRecord> {
  return firstExported("buildFixReviewPrompt", [
    async () => (await import("@/prompts/builders/fix-review-builder")) as unknown as AnyRecord,
    async () => (await import("@/prompts")) as unknown as AnyRecord,
  ]);
}

/**
 * Locate a module's injectable deps object — the repo's `_deps` convention.
 * Found by the method names it carries, so the identifier is the
 * implementation's choice.
 */
function tryInjectableDeps(moduleExports: AnyRecord, methodNames: readonly string[]): AnyRecord | undefined {
  for (const [name, value] of Object.entries(moduleExports)) {
    if (!name.startsWith("_") || !isRecord(value)) continue;
    if (methodNames.some((method) => typeof value[method] === "function")) return value;
  }
  return undefined;
}

function injectableDeps(moduleExports: AnyRecord, methodNames: readonly string[]): AnyRecord {
  const found = tryInjectableDeps(moduleExports, methodNames);
  if (found !== undefined) return found;
  throw new Error(
    `no injectable deps object found exposing ${methodNames.join("/")} — the module must export a mutable ` +
      "`_`-prefixed object carrying those functions (mock.module() is forbidden project-wide)",
  );
}

/** Temporarily replace keys on a mutable object; returns a restore function. */
function patch(target: AnyRecord, values: AnyRecord): () => void {
  const saved = new Map<string, unknown>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, target[key]);
    target[key] = value;
  }
  return () => {
    for (const [key, value] of saved) target[key] = value;
  };
}

// ─── git helpers for the US-002 working-tree ACs ───────────────────────────

/** A fake subprocess for the modules whose spawn seam returns a `SpawnResult`. */
function fakeProc(stdout: string, exitCode = 0): AnyRecord {
  const body = new TextEncoder().encode(stdout);
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (body.length > 0) controller.enqueue(body);
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    pid: 4242,
    kill: () => {},
  };
}

function runGit(cwd: string, args: readonly string[]): { exitCode: number; stdout: Buffer; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env as never });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout as Uint8Array),
    stderr: proc.stderr.toString(),
  };
}

function git(cwd: string, args: readonly string[]): string {
  const out = runGit(cwd, args);
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout.toString().trim();
}

function writeIn(dir: string, relPath: string, contents: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A fresh temporary repository on one real commit; no staged or working-tree changes. */
function makeRepo(): string {
  const dir = makeTempDir("nax-fix-review-repo-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "acceptance@nax.test"]);
  git(dir, ["config", "user.name", "nax acceptance"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeIn(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "baseline"]);
  return dir;
}

async function snapshot(workdir: string): Promise<string> {
  const mod = await loadTreeSnapshot();
  return (mod.snapshotWorkingTree as (w: string) => Promise<string>)(workdir);
}

async function changedPaths(workdir: string, from: string, to: string): Promise<string[]> {
  const mod = await loadTreeSnapshot();
  return (mod.changedPathsBetween as (w: string, f: string, t: string) => Promise<string[]>)(workdir, from, to);
}

async function diffBetween(workdir: string, from: string, to: string): Promise<string> {
  const mod = await loadTreeSnapshot();
  return (mod.diffBetween as (w: string, f: string, t: string) => Promise<string>)(workdir, from, to);
}

/** Assert a promise rejects with a NaxError carrying exactly `code`. */
async function expectNaxErrorCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try {
    await fn();
  } catch (err) {
    rejected = true;
    caught = err;
  }
  expect(rejected).toBe(true);
  expect(caught).toBeInstanceOf(NaxError);
  expect((caught as NaxError).code).toBe(code);
}

// ─── US-001 — config, model resolution, session role, audit ────────────────

describe("US-001 config, model resolution, session role and audit kind", () => {
  test("AC-1: an empty NaxConfigSchema input yields review.fixReview.enabled === true", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.review.fixReview.enabled).toBe(true);
  });

  test("AC-2: an empty NaxConfigSchema input yields review.fixReview.timeoutMs === 600000", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.review.fixReview.timeoutMs).toBe(600_000);
  });

  test("AC-3: an empty NaxConfigSchema input yields review.fixReview.model === undefined", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.review.fixReview.model).toBeUndefined();
  });

  test("AC-4: NaxConfigSchema rejects fixReview.timeoutMs 0 on path review.fixReview.timeoutMs", () => {
    const result = NaxConfigSchema.safeParse({ review: { fixReview: { timeoutMs: 0 } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("review.fixReview.timeoutMs");
  });

  test("AC-5: resolveFixReviewModel prefers fixReview.model over a different semantic.model", async () => {
    const { resolveFixReviewModel } = await loadFixReviewConfig();
    const resolve = resolveFixReviewModel as (review: unknown) => unknown;
    expect(resolve({ fixReview: { model: "powerful" }, semantic: { model: "fast" } })).toBe("powerful");
  });

  test("AC-6: resolveFixReviewModel falls back to semantic.model when fixReview.model is unset", async () => {
    const { resolveFixReviewModel } = await loadFixReviewConfig();
    const resolve = resolveFixReviewModel as (review: unknown) => unknown;
    expect(resolve({ fixReview: { model: undefined }, semantic: { model: "fast" } })).toBe("fast");
  });

  test("AC-7: resolveFixReviewModel returns 'balanced' when neither site is set", async () => {
    const { resolveFixReviewModel } = await loadFixReviewConfig();
    const resolve = resolveFixReviewModel as (review: unknown) => unknown;
    expect(resolve({ fixReview: { model: undefined } })).toBe("balanced");
  });

  test("AC-8: the precheck model-resolution walk lists review.fixReview.model when set", () => {
    const { pins } = collectConfiguredModelPins({ review: { fixReview: { model: "powerful" } } });
    expect(pins.map((pin) => pin.keyPath)).toContain("review.fixReview.model");
  });

  test("AC-9: the precheck model-resolution walk has no review.fixReview.model site when unset", () => {
    const { pins } = collectConfiguredModelPins({});
    expect(pins.map((pin) => pin.keyPath)).not.toContain("review.fixReview.model");
  });

  test("AC-10: KNOWN_SESSION_ROLES contains 'reviewer-fix'", () => {
    expect(KNOWN_SESSION_ROLES).toContain("reviewer-fix");
  });

  test("AC-11: emitReviewDecision emits one fix review-decision event for a pass with no findings", () => {
    const events: AnyRecord[] = [];
    const ctx = makeLightCtx();
    rec(ctx.runtime).dispatchEvents = { emitReviewDecision: (event: unknown) => events.push(rec(event)) };

    emitReviewDecision(ctx as never, "fix-review", { parsed: true, passed: true, reason: "ok" });

    expect(events).toHaveLength(1);
    expect(events[0].reviewer).toBe("fix");
    expect(events[0].parsed).toBe(true);
    expect(events[0].result).toEqual({ passed: true, findings: [] });
  });

  test("AC-12: emitReviewDecision synthesizes one finding from a fail verdict", () => {
    const events: AnyRecord[] = [];
    const ctx = makeLightCtx();
    rec(ctx.runtime).dispatchEvents = { emitReviewDecision: (event: unknown) => events.push(rec(event)) };

    emitReviewDecision(ctx as never, "fix-review", {
      parsed: true,
      passed: false,
      reason: "adds mkdir",
      acIndex: 4,
      file: "src/a.ts",
    });

    expect(events).toHaveLength(1);
    const findings = rec(events[0].result).findings as AnyRecord[];
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("adds mkdir");
    expect(findings[0].acIndex).toBe(4);
    expect(findings[0].file).toBe("src/a.ts");
  });

  test("AC-13: emitReviewDecision reports an unparsed fix review as parsed:false with a null result", () => {
    const events: AnyRecord[] = [];
    const ctx = makeLightCtx();
    rec(ctx.runtime).dispatchEvents = { emitReviewDecision: (event: unknown) => events.push(rec(event)) };

    emitReviewDecision(ctx as never, "fix-review", { parsed: false, unparsedPreview: "garbage" });

    expect(events).toHaveLength(1);
    expect(events[0].parsed).toBe(false);
    expect(events[0].result).toBeNull();
    expect(events[0].unparsedPreview).toBe("garbage");
  });

  test("AC-14: the review-audit subscriber writes one JSON record for a reviewer 'fix' decision", async () => {
    const outputDir = makeTempDir("nax-fix-review-audit-");
    const auditor = new ReviewAuditor("run-1", outputDir);
    const bus = new DispatchEventBus();
    attachReviewAuditSubscriber(bus, auditor, "run-1");

    bus.emitReviewDecision({
      kind: "review-decision",
      reviewer: "fix",
      runId: "run-1",
      storyId: "US-001",
      featureName: "feat-audit",
      workdir: "/tmp/nax-fix-review-project",
      timestamp: Date.now(),
      parsed: true,
      passed: true,
      result: { passed: true, findings: [] },
    } as never);
    await auditor.flush();

    const dir = join(outputDir, "review-audit", "feat-audit");
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const record = rec(JSON.parse(readFileSync(join(dir, files[0]), "utf8")));
    expect(record.reviewer).toBe("fix");
  });

  test("AC-15: reviewerFromRole maps 'reviewer-fix' to 'fix'", async () => {
    const mod = (await import("@/runtime/middleware/review-audit")) as unknown as AnyRecord;
    const reviewerFromRole = mod.reviewerFromRole as (role: string) => string | null;
    expect(typeof reviewerFromRole).toBe("function");
    expect(reviewerFromRole("reviewer-fix")).toBe("fix");
    expect(reviewerFromRole("reviewer-semantic")).toBe("semantic");
  });
});

// ─── US-002 — working-tree snapshot helpers ───────────────────────────────

describe("US-002 working-tree snapshot helpers", () => {
  test("AC-16: snapshotWorkingTree returns HEAD's tree id in a clean repository", async () => {
    const repo = makeRepo();
    const headTree = git(repo, ["rev-parse", "HEAD^{tree}"]);
    expect(git(repo, ["show", "-s", "--format=%T", "HEAD"])).toBe(headTree);

    expect(await snapshot(repo)).toBe(headTree);
  });

  test("AC-17: an unstaged edit to a tracked file is the only changed path", async () => {
    const repo = makeRepo();
    writeIn(repo, "src/a.ts", "export const a = 2;\n");

    expect(await changedPaths(repo, "HEAD", await snapshot(repo))).toEqual(["src/a.ts"]);
  });

  test("AC-18: an untracked, non-ignored file is reported as changed", async () => {
    const repo = makeRepo();
    writeIn(repo, "src/new.ts", "export const created = true;\n");

    expect(await changedPaths(repo, "HEAD", await snapshot(repo))).toContain("src/new.ts");
  });

  test("AC-19: a file matched by .gitignore is absent from the changed paths", async () => {
    const repo = makeRepo();
    writeIn(repo, ".gitignore", "ignored.ts\n");
    writeIn(repo, "ignored.ts", "export const ignored = true;\n");

    expect(await changedPaths(repo, "HEAD", await snapshot(repo))).not.toContain("ignored.ts");
  });

  test("AC-20: a pre-existing untracked file is absent from a snapshot-to-snapshot diff", async () => {
    const repo = makeRepo();
    writeIn(repo, "src/pre-existing.ts", "export const preExisting = true;\n");
    const before = await snapshot(repo);

    writeIn(repo, "src/a.ts", "export const a = 3;\n");
    const after = await snapshot(repo);

    const paths = await changedPaths(repo, before, after);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("src/pre-existing.ts");
  });

  test("AC-21: snapshotWorkingTree leaves status, staged paths and .git/index byte-identical", async () => {
    const repo = makeRepo();
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/b.ts"]);
    git(repo, ["commit", "-qm", "add b"]);
    // staged + unstaged tracked + untracked changes, all at once.
    writeIn(repo, "src/b.ts", "export const b = 2;\n");
    git(repo, ["add", "src/b.ts"]);
    writeIn(repo, "src/a.ts", "export const a = 9;\n");
    writeIn(repo, "src/untracked.ts", "export const untracked = true;\n");

    const status = () => runGit(repo, ["status", "--porcelain=v1", "-z"]).stdout.toString("base64");
    const staged = () => runGit(repo, ["diff", "--cached", "--name-only", "-z"]).stdout.toString("base64");
    const indexHash = () => sha256(readFileSync(join(repo, ".git", "index")));

    const before = { status: status(), staged: staged(), index: indexHash() };
    await snapshot(repo);
    const after = { status: status(), staged: staged(), index: indexHash() };

    expect(after.status).toBe(before.status);
    expect(after.staged).toBe(before.staged);
    expect(after.index).toBe(before.index);
  });

  test("AC-22: a package subdirectory workdir reports repo-root-relative paths", async () => {
    const repo = makeRepo();
    writeIn(repo, "packages/a/src/x.ts", "export const x = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add package file"]);
    writeIn(repo, "packages/a/src/x.ts", "export const x = 2;\n");

    const packageWorkdir = join(repo, "packages", "a");
    expect(await changedPaths(packageWorkdir, "HEAD", await snapshot(packageWorkdir))).toEqual([
      "packages/a/src/x.ts",
    ]);
  });

  test("AC-23: an unknown ref rejects with NaxError FIX_REVIEW_GIT_FAILED", async () => {
    const repo = makeRepo();
    await expectNaxErrorCode(() => changedPaths(repo, "no-such-ref", "HEAD"), "FIX_REVIEW_GIT_FAILED");
  });

  test("AC-24: a directory outside any git work tree rejects with NaxError FIX_REVIEW_GIT_FAILED", async () => {
    const dir = makeTempDir("nax-fix-review-not-a-repo-");
    const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    try {
      // Precondition: nothing above this directory is a git work tree.
      expect(runGit(dir, ["rev-parse", "--show-toplevel"]).exitCode).not.toBe(0);
      await expectNaxErrorCode(() => snapshot(dir), "FIX_REVIEW_GIT_FAILED");
    } finally {
      if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    }
  });

  test("AC-25: diffBetween shows the source change and excludes everything under .nax/", async () => {
    const repo = makeRepo();
    writeIn(repo, ".nax/cache.json", '{ "v": 1 }\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add .nax artifact"]);

    const sourceSentinel = "export const sentinel = 'SRC_SENTINEL_LINE';";
    const naxSentinel = "NAX_SENTINEL_LINE";
    writeIn(repo, "src/a.ts", `export const a = 1;\n${sourceSentinel}\n`);
    writeIn(repo, ".nax/cache.json", `{ "v": 2, "note": "${naxSentinel}" }\n`);

    const diff = await diffBetween(repo, "HEAD", await snapshot(repo));

    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff).toContain(sourceSentinel);
    expect(diff).not.toContain("diff --git a/.nax/");
    expect(diff).not.toContain(naxSentinel);
  });
});

// ─── US-002 — the deterministic scope check ────────────────────────────────

function scopeStory(over: AnyRecord = {}): AnyRecord {
  return { contextFiles: [], relevantFiles: undefined, expectedFiles: [], modifiedFiles: [], ...over };
}

async function checkScope(input: AnyRecord): Promise<AnyRecord> {
  const { checkFixScope } = await loadFixReviewScope();
  const check = checkFixScope as (i: unknown) => unknown;
  expect(typeof check).toBe("function");
  return rec(check(input));
}

describe("US-002 checkFixScope", () => {
  test("AC-26: changed files listed in storyFiles are in scope", async () => {
    const result = await checkScope({
      changedFiles: ["src/a.ts", "src/b.ts"],
      storyFiles: ["src/a.ts", "src/b.ts"],
      story: scopeStory(),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  test("AC-27: a changed file listed only in story.contextFiles is in scope", async () => {
    const result = await checkScope({
      changedFiles: ["src/context-only.ts"],
      storyFiles: [],
      story: scopeStory({ contextFiles: ["src/context-only.ts"] }),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-28: a changed file listed only in story.expectedFiles is in scope", async () => {
    const result = await checkScope({
      changedFiles: ["src/expected-only.ts"],
      storyFiles: [],
      story: scopeStory({ expectedFiles: ["src/expected-only.ts"] }),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-29: a changed file listed only as a story.modifiedFiles path is in scope", async () => {
    const result = await checkScope({
      changedFiles: ["src/modified-only.ts"],
      storyFiles: [],
      story: scopeStory({ modifiedFiles: [{ path: "src/modified-only.ts" }] }),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-30: a seeding finding's workdir-relative file is joined onto packageDirRel", async () => {
    const result = await checkScope({
      changedFiles: ["packages/a/src/lock.ts"],
      storyFiles: [],
      story: scopeStory(),
      findings: [{ file: "src/lock.ts" }],
      packageDirRel: "packages/a",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-31: a changed file the isTestFile predicate claims is in scope", async () => {
    const result = await checkScope({
      changedFiles: ["src/foo.test.ts"],
      storyFiles: [],
      story: scopeStory(),
      findings: [],
      packageDirRel: "",
      isTestFile: (path: string) => path === "src/foo.test.ts",
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-32: a changed path under .nax/ is ignored", async () => {
    const result = await checkScope({
      changedFiles: [".nax/cache.json"],
      storyFiles: [],
      story: scopeStory(),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });

  test("AC-33: an unlisted non-test file makes the pass out of scope and is named", async () => {
    const result = await checkScope({
      changedFiles: ["src/utils/path-file-lock.ts"],
      storyFiles: [],
      story: scopeStory(),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(false);
    expect(result.outOfScopeFiles).toEqual(["src/utils/path-file-lock.ts"]);
  });

  test("AC-34: an unknown storyFiles set skips the check without flagging anything", async () => {
    const result = await checkScope({
      changedFiles: ["src/anything.ts"],
      storyFiles: undefined,
      story: scopeStory(),
      findings: [],
      packageDirRel: "",
      isTestFile: () => false,
    });
    expect(result.inScope).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
  });
});

// ─── US-003 — prompt ──────────────────────────────────────────────────────

async function buildFixReviewPromptOf(input: AnyRecord): Promise<string> {
  const mod = await loadFixReviewPromptModule();
  const builder = mod.buildFixReviewPrompt as (i: unknown) => string;
  expect(typeof builder).toBe("function");
  return builder(input);
}

describe("US-003 buildFixReviewPrompt", () => {
  test("AC-35: acceptance criteria are numbered from 1", async () => {
    const prompt = await buildFixReviewPromptOf({
      story: storyFixture({ acceptanceCriteria: ["first", "second"] }),
      diff: "",
      findings: [],
    });
    expect(prompt).toContain("1. first");
    expect(prompt).toContain("2. second");
  });

  test("AC-36: the story's outOfScope rules are rendered", async () => {
    const prompt = await buildFixReviewPromptOf({
      story: storyFixture({ outOfScope: ["no new files", "no network"] }),
      diff: "",
      findings: [],
    });
    expect(prompt).toContain("no new files");
    expect(prompt).toContain("no network");
  });

  test("AC-37: the story's design description is rendered", async () => {
    const prompt = await buildFixReviewPromptOf({
      story: storyFixture({ description: "Design prose marker" }),
      diff: "",
      findings: [],
    });
    expect(prompt).toContain("Design prose marker");
  });

  test("AC-38: the fix diff is embedded", async () => {
    const prompt = await buildFixReviewPromptOf({
      story: storyFixture(),
      diff: "diff --git a/x b/x",
      findings: [],
    });
    expect(prompt).toContain("diff --git a/x b/x");
  });

  test("AC-39: every seeding finding message is rendered", async () => {
    const prompt = await buildFixReviewPromptOf({
      story: storyFixture(),
      diff: "",
      findings: [{ message: "first finding" }, { message: "second finding" }],
    });
    expect(prompt).toContain("first finding");
    expect(prompt).toContain("second finding");
  });
});

// ─── US-003 — the op ──────────────────────────────────────────────────────

async function fixReviewOpOf(): Promise<AnyRecord> {
  const mod = await loadFixReviewOpModule();
  const op = mod.fixReviewOp;
  expect(op).toBeDefined();
  return rec(op);
}

async function parseFixReviewOutput(raw: string): Promise<unknown> {
  const op = await fixReviewOpOf();
  const parse = op.parse as (output: string, input: unknown, ctx: unknown) => unknown;
  return parse(raw, {}, {});
}

describe("US-003 fixReviewOp", () => {
  test("AC-40: a fail verdict parses into the documented op output", async () => {
    const parsed = await parseFixReviewOutput('{"passed":false,"reason":"r","acIndex":4,"file":"src/a.ts"}');
    expect(parsed).toEqual({ parsed: true, passed: false, reason: "r", acIndex: 4, file: "src/a.ts" });
  });

  test("AC-41: an unparseable response yields parsed:false with a non-empty preview", async () => {
    const parsed = rec(await parseFixReviewOutput("not a JSON object"));
    expect(parsed.parsed).toBe(false);
    expect(typeof parsed.unparsedPreview).toBe("string");
    expect((parsed.unparsedPreview as string).length).toBeGreaterThan(0);
  });

  test("AC-42: the op runs on a fresh reviewer-fix session", async () => {
    const op = await fixReviewOpOf();
    expect(op.session).toEqual({ role: "reviewer-fix", lifetime: "fresh" });
  });

  test("AC-43: the op's model resolver reads ctx.config.review through resolveFixReviewModel", async () => {
    const op = await fixReviewOpOf();
    const { resolveFixReviewModel } = await loadFixReviewConfig();
    const resolve = resolveFixReviewModel as (review: unknown) => unknown;
    expect(typeof op.model).toBe("function");
    const resolver = op.model as (input: unknown, ctx: unknown) => unknown;

    const pinned = { fixReview: { model: "powerful" }, semantic: { model: "fast" } };
    expect(resolver({}, { config: { review: pinned } })).toBe("powerful");
    expect(resolver({}, { config: { review: pinned } })).toBe(resolve(pinned));

    expect(resolver({}, { config: { review: { fixReview: { model: undefined }, semantic: { model: "fast" } } } })).toBe(
      "fast",
    );
    expect(resolver({}, { config: { review: { fixReview: { model: undefined } } } })).toBe("balanced");
  });
});

// ─── US-003 — runFixReview ────────────────────────────────────────────────

interface FixReviewHarness {
  calls: {
    snapshotWorkingTree: number;
    changedPathsBetween: unknown[][];
    diffBetween: unknown[][];
    callOp: unknown[][];
    emitReviewDecision: unknown[][];
    checkFixScope: AnyRecord[];
  };
  deps: AnyRecord;
}

function fixReviewHarness(overrides: AnyRecord = {}): FixReviewHarness {
  const calls: FixReviewHarness["calls"] = {
    snapshotWorkingTree: 0,
    changedPathsBetween: [],
    diffBetween: [],
    callOp: [],
    emitReviewDecision: [],
    checkFixScope: [],
  };
  const deps: AnyRecord = {
    snapshotWorkingTree: async () => {
      calls.snapshotWorkingTree += 1;
      return "post-fix-tree";
    },
    changedPathsBetween: async (workdir: string, from: string, to: string) => {
      calls.changedPathsBetween.push([workdir, from, to]);
      return ["src/a.ts"];
    },
    diffBetween: async (workdir: string, from: string, to: string) => {
      calls.diffBetween.push([workdir, from, to]);
      return "RAW_DIFF";
    },
    callOp: async (...args: unknown[]) => {
      calls.callOp.push(args);
      return { parsed: true, passed: true, reason: "ok" };
    },
    emitReviewDecision: (...args: unknown[]) => {
      calls.emitReviewDecision.push(args);
    },
    resolveTestFilePatterns: async () => NO_TEST_PATTERNS,
    ...overrides,
  };
  return { calls, deps };
}

function fixReviewRequest(over: AnyRecord = {}): AnyRecord {
  return {
    workdir: "/tmp/nax-fix-review-project",
    story: storyFixture(),
    preFixTree: "pre-fix-tree",
    findings: [],
    config: { fixReview: { enabled: true, model: undefined, timeoutMs: 600_000 }, semantic: { model: "balanced" } },
    ...over,
  };
}

async function runFixReviewOf(ctx: AnyRecord, req: AnyRecord, deps: AnyRecord): Promise<AnyRecord> {
  const { runFixReview } = await loadFixReviewRun();
  const run = runFixReview as (c: unknown, r: unknown, d: unknown) => Promise<unknown>;
  expect(typeof run).toBe("function");
  return rec(await run(ctx, req, deps));
}

describe("US-003 runFixReview", () => {
  test("AC-44: a disabled fix review passes unreviewed without touching git or the model", async () => {
    const { deps, calls } = fixReviewHarness();
    const result = await runFixReviewOf(
      makeLightCtx(),
      fixReviewRequest({ config: { fixReview: { enabled: false, model: undefined, timeoutMs: 600_000 } } }),
      deps,
    );

    expect(result).toMatchObject({ kind: "pass", reviewed: false });
    expect(calls.snapshotWorkingTree).toBe(0);
    expect(calls.callOp).toHaveLength(0);
  });

  test("AC-45: no changed paths passes unreviewed without an LLM call", async () => {
    const { deps, calls } = fixReviewHarness({ changedPathsBetween: async () => [] });
    const result = await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(result).toMatchObject({ kind: "pass", reviewed: false });
    expect(calls.callOp).toHaveLength(0);
  });

  test("AC-46: a scope violation fails with cause 'scope' and names the file, without an LLM call", async () => {
    const { deps, calls } = fixReviewHarness({
      checkFixScope: () => ({ inScope: false, outOfScopeFiles: ["src/out-of-scope.ts"], skipped: false }),
    });
    const result = await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(result.kind).toBe("fail");
    expect(result.cause).toBe("scope");
    expect(result.files).toContain("src/out-of-scope.ts");
    expect(calls.callOp).toHaveLength(0);
  });

  test("AC-47: a parsed pass dispatches the fix-review op once and reports reviewed", async () => {
    const fixReviewOp = await fixReviewOpOf();
    const { deps, calls } = fixReviewHarness();
    const result = await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(calls.callOp).toHaveLength(1);
    expect(calls.callOp[0][1]).toBe(fixReviewOp);
    expect(result).toMatchObject({ kind: "pass", reviewed: true });
  });

  test("AC-48: a parsed contradiction fail carries the ac index, file and reason", async () => {
    const { deps } = fixReviewHarness({
      callOp: async () => ({ parsed: true, passed: false, reason: "r", acIndex: 4, file: "src/a.ts" }),
    });
    const result = await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(result).toEqual({ kind: "fail", cause: "contradiction", acIndex: 4, file: "src/a.ts", reason: "r" });
  });

  test("AC-49: a dispatch error is reported as kind 'error'", async () => {
    const { deps } = fixReviewHarness({
      callOp: async () => {
        throw new Error("boom");
      },
    });
    expect((await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps)).kind).toBe("error");
  });

  test("AC-50: an unparseable op output is reported as kind 'error'", async () => {
    const { deps } = fixReviewHarness({ callOp: async () => ({ parsed: false, unparsedPreview: "raw" }) });
    expect((await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps)).kind).toBe("error");
  });

  test("AC-51: a git failure while snapshotting is an error and never reaches the model", async () => {
    const { deps, calls } = fixReviewHarness({
      snapshotWorkingTree: async () => {
        throw new NaxError("git failed", "FIX_REVIEW_GIT_FAILED");
      },
    });
    const result = await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(result.kind).toBe("error");
    expect(calls.callOp).toHaveLength(0);
  });

  test("AC-52: the op output is emitted once as a review decision, parsed or not", async () => {
    for (const output of [
      { parsed: true, passed: true, reason: "ok" },
      { parsed: false, unparsedPreview: "raw" },
    ]) {
      const { deps, calls } = fixReviewHarness({ callOp: async () => output });
      await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

      expect(calls.emitReviewDecision).toHaveLength(1);
      expect(calls.emitReviewDecision[0][1]).toBe("fix-review");
      expect(calls.emitReviewDecision[0][2]).toBe(output);
    }
  });

  test("AC-53: a story without storyGitRef passes undefined story files and still reviews", async () => {
    const seen: AnyRecord[] = [];
    const { deps, calls } = fixReviewHarness({
      checkFixScope: (input: AnyRecord) => {
        seen.push(input);
        return { inScope: true, outOfScopeFiles: [], skipped: true };
      },
    });
    const req = fixReviewRequest({ story: storyFixture({ storyGitRef: undefined }) });

    const result = await runFixReviewOf(makeLightCtx(), req, deps);

    expect(seen).toHaveLength(1);
    expect(seen[0].storyFiles).toBeUndefined();
    expect(calls.callOp).toHaveLength(1);
    expect(result).toMatchObject({ kind: "pass", reviewed: true });
  });

  test("AC-54: the op receives the truncated diff between the pre-fix and post-fix trees", async () => {
    const { deps, calls } = fixReviewHarness();
    await runFixReviewOf(makeLightCtx(), fixReviewRequest(), deps);

    expect(calls.diffBetween).toHaveLength(1);
    expect(calls.diffBetween[0][1]).toBe("pre-fix-tree");
    expect(calls.diffBetween[0][2]).toBe("post-fix-tree");
    expect(rec(calls.callOp[0][2]).diff).toBe(truncateDiff("RAW_DIFF"));
  });
});

// ─── US-004 — the scoped fix review at the NBF keep gate ──────────────────

interface NbfHarness {
  args: AnyRecord;
  deps: AnyRecord;
  reviewFixCalls: string[];
  rollbackCalls: unknown[][];
  measureCalls: unknown[][];
  hasReviewFix: boolean;
}

function nbfHarness(over: { reviewFix?: unknown; args?: AnyRecord; deps?: AnyRecord } = {}): NbfHarness {
  const reviewFixCalls: string[] = [];
  const rollbackCalls: unknown[][] = [];
  const measureCalls: unknown[][] = [];
  const args: AnyRecord = {
    workdir: "/tmp/nax-fix-review-project",
    storyId: "US-001",
    advisoryFindings: [
      findingFixture({ source: "adversarial-review", severity: "warning", category: "input", message: "m" }),
    ],
    cfg: {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    },
    phaseOutputs: {},
    phaseCosts: {},
    runRectify: async () => ({ rectificationExhausted: false }),
    ...over.args,
  };
  const deps: AnyRecord = {
    captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
    rollbackToRef: async (...call: unknown[]) => {
      rollbackCalls.push(call);
    },
    measureSourceDiff: async (...call: unknown[]) => {
      measureCalls.push(call);
      return { fileCount: 0, sourceLineCount: 0 };
    },
    ...(over.reviewFix !== undefined
      ? {
          reviewFix: async (ref: string) => {
            reviewFixCalls.push(ref);
            return over.reviewFix;
          },
        }
      : {}),
    ...over.deps,
  };
  return { args, deps, reviewFixCalls, rollbackCalls, measureCalls, hasReviewFix: over.reviewFix !== undefined };
}

describe("US-004 scoped fix review at the NBF keep gate", () => {
  test("AC-55: a passing fix review keeps the pass and never rolls back", async () => {
    const h = nbfHarness({ reviewFix: { kind: "pass", reviewed: true, reason: "ok" } });
    const result = await runNonBlockingFix(h.args as never, h.deps as never);

    expect(result.ran).toBe(true);
    expect(result.kept).toBe(true);
    expect(result.restored).toBe(false);
    expect(h.rollbackCalls).toHaveLength(0);
  });

  test("AC-56: a scope fail restores the pass", async () => {
    const h = nbfHarness({ reviewFix: { kind: "fail", cause: "scope", files: ["src/x.ts"], reason: "scope" } });
    const result = await runNonBlockingFix(h.args as never, h.deps as never);

    expect(result.kept).toBe(false);
    expect(result.restored).toBe(true);
  });

  test("AC-57: a contradiction fail rolls back to the snapshot sha", async () => {
    const h = nbfHarness({ reviewFix: { kind: "fail", cause: "contradiction", reason: "r" } });
    await runNonBlockingFix(h.args as never, h.deps as never);

    expect(h.rollbackCalls).toHaveLength(1);
    expect(h.rollbackCalls[0][1]).toBe("snap-sha");
  });

  test("AC-58: an error verdict restores the pass", async () => {
    const h = nbfHarness({ reviewFix: { kind: "error", reason: "boom" } });
    expect((await runNonBlockingFix(h.args as never, h.deps as never)).restored).toBe(true);
  });

  test("AC-59: a cap-clearing pass reviews exactly once against the captured snapshot sha", async () => {
    const h = nbfHarness({ reviewFix: { kind: "pass", reviewed: true, reason: "ok" } });
    await runNonBlockingFix(h.args as never, h.deps as never);

    expect(h.reviewFixCalls).toEqual(["snap-sha"]);
  });

  test("AC-60: a pass the source-diff cap already restored is never reviewed", async () => {
    const h = nbfHarness({
      reviewFix: { kind: "pass", reviewed: true, reason: "ok" },
      deps: { measureSourceDiff: async () => ({ fileCount: 99, sourceLineCount: 9_999 }) },
    });
    const result = await runNonBlockingFix(h.args as never, h.deps as never);

    expect(result.restored).toBe(true);
    expect(h.reviewFixCalls).toHaveLength(0);
  });

  test("AC-61: an exhausted rectification is never reviewed", async () => {
    const h = nbfHarness({
      reviewFix: { kind: "pass", reviewed: true, reason: "ok" },
      args: { runRectify: async () => ({ rectificationExhausted: true }) },
    });
    const result = await runNonBlockingFix(h.args as never, h.deps as never);

    expect(result.restored).toBe(true);
    expect(h.reviewFixCalls).toHaveLength(0);
  });

  test("AC-62: without a reviewFix dep a cap-clearing pass is kept", async () => {
    const h = nbfHarness();
    const result = await runNonBlockingFix(h.args as never, h.deps as never);

    expect(h.hasReviewFix).toBe(false);
    expect(result.kept).toBe(true);
    expect(h.measureCalls).toHaveLength(1);
  });

  test("AC-63: a rejected pass logs the verdict kind at info level", async () => {
    const h = nbfHarness({ reviewFix: { kind: "fail", cause: "scope", reason: "r", files: ["a.ts"] } });
    await withLogSpy("info", async (spy) => {
      await runNonBlockingFix(h.args as never, h.deps as never);
      const call = firstCallMatching(spy, "fix review rejected the pass — restoring");
      expect(call).toBeDefined();
      expect(call?.[0]).toBe("non-blocking-fix");
      expect(rec(call?.[2]).kind).toBe("fail");
    });
  });

  test("AC-64: buildNbfDeps omits reviewFix when the call context has no story", async () => {
    const { buildNbfDeps } = await loadNbfDeps();
    expect(typeof buildNbfDeps).toBe("function");
    const ctx = makeCallCtx(DEFAULT_CONFIG, { story: undefined });
    const result = rec((buildNbfDeps as (a: unknown) => unknown)({ ctx, findings: [] }));

    expect(Object.hasOwn(result, "reviewFix")).toBe(false);
    expect(result.reviewFix).toBeUndefined();
  });
});

// ─── US-004 / US-005 — plan-level wiring ──────────────────────────────────

interface PlanHarness {
  ctx: AnyRecord;
  config: AnyRecord;
  cycles: AnyRecord[];
  callOpCalls: { opName: string; input: unknown }[];
  reviewFixCalls: unknown[][];
  setAdversarialOutput(output: unknown): void;
  run(): Promise<void>;
  restore(): void;
}

/** The config a plan runs with: defaults, plus the fix-review/nbf knobs. */
function planConfig(nbf: AnyRecord): AnyRecord {
  const review = {
    ...rec(DEFAULT_CONFIG.review),
    adversarial: {
      ...rec(rec(DEFAULT_CONFIG.review).adversarial),
      model: "balanced",
      diffMode: "ref",
      rules: [],
      timeoutMs: 600_000,
    },
    nonBlockingFix: { regressionAttempts: 1, verifierGuard: false, scope: "both", sources: ["adversarial"], ...nbf },
  };
  return { ...rec(DEFAULT_CONFIG), review };
}

/**
 * Build a three-session plan whose side effects are stubbed at their documented
 * seams, without running it — `run()` drives the real `ExecutionPlan.run`.
 */
async function setupPlanHarness(opts: {
  adversarial: () => unknown;
  nbf: AnyRecord;
  reviewFix: (args: unknown[], ctx: AnyRecord) => unknown | Promise<unknown>;
}): Promise<PlanHarness> {
  const config = planConfig(opts.nbf);
  const restores: (() => void)[] = [];
  const cycles: AnyRecord[] = [];
  const callOpCalls: { opName: string; input: unknown }[] = [];
  const reviewFixCalls: unknown[][] = [];
  let adversarialOutput: () => unknown = opts.adversarial;

  // The wrapped blocking-cycle strategy and the NBF keep gate each reach the
  // runner through the module's own injectable seam. Both are optional so the
  // plan-level ACs work whichever module owns the call.
  const strategySeam = tryInjectableDeps(await loadFixReviewStrategy(), ["runFixReview", "snapshotWorkingTree"]);
  const nbfSeam = tryInjectableDeps(await loadNbfDeps(), ["runFixReview"]);
  if (strategySeam === undefined && nbfSeam === undefined) {
    throw new Error(
      "neither fix-review-strategy nor nbf-deps exposes an injectable seam for runFixReview, so the plan-level " +
        "plumbing cannot be observed (mock.module() is forbidden project-wide)",
    );
  }

  const story = storyFixture({ storyGitRef: "HEAD" });
  const ctx = makeCallCtx(config, { story });
  const record = (args: unknown[]) => {
    reviewFixCalls.push(args);
    return opts.reviewFix(args, ctx);
  };
  if (strategySeam !== undefined) {
    restores.push(
      patch(strategySeam, {
        snapshotWorkingTree: async () => "pre-fix-tree",
        runFixReview: async (...args: unknown[]) => record(args),
      }),
    );
  }
  if (nbfSeam !== undefined && nbfSeam !== strategySeam) {
    restores.push(patch(nbfSeam, { runFixReview: async (...args: unknown[]) => record(args) }));
  }
  restores.push(
    patch(_storyOrchestratorDeps as unknown as AnyRecord, {
      callOp: async (_ctx: unknown, op: { name: string }, input: unknown) => {
        callOpCalls.push({ opName: op.name, input });
        if (op.name === "adversarial-review") return adversarialOutput();
        return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
      },
      runFixCycle: async (cycle: AnyRecord) => {
        cycles.push(cycle);
        return { iterations: [], finalFindings: [], exitReason: "no-strategy", costUsd: 0 };
      },
      captureGitRef: async () => "HEAD",
      captureTreeState: async () => ({ headSha: "acceptance-head", dirtyDigest: "clean" }),
    }),
  );
  // The NBF pass's own source-diff measurement runs `git diff --numstat`; stub
  // its git layer so a plan-level run never spawns against a real (absent) repo.
  restores.push(
    patch(_nonBlockingFixDeps as unknown as AnyRecord, {
      spawn: () => fakeProc(""),
      resolveTestFilePatterns: async () => NO_TEST_PATTERNS,
    }),
  );
  restores.push(
    patch(_rollbackDeps as unknown as AnyRecord, {
      autoCommitIfDirty: async () => {},
      spawn: (() => ({
        stdout: new Response("abc1234\n").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill: () => {},
        pid: 1,
      })) as never,
    }),
  );

  const inputs = {
    story,
    config,
    resolvedTestPatterns: {
      globs: ["test/**/*.test.ts"],
      pathspec: [":(exclude)test/**/*.test.ts"],
      regex: [/\.test\.ts$/],
      testDirs: ["test/unit", "test/integration"],
      resolution: "detected" as const,
    },
    implementer: { story },
    fullSuiteGate: { story, workdir: "/tmp/nax-fix-review-project" },
    verifier: { story },
    adversarialReview: {
      story,
      workdir: "/tmp/nax-fix-review-project",
      adversarialConfig: rec(config.review).adversarial,
      mode: "ref",
    },
    rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
  };
  const plan = await buildPlanForStrategy(
    ctx as never,
    story as never,
    config as never,
    "three-session-tdd",
    inputs as never,
  );

  return {
    ctx,
    config,
    cycles,
    callOpCalls,
    reviewFixCalls,
    setAdversarialOutput: (output) => {
      adversarialOutput = typeof output === "function" ? (output as () => unknown) : () => output;
    },
    run: async () => {
      await plan.run();
    },
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

const ADVISORY_OUTPUT = () => ({
  success: true,
  passed: true,
  advisoryFindings: [
    {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "advisory warning",
      fixTarget: "source",
    },
  ],
});

/** The `FixReviewRequest` handed to the runner, whichever seam carried it. */
function requestOf(args: unknown[]): AnyRecord {
  for (const arg of args) {
    if (isRecord(arg) && arg.preFixTree !== undefined) return arg;
  }
  throw new Error("the fix review was invoked without a request carrying preFixTree");
}

describe("US-004 fix review at the plan's NBF keep gate", () => {
  test("AC-65: a kept NBF pass reviews once with the snapshot sha and the seed findings", async () => {
    const harness = await setupPlanHarness({
      adversarial: ADVISORY_OUTPUT,
      nbf: { enabled: true, scope: "both", sources: ["adversarial"], sourceDiffCap: undefined },
      reviewFix: () => ({ kind: "pass", reviewed: true, reason: "ok" }),
    });
    try {
      await harness.run();

      expect(harness.reviewFixCalls).toHaveLength(1);
      const request = requestOf(harness.reviewFixCalls[0]);
      // The NBF snapshot sha is whatever `captureSnapshotRef` returned: the
      // seeded git stub above reports "abc1234".
      expect(request.preFixTree).toBe("abc1234");
      expect(request.findings).toEqual([
        expect.objectContaining({ source: "adversarial-review", message: "advisory warning" }),
      ]);
    } finally {
      harness.restore();
    }
  });

  test("AC-66: a kept NBF pass emits exactly one review-decision event with reviewer 'fix'", async () => {
    const events: AnyRecord[] = [];
    const harness = await setupPlanHarness({
      adversarial: ADVISORY_OUTPUT,
      nbf: { enabled: true, scope: "both", sources: ["adversarial"], sourceDiffCap: undefined },
      reviewFix: async (args, ctx) => {
        // Only the agent's answer is stubbed; the op, the runner and the
        // review-decision emission all run for real.
        const { runFixReview } = await loadFixReviewRun();
        const real = runFixReview as (c: unknown, r: unknown, d: unknown) => Promise<unknown>;
        return real(ctx, requestOf(args), {
          snapshotWorkingTree: async () => "post-fix-tree",
          changedPathsBetween: async () => [".nax/cache.json"],
          diffBetween: async () => "diff --git a/src/a.ts b/src/a.ts\n+export const a = 2;\n",
          callOp: async () => ({ parsed: true, passed: true, reason: "ok" }),
          resolveTestFilePatterns: async () => NO_TEST_PATTERNS,
          emitReviewDecision,
        });
      },
    });
    try {
      const bus = rec(harness.ctx.runtime).dispatchEvents as DispatchEventBus;
      bus.onReviewDecision((event) => events.push(rec(event)));

      await harness.run();

      const fixEvents = events.filter((event) => event.reviewer === "fix");
      expect(fixEvents).toHaveLength(1);
    } finally {
      harness.restore();
    }
  });
});

// ─── US-005 — dispatch hook and findings ──────────────────────────────────

const FAKE_STRATEGY_OP = { name: "fake-fix-op", kind: "run" };

function fakeStrategy(over: AnyRecord = {}): AnyRecord {
  return {
    name: "autofix-test-writer",
    appliesTo: () => true,
    fixOp: FAKE_STRATEGY_OP,
    buildInput: (findings: unknown[]) => ({ findings }),
    maxAttempts: 1,
    ...over,
  };
}

async function dispatchOnce(
  strategy: AnyRecord,
  findings: unknown[],
  over: { ctx?: AnyRecord; callOp?: unknown } = {},
): Promise<unknown> {
  const ctx = over.ctx ?? makeFixCtx();
  return dispatchStrategy(strategy as never, ctx as never, findings as never, [], {
    callOp: (over.callOp ?? (async () => ({ success: true }))) as never,
    dispatchCallId: "call-1",
    logger: null,
    logCtx: { storyId: "US-001", cycleName: "acceptance" },
  });
}

describe("US-005 dispatchStrategy hook", () => {
  test("AC-67: beforeDispatch is awaited before callOp runs", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const strategy = fakeStrategy({
      beforeDispatch: async () => {
        order.push("beforeDispatch");
        await gate;
        order.push("beforeDispatch:resolved");
      },
    });
    let callOpRuns = 0;
    const callOp = async () => {
      callOpRuns += 1;
      order.push("callOp");
      return { success: true };
    };

    const pending = dispatchOnce(strategy, [], { callOp });
    await Bun.sleep(20);
    expect(order).toEqual(["beforeDispatch"]);
    expect(callOpRuns).toBe(0);

    release();
    await pending;
    expect(order).toEqual(["beforeDispatch", "beforeDispatch:resolved", "callOp"]);
    expect(callOpRuns).toBe(1);
  });

  test("AC-68: a strategy without beforeDispatch still dispatches exactly once", async () => {
    const strategy = fakeStrategy();
    expect(Object.hasOwn(strategy, "beforeDispatch")).toBe(false);

    let callOpRuns = 0;
    const result = await dispatchOnce(strategy, [], {
      callOp: async () => {
        callOpRuns += 1;
        return { success: true };
      },
    });

    expect(callOpRuns).toBe(1);
    expect(rec(result).strategyName).toBe("autofix-test-writer");
  });
});

describe("US-005 toFixReviewFinding", () => {
  async function toFinding(verdict: AnyRecord): Promise<AnyRecord> {
    const { toFixReviewFinding } = await loadFixReviewStrategy();
    const convert = toFixReviewFinding as (v: unknown) => unknown;
    expect(typeof convert).toBe("function");
    return rec(convert(verdict));
  }

  test("AC-69: a contradiction anchored at AC 3 becomes rule 'fix-review:AC-3'", async () => {
    const finding = await toFinding({ kind: "fail", cause: "contradiction", acIndex: 3, reason: "r" });
    expect(finding.rule).toBe("fix-review:AC-3");
  });

  test("AC-70: the verdict's file is carried onto the finding", async () => {
    const finding = await toFinding({
      kind: "fail",
      cause: "contradiction",
      acIndex: 1,
      reason: "r",
      file: "test/a.test.ts",
    });
    expect(finding.file).toBe("test/a.test.ts");
  });

  test("AC-71: fix-review findings are reported as semantic-review findings", async () => {
    const finding = await toFinding({ kind: "fail", cause: "contradiction", acIndex: 2, reason: "r" });
    expect(finding.source).toBe("semantic-review");
  });

  test("AC-72: fix-review findings target the test lane", async () => {
    const finding = await toFinding({ kind: "fail", cause: "contradiction", acIndex: 2, reason: "r" });
    expect(finding.fixTarget).toBe("test");
  });

  test("AC-73: findingsToFailedChecks maps a fix-review finding to the semantic check", async () => {
    const finding = await toFinding({ kind: "fail", cause: "contradiction", acIndex: 2, reason: "r" });
    const checks = findingsToFailedChecks([finding] as never);
    expect(checks).toHaveLength(1);
    expect(checks[0].check).toBe("semantic");
  });
});

// ─── US-005 — the wrapped strategy ────────────────────────────────────────

interface WrapperHarness {
  wrapper: AnyRecord;
  strategy: AnyRecord;
  runFixReviewCalls: unknown[][];
  snapshotCalls: number;
  restore(): void;
}

async function setupWrapper(
  reviewResult: unknown | ((args: unknown[]) => Promise<unknown>),
  over: { snapshotRejects?: boolean } = {},
): Promise<WrapperHarness> {
  const mod = await loadFixReviewStrategy();
  const seam = injectableDeps(mod, ["runFixReview", "snapshotWorkingTree"]);
  const runFixReviewCalls: unknown[][] = [];
  let snapshotCalls = 0;
  const restore = patch(seam, {
    snapshotWorkingTree: async () => {
      snapshotCalls += 1;
      if (over.snapshotRejects) throw new NaxError("git failed", "FIX_REVIEW_GIT_FAILED");
      return "pre-fix-tree";
    },
    runFixReview: async (...args: unknown[]) => {
      runFixReviewCalls.push(args);
      return typeof reviewResult === "function"
        ? await (reviewResult as (args: unknown[]) => Promise<unknown>)(args)
        : reviewResult;
    },
  });

  const createWrapper = mod.createFixReviewWrapper as (a: unknown) => unknown;
  expect(typeof createWrapper).toBe("function");
  const wrapper = rec(
    createWrapper({
      ctx: makeLightCtx(),
      story: storyFixture(),
      config: reviewConfig(),
    }),
  );
  const wrap = wrapper.wrap as (s: unknown) => unknown;
  expect(typeof wrap).toBe("function");
  const strategy = rec(wrap(fakeStrategy()));
  return {
    wrapper,
    strategy,
    runFixReviewCalls,
    get snapshotCalls() {
      return snapshotCalls;
    },
    restore,
  };
}

function drained(wrapper: AnyRecord): unknown[] {
  const drain = wrapper.drainFindings;
  if (typeof drain !== "function") throw new Error("the wrapper must expose drainFindings()");
  return (drain as () => unknown[]).call(wrapper);
}

describe("US-005 wrapped strategy", () => {
  test("AC-74: an AC-anchored contradiction is queued once and drained", async () => {
    const h = await setupWrapper({ kind: "fail", cause: "contradiction", acIndex: 2, reason: "r" });
    try {
      await dispatchOnce(h.strategy, [findingFixture({ message: "seed" })]);

      const findings = drained(h.wrapper);
      expect(findings).toHaveLength(1);
      expect(rec(findings[0]).source).toBe("semantic-review");
      expect(rec(findings[0]).rule).toBe("fix-review:AC-2");
      expect(drained(h.wrapper)).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test("AC-75: a scope fail is not fed back and warns", async () => {
    await withLogSpy("warn", async (spy) => {
      const h = await setupWrapper({ kind: "fail", cause: "scope", reason: "r", files: ["a.ts"] });
      try {
        await dispatchOnce(h.strategy, []);
        expect(drained(h.wrapper)).toEqual([]);
        const call = firstCallMatching(spy, "fix review non-pass not fed back");
        expect(call).toBeDefined();
        expect(call?.[0]).toBe("fix-review");
        expect(rec(call?.[2]).cause).toBe("scope");
      } finally {
        h.restore();
      }
    });
  });

  test("AC-76: a contradiction with no acIndex is not fed back and warns", async () => {
    await withLogSpy("warn", async (spy) => {
      const h = await setupWrapper({ kind: "fail", cause: "contradiction", reason: "r" });
      try {
        await dispatchOnce(h.strategy, []);
        expect(drained(h.wrapper)).toEqual([]);
        const call = firstCallMatching(spy, "fix review non-pass not fed back");
        expect(call).toBeDefined();
        expect(call?.[0]).toBe("fix-review");
        expect(rec(call?.[2]).cause).toBe("contradiction");
      } finally {
        h.restore();
      }
    });
  });

  test("AC-77: a pass is not fed back and warns nothing", async () => {
    await withLogSpy("warn", async (spy) => {
      const h = await setupWrapper({ kind: "pass", reviewed: true, reason: "ok" });
      try {
        await dispatchOnce(h.strategy, []);
        expect(drained(h.wrapper)).toEqual([]);
        expect(firstCallMatching(spy, "fix review non-pass not fed back")).toBeUndefined();
      } finally {
        h.restore();
      }
    });
  });

  test("AC-78: an error verdict is not fed back and warns", async () => {
    await withLogSpy("warn", async (spy) => {
      const h = await setupWrapper({ kind: "error", cause: "test-error", reason: "r" });
      try {
        await dispatchOnce(h.strategy, []);
        expect(drained(h.wrapper)).toEqual([]);
        const call = firstCallMatching(spy, "fix review non-pass not fed back");
        expect(call).toBeDefined();
        expect(call?.[0]).toBe("fix-review");
        expect(rec(call?.[2]).cause).toBe("error");
      } finally {
        h.restore();
      }
    });
  });

  test("AC-79: a failing snapshot skips the review for that dispatch", async () => {
    const h = await setupWrapper({ kind: "pass", reviewed: true, reason: "ok" }, { snapshotRejects: true });
    try {
      const ctx = makeFixCtx();
      await (h.strategy.beforeDispatch as (c: unknown) => Promise<void>)(ctx);
      await (h.strategy.extractApplied as (o: unknown, i: unknown) => Promise<unknown>)({ success: true }, {
        findings: [],
      });

      expect(h.snapshotCalls).toBe(1);
      expect(h.runFixReviewCalls).toHaveLength(0);
      expect(drained(h.wrapper)).toEqual([]);
    } finally {
      h.restore();
    }
  });

  test("AC-80: the review receives the findings buildInput was given", async () => {
    const h = await setupWrapper({ kind: "pass", reviewed: true, reason: "ok" });
    try {
      const seed = [
        findingFixture({ source: "adversarial-review", severity: "error", category: "test-gap", message: "F1" }),
      ];
      const ctx = makeFixCtx();
      const input = (h.strategy.buildInput as (f: unknown[], i: unknown[], c: unknown) => unknown)(seed, [], ctx);
      await (h.strategy.beforeDispatch as (c: unknown) => Promise<void>)(ctx);
      await (h.strategy.extractApplied as (o: unknown, i: unknown) => Promise<unknown>)({ success: true }, input);

      expect(h.runFixReviewCalls).toHaveLength(1);
      const request = rec(h.runFixReviewCalls[0].find((arg) => isRecord(arg) && Array.isArray(arg.findings)));
      expect(request.findings).toEqual(seed);
    } finally {
      h.restore();
    }
  });
});

// ─── US-005 — plan-level wiring ───────────────────────────────────────────

describe("US-005 plan-level wiring", () => {
  test("AC-81: an AC-anchored contradiction reaches the next autofix-test-writer dispatch", async () => {
    const harness = await setupPlanHarness({
      adversarial: () => ({
        success: false,
        passed: false,
        normalizedFindings: [
          {
            source: "adversarial-review",
            severity: "error",
            category: "test-gap",
            message: "missing coverage",
            fixTarget: "test",
          },
        ],
      }),
      nbf: { enabled: false },
      reviewFix: () => ({
        kind: "fail",
        cause: "contradiction",
        acIndex: 2,
        reason: "drops the AC-2 assertion",
      }),
    });
    try {
      await harness.run();
      // The revalidation sweep must not re-introduce the blocking finding, so the
      // drained fix-review finding is the only thing the next iteration adds.
      harness.setAdversarialOutput({ success: true });

      const cycle = harness.cycles.find((candidate) =>
        (candidate.strategies as AnyRecord[]).some((strategy) => strategy.name === "autofix-test-writer"),
      );
      expect(cycle).toBeDefined();
      const strategy = (rec(cycle).strategies as AnyRecord[]).find(
        (candidate) => candidate.name === "autofix-test-writer",
      );
      expect(strategy).toBeDefined();

      const fixCtx = { ...harness.ctx, storyId: "US-001" };
      const dispatchedInputs: AnyRecord[] = [];
      const recordingCallOp = async (_ctx: unknown, op: { name: string }, input: unknown) => {
        if (op.name === rec(strategy).fixOp.name) dispatchedInputs.push(rec(input));
        return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
      };

      let findings: unknown[] = [
        {
          source: "adversarial-review",
          severity: "error",
          category: "test-gap",
          message: "missing coverage",
          fixTarget: "test",
        },
      ];
      for (let iteration = 0; iteration < 2; iteration += 1) {
        await dispatchStrategy(strategy as never, fixCtx as never, findings as never, [], {
          callOp: recordingCallOp as never,
          dispatchCallId: `acceptance-${iteration}`,
          logger: null,
          logCtx: { storyId: "US-001", cycleName: "acceptance" },
        });
        const validated = await (rec(cycle).validate as (c: unknown, o: unknown) => Promise<unknown>)(fixCtx, {
          mode: "full",
          strategiesRun: ["autofix-test-writer"],
        });
        findings = Array.isArray(validated) ? validated : rec(validated).findings;
      }

      expect(dispatchedInputs.length).toBeGreaterThanOrEqual(2);
      const secondMessages = ((dispatchedInputs[1].failedChecks as AnyRecord[] | undefined) ?? []).flatMap(
        (check) => ((check.findings as AnyRecord[] | undefined) ?? []).map((finding) => finding.message),
      );
      expect(secondMessages).toContain("drops the AC-2 assertion");
    } finally {
      harness.restore();
    }
  });

  test("AC-82: with NBF enabled the review runs once, at the keep gate only", async () => {
    const harness = await setupPlanHarness({
      adversarial: ADVISORY_OUTPUT,
      nbf: { enabled: true, scope: "both", sources: ["adversarial"], sourceDiffCap: undefined },
      reviewFix: () => ({ kind: "pass", reviewed: true, reason: "ok" }),
    });
    try {
      await harness.run();
      expect(harness.reviewFixCalls).toHaveLength(1);

      const nbfCycle = harness.cycles.at(-1);
      expect(nbfCycle).toBeDefined();
      const strategy = (rec(nbfCycle).strategies as AnyRecord[]).find(
        (candidate) => candidate.name === "autofix-test-writer",
      );
      expect(strategy).toBeDefined();

      // Driving the NBF pass's own autofix-test-writer dispatch must not review:
      // the NBF strategy list is deliberately left unwrapped.
      await dispatchOnce(strategy as AnyRecord, [
        findingFixture({ source: "adversarial-review", severity: "warning", message: "advisory warning" }),
      ]);

      expect(harness.reviewFixCalls).toHaveLength(1);
    } finally {
      harness.restore();
    }
  });
});
