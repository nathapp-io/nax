import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "../../../helpers";
import { TddPromptBuilder } from "../../../../src/prompts/builders/tdd-builder";

describe("TddPromptBuilder.buildForRole", () => {
  test("builds a non-empty prompt for test-writer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({ quality: { commands: { test: "bun test" } } });
    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for implementer", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("implementer", "/tmp", config, story, { lite: false });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("builds a non-empty prompt for verifier", async () => {
    const story = makeStory();
    const config = makeNaxConfig({});
    const prompt = await TddPromptBuilder.buildForRole("verifier", "/tmp", config, story, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
