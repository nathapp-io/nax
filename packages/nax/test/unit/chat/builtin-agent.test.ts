import { describe, expect, test } from "bun:test";
import { GENERAL_AGENT_NAME, generalAgent } from "@/chat";
import { GENERAL_AGENT_DESCRIPTION } from "@/chat/builtin-agent";
import { buildGeneralAgentPrompt } from "@/prompts";
import { buildResourceCatalog } from "@/resources";

describe("GENERAL_AGENT_NAME", () => {
  test("AC-1: is general", () => {
    expect(GENERAL_AGENT_NAME).toBe("general");
  });
});

describe("generalAgent", () => {
  test("AC-2: is an agent named and qualified as the general agent", () => {
    const agent = generalAgent();
    expect(agent.kind).toBe("agent");
    expect(agent.name).toBe(GENERAL_AGENT_NAME);
    expect(agent.qualifiedName).toBe(GENERAL_AGENT_NAME);
  });

  test("AC-3: origin is the nax built-in origin", () => {
    expect(generalAgent().origin).toEqual({ kind: "nax-builtin" });
  });

  test("AC-4: has no path", () => {
    expect(generalAgent().path).toBe("");
  });

  test("AC-5: carries the general-agent description", () => {
    expect(generalAgent().description).toBe(GENERAL_AGENT_DESCRIPTION);
    expect(generalAgent().description).toBe("Runs a self-contained task on the model you pass");
  });

  test("AC-6: declares no model, so the caller's model wins", () => {
    expect("model" in generalAgent()).toBe(false);
  });

  test("AC-7: declares no tools, so every parent tool is admitted", () => {
    expect("tools" in generalAgent()).toBe(false);
  });

  test("AC-8: prompt is buildGeneralAgentPrompt()", () => {
    expect(generalAgent().prompt).toBe(buildGeneralAgentPrompt());
  });

  test("AC-13: the built-in agent stays out of a resource catalog", () => {
    const catalog = buildResourceCatalog([]);
    generalAgent();
    expect(catalog.findAgent(GENERAL_AGENT_NAME)).toBeUndefined();
  });
});
