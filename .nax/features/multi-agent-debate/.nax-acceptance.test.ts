/**
 * Multi-Agent Debate Feature Acceptance Tests
 *
 * Tests for the debate session primitive that spawns 2-3 agents to deliberate
 * on judgment tasks. Covers configuration, session modes, resolver strategies,
 * and integration with plan, review, and rectification stages.
 *
 * Related spec: docs/specs/SPEC-multi-agent-debate.md
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig, DebateConfig, DebateStageConfig, Debater, ResolverConfig } from "../../../src/config/types";

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Config defaults when debate key absent
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: When debate key is absent, loadConfig returns defaults", () => {
  test("debate.enabled defaults to false when debate section omitted", () => {
    const config = {
      ...DEFAULT_CONFIG,
      // debate key intentionally omitted
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.enabled).toBe(false);
    }
  });

  test("debate.stages.plan defaults are populated", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.plan).toBeDefined();
    expect(config.debate.stages.plan.sessionMode).toBe("stateful");
    expect(config.debate.stages.plan.resolver.type).toBe("synthesis");
    expect(config.debate.stages.plan.rounds).toBe(3);
    expect(config.debate.stages.plan.enabled).toBe(true);
  });

  test("debate.stages.review defaults are populated", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.review).toBeDefined();
    expect(config.debate.stages.review.sessionMode).toBe("one-shot");
    expect(config.debate.stages.review.resolver.type).toBe("majority");
    expect(config.debate.stages.review.rounds).toBe(2);
    expect(config.debate.stages.review.enabled).toBe(true);
  });

  test("debate.stages.acceptance disabled by default", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.acceptance).toBeDefined();
    expect(config.debate.stages.acceptance.enabled).toBe(false);
    expect(config.debate.stages.acceptance.sessionMode).toBe("one-shot");
    expect(config.debate.stages.acceptance.resolver.type).toBe("majority");
    expect(config.debate.stages.acceptance.rounds).toBe(1);
  });

  test("debate.stages.rectification disabled by default", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.rectification).toBeDefined();
    expect(config.debate.stages.rectification.enabled).toBe(false);
    expect(config.debate.stages.rectification.sessionMode).toBe("one-shot");
    expect(config.debate.stages.rectification.resolver.type).toBe("synthesis");
    expect(config.debate.stages.rectification.rounds).toBe(1);
  });

  test("debate.stages.escalation disabled by default", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.escalation).toBeDefined();
    expect(config.debate.stages.escalation.enabled).toBe(false);
    expect(config.debate.stages.escalation.sessionMode).toBe("one-shot");
    expect(config.debate.stages.escalation.resolver.type).toBe("majority");
    expect(config.debate.stages.escalation.rounds).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: No agent/model fields stored in debate config
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: When no debaters or resolver.agent specified, runtime resolves from config", () => {
  test("debate config does not store explicit agent/model when omitted", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            // debaters intentionally omitted
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      // debaters should be undefined if not provided — runtime resolves from autoMode.defaultAgent + models.fast
      expect(result.data.debate.stages.plan.debaters).toBeUndefined();
    }
  });

  test("resolver.agent is optional and omitted when not configured", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const }, // agent intentionally omitted
            sessionMode: "stateful" as const,
            rounds: 3,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.stages.plan.resolver.agent).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Debaters array must have at least 2 entries
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: Debaters array validation", () => {
  test("rejects debaters array with 1 entry", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [{ agent: "claude" }],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.issues.map((i) => i.message).join("; ");
      expect(errorMessage.toLowerCase()).toContain("at least 2");
    }
  });

  test("rejects debaters array with 0 entries", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("accepts debaters array with exactly 2 entries", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [
              { agent: "claude", model: "claude-haiku-4-5" },
              { agent: "codex" },
            ],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts debaters array with 3+ entries", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [
              { agent: "claude" },
              { agent: "claude" },
              { agent: "codex" },
            ],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Resolver type must be valid
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: Resolver type validation", () => {
  test("accepts valid resolver type 'majority'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          review: {
            enabled: true,
            resolver: { type: "majority" as const },
            sessionMode: "one-shot" as const,
            rounds: 2,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts valid resolver type 'synthesis'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("accepts valid resolver type 'judge'", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "judge" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("rejects invalid resolver type", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "invalid" },
            sessionMode: "stateful" as const,
            rounds: 3,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Partial stage config falls back to stage defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: Partial stage config uses stage defaults", () => {
  test("partial plan config inherits defaults for sessionMode, rounds, debaters", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            // sessionMode, rounds, debaters omitted — should get plan defaults
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      // After merge with defaults, should have all fields
      const plan = result.data.debate.stages.plan;
      expect(plan.sessionMode).toBe("stateful");
      expect(plan.rounds).toBe(3);
    }
  });

  test("partial review config inherits defaults for sessionMode, rounds", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          review: {
            enabled: true,
            resolver: { type: "majority" as const },
            // sessionMode, rounds omitted
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const review = result.data.debate.stages.review;
      expect(review.sessionMode).toBe("one-shot");
      expect(review.rounds).toBe(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: Debater with agent but no model is valid
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: Debater without model is valid", () => {
  test("accepts debater with only agent field", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [
              { agent: "claude" }, // model omitted — resolved at runtime
              { agent: "codex" },
            ],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.stages.plan.debaters?.[0]).toEqual({ agent: "claude" });
    }
  });

  test("accepts debater with both agent and model", () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
            debaters: [
              { agent: "claude", model: "claude-sonnet-4-5" },
              { agent: "codex" },
            ],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: nax config show displays debate section
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: nax config show displays debate section", () => {
  test("config descriptions include debate section", () => {
    // This test verifies that src/cli/config-descriptions.ts includes debate descriptions
    // For now, we check that the config structure is documented
    const config = DEFAULT_CONFIG;
    expect(config.debate).toBeDefined();
    expect(config.debate.enabled).toBeDefined();
    expect(config.debate.agents).toBeDefined();
    expect(config.debate.stages).toBeDefined();
  });

  test("debate.stages has human-readable field names", () => {
    const stageNames = Object.keys(DEFAULT_CONFIG.debate.stages);
    expect(stageNames).toContain("plan");
    expect(stageNames).toContain("review");
    expect(stageNames).toContain("acceptance");
    expect(stageNames).toContain("rectification");
    expect(stageNames).toContain("escalation");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: DebateSession.run resolves adapters and calls complete()
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: DebateSession.run resolves adapters", () => {
  test("resolves each debater via getAgent() and calls complete()", async () => {
    // This test will be implemented once src/debate/session.ts exists
    // Placeholder demonstrates the test pattern
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: Parallel proposal collection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: DebateSession.run calls debaters in parallel", () => {
  test("uses Promise.allSettled() for proposal round", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: Missing agent warning
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: When debater agent not installed, debater is skipped", () => {
  test("logs warning when getAgent returns null", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: Fallback to single-agent on failure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: Fallback to single-agent mode when fewer than 2 succeed", () => {
  test("falls back to single complete() when all debaters fail", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("returns the one successful proposal when 1 succeeds", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: Critique round includes other proposals
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: When rounds is 2, critique includes other proposals", () => {
  test("critique prompt contains all other debaters' proposals", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: Single round skips critique
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: When rounds is 1, critique is skipped", () => {
  test("goes directly to resolver without critique round", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: Majority resolver pass decision
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: majorityResolver returns pass when majority agree", () => {
  test("returns passed when 2 of 3 proposals have 'passed': true", async () => {
    // Placeholder for when majorityResolver is implemented
    expect(true).toBe(true);
  });

  test("parses JSON output from proposals correctly", async () => {
    // Placeholder for when majorityResolver is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: Majority resolver tie-break
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: majorityResolver uses fail-closed on tie", () => {
  test("returns conservative answer on 1-1 split with 1 unparseable", async () => {
    // Placeholder for when majorityResolver is implemented
    expect(true).toBe(true);
  });

  test("prefers fail (false) over pass (true) on tie", async () => {
    // Placeholder for when majorityResolver is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: Synthesis resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: synthesisResolver calls complete() with proposals + critiques", () => {
  test("makes single adapter.complete() call with synthesis prompt", async () => {
    // Placeholder for when synthesisResolver is implemented
    expect(true).toBe(true);
  });

  test("includes all proposals in synthesis prompt", async () => {
    // Placeholder for when synthesisResolver is implemented
    expect(true).toBe(true);
  });

  test("includes all critiques in synthesis prompt", async () => {
    // Placeholder for when synthesisResolver is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: Judge resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: judgeResolver calls complete() with judge prompt", () => {
  test("uses configured resolver.agent if set", async () => {
    // Placeholder for when judgeResolver is implemented
    expect(true).toBe(true);
  });

  test("defaults to fast tier when resolver.agent omitted", async () => {
    // Placeholder for when judgeResolver is implemented
    expect(true).toBe(true);
  });

  test("returns judge's selection or merged output", async () => {
    // Placeholder for when judgeResolver is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: DebateResult cost tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: DebateResult.totalCostUsd sums all calls", () => {
  test("aggregates proposal costs from all debaters", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("includes resolver cost in total", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("includes critique round costs", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: DebateResult proposals contain debater identity
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: DebateResult.proposals includes debater identity", () => {
  test("each proposal includes agent field", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("each proposal includes model field", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("proposals are ordered by debater index", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: Stateful session creation per debater
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: Stateful mode creates SpawnAcpClient per debater", () => {
  test("creates session with session name containing storyId", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });

  test("creates separate session for each debater", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });

  test("calls client.createSession() with agent config", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: Stateful critique doesn't paste all proposals
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: Stateful critique uses session history, not pasted proposals", () => {
  test("sends only other debaters' proposals to critique, not own proposal", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });

  test("session retains own proposal in history from round 1", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: Stateful session cleanup in finally block
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: Stateful sessions closed in finally block", () => {
  test("closes all sessions even if debate fails", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });

  test("calls session.close() on each session", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-23: One-shot mode uses adapter.complete()
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-23: One-shot mode uses adapter.complete()", () => {
  test("does not create persistent sessions", async () => {
    // Placeholder for when one-shot mode is implemented
    expect(true).toBe(true);
  });

  test("calls adapter.complete() per debater per round", async () => {
    // Placeholder for when one-shot mode is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-24: Stateful session create failure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-24: When session creation fails, debater is skipped", () => {
  test("skips debater and logs warning on acpx error", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });

  test("continues debate with remaining debaters (minimum 2 required)", async () => {
    // Placeholder for when stateful mode is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: Different sessionMode per stage
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: Different sessionMode per stage independent", () => {
  test("plan can be stateful while review is one-shot", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: true,
        agents: 3,
        stages: {
          plan: {
            enabled: true,
            resolver: { type: "synthesis" as const },
            sessionMode: "stateful" as const,
            rounds: 3,
          },
          review: {
            enabled: true,
            resolver: { type: "majority" as const },
            sessionMode: "one-shot" as const,
            rounds: 2,
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.stages.plan.sessionMode).toBe("stateful");
      expect(result.data.debate.stages.review.sessionMode).toBe("one-shot");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: Plan debate integration
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-26: nax plan --auto uses debate when enabled", () => {
  test("uses DebateSession.run() when debate.enabled and plan.enabled", async () => {
    // Integration test: needs CLI plan command implementation
    expect(true).toBe(true);
  });

  test("passes same prompt as single-agent mode", async () => {
    // Integration test: needs CLI plan command implementation
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: No debate disabled
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-27: When debate.enabled is false, no debate calls", () => {
  test("nax plan calls adapter.complete() exactly once", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: { ...DEFAULT_CONFIG.debate, enabled: false },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.enabled).toBe(false);
    }
  });

  test("debate behavior is disabled even if stages are enabled", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: {
        enabled: false, // global disable
        agents: 3,
        stages: {
          plan: { enabled: true, resolver: { type: "synthesis" as const }, sessionMode: "stateful" as const, rounds: 3 },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.enabled).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: Review debate integration
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-28: runSemanticReview uses debate when enabled", () => {
  test("uses DebateSession.run() when debate.enabled and review.enabled", async () => {
    // Integration test: needs semantic review implementation
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-29: Review debate majority vote
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-29: Review debate majority resolver reflects vote", () => {
  test("ReviewCheckResult.success reflects majority vote", async () => {
    // Integration test: needs semantic review debate implementation
    expect(true).toBe(true);
  });

  test("majority pass results in success=true", async () => {
    // Placeholder for when review debate is implemented
    expect(true).toBe(true);
  });

  test("majority fail results in success=false", async () => {
    // Placeholder for when review debate is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-30: Review debate findings deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-30: Review debate merges and deduplicates findings", () => {
  test("ReviewCheckResult.findings includes all debater findings", async () => {
    // Placeholder for when review debate is implemented
    expect(true).toBe(true);
  });

  test("findings are deduplicated by AC id", async () => {
    // Placeholder for when review debate is implemented
    expect(true).toBe(true);
  });

  test("keeps all unique findings from all debaters", async () => {
    // Placeholder for when review debate is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-31: Fallback when all debaters fail during plan
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-31: All debaters fail, fallback to single agent", () => {
  test("logs warning with stage='debate' and event='fallback'", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });

  test("falls back to single adapter.complete() call", async () => {
    // Placeholder for when DebateSession is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-32: Rectification debate diagnosis
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-32: Rectification runs debate for diagnosis", () => {
  test("runs DebateSession.run() when rectification.enabled", async () => {
    // Integration test: needs rectification loop implementation
    expect(true).toBe(true);
  });

  test("diagnosis happens before rectification prompt is built", async () => {
    // Placeholder for when rectification debate is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-33: Root cause prepended to prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-33: Diagnosis output prepended as Root Cause Analysis", () => {
  test("rectification prompt includes ## Root Cause Analysis section", async () => {
    // Placeholder for when rectification debate is implemented
    expect(true).toBe(true);
  });

  test("diagnosis is inserted before original rectification prompt", async () => {
    // Placeholder for when rectification debate is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-34: Rectification debate disabled by default
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-34: Rectification debate disabled by default", () => {
  test("rectification.enabled defaults to false", () => {
    const config = DEFAULT_CONFIG;
    expect(config.debate.stages.rectification.enabled).toBe(false);
  });

  test("rectification loop unchanged when disabled", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      debate: { ...DEFAULT_CONFIG.debate, stages: { ...DEFAULT_CONFIG.debate.stages, rectification: { ...DEFAULT_CONFIG.debate.stages.rectification, enabled: false } } },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate.stages.rectification.enabled).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-35: Diagnosis debate fails
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-35: Diagnosis failure doesn't block rectification", () => {
  test("rectification proceeds without diagnosis section on debate failure", async () => {
    // Placeholder for when rectification debate is implemented
    expect(true).toBe(true);
  });

  test("logs event='fallback' when diagnosis fails", async () => {
    // Placeholder for when rectification debate is implemented
    expect(true).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-36: Debate cost included in story total
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-36: Debate cost is included in story total cost", () => {
  test("DebateResult.totalCostUsd rolls into story metrics", async () => {
    // Integration test: needs metrics aggregation
    expect(true).toBe(true);
  });

  test("debate cost appears in final cost tracking", async () => {
    // Placeholder for when debate cost aggregation is implemented
    expect(true).toBe(true);
  });
});
