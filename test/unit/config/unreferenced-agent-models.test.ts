/**
 * findUnreferencedAgentModels: under the hybrid default, unassigned work runs on
 * agent.default (native). A user-declared `models.<acpx agent>` map that no
 * default, enabled fallback rung, pin, escalation rung, complexity route,
 * routing profile or PRD story reaches is dead config.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { describeUnreferencedAgentModels, findUnreferencedAgentModels } from "@/config";

const CLAUDE_MAP = { fast: "haiku", balanced: "sonnet[medium]", powerful: "opus" };
const PIN = { agent: "claude", model: "balanced" };

describe("findUnreferencedAgentModels", () => {
  test("reports a declared acpx map nothing reaches", () => {
    expect(findUnreferencedAgentModels(makeNaxConfig({ models: { claude: CLAUDE_MAP } }))).toEqual(["claude"]);
  });

  test("the built-in claude map is not a declaration", () => {
    expect(findUnreferencedAgentModels(makeNaxConfig())).toEqual([]);
  });

  test.each([
    ["the default agent", { agent: { default: "claude" } }],
    ["an enabled fallback rung", { agent: { fallback: { enabled: true, map: { native: ["claude"] } } } }],
    ["an enabled fallback object rung", { agent: { fallback: { enabled: true, map: { native: [PIN] } } } }],
    ["a review pin", { review: { semantic: { model: PIN } } }],
    ["a finish reviewer pin", { finish: { reviewers: { quality: PIN } } }],
    ["an acceptance fix pin", { acceptance: { fix: { fixModel: PIN } } }],
    ["an acceptance generate pin", { acceptance: { generateModel: PIN } }],
    [
      "an escalation rung",
      { autoMode: { escalation: { tierOrder: [{ tier: "powerful", agent: "claude", attempts: 1 }] } } },
    ],
    [
      "a complexity route",
      {
        autoMode: {
          complexityRouting: {
            simple: "fast",
            medium: "balanced",
            complex: { tier: "powerful", agent: "claude" },
            expert: "powerful",
          },
        },
      },
    ],
    ["a routing profile target", { routing: { agents: { profiles: [{ id: "c", target: PIN, strengths: ["x"] }] } } }],
  ])("stays silent when %s reaches the map", (_label, overrides) => {
    expect(findUnreferencedAgentModels(makeNaxConfig({ models: { claude: CLAUDE_MAP }, ...overrides }))).toEqual([]);
  });

  test("a PRD story routed to the agent reaches it", () => {
    expect(findUnreferencedAgentModels(makeNaxConfig({ models: { claude: CLAUDE_MAP } }), ["claude"])).toEqual([]);
  });

  test("a rung in a disabled fallback map does not reach the agent", () => {
    const config = makeNaxConfig({
      models: { claude: CLAUDE_MAP },
      agent: { fallback: { enabled: false, map: { native: ["claude"] } } },
    });
    expect(findUnreferencedAgentModels(config)).toEqual(["claude"]);
  });

  test("never reports models.native", () => {
    const config = makeNaxConfig({ agent: { default: "claude" }, models: { native: { fast: "openai/gpt-5.4-mini" } } });
    expect(findUnreferencedAgentModels(config)).toEqual([]);
  });
});

describe("describeUnreferencedAgentModels", () => {
  test("names the map, the default that takes unassigned work, and the agent.default fix", () => {
    const message = describeUnreferencedAgentModels(["claude"], makeNaxConfig());
    expect(message).toContain("models.claude");
    expect(message).toContain('agent.default "native"');
    expect(message).toContain('Set agent.default "claude"');
  });

  test("under protocol native it does not suggest an acpx default the gate would reject", () => {
    const config = makeNaxConfig({ agent: { protocol: "native", default: "native" } });
    const message = describeUnreferencedAgentModels(["claude"], config);
    expect(message).not.toContain('Set agent.default "claude"');
    expect(message).toContain('protocol "native"');
  });
});
