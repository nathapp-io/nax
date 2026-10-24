import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { AgentRoutingConfig, AgentRoutingProfile } from "@/config";
import { getLogger } from "@/logger";
import { _persistPrdDeps, finalizeAndWritePrd } from "@/plan/strategies";
import type { PRD } from "@/prd/types";

const PROFILES: AgentRoutingProfile[] = [
  { id: "a", target: { agent: "claude", model: "balanced" }, strengths: ["implementation"], costTier: "low" },
  { id: "b", target: { agent: "claude", model: "balanced" }, strengths: ["implementation"], costTier: "medium" },
];
const ROUTING: AgentRoutingConfig = { enabled: true, strategy: "off", profiles: PROFILES };
const MESSAGE = "agent profile assignment";
const originalDeps = { ..._persistPrdDeps };
let info: Mock<ReturnType<typeof getLogger>["info"]>;
let warn: Mock<ReturnType<typeof getLogger>["warn"]>;

beforeEach(() => {
  info = spyOn(getLogger(), "info");
  warn = spyOn(getLogger(), "warn");
  _persistPrdDeps.discoverWorkspacePackages = async () => [];
  _persistPrdDeps.existsSync = () => false;
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  Object.assign(_persistPrdDeps, originalDeps);
});

function prdWithProfiles(ids: (string | undefined)[]): PRD {
  return makePRD({
    userStories: ids.map((agentProfileId, index) =>
      makeStory({
        id: `US-${String(index + 1).padStart(3, "0")}`,
        workdirSource: "defaulted",
        routing: {
          complexity: "medium",
          testStrategy: "test-after",
          reasoning: "model choice",
          ...(agentProfileId === undefined ? {} : { agentProfileId }),
        },
      }),
    ),
  });
}

async function persist(
  prd: PRD,
  agentRouting: AgentRoutingConfig | undefined = ROUTING,
  scope?: ReadonlySet<string>,
): Promise<PRD> {
  let written = "";
  const path = await finalizeAndWritePrd({
    prd,
    agentRouting,
    scope,
    specContent: "",
    featureName: "f",
    projectName: "p",
    profileName: undefined,
    models: makeNaxConfig().models,
    defaultAgent: "claude",
    outputPath: "/repo/prd.json",
    repoRoot: "/repo",
    writeFile: async (_path, content) => {
      // Enabled routing must log before writing, not after persistence.
      if (agentRouting?.enabled && agentRouting.profiles.length > 0) {
        expect(info.mock.calls.filter((call) => call[1] === MESSAGE)).toHaveLength(1);
      }
      written = content;
    },
  });
  expect(path).toBe("/repo/prd.json");
  return JSON.parse(written);
}

function expectDistribution(data: Record<string, unknown>): void {
  expect(info.mock.calls).toEqual([["plan", MESSAGE, data]]);
}

describe("finalizeAndWritePrd profile distribution", () => {
  test("AC-12, AC-20: logs a/a/b exactly once through info, never warn", async () => {
    await persist(prdWithProfiles(["a", "a", "b"]));
    expectDistribution({ storyCount: 3, byProfile: { a: 2, b: 1 }, unassigned: 0 });
    expect(warn.mock.calls.filter((call) => call[1] === MESSAGE)).toEqual([]);
  });
  test("AC-13: absent profile without default is unassigned", async () => {
    await persist(prdWithProfiles([undefined]), { ...ROUTING, profiles: PROFILES.slice(0, 1) });
    expectDistribution({ storyCount: 1, byProfile: {}, unassigned: 1 });
  });
  test("AC-14: counts unknown id under finalized default, not unknown id", async () => {
    const written = await persist(prdWithProfiles(["zzz"]), { ...ROUTING, default: "a" });
    expect(written.userStories[0]?.routing?.agentProfileId).toBe("a");
    expectDistribution({ storyCount: 1, byProfile: { a: 1 }, unassigned: 0 });
  });
  test("AC-15: unknown id without default is unassigned", async () => {
    const written = await persist(prdWithProfiles(["zzz"]), { ...ROUTING, profiles: PROFILES.slice(0, 1) });
    expect(written.userStories[0]?.routing?.agentProfileId).toBe("zzz");
    expectDistribution({ storyCount: 1, byProfile: {}, unassigned: 1 });
  });
  test("AC-16: counts only scoped finalized stories", async () => {
    await persist(prdWithProfiles(["a", "b"]), ROUTING, new Set(["US-002"]));
    expectDistribution({ storyCount: 1, byProfile: { b: 1 }, unassigned: 0 });
  });
  test.each([
    ["AC-17", undefined],
    ["AC-18", { ...ROUTING, enabled: false, profiles: PROFILES.slice(0, 1) }],
    ["AC-19", { ...ROUTING, profiles: [] }],
  ] satisfies Array<[string, AgentRoutingConfig | undefined]>)(
    "%s, AC-21: inactive routing is silent and preserves written PRD",
    async (_ac, routing) => {
      const prd = prdWithProfiles(["a", undefined, "zzz"]);
      // Explicitly supply undefined through the args rather than the helper default.
      const inactive = routing ?? undefined;
      let written = "";
      await finalizeAndWritePrd({
        prd,
        agentRouting: inactive,
        specContent: "",
        featureName: "f",
        projectName: "p",
        profileName: undefined,
        models: makeNaxConfig().models,
        defaultAgent: "claude",
        outputPath: "/repo/prd.json",
        repoRoot: "/repo",
        writeFile: async (_path, content) => {
          written = content;
        },
      });
      expect(info.mock.calls.filter((call) => call[1] === MESSAGE)).toEqual([]);
      expect(written).toBe(JSON.stringify({ ...prd, project: "p", routingProfile: "default" }, null, 2));
    },
  );
  test("AC-22: medium model choice remains b despite cheaper a", async () => {
    const written = await persist(prdWithProfiles(["b"]));
    expect(written.userStories[0]?.routing?.complexity).toBe("medium");
    expect(written.userStories[0]?.routing?.agentProfileId).toBe("b");
    expectDistribution({ storyCount: 1, byProfile: { b: 1 }, unassigned: 0 });
  });
  test("empty scope counts zero stories", async () => {
    await persist(prdWithProfiles(["a"]), ROUTING, new Set());
    expectDistribution({ storyCount: 0, byProfile: {}, unassigned: 0 });
  });
  test("profile ids matching object prototype names are counted normally", async () => {
    await persist(prdWithProfiles(["__proto__", "constructor", "__proto__"]), {
      ...ROUTING,
      profiles: ["__proto__", "constructor"].map((id) => ({
        ...PROFILES[0],
        id,
        target: { agent: "claude", model: "balanced" },
        strengths: [],
      })),
    });
    expectDistribution({ storyCount: 3, byProfile: { ["__proto__"]: 2, constructor: 1 }, unassigned: 0 });
  });
});
