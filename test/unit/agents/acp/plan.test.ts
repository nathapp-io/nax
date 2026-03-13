/**
 * Tests for AcpAgentAdapter.plan() — ACP-005
 *
 * Covers:
 * - plan() returns PlanResult with specContent from ACP session response
 * - plan() in non-interactive mode works end-to-end via ACP one-shot
 * - plan() in interactive mode throws clear 'not yet supported via ACP' error
 * - plan() handles ACP errors gracefully with clear error messages
 * - plan() respects model override from options.modelDef
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import type { PlanOptions } from "../../../../src/agents/types";
import { makeClient, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature Spec
This is the specification for a new feature.
## Overview
Build an authentication system.`;

function makePlanOptions(overrides: Partial<PlanOptions> = {}): PlanOptions {
  return {
    prompt: "Plan an authentication system",
    workdir: "/tmp/nax-plan-test",
    interactive: false,
    codebaseContext: "TypeScript project with Express",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// plan() — non-interactive mode
// ─────────────────────────────────────────────────────────────────────────────

describe("plan() — non-interactive mode", () => {
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

  test("returns PlanResult with specContent from ACP session response", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: SAMPLE_SPEC }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 100, output_tokens: 200 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const result = await adapter.plan(makePlanOptions({ interactive: false }));

    expect(result).toBeDefined();
    expect(typeof result.specContent).toBe("string");
    expect(result.specContent.length).toBeGreaterThan(0);
  });

  test("specContent matches the assistant text from the ACP response", async () => {
    const expectedSpec = "# My Feature Spec\n\nThis is the plan.";
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: expectedSpec }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 50, output_tokens: 100 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: false }));
    expect(result.specContent).toBe(expectedSpec);
  });

  test("sends the planning prompt to the ACP session", async () => {
    let receivedPrompt = "";
    const session = makeSession({
      promptFn: async (text: string) => {
        receivedPrompt = text;
        return {
          messages: [{ role: "assistant", content: "Generated spec" }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 50, output_tokens: 100 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const opts = makePlanOptions({ prompt: "Plan an OAuth2 flow", interactive: false });
    await new AcpAgentAdapter("claude").plan(opts);

    expect(receivedPrompt).toContain("Plan an OAuth2 flow");
  });

  test("respects model override from options.modelDef", async () => {
    let capturedCmd = "";
    const session = makeSession();
    _acpAdapterDeps.createClient = mock((cmd: string) => {
      capturedCmd = cmd;
      return makeClient(session);
    });

    const customModel = "claude-opus-4-6";
    await new AcpAgentAdapter("claude").plan(
      makePlanOptions({
        interactive: false,
        modelDef: { provider: "anthropic", model: customModel, env: {} },
      }),
    );

    expect(capturedCmd).toContain(customModel);
  });

  test("closes the ACP session after completion", async () => {
    let closeCalled = false;
    const session = makeSession({ closeFn: async () => { closeCalled = true; } });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: false }));
    expect(closeCalled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan() — interactive mode
// ─────────────────────────────────────────────────────────────────────────────

describe("plan() — interactive mode", () => {
  const origCreateClient = _acpAdapterDeps.createClient;

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("throws an error when called in interactive mode", async () => {
    const adapter = new AcpAgentAdapter("claude");
    await expect(adapter.plan(makePlanOptions({ interactive: true }))).rejects.toThrow();
  });

  test("error message contains 'not yet supported via ACP' for interactive mode", async () => {
    const adapter = new AcpAgentAdapter("claude");
    let errorMessage = "";
    try {
      await adapter.plan(makePlanOptions({ interactive: true }));
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage.toLowerCase()).toMatch(/not yet supported via acp/i);
  });

  test("does not call AcpClient in interactive mode", async () => {
    let clientCreated = false;
    _acpAdapterDeps.createClient = mock((_cmd: string) => {
      clientCreated = true;
      return makeClient(makeSession());
    });

    try {
      await new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: true }));
    } catch {
      // expected
    }

    expect(clientCreated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan() — ACP error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("plan() — ACP error handling", () => {
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

  test("propagates ACP errors with a clear error message", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => {
        throw new Error("ACP connection refused");
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: false })),
    ).rejects.toThrow();
  });

  test("error message includes acp-adapter context prefix", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => {
        throw new Error("session dropped");
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    let errorMessage = "";
    try {
      await new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: false }));
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    expect(errorMessage).toMatch(/\[acp-adapter\]/);
  });

  test("throws when ACP session returns empty spec content", async () => {
    const session = makeSession({
      promptFn: async (_text: string) => ({
        messages: [{ role: "assistant", content: "   " }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 0 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    await expect(
      new AcpAgentAdapter("claude").plan(makePlanOptions({ interactive: false })),
    ).rejects.toThrow();
  });
});
