import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime } from "../../helpers";
import { autoApproveOp } from "../../../src/operations/auto-approve";
import type { AutoApproveInput } from "../../../src/operations/auto-approve";

const SAMPLE_INPUT: AutoApproveInput = {
  id: "req-1",
  type: "review",
  stage: "review",
  featureName: "feature-a",
  summary: "Run reviewer",
  fallback: "escalate",
  createdAt: Date.now(),
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig({
    interaction: {
      ...overrides,
    },
  });
  const runtime = makeTestRuntime({ config });
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(autoApproveOp.config) };
}

describe("autoApproveOp model resolution", () => {
  test("uses interaction.config.model when set to tier string", () => {
    const ctx = makeCtx({ config: { model: "powerful" } });
    expect(autoApproveOp.model?.(SAMPLE_INPUT, ctx)).toBe("powerful");
  });

  test("falls back to fast when interaction.config.model is invalid shape", () => {
    const ctx = makeCtx({ config: { model: { agent: "opencode", model: "opencode-go/kimi-k2.6" } } });
    expect(autoApproveOp.model?.(SAMPLE_INPUT, ctx)).toBe("fast");
  });

  test("defaults to fast when interaction.config.model is missing", () => {
    const ctx = makeCtx({});
    expect(autoApproveOp.model?.(SAMPLE_INPUT, ctx)).toBe("fast");
  });
});
