import { describe, expect, test } from "bun:test";
import { getFinishAutoFlowConfig } from "@/plugins";

const withAutoFlow = (autoFlow: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  config: { finish: { autoFlow }, ...rest },
});

describe("getFinishAutoFlowConfig — defaultAgent", () => {
  // Regression: a profile that set only `reviewers` left defaultAgent null, so
  // the plugin passed no `--default-agent` and every non-review node (fix_spec,
  // fix_quality, fix_gate) silently ran on acpx's own default agent — not the
  // one the run had been using.
  test("falls back to the run's own agent when finish.autoFlow.defaultAgent is unset", () => {
    const cfg = getFinishAutoFlowConfig(
      withAutoFlow({ enabled: true, reviewers: { spec: "s", quality: "q" } }, { agent: { default: "claude" } }),
    );
    expect(cfg.defaultAgent).toBe("claude");
  });

  test("an explicit finish.autoFlow.defaultAgent still wins over the run's agent", () => {
    const cfg = getFinishAutoFlowConfig(
      withAutoFlow({ enabled: true, defaultAgent: "codex" }, { agent: { default: "claude" } }),
    );
    expect(cfg.defaultAgent).toBe("codex");
  });

  // resolveDefaultAgent's own fallback — a config with no agent block at all
  // still names an agent rather than deferring to whatever acpx defaults to.
  test("a config with no agent block resolves to nax's fallback agent, never null", () => {
    const cfg = getFinishAutoFlowConfig(withAutoFlow({ enabled: true }));
    expect(cfg.defaultAgent).toBe("claude");
  });

  test("reviewers still default to null, so acpx uses --default-agent for them", () => {
    const cfg = getFinishAutoFlowConfig(withAutoFlow({ enabled: true }));
    expect(cfg.reviewers).toEqual({ spec: null, quality: null });
  });
});

describe("getFinishAutoFlowConfig — unrelated defaults are unchanged", () => {
  test("a context with no finish block at all still reports disabled", () => {
    expect(getFinishAutoFlowConfig({ config: {} }).enabled).toBe(false);
  });

  test("timeouts fall back to the schema defaults", () => {
    const cfg = getFinishAutoFlowConfig(withAutoFlow({ enabled: true, timeouts: { gateMs: 1234 } }));
    expect(cfg.timeouts.gateMs).toBe(1234);
    expect(cfg.timeouts.acceptanceMs).toBe(600_000);
  });
});
