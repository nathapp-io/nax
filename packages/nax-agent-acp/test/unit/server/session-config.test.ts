import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TierModel } from "#src/server/nax-config";
import {
  applyConfigChange,
  applyModeChange,
  BASH_OPTION,
  configOptions,
  MODE_OPTION,
  MODEL_OPTION,
  modeState,
  SESSION_MODES,
  type SessionSettings,
  sameSettings,
} from "#src/server/session-config";

const TIERS: readonly TierModel[] = [
  { tier: "fast", model: "anthropic/claude-haiku-4-5" },
  { tier: "balanced", model: "anthropic/claude-sonnet-5-5", contextWindow: 200_000 },
  { tier: "powerful", model: "anthropic/claude-sonnet-5-5" },
];
const BASE: SessionSettings = { mode: "full", model: "anthropic/claude-sonnet-5-5", bashApproval: "gated" };

function rejects(run: () => unknown): RequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestError) return error;
  }
  throw new Error("expected a RequestError");
}

describe("modes (spec §5.2, M-27)", () => {
  test("four modes, current one selected", () => {
    expect(SESSION_MODES.map((m) => m.id)).toEqual(["none", "read", "ask", "full"]);
    expect(modeState(BASE)).toEqual({ currentModeId: "full", availableModes: [...SESSION_MODES] });
  });

  test("switching to ask coerces bash approval to gated (M-23)", () => {
    expect(applyModeChange({ ...BASE, bashApproval: "raw" }, "ask")).toEqual({
      ...BASE,
      mode: "ask",
      bashApproval: "gated",
    });
    expect(applyModeChange(BASE, "read")).toEqual({ ...BASE, mode: "read" });
  });

  test("an unknown mode is invalid_params", () => {
    expect(rejects(() => applyModeChange(BASE, "yolo")).code).toBe(-32602);
  });
});

describe("config options (spec §5.2, §5.3)", () => {
  test("model lists tiers (deduplicated by model) and bashApproval lists the three modes", () => {
    const [mode, model, bash] = configOptions(BASE, TIERS);
    expect(mode).toMatchObject({
      id: MODE_OPTION,
      type: "select",
      category: "mode",
      currentValue: "full",
      options: SESSION_MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
    });
    expect(model).toMatchObject({
      id: MODEL_OPTION,
      type: "select",
      category: "model",
      currentValue: "anthropic/claude-sonnet-5-5",
      options: [
        { value: "anthropic/claude-haiku-4-5", name: "fast", description: "anthropic/claude-haiku-4-5" },
        { value: "anthropic/claude-sonnet-5-5", name: "balanced", description: "anthropic/claude-sonnet-5-5" },
      ],
    });
    expect(bash).toMatchObject({ id: BASH_OPTION, type: "select", currentValue: "gated" });
    expect(bash?.type === "select" ? bash.options.map((o) => ("value" in o ? o.value : "")) : []).toEqual([
      "gated",
      "escalate",
      "raw",
    ]);
  });

  test("a current model outside the tiers is listed too (set by --model)", () => {
    const model = configOptions({ ...BASE, model: "openai/gpt-x" }, TIERS)[1];
    expect(model?.type === "select" ? model.options.at(-1) : undefined).toEqual({
      value: "openai/gpt-x",
      name: "openai/gpt-x",
      description: "current model",
    });
  });

  test("a model change must name a listed model; the error lists the valid ids", () => {
    expect(applyConfigChange(BASE, MODEL_OPTION, "anthropic/claude-haiku-4-5", TIERS).model).toBe(
      "anthropic/claude-haiku-4-5",
    );
    const error = rejects(() => applyConfigChange(BASE, MODEL_OPTION, "nope/x", TIERS));
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("anthropic/claude-haiku-4-5, anthropic/claude-sonnet-5-5");
  });

  test("bashApproval other than gated under ask is invalid_params; under full it applies", () => {
    expect(rejects(() => applyConfigChange({ ...BASE, mode: "ask" }, BASH_OPTION, "raw", TIERS)).code).toBe(-32602);
    expect(applyConfigChange(BASE, BASH_OPTION, "escalate", TIERS).bashApproval).toBe("escalate");
    expect(rejects(() => applyConfigChange(BASE, BASH_OPTION, "loose", TIERS)).code).toBe(-32602);
  });

  test("a mode change goes through applyModeChange: ask coerces bash to gated; unknown is invalid_params", () => {
    expect(applyConfigChange({ ...BASE, bashApproval: "raw" }, MODE_OPTION, "ask", TIERS)).toEqual({
      ...BASE,
      mode: "ask",
      bashApproval: "gated",
    });
    expect(rejects(() => applyConfigChange(BASE, MODE_OPTION, "yolo", TIERS)).code).toBe(-32602);
  });

  test("an unknown option or a non-string value is invalid_params", () => {
    expect(rejects(() => applyConfigChange(BASE, "temperature", "1", TIERS)).code).toBe(-32602);
    expect(rejects(() => applyConfigChange(BASE, MODEL_OPTION, true, TIERS)).code).toBe(-32602);
  });

  test("sameSettings compares all three fields", () => {
    expect(sameSettings(BASE, { ...BASE })).toBe(true);
    expect(sameSettings(BASE, { ...BASE, bashApproval: "raw" })).toBe(false);
  });
});
