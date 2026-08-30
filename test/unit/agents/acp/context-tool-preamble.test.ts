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
import {
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  QUERY_NEIGHBOR_DESCRIPTOR,
  QUERY_SCRATCH_DESCRIPTOR,
} from "@/context/engine/pull-tools";
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

describe("buildContextToolPreamble — a partial schema degrades instead of throwing", () => {
  function descriptor(inputSchema: Record<string, unknown>): ToolDescriptor {
    return {
      name: "query_partial",
      description: "a tool whose descriptor omits schema fields",
      inputSchema,
      maxCallsPerSession: 3,
      maxTokensPerCall: 512,
    };
  }

  test("renders the tool with no argument list when the schema declares no properties", () => {
    const prompt = buildContextToolPreamble(makeOptions([descriptor({ type: "object" })]));

    expect(prompt).toContain("query_partial");
    expect(prompt).not.toContain("Arguments:");
  });

  test("renders an empty properties object without an argument list", () => {
    const prompt = buildContextToolPreamble(makeOptions([descriptor({ properties: {} })]));

    expect(prompt).toContain("query_partial");
    expect(prompt).not.toContain("Arguments:");
  });

  test("falls back to 'any' for a property with no declared type, and ignores a malformed required", () => {
    // `required` is a string here, not the array JSON Schema demands.
    const prompt = buildContextToolPreamble(
      makeOptions([descriptor({ properties: { x: {}, y: "not-an-object" }, required: "x" })]),
    );

    expect(prompt).toContain("x (any, optional)");
    expect(prompt).toContain("y (any, optional)");
  });
});

describe("buildContextToolPreamble — the call example is real, not a placeholder", () => {
  test("shows a payload built from the first advertised tool's own schema", () => {
    const prompt = buildContextToolPreamble(makeOptions([QUERY_NEIGHBOR_DESCRIPTOR]));

    // A generic {"key":"value"} left the agent to infer the argument name —
    // the exact guess that made every query_neighbor call return empty.
    expect(prompt).not.toContain('{"key":"value"}');
    expect(prompt).toContain('"filePath"');
  });

  test("pins query_scratch's all-optional arguments too", () => {
    const prompt = buildContextToolPreamble(makeOptions([QUERY_SCRATCH_DESCRIPTOR]));

    expect(prompt).toContain("kind (string, optional)");
    expect(prompt).toContain("limit (number, optional)");
  });
});
