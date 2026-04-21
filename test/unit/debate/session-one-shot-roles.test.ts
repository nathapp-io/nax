import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import { makeMockAgentManager } from "../../helpers";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [{ agent: "opencode" }, { agent: "opencode" }],
    timeoutSeconds: 60,
    ...overrides,
  };
}

function makeMockManager(
  completeFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>,
) {
  return makeMockAgentManager({
    completeFn: completeFn ?? (async () => ({ output: '{"passed":true}', costUsd: 0, source: "fallback" as const })),
  });
}

describe("DebateSession.runOneShot() session roles", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
  });

  test("uses indexed session roles for proposal round", async () => {
    const roles: string[] = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, _prompt, opts) => {
        roles.push(opts?.sessionRole ?? "");
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-ROLE",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    await session.run("prompt");

    const proposalRoles = roles.filter((role) => role.startsWith("debate-proposal"));
    expect(proposalRoles).toEqual(["debate-proposal-0", "debate-proposal-1"]);
  });

  test("uses indexed session roles for critique round", async () => {
    const roles: string[] = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, _prompt, opts) => {
        roles.push(opts?.sessionRole ?? "");
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-ROLE",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("prompt");

    const critiqueRoles = roles.filter((role) => role.startsWith("debate-critique"));
    expect(critiqueRoles).toEqual(["debate-critique-0", "debate-critique-1"]);
  });
});

// ─── P1: Proposal prompts include persona block ───────────────────────────────

describe("DebateSession.runOneShot() — persona injection in proposal round (P1)", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
  });

  test("each debater receives a distinct persona block when autoPersona is true", async () => {
    const capturedPrompts: string[] = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-P1",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: true,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
    });

    await session.run("the task context");

    // Three proposal prompts captured
    expect(capturedPrompts).toHaveLength(3);

    // Each prompt contains "## Your Role"
    for (const prompt of capturedPrompts) {
      expect(prompt).toContain("## Your Role");
    }

    // Prompts are NOT all identical — personas differentiate them
    const unique = new Set(capturedPrompts);
    expect(unique.size).toBeGreaterThan(1);
  });

  test("proposal prompts do NOT contain persona block when autoPersona is false", async () => {
    const capturedPrompts: string[] = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-P1-NO-PERSONA",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: false,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
    });

    await session.run("the task context");

    for (const prompt of capturedPrompts) {
      expect(prompt).not.toContain("## Your Role");
    }
  });

  test("task context is preserved in proposal prompt alongside persona", async () => {
    const capturedPrompts: string[] = [];

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-P1-TASK",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: true,
        debaters: [{ agent: "claude", model: "fast" }],
      }),
    });

    await session.run("UNIQUE_TASK_CONTENT_XYZ");

    expect(capturedPrompts[0]).toContain("UNIQUE_TASK_CONTENT_XYZ");
    expect(capturedPrompts[0]).toContain("## Your Role");
  });
});

// ─── P3: labeledProposals uses persona-aware label ────────────────────────────

describe("DebateSession.runOneShot() — labeledProposals persona label (P3)", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
  });

  test("synthesis prompt labels proposals with persona when autoPersona is true", async () => {
    let capturedSynthesisPrompt = "";

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, prompt, opts) => {
        // The synthesis call is identified by sessionRole
        if (opts?.sessionRole === "synthesis") {
          capturedSynthesisPrompt = prompt;
        }
        return { output: "proposal output", costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-P3",
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 1,
        sessionMode: "one-shot",
        autoPersona: true,
        resolver: { type: "synthesis", agent: "claude" },
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
    });

    await session.run("task");

    // Synthesis prompt should have persona-labeled proposals
    expect(capturedSynthesisPrompt).toContain("(challenger)");
    expect(capturedSynthesisPrompt).toContain("(pragmatist)");
    expect(capturedSynthesisPrompt).toContain("(completionist)");
  });

  test("synthesis prompt labels proposals without persona when autoPersona is false", async () => {
    let capturedSynthesisPrompt = "";

    _debateSessionDeps.createManager = mock((_config) =>
      makeMockManager(async (_agentName, prompt, opts) => {
        if (opts?.sessionRole === "synthesis") {
          capturedSynthesisPrompt = prompt;
        }
        return { output: "proposal output", costUsd: 0, source: "fallback" as const };
      }),
    );

    const session = new DebateSession({
      storyId: "US-P3-NO-PERSONA",
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 1,
        sessionMode: "one-shot",
        autoPersona: false,
        resolver: { type: "synthesis", agent: "claude" },
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
    });

    await session.run("task");

    // Should use agent name label only — no persona parens
    expect(capturedSynthesisPrompt).toContain("### Proposal claude");
    expect(capturedSynthesisPrompt).not.toContain("(challenger)");
  });
});
