import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import type { FailureRecord } from "../prompts";
import { RectifierPromptBuilder, repoScopedRectification } from "../prompts";
import { parseTestEditDeclarations, type TestEditDeclaration } from "./test-edit-declaration";
import type { RunOperation } from "./types";

export interface FullSuiteRectifyInput {
  story: UserStory;
  findings: readonly Finding[];
  /**
   * Which mandate to send (#1654). `"story"` (the default) forbids touching
   * anything outside the story; `"repo"` lifts that for the fallthrough
   * dispatch after the story-scoped attempt declined the findings as
   * out-of-scope. Only the prompt differs — the UNRESOLVED protocol and the
   * declaration parser are shared, which is why this is a field rather than a
   * second op.
   */
  scope?: "story" | "repo";
}

export interface FullSuiteRectifyOutput {
  applied: true;
  testEditDeclarations: TestEditDeclaration[];
  /** Populated when the agent emits UNRESOLVED: — triggers agent-gave-up exit in the findings cycle. */
  unresolvedReason?: string;
}

export const fullSuiteRectifyOp: RunOperation<FullSuiteRectifyInput, FullSuiteRectifyOutput, AutofixConfig> = {
  kind: "run",
  name: "full-suite-rectify",
  stage: "rectification",
  session: { role: "implementer", lifetime: "warm" },
  // No GitCommit: neither failingTestRectification nor repoScopedRectification
  // instructs the agent to commit. The repo-scoped strategy attributes changed
  // files via git diff itself (`_repoScopedFixDeps.captureWorkingTreeChanges`,
  // full-suite-rectify.ts) rather than trusting a self-reported commit.
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "Delete", "Git", "RunCommand", "Exec", "RequestCapability"],
  config: autofixConfigSelector,
  // The repo-scoped dispatch runs under its own session role and gets a single
  // attempt, so nothing resumes its session — keeping it warm would strand one.
  // The story-scoped dispatch keeps the op's declared `warm` lifetime.
  keepOpen: (input) => input.scope !== "repo",
  build(input, ctx) {
    if (input.scope === "repo") {
      const prompt = repoScopedRectification(input.findings as Finding[], input.story);
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: prompt, overridable: false },
      };
    }
    // US-004 — story-scoped dispatch reads the full-suite test command out of
    // the resolved package config (the same config the verifier replays
    // against, so the prompt shows the agent what the verifier will run).
    // `regressionFailure` renders the `# TEST COMMAND` block with a
    // `run-check` region, so the dispatch seam can substitute a
    // `RunCommand {"command": "test"}` call under native + advertised
    // `RunCommand` (AC5). ACP keeps the shell string byte-for-byte (AC6).
    // The declared key is always `"test"` per ADR convention — that is the
    // `quality.commands.test` slot's name in the project config.
    const config = ctx.packageView.config;
    const testCommand = config.quality?.commands?.test;
    const failureRecords: FailureRecord[] = (input.findings as Finding[]).map((f) => ({
      test: f.rule ?? undefined,
      file: f.file ?? undefined,
      message: f.message,
      output: undefined,
    }));
    if (testCommand) {
      const testScopedTemplate = config.quality?.commands?.testScoped;
      const hasScopedKey = !!testScopedTemplate;
      const prompt = RectifierPromptBuilder.regressionFailure({
        story: input.story,
        failures: failureRecords,
        testCommand,
        scopedCommandName: "test",
        // US-004 (AC4) — the per-failing-file block is wrapped in a
        // `test-scope` region only when the project declares a scoped
        // template. Without one, `testCommand + file` is the only runnable
        // form, and `test-scope` requires a `{{files}}` placeholder.
        ...(hasScopedKey
          ? {
              testScopedTemplate,
              scopedFileCommandName: "testScoped",
            }
          : {}),
      });
      return {
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: prompt, overridable: false },
      };
    }
    // No test command configured (root or per-package) — fall back to the
    // pre-change prompt shape so the agent still sees the failing test list.
    const prompt = RectifierPromptBuilder.failingTestRectification(input.findings as Finding[], input.story);
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const declarations = parseTestEditDeclarations(output);
    const unresolvedMatch = output.match(/^UNRESOLVED:\s*(.+)$/m);
    return {
      applied: true,
      testEditDeclarations: declarations,
      ...(unresolvedMatch ? { unresolvedReason: unresolvedMatch[1]?.trim() } : {}),
    };
  },
};
