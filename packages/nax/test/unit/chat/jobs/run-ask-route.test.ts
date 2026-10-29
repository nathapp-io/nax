import { describe, expect, test } from "bun:test";
import { MAX_CONSECUTIVE_AGENT_ASKS, routeRunAsk } from "@/chat/jobs/run-ask-route";
import type { InteractionRequest } from "@/interaction/types";

const request: InteractionRequest = {
  id: "ix-1",
  type: "confirm",
  featureName: "feature",
  stage: "execution",
  summary: "Continue?",
  fallback: "escalate",
  createdAt: 0,
};

describe("routeRunAsk", () => {
  test.each([
    ["AC-1 no chain", {}, true, 0, undefined, "human"],
    ["AC-2 inactive chain", { chainId: "chain-1" }, false, 0, undefined, "human"],
    ["AC-3 red safety", { chainId: "chain-1" }, true, 0, { safety: "red" }, "human"],
    ["AC-4 pre-merge", { chainId: "chain-1" }, true, 0, { trigger: "pre-merge" }, "human"],
    ["AC-5 human-review", { chainId: "chain-1" }, true, 0, { trigger: "human-review" }, "human"],
    ["AC-6 streak limit", { chainId: "chain-1" }, true, 3, undefined, "human"],
    ["AC-7 cost-warning", { chainId: "chain-1" }, true, 0, { trigger: "cost-warning" }, "agent"],
    ["AC-8 tool approval", { chainId: "chain-1" }, true, 0, { approvalPrompt: true }, "agent"],
    ["above streak limit", { chainId: "chain-1" }, true, 4, undefined, "human"],
    ["below streak limit", { chainId: "chain-1" }, true, 2, undefined, "agent"],
    ["no metadata", { chainId: "chain-1" }, true, 0, undefined, "agent"],
  ] as const)("%s", (_name, job, chainActive, agentStreak, metadata, expected) => {
    expect(routeRunAsk({ job, chainActive, agentStreak, request: { ...request, metadata } })).toBe(expected);
  });

  test("AC-6 the named limit is three", () => {
    expect(MAX_CONSECUTIVE_AGENT_ASKS).toBe(3);
  });
});
