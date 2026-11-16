/**
 * The built-in explore agent (chat-polish-and-branch-guard US-003).
 *
 * Like `general`, it is never a catalog entry: `/agents` and `findAgent` stay blind to
 * it, and a discovered agent of the same name always wins.
 */
import { describe, expect, test } from "bun:test";
import { agentNamed, EXPLORE_AGENT_DESCRIPTION, EXPLORE_AGENT_NAME, exploreAgent } from "@/chat/builtin-agent";
import { buildExploreAgentPrompt, buildGeneralAgentPrompt } from "@/prompts";
import { type AgentResource, buildResourceCatalog, type ResourceOrigin, type ResourcePackage } from "@/resources";

const projectOrigin: ResourceOrigin = { kind: "claude-project" };

function discovered(name: string): AgentResource {
  return {
    kind: "agent",
    name,
    qualifiedName: name,
    description: `Discovered ${name}`,
    prompt: `Prompt of ${name}`,
    path: `/fixture/agents/${name}.md`,
    origin: projectOrigin,
  };
}

function pkgOf(agents: readonly AgentResource[]): ResourcePackage {
  return {
    id: "claude-project",
    origin: projectOrigin,
    root: "/fixture",
    skills: [],
    commands: [],
    agents,
    mcpServers: [],
    hooks: [],
    diagnostics: [],
  };
}

const emptyCatalog = () => buildResourceCatalog([]);

describe("EXPLORE_AGENT_NAME", () => {
  test("is explore", () => {
    expect(EXPLORE_AGENT_NAME).toBe("explore");
  });
});

describe("exploreAgent", () => {
  test("AC-10 the built-in explore agent carries its name, description, origin, tools and no model", () => {
    const agent = exploreAgent();
    expect(agent.name).toBe("explore");
    expect(agent.description).toBe(EXPLORE_AGENT_DESCRIPTION);
    expect(agent.description).toBe("Searches and reads the codebase without changing it");
    expect(agent.origin).toEqual({ kind: "nax-builtin" });
    expect(agent.tools).toEqual(["Read", "Glob", "Grep", "Git"]);
    expect("model" in agent).toBe(false);
  });

  test("AC-12 the prompt is buildExploreAgentPrompt()", () => {
    expect(exploreAgent().prompt).toBe(buildExploreAgentPrompt());
  });

  test("stays out of a resource catalog", () => {
    const catalog = emptyCatalog();
    exploreAgent();
    expect(catalog.findAgent(EXPLORE_AGENT_NAME)).toBeUndefined();
  });
});

describe("buildExploreAgentPrompt", () => {
  test("AC-13 is a non-empty prompt of its own", () => {
    const prompt = buildExploreAgentPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toBe(buildGeneralAgentPrompt());
  });
});

describe("agentNamed explore", () => {
  test("AC-10 a catalog with no explore agent resolves the built-in one", () => {
    expect(agentNamed(emptyCatalog(), EXPLORE_AGENT_NAME)).toEqual(exploreAgent());
  });

  test("AC-11 a discovered explore agent wins over the built-in one", () => {
    const catalogExplore = discovered("explore");
    const catalog = buildResourceCatalog([pkgOf([catalogExplore])]);
    expect(agentNamed(catalog, EXPLORE_AGENT_NAME)).toBe(catalogExplore);
  });
});
