import { isAbsolute, join } from "node:path";
import { makeParseRetryStrategy, ParseValidationError } from "../agents/retry";
import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { UserStory } from "../prd";
import { TddPromptBuilder } from "../prompts/builders/tdd-builder";
import { _isolationDeps, verifyImplementerIsolation } from "../tdd/isolation";
import type { FailureCategory, IsolationCheck } from "../tdd/types";
import type { VerdictCategorization, VerifierVerdict } from "../tdd/verdict";
import { categorizeVerdict, cleanupVerdict, coerceVerdict, isValidVerdict, readVerdict } from "../tdd/verdict";
import { tryParseLLMJson } from "../utils/llm-json";
import type { BuildContext, RunOperation, VerifyContext } from "./types";

void _isolationDeps; // re-export to keep test mocks pointed at the same singleton

export interface VerifierInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  /**
   * Git ref captured by the orchestrator just before this phase dispatches.
   * When present, isolation is checked in both verify and recover paths.
   * Absent in legacy / ad-hoc callers — isolation is then skipped.
   */
  readonly beforeRef?: string;
}

export interface VerifierOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Isolation check result, populated when isolation was run. */
  readonly isolation?: IsolationCheck;
  /** Failure category from verifier verdict categorization. */
  readonly failureCategory?: FailureCategory;
  /** Human-readable reason for rejection from the verifier verdict. */
  readonly reviewReason?: string;
  /** Structured findings populated when categorizeVerdict returned success=false. Always present; [] on success. */
  readonly normalizedFindings: readonly Finding[];
}

function buildVerifierFindings(verdict: VerifierVerdict, categorization: VerdictCategorization): Finding[] {
  if (categorization.success) return [];

  switch (categorization.failureCategory) {
    case "verifier-rejected": {
      const files = verdict.testModifications.files;
      return [
        {
          source: "tdd-verifier",
          severity: "error",
          category: "illegitimate-test-edits",
          fixTarget: "test",
          message:
            files.length > 0
              ? `Implementer edited test files illegitimately: ${files.join(", ")}`
              : "Implementer made illegitimate test modifications",
          meta: {
            reasoning: verdict.testModifications.reasoning,
            files,
          },
        },
      ];
    }
    case "tests-failing": {
      return [
        {
          source: "tdd-verifier",
          severity: "error",
          category: "tests-failed",
          fixTarget: "source",
          message: `${verdict.tests.failCount} story-scoped test(s) failed (verifier)`,
          meta: {
            passCount: verdict.tests.passCount,
            failCount: verdict.tests.failCount,
            reasoning: verdict.reasoning,
          },
        },
      ];
    }
    case "test-incorrect": {
      const assertions = verdict.testFailureDiagnosis?.assertions ?? [];
      const files = assertions.map((assertion) => assertion.file);
      return [
        {
          source: "tdd-verifier",
          severity: "error",
          category: "incorrect-test-assertion",
          fixTarget: "test",
          message: `Verifier identified incorrect test assertion(s) in ${files.join(", ")}; human review required`,
          meta: {
            assertions,
            reasoning: verdict.reasoning,
          },
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Parse the agent's stdout into a VerifierOutput using the project's tolerant
 * JSON extractor. Throws ParseValidationError when the output is empty, not
 * JSON, or missing the required VerifierVerdict shape — the parse-retry
 * strategy converts this into an in-session re-prompt.
 */
function parseVerdictFromStdout(output: string, input: VerifierInput, _ctx: BuildContext<TddConfig>): VerifierOutput {
  if (!output || !output.trim()) {
    throw new ParseValidationError("verifier produced no stdout");
  }
  const raw = tryParseLLMJson<Record<string, unknown>>(output);
  if (!raw || typeof raw !== "object") {
    throw new ParseValidationError("verifier stdout is not a JSON object");
  }
  const verdict = isValidVerdict(raw) ? raw : coerceVerdict(raw);
  if (!verdict) {
    throw new ParseValidationError("verifier stdout JSON missing required VerifierVerdict fields");
  }
  const categorization = categorizeVerdict(verdict, verdict.tests.allPassing === true);
  // Surface the verdict outcome on the success path. The agent's `approved`
  // flag can disagree with the categorized outcome: categorizeVerdict treats
  // approved:false for advisory AC/quality reasons as success (semantic review
  // owns those), blocking only on TDD-integrity failures. Without this line the
  // mapping is invisible in the run log and only recoverable from prompt-audit.
  getSafeLogger()?.info("verifier", "Verdict categorized", {
    storyId: input.story.id,
    approved: verdict.approved,
    success: categorization.success,
    advisoryOverride: verdict.approved === false && categorization.success,
    testsPassing: verdict.tests.allPassing,
    passCount: verdict.tests.passCount,
    failCount: verdict.tests.failCount,
    testModsDetected: verdict.testModifications.detected,
    testModsLegitimate: verdict.testModifications.legitimate,
    ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
  });
  return {
    success: categorization.success,
    filesChanged: [],
    estimatedCostUsd: 0,
    durationMs: 0,
    output,
    normalizedFindings: buildVerifierFindings(verdict, categorization),
    ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
    ...(categorization.reviewReason && { reviewReason: categorization.reviewReason }),
  };
}

async function runVerifierIsolation(
  beforeRef: string | undefined,
  ctx: VerifyContext<TddConfig>,
): Promise<IsolationCheck | undefined> {
  if (!beforeRef) return undefined;
  const testFilePatterns =
    typeof ctx.packageView.config.execution?.smartTestRunner === "object" &&
    ctx.packageView.config.execution.smartTestRunner !== null
      ? ctx.packageView.config.execution.smartTestRunner.testFilePatterns
      : undefined;
  return verifyImplementerIsolation(resolveAbsolutePackageDir(ctx), beforeRef, testFilePatterns);
}

/**
 * Resolve the ABSOLUTE package directory from a verify context's package view.
 * `packageView.packageDir` is a RELATIVE key ("" for the repo root) — it must
 * never be probed/spawned against directly (see full-suite-gate / verify-scoped).
 * The verifier writes its verdict and runs isolation against the absolute
 * workdir, so recover/verify join the key onto the package view's repo root.
 * Tolerates callers that already pass an absolute `packageDir` (e.g. unit tests
 * that build a minimal package view without a repo root).
 */
function resolveAbsolutePackageDir(ctx: VerifyContext<TddConfig>): string {
  const { repoRoot, packageDir } = ctx.packageView;
  if (!packageDir) return repoRoot || "";
  if (!repoRoot || isAbsolute(packageDir)) return packageDir;
  return join(repoRoot, packageDir);
}

export const verifierOp: RunOperation<VerifierInput, VerifierOutput, TddConfig> = {
  kind: "run",
  name: "verifier",
  stage: "verify",
  session: { role: "verifier", lifetime: "fresh" },
  config: tddConfigSelector,
  // Verification is a cheap scoped task — follows the configured per-role tier.
  model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.verifier,
  // Mirror semantic-review: maxAttempts=2, in-session re-prompt on parse failure.
  retry: makeParseRetryStrategy({
    validate: (parsed) => {
      if (!parsed || typeof parsed !== "object") return false;
      const r = parsed as Record<string, unknown>;
      return isValidVerdict(r) || coerceVerdict(r) !== null;
    },
    reviewerKind: "verifier",
    maxAttempts: 2,
    // Surface the unparseable bytes in the run log — verifier verdicts are the
    // single hardest phase to diagnose post-hoc, and "originalByteSize: 155"
    // alone tells you nothing about what the agent actually emitted.
    outputPreviewBytes: 600,
    prompts: {
      invalid: () => TddPromptBuilder.verdictRetry(),
      truncated: () => TddPromptBuilder.verdictRetryCondensed(),
    },
    // No exhaustedFallback — let callOp fall through to op.recover so we keep
    // the existing disk-file fallback path. op.recover always returns non-null,
    // satisfying the retry-strategy escape-hatch rule.
  }),
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `Verify implementation for story: ${input.story.id}`,
        overridable: false,
      },
    };
  },
  parse: parseVerdictFromStdout,
  async verify(parsed, input, ctx): Promise<VerifierOutput | null> {
    // parsed is the result of op.parse — parse only returns for valid verdicts,
    // so we don't need to signal recover here. Just attach isolation when configured.
    const isolation = await runVerifierIsolation(input.beforeRef, ctx);
    return isolation ? { ...parsed, isolation } : parsed;
  },
  async recover(input, verifyCtx): Promise<VerifierOutput> {
    // Last-ditch fallback: read .nax-verifier-verdict.json from disk. If the
    // file is missing or unparseable, return a fail-closed VerifierOutput so
    // the orchestrator records an explicit failure (never null — satisfies
    // the parse-retry escape-hatch rule).
    const packageDir = resolveAbsolutePackageDir(verifyCtx);
    const logger = getSafeLogger();
    const storyId = input.story.id;
    try {
      // An empty packageDir means no resolvable workdir (no repoRoot either).
      // readVerdict/cleanupVerdict join onto the empty string, which resolves
      // against the process cwd — that would read (or delete) a verdict file
      // in the wrong place. Fail closed without touching the filesystem.
      const verdict = packageDir ? await readVerdict(packageDir) : null;
      if (verdict) {
        const testsAllPassing = verdict.tests.allPassing === true;
        const categorization = categorizeVerdict(verdict, testsAllPassing);
        const isolation = await runVerifierIsolation(input.beforeRef, verifyCtx);
        const normalizedFindings = buildVerifierFindings(verdict, categorization);
        logger?.warn("verifier", "Recovered verdict from disk after unparseable stdout", {
          storyId,
          packageDir,
          success: categorization.success,
          findingsCount: normalizedFindings.length,
          ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
        });
        return {
          success: categorization.success,
          filesChanged: [],
          estimatedCostUsd: 0,
          durationMs: 0,
          output: "",
          normalizedFindings,
          ...(categorization.failureCategory && { failureCategory: categorization.failureCategory }),
          ...(categorization.reviewReason && { reviewReason: categorization.reviewReason }),
          ...(isolation && { isolation }),
        };
      }
      logger?.error("verifier", "No usable verdict — unparseable stdout and no verdict file on disk (fail-closed)", {
        storyId,
        packageDir,
      });
      return {
        success: false,
        filesChanged: [],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
        normalizedFindings: [],
        reviewReason:
          "verifier produced unparseable verdict in stdout after retries and no usable verdict file on disk",
      };
    } finally {
      if (packageDir) await cleanupVerdict(packageDir);
    }
  },
};

/** Backward-compat alias — callers may use either name. */
export const verifyTddOp = verifierOp;
