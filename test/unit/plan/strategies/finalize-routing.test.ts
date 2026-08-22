import { describe, expect, test } from "bun:test";
import type { AgentRoutingConfig } from "@/config";
import { finalizePrdRouting } from "@/plan";
import type { PRD } from "@/prd/types";
import { makePRD } from "@test/helpers";

const agentRouting: AgentRoutingConfig = {
  enabled: true,
  strategy: "off",
  default: "opencode-structural",
  profiles: [
    { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
    { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
  ],
};

function prdWith(routing: Record<string, unknown>): PRD {
  return makePRD({
    project: "p",
    feature: "f",
    branchName: "feat/f",
    userStories: [
      {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        attempts: 0,
        escalations: [],
        routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "r", ...routing },
      },
    ],
  });
}

describe("finalizePrdRouting", () => {
  test("resolves agentProfileId to agent + tier and stamps origin fields", () => {
    const out = finalizePrdRouting(prdWith({ agentProfileId: "claude-final" }), agentRouting, "cross-agent");
    const r = out.userStories[0].routing;
    expect(r?.agent).toBe("claude");
    expect(r?.agentProfileId).toBe("claude-final");
    expect(r?.profileModelTier).toBe("balanced");
    expect(r?.initialAgent).toBe("claude");
    expect(r?.initialProfileId).toBe("claude-final");
    expect(out.routingProfile).toBe("cross-agent");
  });

  test("applies the default profile when no id was selected", () => {
    const out = finalizePrdRouting(prdWith({}), agentRouting, undefined);
    expect(out.userStories[0].routing?.agent).toBe("opencode");
    expect(out.routingProfile).toBe("default");
  });

  test("never overwrites an existing initialAgent (escalation origin is sticky)", () => {
    const out = finalizePrdRouting(
      prdWith({ agentProfileId: "claude-final", initialAgent: "opencode", initialProfileId: "opencode-structural" }),
      agentRouting,
      "cross-agent",
    );
    expect(out.userStories[0].routing?.initialAgent).toBe("opencode");
    expect(out.userStories[0].routing?.initialProfileId).toBe("opencode-structural");
  });

  test("leaves stories untouched when routing is disabled but still records routingProfile", () => {
    const out = finalizePrdRouting(prdWith({}), { ...agentRouting, enabled: false }, "cross-agent");
    expect(out.userStories[0].routing?.agent).toBeUndefined();
    expect(out.routingProfile).toBe("cross-agent");
  });

  test("does not mutate the input PRD", () => {
    const input = prdWith({ agentProfileId: "claude-final" });
    finalizePrdRouting(input, agentRouting, "cross-agent");
    expect(input.userStories[0].routing?.agent).toBeUndefined();
  });
});
