import { autofixConfigSelector } from "../config";
import type { AutofixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import type { UserStory } from "../prd";
import { RectifierPromptBuilder, repoScopedRectification } from "../prompts";
import { storyRoutingModel } from "./story-routing-model";
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
  // Inherit the story's rung so an escalation or a profile pin reaches the fix
  // cycle too — without this the op fell through to callOp's literal "balanced".
  model: (input) => storyRoutingModel(input.story),
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
    // US-004 — story-scoped dispatch extends the pre-change
    // `failingTestRectification` prompt with a `# TEST COMMAND` block and
    // an optional per-failing-file block, both wrapped in protocol regions.
    // The pre-change ACP text (failing-test list, fix directive, escape
    // hatch) is preserved verbatim; only the affordance-rendered blocks
    // are appended. ACP byte-parity for the existing text is the gate per
    // US-004's "Out of Scope #2"; the new blocks are accepted because
    // AC5/AC6 require a `# TEST COMMAND` section and AC4 requires a
    // per-failing-file section.
    const config = ctx.packageView.config;
    const testCommand = config.quality?.commands?.test;
    const testScopedTemplate = config.quality?.commands?.testScoped;
    // SSOT for naming the `testScoped` key: `RunCommand` resolves by
    // exact placeholder match; a template that takes anything other than
    // `{{files}}` hands the agent a tool call the runtime always rejects
    // (`value "files" is not a placeholder in this command`). See
    // src/execution/lifecycle/acceptance-helpers.ts:89.
    const scopedCommandName = testScopedTemplate?.includes("{{files}}") === true ? "testScoped" : undefined;
    const prompt = RectifierPromptBuilder.failingTestRectification(input.findings as Finding[], input.story, {
      // US-004 (AC5/AC6) — `# TEST COMMAND` block always names the declared
      // `test` key (per ADR convention — `quality.commands.test` slot).
      ...(testCommand ? { testCommand, testCommandScopeCommandName: "test" } : {}),
      // US-004 (AC4/AC7) — per-failing-file block uses the declared
      // `testScoped` key, but only when the template carries the
      // `{{files}}` placeholder (the SSOT gate at acceptance-helpers.ts:89).
      ...(testCommand && scopedCommandName ? { testScopedTemplate, fileScopeCommandName: scopedCommandName } : {}),
    });
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
