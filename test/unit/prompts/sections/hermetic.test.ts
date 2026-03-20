import { describe, expect, test } from "bun:test";
import { buildHermeticSection } from "../../../../src/prompts/sections/hermetic";

describe("buildHermeticSection", () => {
  describe("role filtering", () => {
    test("returns content for test-writer", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).not.toBe("");
      expect(result).toContain("# Hermetic Test Requirement");
    });

    test("returns content for implementer", () => {
      const result = buildHermeticSection("implementer", undefined, undefined);
      expect(result).not.toBe("");
    });

    test("returns content for tdd-simple", () => {
      const result = buildHermeticSection("tdd-simple", undefined, undefined);
      expect(result).not.toBe("");
    });

    test("returns content for batch", () => {
      const result = buildHermeticSection("batch", undefined, undefined);
      expect(result).not.toBe("");
    });

    test("returns content for single-session", () => {
      const result = buildHermeticSection("single-session", undefined, undefined);
      expect(result).not.toBe("");
    });

    test("returns empty string for verifier (read-only)", () => {
      const result = buildHermeticSection("verifier", undefined, undefined);
      expect(result).toBe("");
    });
  });

  describe("base content", () => {
    test("includes hermetic requirement statement", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).toContain("hermetic");
      expect(result).toContain("Mock all I/O boundaries");
    });

    test("covers CLI spawning boundary", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).toContain("CLI tool spawning");
    });

    test("covers database/cache boundary", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).toContain("database and cache clients");
    });

    test("covers HTTP/gRPC boundary", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).toContain("HTTP/gRPC");
    });

    test("mentions injectable deps pattern", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).toContain("injectable deps");
    });
  });

  describe("externalBoundaries", () => {
    test("no mention when undefined", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).not.toContain("Project-specific boundaries");
    });

    test("injects boundaries as backtick-wrapped list", () => {
      const result = buildHermeticSection("test-writer", ["claude", "acpx", "redis"], undefined);
      expect(result).toContain("Project-specific boundaries to mock");
      expect(result).toContain("`claude`");
      expect(result).toContain("`acpx`");
      expect(result).toContain("`redis`");
    });

    test("handles single boundary", () => {
      const result = buildHermeticSection("test-writer", ["redis"], undefined);
      expect(result).toContain("`redis`");
    });

    test("handles empty array (no boundaries line)", () => {
      const result = buildHermeticSection("test-writer", [], undefined);
      expect(result).not.toContain("Project-specific boundaries");
    });
  });

  describe("mockGuidance", () => {
    test("no mention when undefined", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined);
      expect(result).not.toContain("Mocking guidance");
    });

    test("injects guidance verbatim", () => {
      const guidance = "Use injectable deps for CLI spawning, ioredis-mock for Redis";
      const result = buildHermeticSection("test-writer", undefined, guidance);
      expect(result).toContain("Mocking guidance for this project");
      expect(result).toContain(guidance);
    });
  });

  describe("combined fields", () => {
    test("includes both boundaries and guidance when both provided", () => {
      const result = buildHermeticSection(
        "test-writer",
        ["claude", "redis"],
        "Use ioredis-mock for Redis",
      );
      expect(result).toContain("`claude`");
      expect(result).toContain("`redis`");
      expect(result).toContain("ioredis-mock");
    });
  });
});

describe("PromptBuilder hermetic integration", () => {
  const { PromptBuilder } = require("../../../../src/prompts");
  const makeStory = () => ({
    id: "US-001",
    title: "Add login",
    description: "Implement login feature",
    complexity: "simple" as const,
    status: "pending" as const,
    acceptanceCriteria: [],
  });

  test("hermetic section injected when hermeticConfig has hermetic=true", async () => {
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(makeStory())
      .hermeticConfig({ hermetic: true })
      .build();
    expect(prompt).toContain("# Hermetic Test Requirement");
  });

  test("hermetic section NOT injected when hermetic=false", async () => {
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(makeStory())
      .hermeticConfig({ hermetic: false })
      .build();
    expect(prompt).not.toContain("# Hermetic Test Requirement");
  });

  test("hermetic section NOT injected when hermeticConfig not called", async () => {
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(makeStory())
      .build();
    expect(prompt).not.toContain("# Hermetic Test Requirement");
  });

  test("hermetic section NOT injected for verifier even with hermetic=true", async () => {
    const prompt = await PromptBuilder.for("verifier")
      .story(makeStory())
      .hermeticConfig({ hermetic: true })
      .build();
    expect(prompt).not.toContain("# Hermetic Test Requirement");
  });

  test("boundaries and guidance appear in prompt", async () => {
    const prompt = await PromptBuilder.for("test-writer", { isolation: "strict" })
      .story(makeStory())
      .hermeticConfig({
        hermetic: true,
        externalBoundaries: ["claude", "acpx"],
        mockGuidance: "Use injectable deps for CLI",
      })
      .build();
    expect(prompt).toContain("`claude`");
    expect(prompt).toContain("`acpx`");
    expect(prompt).toContain("Use injectable deps for CLI");
  });

  test("hermetic section appears after isolation rules", async () => {
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(makeStory())
      .hermeticConfig({ hermetic: true })
      .build();
    const isolationIdx = prompt.indexOf("# Isolation Rules");
    const hermeticIdx = prompt.indexOf("# Hermetic Test Requirement");
    expect(isolationIdx).toBeGreaterThanOrEqual(0);
    expect(hermeticIdx).toBeGreaterThan(isolationIdx);
  });
});
