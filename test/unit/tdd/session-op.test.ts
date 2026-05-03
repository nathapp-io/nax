import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _sessionRunnerDeps } from "../../../src/tdd/session-runner";
import { implementTddOp, runTddSessionOp, verifyTddOp, writeTddTestOp } from "../../../src/tdd/session-op";
import { makeAgentAdapter, makeNaxConfig, makeStory } from "../../helpers";
import { fakeAgentManager } from "../../helpers/fake-agent-manager";

let savedDeps: Record<string, unknown>;
beforeEach(() => {
  savedDeps = { ..._sessionRunnerDeps };
  _sessionRunnerDeps.autoCommitIfDirty = mock(async () => {});
  _sessionRunnerDeps.getChangedFiles = mock(async () => ["test/foo.test.ts"]);
  _sessionRunnerDeps.verifyTestWriterIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.verifyImplementerIsolation = mock(async () => ({ passed: true, violations: [] }));
  _sessionRunnerDeps.captureGitRef = mock(async () => "ref");
  _sessionRunnerDeps.cleanupProcessTree = mock(async () => {});
  _sessionRunnerDeps.buildPrompt = mock(async () => "prompt text");
});
afterEach(() => {
  Object.assign(_sessionRunnerDeps, savedDeps);
});

describe("TddRunOp constants", () => {
  test("writeTddTestOp has role test-writer", () => {
    expect(writeTddTestOp.role).toBe("test-writer");
  });

  test("implementTddOp has role implementer", () => {
    expect(implementTddOp.role).toBe("implementer");
  });

  test("verifyTddOp has role verifier", () => {
    expect(verifyTddOp.role).toBe("verifier");
  });
});

describe("runTddSessionOp", () => {
  test("runs a test-writer session and returns TddSessionResult with correct role", async () => {
    const config = makeNaxConfig({
      quality: { commands: { test: "bun test" } },
      tdd: { testWriterAllowedPaths: [], rollbackOnFailure: false },
    });
    const options = {
      agent: makeAgentAdapter(),
      agentManager: fakeAgentManager(makeAgentAdapter()),
      story: makeStory(),
      config,
      workdir: "/tmp/fake",
      modelTier: "balanced" as const,
      dryRun: false,
      lite: false,
    };
    const result = await runTddSessionOp(writeTddTestOp, options, "HEAD");
    expect(result.role).toBe("test-writer");
    expect(typeof result.success).toBe("boolean");
  });

  test("limits verifier prompt inputs to TDD integrity context", async () => {
    const config = makeNaxConfig({
      quality: { commands: { test: "bun test" } },
      tdd: { rollbackOnFailure: false },
    });
    const contextBundle = {
      pushMarkdown: "## Broad Feature Context\nSemantic details",
      pullTools: [{ name: "query_feature_context", description: "feature search" }],
      digest: "digest",
    };
    const buildPrompt = _sessionRunnerDeps.buildPrompt as ReturnType<typeof mock>;

    const result = await runTddSessionOp(
      verifyTddOp,
      {
        agent: makeAgentAdapter(),
        agentManager: fakeAgentManager(makeAgentAdapter()),
        story: makeStory(),
        config,
        workdir: "/tmp/fake",
        modelTier: "balanced" as const,
        constitution: "constitution.md content",
        featureContextMarkdown: "legacy feature context",
        contextMarkdown: "legacy run context",
      },
      "HEAD",
      contextBundle as never,
    );

    expect(result.role).toBe("verifier");
    expect(buildPrompt.mock.calls[0]?.[4]).toBeUndefined(); // contextMarkdown
    expect(buildPrompt.mock.calls[0]?.[6]).toBeUndefined(); // constitution
    expect(buildPrompt.mock.calls[0]?.[7]).toBeUndefined(); // feature context / v2 pushMarkdown
  });
});
