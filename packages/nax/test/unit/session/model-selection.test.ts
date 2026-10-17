import { describe, expect, test } from "bun:test";
import { selectModel } from "@/session/model-selection";

describe("selectModel", () => {
  test("hands the adapter a SessionModel with config pricing converted", () => {
    const out = selectModel({
      modelDef: { provider: "p", model: "m", pricing: { inputPer1M: 2, outputPer1M: 8 } },
      modelTier: "balanced",
    });
    expect(out).toEqual({
      modelDef: { provider: "p", model: "m", pricing: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 } },
      modelTier: "balanced",
    });
  });

  test("omits modelTier when the model came from a pin", () => {
    expect("modelTier" in selectModel({ modelDef: { provider: "p", model: "m" } })).toBe(false);
  });

  // US-002 (codex-acp-read-only). The codex env is injected only when the
  // caller supplies the settings; the one-argument form is unchanged.
  test("AC-18: a one-argument call injects no codex env, even for codex", () => {
    const out = selectModel({
      modelDef: { provider: "openai", model: "gpt", env: {} },
      agentName: "codex",
    });

    expect("CODEX_HOME" in (out.modelDef.env ?? {})).toBe(false);
    expect("INITIAL_AGENT_MODE" in (out.modelDef.env ?? {})).toBe(false);
  });

  test("US-002: the settings argument adds the codex env to the SessionModel def", () => {
    const out = selectModel(
      { modelDef: { provider: "openai", model: "gpt", env: { A: "1" } }, agentName: "codex" },
      { isolateHome: false, fullMode: "agent-full-access" },
    );

    expect(out.modelDef.env).toEqual({ A: "1", INITIAL_AGENT_MODE: "agent-full-access" });
  });

  test("US-002: settings for a non-codex agent leave the model def alone", () => {
    const out = selectModel(
      { modelDef: { provider: "anthropic", model: "claude-haiku", env: {} }, agentName: "claude" },
      { isolateHome: true, fullMode: "agent-full-access" },
    );

    expect(out.modelDef.env).toEqual({});
  });
});
