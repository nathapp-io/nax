import { describe, expect, test } from "bun:test";
import { buildHermeticSection } from "../../../../src/prompts/sections/hermetic";

describe("buildHermeticSection", () => {
  describe("role filtering", () => {
    test.each([
      ["test-writer returns content", "test-writer", true],
      ["implementer returns content", "implementer", true],
      ["tdd-simple returns content", "tdd-simple", true],
      ["batch returns content", "batch", true],
      ["single-session returns content", "single-session", true],
      ["verifier returns empty string", "verifier", false],
    ])("%s", (_label, role, hasContent) => {
      const result = buildHermeticSection(role as any, undefined, undefined);
      if (hasContent) {
        expect(result).not.toBe("");
        expect(result).toContain("# Hermetic Test Requirement");
      } else {
        expect(result).toBe("");
      }
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
    test.each([
      ["undefined → no mention", undefined, false],
      ["three boundaries → all backtick-wrapped", ["claude", "acpx", "redis"], true],
      ["single boundary → backtick-wrapped", ["redis"], true],
      ["empty array → no boundaries line", [], false],
    ])("%s", (_label, boundaries, hasBoundaries) => {
      const result = buildHermeticSection("test-writer", boundaries ?? undefined, undefined);
      if (hasBoundaries) {
        expect(result).toContain("Project-specific boundaries to mock");
        for (const b of boundaries!) expect(result).toContain(`\`${b}\``);
      } else {
        expect(result).not.toContain("Project-specific boundaries");
      }
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

  describe("language-aware guidance (US-009)", () => {
    test("Go language derives interface-based mocking guidance", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "go" });
      expect(result).toContain("Define interfaces for external dependencies");
      expect(result).toContain("constructor injection");
    });

    test("Rust language derives mockall-based guidance", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "rust" });
      expect(result).toContain("mockall");
    });

    test("Python language derives unittest.mock and pytest-mock guidance", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "python" });
      expect(result).toContain("unittest.mock.patch");
      expect(result).toContain("pytest-mock");
    });

    test("TypeScript language preserves existing guidance when no profile or profile lacks language", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "typescript" });
      expect(result).toContain("injectable deps");
    });

    test("explicit mockGuidance overrides language-derived guidance", () => {
      const result = buildHermeticSection(
        "test-writer",
        undefined,
        "Use ioredis-mock",
        { language: "go" }
      );
      expect(result).toContain("Use ioredis-mock");
      expect(result).not.toContain("Define interfaces for external dependencies");
    });

    test("undefined profile does not break existing behavior", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, undefined);
      expect(result).toContain("injectable deps");
    });

    test("verifier role returns empty string regardless of language", () => {
      const result = buildHermeticSection("verifier", undefined, undefined, { language: "go" });
      expect(result).toBe("");
    });

    test("language-aware guidance preserves base content", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "go" });
      expect(result).toContain("hermetic");
      expect(result).toContain("Mock all I/O boundaries");
      expect(result).toContain("CLI tool spawning");
    });

    test("language-aware guidance combines with externalBoundaries", () => {
      const result = buildHermeticSection(
        "test-writer",
        ["redis", "claude"],
        undefined,
        { language: "go" }
      );
      expect(result).toContain("Define interfaces for external dependencies");
      expect(result).toContain("`redis`");
      expect(result).toContain("`claude`");
    });

    test("unsupported language falls back to default TypeScript guidance", () => {
      const result = buildHermeticSection("test-writer", undefined, undefined, { language: "ruby" as any });
      expect(result).toContain("injectable deps");
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
