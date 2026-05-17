/**
 * ADR-022 Phase 7 — runAgentRectificationV2
 *
 * Drives the autofix cycle using runFixCycle with two co-run-sequential strategies:
 *   - autofix-implementer: source-targeted findings (maxAttempts from config)
 *   - autofix-test-writer: test-targeted findings (maxAttempts 1)
 *
 * Shadow mode writes divergence snapshots for comparison with legacy routing.
 *
 * Known V2 limitations (tracked for future iterations):
 *   - lintFixCmd / formatFixCmd mechanical shortcuts are not run before agent sessions.
 *     Legacy ran these cheaply (~77ms) to avoid full agent sessions for auto-fixable lint.
 *   - cost telemetry returns 0 — agent cost is not surfaced from op output type yet.
 *   - recheckReview is called unconditionally, skipping the no-op diff optimisation
 *     the legacy path uses to avoid re-running LLM-driven review on unchanged diffs.
 *
 * scope: repo-scoped (closes over outer PipelineContext for recheckReview + config).
 */

import { join } from "node:path";
import type { AutofixConfig } from "@/config/selectors";
import type { Finding, FixCycle, FixCycleContext, FixCycleResult, FixStrategy } from "@/findings";
import { runFixCycle } from "@/findings";
import { getLogger } from "@/logger";
import { type TestEditDeclaration, implementerRectifyOp, testWriterRectifyOp, validatePrdQuote } from "@/operations";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "@/operations";
import type { AutofixTestWriterInput } from "@/operations";
import type { UserStory } from "@/prd";
import type { ReviewCheckResult } from "@/review/types";
import { type ResolvedTestPatterns, resolveTestFilePatterns } from "@/test-runners";
import { captureGitRef } from "@/utils/git";
import type { PipelineContext } from "../types";
import { _autofixDeps } from "./autofix";
import { assertionSiteDiffCheck, revertDiff, runIsolationGuard } from "./autofix-guards";

// ─── Context conversion ───────────────────────────────────────────────────────

function fixCallCtx(ctx: PipelineContext): FixCycleContext {
  const packageView = ctx.packageView ?? ctx.runtime.packages.repo();
  return {
    runtime: ctx.runtime,
    packageView,
    packageDir: ctx.workdir,
    storyId: ctx.story.id,
    featureName: ctx.prd.feature,
    agentName: ctx.agentManager.getDefault(),
    story: ctx.story,
  };
}

// ─── Finding collection ───────────────────────────────────────────────────────

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

/**
 * Collect structured findings from the current review result.
 * Synthesizes one finding per check for mechanical checks without structured findings
 * so the cycle has something to act on even when findings[] is unpopulated.
 */
function collectCurrentFindings(ctx: PipelineContext): Finding[] {
  const checks = collectFailedChecks(ctx);
  if (checks.length === 0) return [];

  return checks.flatMap((c): Finding[] => {
    if (c.findings?.length) return c.findings;
    // Synthesize a minimal finding for mechanical checks without structured output
    return [
      {
        source: c.check === "adversarial" ? "adversarial-review" : c.check === "semantic" ? "semantic-review" : "lint",
        severity: "error",
        category: c.check,
        message: (c.output ?? c.check).slice(0, 200),
        fixTarget: "source",
      },
    ];
  });
}

function collectTestTargetedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return collectFailedChecks(ctx)
    .map((c) => ({ ...c, findings: (c.findings ?? []).filter((f) => f.fixTarget === "test") }))
    .filter((c) => c.findings.length > 0);
}

function collectAdversarialSourceChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return collectFailedChecks(ctx)
    .map((c) => ({
      ...c,
      findings: (c.findings ?? []).filter(
        (f) => (f.fixTarget ?? "source") === "source" && f.severity === "error" && f.source === "adversarial-review",
      ),
    }))
    .filter((c) => c.check === "adversarial" && c.findings.length > 0);
}

// ─── Strategies ───────────────────────────────────────────────────────────────

export function buildAutofixStrategies(
  ctx: PipelineContext,
  maxAttempts: number,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to cycle layer
): FixStrategy<Finding, any, any, AutofixConfig>[] {
  const implementer: FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> = {
    name: "autofix-implementer",
    // Exclude prd_quote_mismatch advisories: they are diagnostic only and should not
    // trigger another implementer session.
    appliesTo: (f) => (f.fixTarget ?? "source") === "source" && f.category !== "prd_quote_mismatch",
    fixOp: implementerRectifyOp,
    maxAttempts,
    coRun: "co-run-sequential",
    buildInput: (_findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: collectFailedChecks(ctx),
      story: ctx.story,
    }),
    extractApplied: (output) => {
      const decls = output.testEditDeclarations ?? [];
      if (decls.length > 0) {
        ctx.testEditDeclarations = [...(ctx.testEditDeclarations ?? []), ...decls];
      }
      return {
        summary: output.unresolvedReason ?? "",
        unresolved: output.unresolvedReason,
      };
    },
  };

  const testWriter: FixStrategy<Finding, AutofixTestWriterInput, { applied: true }, AutofixConfig> = {
    name: "autofix-test-writer",
    appliesTo: (f) => f.fixTarget === "test",
    fixOp: testWriterRectifyOp,
    maxAttempts: 2,
    coRun: "co-run-sequential",
    buildInput: (findings, _prior, _cycleCtx): AutofixTestWriterInput => {
      // Branch 1: synthetic implementer-handoff findings present (mock_structure path).
      const handoffFindings = findings.filter(
        (f) => f.source === "implementer-handoff" && f.category === "test_mock_restructure",
      );
      if (handoffFindings.length > 0) {
        const handoffFiles = [...new Set(handoffFindings.map((f) => f.file).filter((f): f is string => f != null))];
        const handoffs = ctx.pendingMockStructureHandoffs ?? [];
        const handoffReason = handoffs.map((h) => h.reasonDetail).join("\n\n---\n\n");
        // Clear side-channel after consumption — one-shot per spec US-004 AC #3.
        ctx.pendingMockStructureHandoffs = [];
        return {
          failedChecks: collectFailedChecks(ctx),
          story: ctx.story,
          mode: "mock-restructure",
          handoffFiles,
          handoffReason,
          blockingThreshold: ctx.config.review?.blockingThreshold,
        };
      }
      // Existing branches unchanged below this point.
      const hasSourceBug = findings.some(
        (f) => (f.fixTarget ?? "source") === "source" && f.source === "adversarial-review",
      );
      if (hasSourceBug) {
        return {
          failedChecks: collectAdversarialSourceChecks(ctx),
          story: ctx.story,
          mode: "write-failing-test",
          blockingThreshold: ctx.config.review?.blockingThreshold,
        };
      }
      return {
        failedChecks: collectTestTargetedChecks(ctx),
        story: ctx.story,
        blockingThreshold: ctx.config.review?.blockingThreshold,
      };
    },
  };

  // D2: test-writer runs before implementer (TDD order) — test-writer writes the failing
  // test first, then implementer makes it pass. Both run co-run-sequential in the same iteration.
  return [testWriter, implementer];
}

// ─── Capacity prediction ──────────────────────────────────────────────────────

/**
 * Predicts whether the next runFixCycle call would exit immediately at one of its
 * cap precheckers (max-attempts-per-strategy or max-attempts-total) given the
 * current ctx.autofixPriorIterations and current failing findings.
 *
 * Used by autofix.ts to short-circuit a partial-progress retry when re-running
 * review would only feed an already-exhausted autofix cycle — wasting LLM tokens
 * on adversarial / semantic checks that cannot lead to a fix this run.
 *
 * Mirrors the cap logic in cycle.ts:180–219:
 *   - any active strategy at its per-strategy cap → exhausted
 *   - total prior fixesApplied at maxAttemptsTotal → exhausted
 *   - no strategy matches the current findings    → exhausted (no-strategy)
 */
export function autofixCapacityExhausted(ctx: PipelineContext): boolean {
  const findings = collectCurrentFindings(ctx);
  if (findings.length === 0) return false;

  const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 3;
  const maxTotal = ctx.config.quality.autofix?.maxTotalAttempts ?? 12;
  const prior = ctx.autofixPriorIterations ?? [];

  const totalUsed = prior.reduce((sum, iter) => sum + iter.fixesApplied.length, 0);
  if (totalUsed >= maxTotal) return true;

  const strategies = buildAutofixStrategies(ctx, maxAttempts);
  const active = strategies.filter((s) => findings.some((f) => s.appliesTo(f)));
  if (active.length === 0) return true;

  return active.some((s) => {
    const used = prior.reduce(
      (sum, iter) => sum + iter.fixesApplied.filter((fa) => fa.strategyName === s.name).length,
      0,
    );
    return used >= s.maxAttempts;
  });
}

// ─── Escalation digest ───────────────────────────────────────────────────────

function buildEscalationDigest(findings: Finding[]): string {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const file = f.file ?? "unknown";
    const list = byFile.get(file) ?? [];
    list.push(f);
    byFile.set(file, list);
  }
  const lines = [...byFile.entries()].map(([file, fs]) => {
    const categories = fs.map((f) => f.category ?? f.source).join(", ");
    return `  - ${categories} in ${file}`;
  });
  return `Autofix exhausted: ${findings.length} finding${findings.length !== 1 ? "s" : ""} remain\n${lines.join("\n")}`;
}

// ─── Shadow mode ──────────────────────────────────────────────────────────────

interface ShadowReport {
  storyId: string;
  timestamp: string;
  initialFindingsCount: number;
  exitReason: FixCycleResult<Finding>["exitReason"];
  iterations: number;
  finalFindingsCount: number;
  exhaustedStrategy?: string;
}

async function writeShadowReport(
  ctx: PipelineContext,
  result: FixCycleResult<Finding>,
  initialFindingsCount: number,
): Promise<void> {
  const logger = getLogger();
  const shadowDir = join(ctx.runtime.outputDir, "cycle-shadow", ctx.story.id);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: ShadowReport = {
    storyId: ctx.story.id,
    timestamp,
    initialFindingsCount,
    exitReason: result.exitReason,
    iterations: result.iterations.length,
    finalFindingsCount: result.finalFindings.length,
    ...(result.exhaustedStrategy ? { exhaustedStrategy: result.exhaustedStrategy } : {}),
  };
  try {
    const file = join(shadowDir, `${timestamp}.json`);
    await Bun.write(file, JSON.stringify(report, null, 2));
  } catch (err) {
    logger.debug("autofix-cycle", "Shadow report write failed (non-fatal)", {
      storyId: ctx.story.id,
      error: String(err),
    });
  }
}

// ─── Mock structure validation ────────────────────────────────────────────────

/** Injectable dependencies for file I/O in validateMockStructureFiles. */
export const _autofixCycleDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
};

/** Injectable dependencies for guard checks in runAgentRectificationV2. */
export const _autofixCycleGuardDeps = {
  captureGitRef,
  assertionSiteDiffCheck,
  runIsolationGuard,
  revertDiff,
};

/**
 * Async validator for mock_structure declarations.
 *
 * Partitions declarations into { valid, invalid }:
 * - valid: non-mock_structure declarations (pass-through) + mock_structure with all paths existing and classified as test files
 * - invalid: mock_structure declarations with missing/non-test paths, tagged with missing and nonTest arrays
 */
export async function validateMockStructureFiles(
  decls: TestEditDeclaration[],
  workdir: string,
  resolved: ResolvedTestPatterns,
): Promise<{
  valid: TestEditDeclaration[];
  invalid: Array<{ decl: TestEditDeclaration; missing: string[]; nonTest: string[] }>;
}> {
  const valid: TestEditDeclaration[] = [];
  const invalid: Array<{ decl: TestEditDeclaration; missing: string[]; nonTest: string[] }> = [];

  for (const decl of decls) {
    if (decl.reason !== "mock_structure") {
      valid.push(decl);
      continue;
    }

    const files = decl.files ?? [];
    // Defensive: empty FILES is structurally invalid even if the parser dropped the block.
    if (files.length === 0) {
      invalid.push({ decl, missing: [], nonTest: [] });
      continue;
    }

    const missing: string[] = [];
    const nonTest: string[] = [];

    for (const filePath of files) {
      const absPath = join(workdir, filePath);
      const exists = await _autofixCycleDeps.fileExists(absPath);
      if (!exists) {
        missing.push(filePath);
        continue;
      }
      const isTest = resolved.regex.some((re) => re.test(filePath));
      if (!isTest) {
        nonTest.push(filePath);
      }
    }

    if (missing.length === 0 && nonTest.length === 0) {
      valid.push(decl);
    } else {
      invalid.push({ decl, missing, nonTest });
    }
  }

  return { valid, invalid };
}

// ─── Declaration application ──────────────────────────────────────────────────

/**
 * Apply implementer-emitted TEST_EDIT_REASON declarations to fresh findings.
 *
 * For each `prd_contract` declaration:
 *   - If PRD_QUOTE is fabricated (not in story text), append a `prd_quote_mismatch`
 *     advisory finding so the misuse is visible without escalating.
 *   - Otherwise, re-tag any finding whose file matches FILE: change fixTarget
 *     from "source" to "test" so the testWriter strategy claims it next iteration.
 *
 * For each `mock_structure` declaration (valid):
 *   - Append one synthetic finding per path in `decl.files` with source="implementer-handoff",
 *     severity="error", category="test_mock_restructure", fixTarget="test".
 *
 * For each `mock_structure` declaration (invalid):
 *   - Append one advisory finding with category="mock_structure_invalid_files",
 *     severity="warning", listing missing/non-test paths in message.
 *
 * `lint_only` and `sibling_scope` declarations are passthrough (parsed for
 * telemetry but not routed by this function).
 *
 * Pure — does not mutate input arrays. Returns a new array.
 */
export function applyTestEditDeclarations(
  findings: Finding[],
  declarations: TestEditDeclaration[],
  story: UserStory,
  invalidMockStructure?: Array<{ decl: TestEditDeclaration; missing: string[]; nonTest: string[] }>,
): Finding[] {
  if (declarations.length === 0 && (!invalidMockStructure || invalidMockStructure.length === 0)) return findings;

  const out: Finding[] = [...findings];
  const originalLength = findings.length;
  const reTaggedKeys = new Set<number>();

  for (const decl of declarations) {
    if (decl.reason === "prd_contract") {
      if (!validatePrdQuote(decl.prdQuote ?? "", story)) {
        out.push({
          source: "adversarial-review",
          severity: "warning",
          category: "prd_quote_mismatch",
          message: `Implementer declared TEST_EDIT_REASON: prd_contract with PRD_QUOTE not found in story description or AC text: ${decl.prdQuote}`,
          file: decl.file,
          fixTarget: "source",
        });
        continue;
      }

      // Only iterate original findings — not advisory findings appended earlier in this loop.
      for (let i = 0; i < originalLength; i++) {
        if (reTaggedKeys.has(i)) continue;
        if (out[i].file !== decl.file) continue;
        if ((out[i].fixTarget ?? "source") === "test") continue;
        out[i] = {
          ...out[i],
          fixTarget: "test",
          meta: {
            ...(out[i].meta ?? {}),
            prdContractDeclaration: {
              prdQuote: decl.prdQuote,
              testBefore: decl.testBefore,
              testAfter: decl.testAfter,
            },
          },
        };
        reTaggedKeys.add(i);
      }
    } else if (decl.reason === "mock_structure") {
      // Generate one synthetic finding per path for valid mock_structure declarations.
      if (decl.files) {
        for (const file of decl.files) {
          out.push({
            source: "implementer-handoff",
            severity: "error",
            category: "test_mock_restructure",
            message: "Restructure mocks per implementer handoff",
            file,
            fixTarget: "test",
          });
        }
      }
    }
  }

  // Advisory findings for invalid mock_structure declarations (from validateMockStructureFiles).
  for (const { decl, missing, nonTest } of invalidMockStructure ?? []) {
    const offendingPaths = [...missing, ...nonTest];
    out.push({
      source: "implementer-handoff",
      severity: "warning",
      category: "mock_structure_invalid_files",
      message: `mock_structure declaration refers to missing or non-test paths: ${offendingPaths.join(", ")}`,
      file: decl.file,
      fixTarget: "source",
    });
  }

  return out;
}

// ─── V2 entry point ───────────────────────────────────────────────────────────

/**
 * V2 autofix via runFixCycle. Mirrors the return contract of runAgentRectification.
 */
export async function runAgentRectificationV2(
  ctx: PipelineContext,
  _lintFixCmd: string | undefined,
  _formatFixCmd: string | undefined,
  _effectiveWorkdir: string,
): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string; escalationDigest?: string }> {
  const logger = getLogger();
  const storyId = ctx.story.id;

  const cycleCtx = fixCallCtx(ctx);
  const initialFindings = collectCurrentFindings(ctx);
  const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 3;
  const maxTotalAttempts = ctx.config.quality.autofix?.maxTotalAttempts ?? 12;

  logger.info("autofix-cycle", "Starting V2 fix cycle", {
    storyId,
    initialFindingsCount: initialFindings.length,
    maxAttempts,
    maxTotalAttempts,
  });

  // Capture HEAD before any test-writer op commits, so guards can diff against it.
  let iterationBeforeRef: string | undefined = await _autofixCycleGuardDeps.captureGitRef(ctx.workdir);

  const strategies = buildAutofixStrategies(ctx, maxAttempts);

  // Patch testWriter's extractApplied to run safety guards in mock-restructure mode.
  const twStrategy = strategies.find((s) => s.name === "autofix-test-writer");
  if (twStrategy) {
    twStrategy.extractApplied = async (_output: unknown, input: AutofixTestWriterInput) => {
      if (input.mode !== "mock-restructure" || !iterationBeforeRef || !input.handoffFiles?.length) {
        return {};
      }
      const handoffFiles = input.handoffFiles;
      const beforeRef = iterationBeforeRef;

      const assertionResult = await _autofixCycleGuardDeps.assertionSiteDiffCheck(ctx.workdir, beforeRef, handoffFiles);
      if (assertionResult.violated) {
        await _autofixCycleGuardDeps.revertDiff(ctx.workdir, handoffFiles);
        logger.info("autofix-cycle", "assertion-site guard violated — reverted", {
          storyId,
          file: assertionResult.file,
          line: assertionResult.line,
        });
        return { unresolved: `assertion_weakening:${assertionResult.file}:${assertionResult.line}` };
      }

      const isolationResult = await _autofixCycleGuardDeps.runIsolationGuard(
        ctx.workdir,
        beforeRef,
        ctx.config,
        ctx.story.workdir || undefined,
      );
      if (isolationResult.violated) {
        await _autofixCycleGuardDeps.revertDiff(ctx.workdir, isolationResult.files);
        logger.info("autofix-cycle", "test-writer isolation guard violated — reverted", {
          storyId,
          files: isolationResult.files,
        });
        return { unresolved: `test_writer_isolation_violation:${isolationResult.files.join(",")}` };
      }

      return {};
    };
  }

  const cycle: FixCycle<Finding> = {
    findings: initialFindings,
    iterations: [...(ctx.autofixPriorIterations ?? [])],
    strategies,
    config: {
      maxAttemptsTotal: maxTotalAttempts,
      validatorRetries: 1,
    },
    async validate(_cycleCtx: FixCycleContext, _opts: { mode: "full" | "lite" }): Promise<Finding[]> {
      // Update beforeRef after all strategies in this iteration have committed.
      iterationBeforeRef = (await _autofixCycleGuardDeps.captureGitRef(ctx.workdir)) ?? iterationBeforeRef;
      // recheckReview mutates ctx.reviewResult; subsequent buildInput reads fresh state
      await _autofixDeps.recheckReview(ctx);
      const fresh = collectCurrentFindings(ctx);
      const pending = ctx.testEditDeclarations ?? [];
      if (pending.length === 0) return fresh;

      // Partition mock_structure declarations via async validator.
      const resolved = await resolveTestFilePatterns(ctx.config, ctx.workdir, ctx.story.workdir || undefined);
      const { valid, invalid } = await validateMockStructureFiles(pending, ctx.workdir, resolved);

      // Stash valid mock_structure handoffs for the TDD orchestrator before applying.
      const validMockStructure = valid.filter((d) => d.reason === "mock_structure");
      if (validMockStructure.length > 0) {
        ctx.pendingMockStructureHandoffs = [
          ...(ctx.pendingMockStructureHandoffs ?? []),
          ...validMockStructure.map((d) => ({
            files: d.files ?? [],
            reasonDetail: d.reasonDetail ?? "",
          })),
        ];
      }

      const retagged = applyTestEditDeclarations(fresh, valid, ctx.story, invalid);
      // Clear side-channel after consumption so the next iteration starts fresh.
      ctx.testEditDeclarations = [];
      logger.info("autofix-cycle", "applied test-edit declarations", {
        storyId: ctx.story.id,
        declarationCount: pending.length,
        reTaggedCount:
          retagged.filter((f) => f.fixTarget === "test").length - fresh.filter((f) => f.fixTarget === "test").length,
      });
      return retagged;
    },
  };

  const result = await runFixCycle(cycle, cycleCtx, "autofix-v2");

  // Persist iterations for next pipeline retry
  ctx.autofixPriorIterations = result.iterations;

  await writeShadowReport(ctx, result, initialFindings.length);

  // Surface unresolvedReason only when the agent explicitly gave up mid-cycle.
  // Cap-exhausted exits ("max-attempts-per-strategy") use the escalation digest path instead.
  const unresolvedReason = result.exitReason === "agent-gave-up" ? result.unresolvedDetail : undefined;
  const escalationDigest =
    result.exitReason === "max-attempts-per-strategy" && result.finalFindings.length > 0
      ? buildEscalationDigest(result.finalFindings)
      : undefined;
  const succeeded = result.exitReason === "resolved" || result.finalFindings.length === 0;

  logger.info("autofix-cycle", "V2 fix cycle complete", {
    storyId,
    exitReason: result.exitReason,
    iterations: result.iterations.length,
    finalFindingsCount: result.finalFindings.length,
    succeeded,
    ...(unresolvedReason ? { unresolvedReason } : {}),
    ...(escalationDigest ? { escalationDigest } : {}),
  });

  return {
    succeeded,
    cost: 0,
    ...(unresolvedReason ? { unresolvedReason } : {}),
    ...(escalationDigest ? { escalationDigest } : {}),
  };
}
