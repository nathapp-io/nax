import { describe, expect, test } from "bun:test";

describe("resolveSubagentModel", () => {
  test("AC-1: inherits the parent model when requested is absent", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: undefined, parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "inherit",
    });
  });

  test("AC-2: inherits the parent model when requested is inherit", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "inherit", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "inherit",
    });
  });

  test("AC-3: resolves a configured alias", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({ requested: "sonnet", parentModel: "p/m", aliases: { sonnet: "a/s" }, tiers: {} }),
    ).toEqual({ model: "a/s", source: "alias" });
  });

  test("AC-4: an alias wins over the tier step", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({
        requested: "sonnet",
        parentModel: "p/m",
        aliases: { sonnet: "a/s" },
        tiers: { balanced: "b/t" },
      }),
    ).toEqual({ model: "a/s", source: "alias" });
  });

  test("AC-5: maps haiku to a string fast tier entry", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({ requested: "haiku", parentModel: "p/m", aliases: {}, tiers: { fast: "f/m" } }),
    ).toEqual({ model: "f/m", source: "tier" });
  });

  test("AC-6: maps opus to an object powerful tier entry as provider/model", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({
        requested: "opus",
        parentModel: "p/m",
        aliases: {},
        tiers: { powerful: { provider: "x", model: "y" } },
      }),
    ).toEqual({ model: "x/y", source: "tier" });
  });

  test("maps sonnet to the balanced tier", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({ requested: "sonnet", parentModel: "p/m", aliases: {}, tiers: { balanced: "b/t" } }),
    ).toEqual({ model: "b/t", source: "tier" });
  });

  test("AC-7: falls back to the parent when the tier is not configured", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "opus", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "fallback",
    });
  });

  test("AC-8: uses a provider-qualified requested model as is", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "openai/gpt-x", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "openai/gpt-x",
      source: "model",
    });
  });

  test("AC-9: falls back to the parent for an unknown bare name", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "claude-opus-4", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "fallback",
    });
  });

  // US-002 (chat-acp-subagents): a second ACP agent can review the parent's
  // work, so an unaliased `acp:` request names an explicit model the same way a
  // `provider/model` request does — it must not fall back to the parent.
  test("US-002 AC-6: takes an unaliased acp: request as an explicit model", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "acp:codex", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "acp:codex",
      source: "model",
    });
  });

  test("US-002 AC-7: resolves an alias whose value is an acp: target", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    const aliases = { reviewer: "acp:codex/gpt-6.1-terra" };
    expect(resolveSubagentModel({ requested: "reviewer", parentModel: "p/m", aliases, tiers: {} })).toEqual({
      model: "acp:codex/gpt-6.1-terra",
      source: "alias",
    });
  });

  test("US-002 AC-8: an alias key written as acp:<agent> wins over explicit-model resolution", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    const aliases = { "acp:codex": "openai/gpt-x" };
    expect(resolveSubagentModel({ requested: "acp:codex", parentModel: "p/m", aliases, tiers: {} })).toEqual({
      model: "openai/gpt-x",
      source: "alias",
    });
  });

  test("US-002 AC-11: still falls back to the parent for an unknown bare name", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(
      resolveSubagentModel({ requested: "unknown-bare-name", parentModel: "p/m", aliases: {}, tiers: {} }),
    ).toEqual({ model: "p/m", source: "fallback" });
  });

  test("ignores inherited Object.prototype keys when looking up aliases", async () => {
    const { resolveSubagentModel } = await import("@/chat/subagent-model");
    expect(resolveSubagentModel({ requested: "constructor", parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "fallback",
    });
  });

  test("AC-18: is exposed from the @/chat barrel", async () => {
    const chat = await import("@/chat");
    expect(typeof chat.resolveSubagentModel).toBe("function");
    expect(chat.resolveSubagentModel({ parentModel: "p/m", aliases: {}, tiers: {} })).toEqual({
      model: "p/m",
      source: "inherit",
    });
  });
});
