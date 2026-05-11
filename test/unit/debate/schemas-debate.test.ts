/**
 * Tests for debate schema extensions (plug-point fields + grounder).
 * AC 1-5 for the "Plug-point schema + contracts + registries" story.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { DebateConfigSchema } from "@/config";

// ─── AC 1: DebateStageConfigSchema defaults ───────────────────────────────────

describe("DebateStageConfigSchema — parse({})", () => {
  it("new optional fields are undefined after parse", () => {
    const result = DebateConfigSchema.parse({});
    const plan = result.stages.plan;
    expect(plan.preDebatePhase).toBeUndefined();
    expect(plan.proposers).toBeUndefined();
    expect(plan.selector).toBeUndefined();
    expect(plan.postDebateVerifier).toBeUndefined();
  });

  it("existing stage fields retain their current defaults", () => {
    const result = DebateConfigSchema.parse({});
    const plan = result.stages.plan;
    expect(plan.enabled).toBe(true);
    expect(plan.sessionMode).toBe("stateful");
    expect(plan.rounds).toBe(3);
    expect(plan.mode).toBe("panel");
    expect(plan.timeoutSeconds).toBe(600);
    expect(plan.autoPersona).toBe(false);
    expect(plan.resolver.type).toBe("synthesis");
  });
});

// ─── AC 2: selector discriminated union ──────────────────────────────────────

describe("DebateStageConfigSchema — selector field", () => {
  const VALID_KINDS = [
    "synthesis",
    "majority-fail-closed",
    "majority-fail-open",
    "judge",
    "dialogue-verdict",
  ] as const;

  for (const kind of VALID_KINDS) {
    it(`accepts selector.kind = '${kind}'`, () => {
      const result = DebateConfigSchema.parse({
        stages: { plan: { selector: { kind } } },
      });
      expect(result.stages.plan.selector?.kind).toBe(kind);
    });
  }

  it("throws ZodError for kind = 'verifier-pick'", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: { plan: { selector: { kind: "verifier-pick" } } },
      }),
    ).toThrow(z.ZodError);
  });

  it("throws ZodError for kind = 'unknown-kind'", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: { plan: { selector: { kind: "unknown-kind" } } },
      }),
    ).toThrow(z.ZodError);
  });
});

// ─── AC 3: proposers field ────────────────────────────────────────────────────

describe("DebateStageConfigSchema — proposers field", () => {
  it("preserves all proposers fields", () => {
    const result = DebateConfigSchema.parse({
      stages: {
        plan: {
          proposers: {
            citationsRequired: true,
            fileReadAccess: true,
            fileReadBudget: 10,
          },
        },
      },
    });
    const proposers = result.stages.plan.proposers;
    expect(proposers?.citationsRequired).toBe(true);
    expect(proposers?.fileReadAccess).toBe(true);
    expect(proposers?.fileReadBudget).toBe(10);
  });
});

// ─── AC 4: preDebatePhase field ───────────────────────────────────────────────

describe("DebateStageConfigSchema — preDebatePhase field", () => {
  it("accepts preDebatePhase.kind = 'grounder'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { preDebatePhase: { kind: "grounder" } } },
    });
    expect(result.stages.plan.preDebatePhase?.kind).toBe("grounder");
  });

  it("accepts preDebatePhase.kind = 'custom'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { preDebatePhase: { kind: "custom" } } },
    });
    expect(result.stages.plan.preDebatePhase?.kind).toBe("custom");
  });

  it("throws ZodError when extra field 'model' is present in preDebatePhase (strict schema)", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: {
          plan: { preDebatePhase: { kind: "grounder", model: "balanced" } },
        },
      }),
    ).toThrow(z.ZodError);
  });
});

// ─── AC 5: DebateConfigSchema grounder block ─────────────────────────────────

describe("DebateConfigSchema — grounder block", () => {
  it("parse({}) returns grounder.model === 'fast' and grounder.timeoutSeconds === 300", () => {
    const result = DebateConfigSchema.parse({});
    expect(result.grounder.model).toBe("fast");
    expect(result.grounder.timeoutSeconds).toBe(300);
  });

  it("parse({ grounder: { model: 'balanced' } }) returns grounder.model === 'balanced'", () => {
    const result = DebateConfigSchema.parse({ grounder: { model: "balanced" } });
    expect(result.grounder.model).toBe("balanced");
    expect(result.grounder.timeoutSeconds).toBe(300);
  });

  it("parse with object model returns grounder.model.agent === 'claude'", () => {
    const result = DebateConfigSchema.parse({
      grounder: { model: { agent: "claude", model: "claude-opus-4-7" } },
    });
    const model = result.grounder.model as { agent: string; model: string };
    expect(model.agent).toBe("claude");
    expect(model.model).toBe("claude-opus-4-7");
  });

  it("parse({ grounder: { timeoutSeconds: 600 } }) returns timeoutSeconds=600, model defaults to 'fast'", () => {
    const result = DebateConfigSchema.parse({ grounder: { timeoutSeconds: 600 } });
    expect(result.grounder.timeoutSeconds).toBe(600);
    expect(result.grounder.model).toBe("fast");
  });
});
