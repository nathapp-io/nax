/**
 * buildContextToolPreamble — unit tests.
 *
 * The preamble is the ONLY thing that tells an agent a pull tool exists and
 * how to call it. Advertising a tool's name without its argument schema means
 * the agent must guess the payload: `query_neighbor` requires `filePath`, and
 * a guessed `{}` reaches the handler as `filePath: undefined`, which returned
 * an empty result while still burning the session budget.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { buildContextToolPreamble } from "@/agents/acp/adapter-output";
import type { AgentRunOptions } from "@/agents/types";
import { QUERY_FEATURE_CONTEXT_DESCRIPTOR, QUERY_NEIGHBOR_DESCRIPTOR } from "@/context/engine/pull-tools";
import type { ToolDescriptor } from "@/context/engine/types";

function makeOptions(tools: ToolDescriptor[], prompt = "implement US-001"): AgentRunOptions {
  return {
    prompt,
    workdir: "/repo",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: makeNaxConfig(),
    contextPullTools: tools,
    contextToolRuntime: { callTool: async () => "" },
  };
}

describe("buildContextToolPreamble — argument schema reaches the agent", () => {
  test("names each required argument of an advertised tool", () => {
    const prompt = buildContextToolPreamble(makeOptions([QUERY_NEIGHBOR_DESCRIPTOR]));

    expect(prompt).toContain("query_neighbor");
    // Without the argument name the agent cannot construct a valid payload.
    expect(prompt).toContain("filePath");
    expect(prompt).toContain("required");
  });

  test("renders the argument type and description, and marks optional arguments", () => {
    const prompt = buildContextToolPreamble(makeOptions([QUERY_NEIGHBOR_DESCRIPTOR]));

    expect(prompt).toContain("filePath (string, required)");
    expect(prompt).toContain("depth (number, optional)");
    // The per-argument description carries the calling convention (repo-relative).
    expect(prompt).toContain("Repo-relative path");
  });

  test("marks an all-optional tool's arguments optional rather than required", () => {
    const prompt = buildContextToolPreamble(makeOptions([QUERY_FEATURE_CONTEXT_DESCRIPTOR]));

    expect(prompt).toContain("filter (string, optional)");
    expect(prompt).not.toContain("filter (string, required)");
  });

  test("still returns the bare prompt when no tools are advertised", () => {
    const prompt = buildContextToolPreamble(makeOptions([]));

    expect(prompt).toBe("implement US-001");
  });
});
