import { tddConfigSelector } from "../config";
import type { TddConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import { packageWorkdir } from "../runtime/packages";
import { _isolationDeps, verifyTestWriterIsolation } from "../tdd/isolation";
import type { IsolationCheck } from "../tdd/types";
import type { ResolvedTestPatterns } from "../test-runners";
import { parseSessionJsonOutput } from "./_session-output";
import { shouldKeepSessionOpen } from "./execution-gates";
import type { RunOperation } from "./types";

void _isolationDeps; // re-export to keep test mocks pointed at the same singleton

export interface TestWriterInput {
  readonly story: UserStory;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
  /**
   * Git ref captured by the orchestrator just before this phase dispatches.
   * When present, the op's `verify` hook runs test-writer isolation against this ref.
   * Absent in legacy / ad-hoc callers — isolation is then skipped.
   */
  readonly beforeRef?: string;
  /**
   * When true, isolation runs in lite mode: stub-sized src/ writes are treated as
   * soft violations to match the lite test-writer prompt contract (it tells the
   * agent it may create minimal stubs in src/). Strict mode (default) rejects any
   * src/ write outside `tdd.testWriterAllowedPaths`.
   */
  readonly lite?: boolean;
  /**
   * Test-file patterns resolved once per plan via the ADR-009 SSOT
   * (`resolveTestFilePatterns`). The `verify` hook passes `.globs` to
   * `verifyTestWriterIsolation` so isolation classifies test files identically
   * to `greenfieldGateOp` (which receives the SAME resolved object). Absent in
   * legacy / ad-hoc callers — isolation then falls back to DEFAULT_TEST_FILE_PATTERNS.
   */
  readonly resolvedTestPatterns?: ResolvedTestPatterns;
}

export interface TestWriterOutput {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly estimatedCostUsd: number;
  readonly durationMs: number;
  readonly output: string;
  /** Populated by `verify` when input.beforeRef was supplied. */
  readonly isolation?: IsolationCheck;
}

export const testWriterOp: RunOperation<TestWriterInput, TestWriterOutput, TddConfig> = {
  kind: "run",
  name: "test-writer",
  stage: "run",
  // warm + keepOpen: keep the test-writer session open after RED (when review or
  // rectification will run) so autofix-test-writer can resume the same ACP session.
  // acpx `sessions ensure` only resumes a still-open session. Mirrors implement.ts.
  session: { role: "test-writer", lifetime: "warm" },
  config: tddConfigSelector,
  // Write/Edit for test files and compile-only stubs. `RunCommand` because step
  // 6 of the role is "Run the new test files. Confirm tests compile AND fail
  // with ASSERTION failures" -- the one distinction the prompt insists on, and
  // one it cannot make without executing. `GitCommit` so the session commits its
  // own RED state, which makes the implementer's `beforeRef` a committed
  // test-only tree rather than whatever an auto-commit happened to sweep up.
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "RunCommand", "GitCommit"],
  // Test-writing is a cheap scoped task — follows the configured per-role tier.
  // Defaults to "fast" via the schema; undefined only for partial test configs.
  model: (_input, ctx) => ctx.config.tdd?.sessionTiers?.testWriter,
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "test-writer"),
  build(input, _ctx) {
    if (input.promptMarkdown?.trim()) {
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.promptMarkdown, overridable: false },
      };
    }
    const context = [input.contextMarkdown, input.featureContextMarkdown].filter(Boolean).join("\n\n");
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: context || `Write tests for story: ${input.story.id}`,
        overridable: false,
      },
      ...(input.constitution ? { constitution: input.constitution } : {}),
    };
  },
  parse(output, _input, _ctx): TestWriterOutput {
    if (!output) return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    // buildHopCallback injects 'Agent "xxx" failed: ...' when all hops fail.
    if (output.startsWith('Agent "')) {
      return { success: false, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output };
    }
    // Mirror implementerOp: the test-writer does not reliably emit the JSON
    // envelope (some agents reply in prose). Treat non-empty, non-error output
    // as success — downstream greenfieldGate / fullSuiteGate / verifier catch
    // the real failure modes (no tests written, tests don't fail in RED, etc.).
    const envelope = parseSessionJsonOutput(output);
    return {
      success: envelope.parsed ? envelope.success : true,
      filesChanged: envelope.filesChanged,
      estimatedCostUsd: 0,
      durationMs: 0,
      output: envelope.output,
    };
  },
  async verify(parsed, input, ctx): Promise<TestWriterOutput | null> {
    if (!input.beforeRef) return parsed;
    const allowedPaths = ctx.config.tdd?.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
    // ADR-009 SSOT: use the patterns resolved once at plan-build time (the SAME
    // object the greenfield gate received) so isolation and greenfield detection
    // classify test files identically. Falls back to verifyTestWriterIsolation's
    // own DEFAULT_TEST_FILE_PATTERNS default when absent (legacy / ad-hoc callers).
    const testFilePatterns = input.resolvedTestPatterns?.globs;
    const isolation = await verifyTestWriterIsolation(
      packageWorkdir(ctx.packageView),
      input.beforeRef,
      allowedPaths,
      testFilePatterns,
      input.lite ? "lite" : "strict",
    );
    return { ...parsed, isolation };
  },
};

/** Backward-compat alias — callers may use either name. */
export const writeTddTestOp = testWriterOp;
