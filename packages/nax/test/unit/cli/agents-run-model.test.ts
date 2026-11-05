import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolveAgentsRunModel } from "@/cli/agents-run-model";
import { NaxError } from "@/errors";
import type { AgentResource } from "@/resources/types";

const agent = (model?: string): AgentResource => ({
  kind: "agent",
  name: "reviewer",
  qualifiedName: "reviewer",
  description: "Reviewer agent",
  ...(model === undefined ? {} : { model }),
  prompt: "Review this spec.",
  path: "/agents/reviewer.md",
  origin: { kind: "claude-project" },
});

const config = (balanced?: string | { provider: string; model: string }) => {
  const result = makeNaxConfig({
    models: {
      native: {
        ...(balanced === undefined ? {} : { balanced }),
        fast: "openai/gpt-fast",
      },
    },
  });
  if (balanced === undefined) result.models.native.balanced = undefined;
  return result;
};

function expectUnknownOverride(balanced?: string): void {
  try {
    resolveAgentsRunModel({ agent: agent(), config: config(balanced), modelOverride: "nonsense" });
    expect.unreachable("expected unknown model usage error");
  } catch (error) {
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({
      code: "AGENTS_RUN_USAGE",
      message: "unknown model nonsense; pass provider/model, acp:<agent>, or a configured alias",
    });
  }
}

describe("resolveAgentsRunModel", () => {
  test("AC-1: resolves an agent family model through its configured tier", () => {
    expect(resolveAgentsRunModel({ agent: agent("haiku"), config: config("openai/gpt-bal") })).toBe("openai/gpt-fast");
  });
  test("AC-2: a configured fast tier does not require the balanced parent tier", () => {
    expect(resolveAgentsRunModel({ agent: agent("haiku"), config: config() })).toBe("openai/gpt-fast");
  });
  test("AC-3: an explicit ACP model override does not require a parent tier", () => {
    expect(resolveAgentsRunModel({ agent: agent("haiku"), config: config(), modelOverride: "acp:codex/x" })).toBe(
      "acp:codex/x",
    );
  });
  test("AC-4: resolves agent model aliases", () => {
    expect(
      resolveAgentsRunModel({
        agent: agent("reviewer"),
        config: makeNaxConfig({ agent: { modelAliases: { reviewer: "acp:codex/x" } }, models: { native: {} } }),
      }),
    ).toBe("acp:codex/x");
  });
  test("AC-5: uses string balanced model for an agent without a model", () => {
    expect(resolveAgentsRunModel({ agent: agent(), config: config("openai/gpt-bal") })).toBe("openai/gpt-bal");
  });
  test("AC-6: formats object balanced model for an agent without a model", () => {
    expect(resolveAgentsRunModel({ agent: agent(), config: config({ provider: "openai", model: "gpt-bal" }) })).toBe(
      "openai/gpt-bal",
    );
  });
  test("AC-7: falls back from an unrecognized agent-file model to the parent model", () => {
    expect(resolveAgentsRunModel({ agent: agent("gpt"), config: config("openai/gpt-bal") })).toBe("openai/gpt-bal");
  });
  test("AC-8: rejects an unknown override when balanced is configured", () => {
    expectUnknownOverride("openai/gpt-bal");
  });
  test("AC-9: rejects an unknown override when balanced is unset", () => {
    expectUnknownOverride();
  });
  test("AC-10: requires a parent model when no model is requested", () => {
    let error: unknown;
    try {
      resolveAgentsRunModel({ agent: agent(), config: config() });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({
      code: "AGENTS_RUN_USAGE",
      message: "configure models.native.balanced or pass --model",
    });
  });
});
