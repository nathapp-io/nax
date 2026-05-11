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

  it("accepts selector.kind = 'verifier-pick'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { selector: { kind: "verifier-pick" } } },
    });
    expect(result.stages.plan.selector?.kind).toBe("verifier-pick");
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

  it("strips extra unknown fields from preDebatePhase (no longer strict)", () => {
    const result = DebateConfigSchema.parse({
      stages: {
        plan: { preDebatePhase: { kind: "grounder", model: "balanced" } },
      },
    });
    expect(result.stages.plan.preDebatePhase?.kind).toBe("grounder");
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

// ─── AC 1 (Phase 2): verifier-pick selector ──────────────────────────────────

describe("DebateStageConfigSchema — verifier-pick selector (Phase 2 AC1)", () => {
  it("preserves selector.patch fields when provided", () => {
    const result = DebateConfigSchema.parse({
      stages: {
        plan: {
          selector: {
            kind: "verifier-pick",
            patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5, onFailure: "use-unpatched" },
          },
        },
      },
    });
    const selector = result.stages.plan.selector as { kind: string; patch?: Record<string, unknown> };
    expect(selector.kind).toBe("verifier-pick");
    expect(selector.patch?.enabled).toBe(true);
    expect(selector.patch?.overlapThreshold).toBe(0.8);
    expect(selector.patch?.maxDeltas).toBe(5);
    expect(selector.patch?.onFailure).toBe("use-unpatched");
  });

  it("leaves patch.overlapThreshold and patch.maxDeltas undefined when omitted", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { selector: { kind: "verifier-pick", patch: { enabled: false } } } },
    });
    const selector = result.stages.plan.selector as { kind: string; patch?: Record<string, unknown> };
    expect(selector.patch?.overlapThreshold).toBeUndefined();
    expect(selector.patch?.maxDeltas).toBeUndefined();
  });

  it("accepts verifier-pick with no patch field", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { selector: { kind: "verifier-pick" } } },
    });
    const selector = result.stages.plan.selector as { kind: string; patch?: unknown };
    expect(selector.kind).toBe("verifier-pick");
    expect(selector.patch).toBeUndefined();
  });

  it("rejects invalid patch.onFailure value with ZodError", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: {
          plan: {
            selector: { kind: "verifier-pick", patch: { enabled: true, onFailure: "invalid-value" } },
          },
        },
      }),
    ).toThrow(z.ZodError);
  });
});

// ─── AC 2 (Phase 2): onBlocker / onFailure ───────────────────────────────────

describe("DebateStageConfigSchema — onBlocker / onFailure (Phase 2 AC2)", () => {
  it("accepts postDebateVerifier.kind 'plan-checklist' with onBlocker 'block'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { postDebateVerifier: { kind: "plan-checklist", onBlocker: "block" } } },
    });
    expect(result.stages.plan.postDebateVerifier?.kind).toBe("plan-checklist");
    expect((result.stages.plan.postDebateVerifier as { onBlocker?: string })?.onBlocker).toBe("block");
  });

  it("accepts postDebateVerifier.kind 'plan-checklist' with onBlocker 'tag-expert'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { postDebateVerifier: { kind: "plan-checklist", onBlocker: "tag-expert" } } },
    });
    expect((result.stages.plan.postDebateVerifier as { onBlocker?: string })?.onBlocker).toBe("tag-expert");
  });

  it("rejects invalid postDebateVerifier.onBlocker value with ZodError", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: { plan: { postDebateVerifier: { kind: "plan-checklist", onBlocker: "do-nothing" } } },
      }),
    ).toThrow(z.ZodError);
  });

  it("accepts preDebatePhase.kind 'grounder' with onFailure 'degrade'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { preDebatePhase: { kind: "grounder", onFailure: "degrade" } } },
    });
    expect((result.stages.plan.preDebatePhase as { onFailure?: string })?.onFailure).toBe("degrade");
  });

  it("accepts preDebatePhase.kind 'grounder' with onFailure 'block'", () => {
    const result = DebateConfigSchema.parse({
      stages: { plan: { preDebatePhase: { kind: "grounder", onFailure: "block" } } },
    });
    expect((result.stages.plan.preDebatePhase as { onFailure?: string })?.onFailure).toBe("block");
  });

  it("rejects invalid preDebatePhase.onFailure value with ZodError", () => {
    expect(() =>
      DebateConfigSchema.parse({
        stages: { plan: { preDebatePhase: { kind: "grounder", onFailure: "ignore" } } },
      }),
    ).toThrow(z.ZodError);
  });
});

// ─── AC 3 (Phase 2): evidenceMode plan-only ──────────────────────────────────

describe("DebateConfigSchema — evidenceMode (Phase 2 AC3)", () => {
  it("accepts stages.plan.evidenceMode === 'asymmetric'", () => {
    const result = DebateConfigSchema.parse({ stages: { plan: { evidenceMode: "asymmetric" } } });
    expect((result.stages.plan as { evidenceMode?: string }).evidenceMode).toBe("asymmetric");
  });

  it("defaults stages.plan.evidenceMode to 'current' when omitted", () => {
    const result = DebateConfigSchema.parse({});
    expect((result.stages.plan as { evidenceMode?: string }).evidenceMode).toBe("current");
  });

  it("rejects unknown evidenceMode value with ZodError", () => {
    expect(() =>
      DebateConfigSchema.parse({ stages: { plan: { evidenceMode: "backwards" } } }),
    ).toThrow(z.ZodError);
  });

  it("does not preserve evidenceMode on non-plan stages (stripped)", () => {
    const result = DebateConfigSchema.parse({ stages: { review: { evidenceMode: "asymmetric" } } });
    expect((result.stages.review as Record<string, unknown>).evidenceMode).toBeUndefined();
  });
});
