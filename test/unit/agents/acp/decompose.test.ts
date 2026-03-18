/**
 * Tests for AcpAgentAdapter.decompose() — ACP-005
 *
 * Covers:
 * - decompose() returns DecomposeResult with parsed stories from ACP response
 * - decompose() reuses existing buildDecomposePrompt and parseDecomposeOutput
 * - decompose() respects model override from options.modelDef
 * - decompose() handles ACP errors gracefully with clear error messages
 * - decompose() validates story parsing and array content
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import type { DecomposeOptions } from "../../../../src/agents/types";
import { makeClient, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature Spec
This is the specification for a new feature.
## Overview
Build an authentication system.`;

const SAMPLE_STORIES_JSON = JSON.stringify([
  {
    id: "US-001",
    title: "Implement login endpoint",
    description: "Create a POST /auth/login endpoint",
    acceptanceCriteria: ["Returns JWT on valid credentials"],
    tags: ["security", "api"],
    dependencies: [],
    complexity: "medium",
    contextFiles: ["src/auth/login.ts"],
    reasoning: "Standard auth endpoint",
    estimatedLOC: 80,
    risks: ["Token expiry handling"],
    testStrategy: "test-after",
  },
]);

const DECOMPOSE_WORKDIR = `/tmp/nax-decompose-test-${randomUUID()}`;

function makeDecomposeOptions(overrides: Partial<DecomposeOptions> = {}): DecomposeOptions {
  return {
    specContent: SAMPLE_SPEC,
    workdir: DECOMPOSE_WORKDIR,
    codebaseContext: "TypeScript project with Express",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// decompose()
// ─────────────────────────────────────────────────────────────────────────────

describe("decompose()", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("returns DecomposeResult with parsed stories from ACP response", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions());

    expect(result).toBeDefined();
    expect(Array.isArray(result.stories)).toBe(true);
    expect(result.stories.length).toBeGreaterThan(0);
  });

  test("parsed stories contain required fields (id, title, complexity)", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions());
    const story = result.stories[0];

    expect(story.id).toBe("US-001");
    expect(story.title).toBe("Implement login endpoint");
    expect(story.complexity).toBe("medium");
  });

  test("sends a prompt derived from buildDecomposePrompt (includes specContent)", async () => {
    let capturedPrompt = "";
    const session = makeSession({
      promptFn: async (text: string) => {
        capturedPrompt = text;
        return {
          messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions({ specContent: SAMPLE_SPEC }));

    // The prompt must include the spec content (reuses buildDecomposePrompt)
    expect(capturedPrompt).toContain("# Feature Spec");
  });

  test("sends a prompt that includes codebase context (reuses buildDecomposePrompt)", async () => {
    let capturedPrompt = "";
    const session = makeSession({
      promptFn: async (text: string) => {
        capturedPrompt = text;
        return {
          messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const codebaseCtx = "Custom codebase context for testing";
    await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions({ codebaseContext: codebaseCtx }));

    expect(capturedPrompt).toContain(codebaseCtx);
  });

  test("respects model override from options.modelDef", async () => {
    let capturedCmd = "";
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
      }),
    });
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return makeClient(session);
    });

    const customModel = "claude-opus-4-6";
    await new AcpAgentAdapter("claude").decompose(
      makeDecomposeOptions({ modelDef: { provider: "anthropic", model: customModel, env: {} } }),
    );

    expect(capturedCmd).toContain(customModel);
  });

  test("closes the ACP session after completion", async () => {
    let closeCalled = false;
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: SAMPLE_STORIES_JSON }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 200, output_tokens: 300 },
      }),
      closeFn: async () => { closeCalled = true; },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions());
    expect(closeCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decompose() — ACP error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("decompose() — ACP error handling", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("propagates ACP errors when session prompt throws", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => {
        throw new Error("ACP network error");
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").decompose(makeDecomposeOptions()),
    ).rejects.toThrow();
  });

  test("error message includes acp-adapter context prefix on failure", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => {
        throw new Error("timeout");
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    let errorMessage = "";
    try {
      await new AcpAgentAdapter("claude").decompose(makeDecomposeOptions());
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage).toMatch(/\[acp-adapter\]/);
  });

  test("throws when ACP response cannot be parsed as JSON story array", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: "This is not valid JSON" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 50, output_tokens: 10 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").decompose(makeDecomposeOptions()),
    ).rejects.toThrow();
  });

  test("throws when ACP returns an empty story array", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: "[]" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 50, output_tokens: 5 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").decompose(makeDecomposeOptions()),
    ).rejects.toThrow();
  });
});
