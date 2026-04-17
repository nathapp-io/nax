/**
 * Tests for AcpAgentAdapter — interaction bridge and context pull tools
 *
 * Covers:
 * - Context pull tool calls in the session loop
 * - Multi-line and single-line question passing to interactionBridge
 * - interactionBridge.onQuestionDetected when output contains question
 * - Skips question detection on max_tokens stopReason
 * - Stops loop when interactionBridge throws (interaction timeout)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { withDepsRestore } from "../../../helpers/deps";
import type { AgentRunOptions } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { makeClient, makeSession } from "./adapter.test";

const BASE_OPTIONS: AgentRunOptions = {
  prompt: "implement the feature",
  workdir: "/tmp/test-project",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
  timeoutSeconds: 30,
  dangerouslySkipPermissions: true,
  featureName: "string-toolkit",
  storyId: "ST-001",
  config: DEFAULT_CONFIG,
};

describe("AcpAgentAdapter — interaction bridge and context pull tools", () => {
  let adapter: AcpAgentAdapter;

  withDepsRestore(_acpAdapterDeps, ["createClient", "sleep"]);

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude", DEFAULT_CONFIG);
    _acpAdapterDeps.sleep = async () => {};
  });

  afterEach(() => {
    mock.restore();
  });

  test("handles context pull tool calls in the session loop", async () => {
    let promptCallCount = 0;
    const toolRuntime = {
      callTool: mock(async (name: string, input: unknown) => {
        expect(name).toBe("query_neighbor");
        expect(input).toEqual({ filePath: "src/index.ts" });
        return "Neighbor context for src/index.ts";
      }),
    };

    const session = makeSession({
      promptFn: async (prompt: string) => {
        promptCallCount++;
        if (promptCallCount === 1) {
          expect(prompt).toContain("## Context Pull Tools");
          expect(prompt).toContain("query_neighbor");
          return {
            messages: [
              {
                role: "assistant",
                content: '<nax_tool_call name="query_neighbor">\n{"filePath":"src/index.ts"}\n</nax_tool_call>',
              },
            ],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        }

        expect(prompt).toContain('<nax_tool_result name="query_neighbor" status="ok">');
        expect(prompt).toContain("Neighbor context for src/index.ts");
        return {
          messages: [{ role: "assistant", content: "Implemented using the extra context." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 80, output_tokens: 40 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await adapter.run({
      ...BASE_OPTIONS,
      contextPullTools: [
        {
          name: "query_neighbor",
          description: "Fetch extra neighbor context",
          inputSchema: { type: "object" },
          maxCallsPerSession: 3,
          maxTokensPerCall: 500,
        },
      ],
      contextToolRuntime: toolRuntime,
    });

    expect(promptCallCount).toBe(2);
    expect(toolRuntime.callTool).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Implemented using the extra context.");
  });

  test("multi-line question block — full paragraph passed to bridge (not just last line)", async () => {
    const answers: string[] = [];
    let promptCallCount = 0;

    const multiLineQuestion = [
      "All ACs are covered and tests pass.",
      "",
      "Would you like me to:",
      "1. Commit the current state if there are uncommitted changes?",
      "2. Check for any remaining gaps in test coverage?",
      "3. Something else?",
    ].join("\n");

    const session = makeSession({
      promptFn: async (_: string) => {
        promptCallCount++;
        if (promptCallCount === 1) {
          return {
            messages: [{ role: "assistant", content: multiLineQuestion }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "Done, committed." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const bridge = {
      detectQuestion: async (_t: string) => true,
      onQuestionDetected: async (q: string) => {
        answers.push(q);
        return "3";
      },
    };

    await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("All ACs are covered and tests pass.");
    expect(answers[0]).toContain("Would you like me to:");
    expect(answers[0]).toContain("1. Commit");
    expect(answers[0]).toContain("3. Something else?");
  });

  test("single-line question — unchanged behaviour (returns the question line)", async () => {
    const answers: string[] = [];
    let promptCallCount = 0;

    const session = makeSession({
      promptFn: async (_: string) => {
        promptCallCount++;
        if (promptCallCount === 1) {
          return {
            messages: [{ role: "assistant", content: "Which OAuth provider should I use?" }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "Implemented with GitHub OAuth." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const bridge = {
      detectQuestion: async (_t: string) => true,
      onQuestionDetected: async (q: string) => {
        answers.push(q);
        return "GitHub OAuth";
      },
    };

    await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

    expect(answers).toHaveLength(1);
    expect(answers[0]).toBe("Which OAuth provider should I use?");
  });

  test("calls interactionBridge.onQuestionDetected when output contains question", async () => {
    let promptCallCount = 0;
    const answers: string[] = [];

    const session = makeSession({
      promptFn: async (_: string) => {
        promptCallCount++;
        if (promptCallCount === 1) {
          return {
            messages: [{ role: "assistant", content: "Which OAuth provider should I use?" }],
            stopReason: "end_turn",
            cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
          };
        }
        return {
          messages: [{ role: "assistant", content: "Implemented with GitHub OAuth." }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const bridge = {
      detectQuestion: async (_t: string) => true,
      onQuestionDetected: async (q: string) => {
        answers.push(q);
        return "Use GitHub OAuth";
      },
    };

    const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("OAuth provider");
    expect(promptCallCount).toBe(2);
    expect(result.output).toContain("GitHub OAuth");
  });

  test("skips question detection when stopReason is max_tokens (not end_turn)", async () => {
    let promptCallCount = 0;
    const bridge = {
      detectQuestion: async (_t: string) => true,
      onQuestionDetected: async (_q: string) => "answer",
    };

    const session = makeSession({
      promptFn: async (_: string) => {
        promptCallCount++;
        return {
          messages: [{ role: "assistant", content: "Which OAuth provider should I use?" }],
          stopReason: "max_tokens",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });

    expect(promptCallCount).toBe(1);
    expect(result.success).toBe(false);
  });

  test("stops loop when interactionBridge throws (interaction timeout)", async () => {
    let promptCallCount = 0;

    const session = makeSession({
      promptFn: async (_: string) => {
        promptCallCount++;
        return {
          messages: [{ role: "assistant", content: "Which environment: prod or staging?" }],
          stopReason: "end_turn",
          cumulative_token_usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const bridge = {
      detectQuestion: async (_t: string) => true,
      onQuestionDetected: async (_q: string) => {
        throw new Error("interaction timeout");
      },
    };

    const result = await adapter.run({ ...BASE_OPTIONS, interactionBridge: bridge });
    expect(promptCallCount).toBe(1);
    expect(result).toBeDefined();
  });
});
