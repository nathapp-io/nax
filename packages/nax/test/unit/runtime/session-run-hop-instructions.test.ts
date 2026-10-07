import { describe, expect, test } from "bun:test";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import type { AgentRunOptions } from "@/agents/types";
import { buildHopCallback } from "@/operations";
import { createSessionRunHop } from "@/runtime/session-run-hop";
import type { OpenSessionRequest } from "@/session/types";

const runOptions: AgentRunOptions = {
  prompt: "implement the story",
  workdir: "/repo/.nax-wt/US-006",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
  timeoutSeconds: 60,
  config: makeNaxConfig(),
};

describe("native instruction scopes at dispatch", () => {
  test("the primary operation hop forwards all participating package scopes", async () => {
    let opened: OpenSessionRequest | undefined;
    const sessions = makeSessionManager({
      openSession: async (_name, options) => {
        opened = options;
        return { id: "native-guidance", agentName: "native" };
      },
    });
    const config = makeNaxConfig({ agent: { native: { instructionFileName: "TEAM.md" } } });
    const options = { ...runOptions, config, instructionDirectories: ["apps/api", "packages/client"] };
    const callback = buildHopCallback(
      {
        sessionManager: sessions,
        agentManager: makeMockAgentManager(),
        story: makeStory({ id: "US-006" }),
        config: options.config,
        featureName: "reconcile-admin",
        workdir: options.workdir,
        effectiveTier: "balanced",
        defaultAgent: "native",
        pipelineStage: "run",
      },
      "operation-session",
      options,
    );
    await callback("native", undefined, { kind: "primary" }, options);
    expect(opened?.workdir).toBe(options.workdir);
    expect(opened?.instructionDirectories).toEqual(["apps/api", "packages/client"]);
    expect(opened?.instructionProtectedPaths?.projectStateDir).toBe(".nax");
    expect(opened?.instructionFileName).toBe("TEAM.md");
  });

  test.each([
    { extra: { codingToolWorkdirLabel: "apps/api" }, expected: ["apps/api"] },
    { extra: { codingToolPackageDir: ".nax-wt/US-006/apps/api" }, expected: ["apps/api"] },
    { extra: { codingToolPackageDir: "/repo/.nax-wt/US-006/apps/api" }, expected: ["apps/api"] },
    {
      extra: { instructionDirectories: ["apps/api", "packages/api-client"] },
      expected: ["apps/api", "packages/api-client"],
    },
    { extra: { instructionDirectories: [] }, expected: [] },
    { extra: {}, expected: ["."] },
  ])("uses package scope without changing execution root: $expected", async ({ extra, expected }) => {
    let opened: OpenSessionRequest | undefined;
    const sessions = makeSessionManager({
      openSession: async (_name, options) => {
        opened = options;
        return { id: "native-guidance", agentName: "native" };
      },
    });
    await createSessionRunHop(sessions)("native", { ...runOptions, ...extra });
    expect(opened?.workdir).toBe("/repo/.nax-wt/US-006");
    expect(opened?.instructionDirectories).toEqual(expected);
    expect(opened?.instructionFileName).toBe("AGENTS.md");
  });

  test("preserves host protected paths and configured denied files", async () => {
    let opened: OpenSessionRequest | undefined;
    const sessions = makeSessionManager({
      openSession: async (_name, options) => {
        opened = options;
        return { id: "native-guidance", agentName: "native" };
      },
    });
    await createSessionRunHop(sessions)("native", {
      ...runOptions,
      config: makeNaxConfig({ execution: { denyPaths: ["apps/api/private/**"] } }),
    });
    expect(opened?.instructionDenyPaths).toEqual(["apps/api/private/**"]);
    expect(opened?.instructionProtectedPaths?.projectStateDir).toBe(".nax");
    expect(opened?.instructionProtectedPaths?.credentialDir).toBeTruthy();
  });

  test("leaves ACP instruction discovery with the CLI", async () => {
    let opened: OpenSessionRequest | undefined;
    const sessions = makeSessionManager({
      openSession: async (_name, options) => {
        opened = options;
        return { id: "cli-guidance", agentName: "claude" };
      },
    });
    await createSessionRunHop(sessions)("claude", { ...runOptions, codingToolWorkdirLabel: "apps/api" });
    expect(opened?.instructionDirectories).toBeUndefined();
    expect(opened?.instructionProtectedPaths).toBeUndefined();
    expect(opened?.instructionFileName).toBeUndefined();
  });
});
