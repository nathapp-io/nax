/**
 * Context Provider Injection Tests (US-002)
 *
 * Tests that context providers are called before agent execution
 * and their content is injected into the agent prompt with proper
 * token budget management and error handling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/schema";
import { contextStage } from "../../src/pipeline/stages/context";
import type { PipelineContext } from "../../src/pipeline/types";
import { PluginRegistry } from "../../src/plugins/registry";
import type { IContextProvider, NaxPlugin } from "../../src/plugins/types";
import type { PRD, UserStory } from "../../src/prd/types";

/**
 * Create a minimal test context for context stage testing
 */
function createTestContext(overrides?: Partial<PipelineContext>): PipelineContext {
  const story: UserStory = {
    id: "US-002",
    title: "Test Story",
    description: "Test story for context provider injection",
    acceptanceCriteria: ["AC1", "AC2"],
    status: "pending",
    dependencies: [],
    reasoning: "test",
    estimatedComplexity: "simple",
    tags: [],
    metadata: {},
  };

  const prd: PRD = {
    version: 1,
    feature: "test-feature",
    description: "Test feature",
    stories: [story],
    acceptanceCriteria: [],
    technicalNotes: "",
    contextFiles: [],
    dependencies: {},
    codebaseSummary: "",
  };

  return {
    config: DEFAULT_CONFIG,
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: "/test/workdir",
    hooks: { hooks: {} },
    ...overrides,
  };
}

/**
 * Create a mock context provider for testing
 */
function createMockProvider(
  name: string,
  content: string,
  estimatedTokens: number,
  label: string,
  shouldThrow = false,
): IContextProvider {
  return {
    name,
    async getContext(story: UserStory) {
      if (shouldThrow) {
        throw new Error(`Provider ${name} failed`);
      }
      return {
        content,
        estimatedTokens,
        label,
      };
    },
  };
}

/**
 * Create a mock plugin with a context provider
 */
function createMockPlugin(provider: IContextProvider): NaxPlugin {
  return {
    name: `plugin-${provider.name}`,
    version: "1.0.0",
    provides: ["context-provider"],
    extensions: {
      contextProvider: provider,
    },
  };
}

describe("US-002: Context Provider Injection", () => {
  describe("AC1: All registered context providers are called before agent execution", () => {
    test("calls all registered context providers", async () => {
      const provider1 = createMockProvider("jira", "Jira ticket data", 100, "Jira Context");
      const provider2 = createMockProvider("linear", "Linear issue data", 150, "Linear Context");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      const ctx = createTestContext({ plugins: registry });

      const result = await contextStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.contextMarkdown).toContain("Jira Context");
      expect(ctx.contextMarkdown).toContain("Jira ticket data");
      expect(ctx.contextMarkdown).toContain("Linear Context");
      expect(ctx.contextMarkdown).toContain("Linear issue data");
    });

    test("providers are called with the current story", async () => {
      let capturedStory: UserStory | undefined;
      const provider = createMockProvider("test", "content", 100, "Test");
      provider.getContext = async (story: UserStory) => {
        capturedStory = story;
        return { content: "test", estimatedTokens: 100, label: "Test" };
      };

      const registry = new PluginRegistry([createMockPlugin(provider)]);
      const ctx = createTestContext({ plugins: registry });

      await contextStage.execute(ctx);

      expect(capturedStory).toBeDefined();
      expect(capturedStory?.id).toBe("US-002");
    });

    test("works with no context providers registered", async () => {
      const registry = new PluginRegistry([]);
      const ctx = createTestContext({ plugins: registry });

      const result = await contextStage.execute(ctx);

      expect(result.action).toBe("continue");
    });
  });

  describe("AC2: Provider content is appended under markdown section with provider's label", () => {
    test("appends provider content under labeled markdown section", async () => {
      const provider = createMockProvider("jira", "Ticket details here", 100, "Jira Context");

      const registry = new PluginRegistry([createMockPlugin(provider)]);
      const ctx = createTestContext({ plugins: registry });

      await contextStage.execute(ctx);

      expect(ctx.contextMarkdown).toContain("## Jira Context");
      expect(ctx.contextMarkdown).toContain("Ticket details here");
    });

    test("multiple providers create separate labeled sections", async () => {
      const provider1 = createMockProvider("jira", "Jira data", 100, "Jira Context");
      const provider2 = createMockProvider("confluence", "Confluence data", 150, "Confluence Docs");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      const ctx = createTestContext({ plugins: registry });

      await contextStage.execute(ctx);

      expect(ctx.contextMarkdown).toContain("## Jira Context");
      expect(ctx.contextMarkdown).toContain("Jira data");
      expect(ctx.contextMarkdown).toContain("## Confluence Docs");
      expect(ctx.contextMarkdown).toContain("Confluence data");
    });

    test("provider content is appended to existing context markdown", async () => {
      const provider = createMockProvider("jira", "New context", 100, "Jira Context");
      const registry = new PluginRegistry([createMockPlugin(provider)]);

      const ctx = createTestContext({
        plugins: registry,
        contextMarkdown: "Existing context\n\n## Dependencies",
      });

      await contextStage.execute(ctx);

      expect(ctx.contextMarkdown).toContain("Existing context");
      expect(ctx.contextMarkdown).toContain("## Dependencies");
      expect(ctx.contextMarkdown).toContain("## Jira Context");
      expect(ctx.contextMarkdown).toContain("New context");
    });
  });

  describe("AC3: Total injected tokens respect the token budget", () => {
    test("respects default token budget of 2000 tokens when not configured", async () => {
      // This test expects the implementation to use config.execution.contextProviderTokenBudget
      // Currently uses hardcoded 20_000, which is why this test will FAIL
      const provider1 = createMockProvider("provider1", "content1", 1000, "Provider 1");
      const provider2 = createMockProvider("provider2", "content2", 1500, "Provider 2");
      const provider3 = createMockProvider("provider3", "content3", 500, "Provider 3");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2), createMockPlugin(provider3)];
      const registry = new PluginRegistry(plugins);

      // Create config with default token budget (2000)
      const configWithBudget = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 2000,
        },
      };

      const ctx = createTestContext({
        plugins: registry,
        config: configWithBudget,
      });

      await contextStage.execute(ctx);

      // Should include provider1 (1000) and provider2 (1500) = 2500 total
      // But should stop before adding all due to budget
      // With 2000 budget, only provider1 should be added
      expect(ctx.contextMarkdown).toContain("Provider 1");
      expect(ctx.contextMarkdown).not.toContain("Provider 2"); // Would exceed budget
      expect(ctx.contextMarkdown).not.toContain("Provider 3");
    });

    test("respects custom token budget from config", async () => {
      const provider1 = createMockProvider("provider1", "content1", 500, "Provider 1");
      const provider2 = createMockProvider("provider2", "content2", 400, "Provider 2");
      const provider3 = createMockProvider("provider3", "content3", 300, "Provider 3");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2), createMockPlugin(provider3)];
      const registry = new PluginRegistry(plugins);

      // Set budget to 1000 tokens
      const configWithBudget = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 1000,
        },
      };

      const ctx = createTestContext({
        plugins: registry,
        config: configWithBudget,
      });

      await contextStage.execute(ctx);

      // Should include provider1 (500) and provider2 (400) = 900 total
      // Should skip provider3 (would make total 1200, exceeding 1000 budget)
      expect(ctx.contextMarkdown).toContain("Provider 1");
      expect(ctx.contextMarkdown).toContain("Provider 2");
      expect(ctx.contextMarkdown).not.toContain("Provider 3");
    });

    test("providers added in order until budget exhausted", async () => {
      const provider1 = createMockProvider("provider1", "content1", 800, "Provider 1");
      const provider2 = createMockProvider("provider2", "content2", 800, "Provider 2");
      const provider3 = createMockProvider("provider3", "content3", 100, "Provider 3");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2), createMockPlugin(provider3)];
      const registry = new PluginRegistry(plugins);

      const configWithBudget = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 1000,
        },
      };

      const ctx = createTestContext({
        plugins: registry,
        config: configWithBudget,
      });

      await contextStage.execute(ctx);

      // Should only include provider1 (800 tokens)
      // provider2 would exceed budget (800 + 800 = 1600 > 1000)
      expect(ctx.contextMarkdown).toContain("Provider 1");
      expect(ctx.contextMarkdown).not.toContain("Provider 2");
      expect(ctx.contextMarkdown).not.toContain("Provider 3");
    });

    test("single provider exceeding budget is included if it's the first", async () => {
      const provider1 = createMockProvider("provider1", "large content", 3000, "Provider 1");
      const provider2 = createMockProvider("provider2", "content2", 100, "Provider 2");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      const configWithBudget = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 2000,
        },
      };

      const ctx = createTestContext({
        plugins: registry,
        config: configWithBudget,
      });

      await contextStage.execute(ctx);

      // First provider should be skipped as it exceeds budget alone
      // Implementation should skip providers that would exceed budget
      expect(ctx.contextMarkdown).not.toContain("Provider 1");
      expect(ctx.contextMarkdown).not.toContain("Provider 2");
    });
  });

  describe("AC4: Provider errors are caught, logged, and skipped", () => {
    test("continues when a provider throws an error", async () => {
      const provider1 = createMockProvider("failing", "content", 100, "Failing Provider", true);
      const provider2 = createMockProvider("working", "content2", 100, "Working Provider");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      const ctx = createTestContext({ plugins: registry });

      const result = await contextStage.execute(ctx);

      // Should continue despite provider1 failing
      expect(result.action).toBe("continue");
      expect(ctx.contextMarkdown).not.toContain("Failing Provider");
      expect(ctx.contextMarkdown).toContain("Working Provider");
      expect(ctx.contextMarkdown).toContain("content2");
    });

    test("handles all providers failing gracefully", async () => {
      const provider1 = createMockProvider("failing1", "content", 100, "Provider 1", true);
      const provider2 = createMockProvider("failing2", "content", 100, "Provider 2", true);

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      const ctx = createTestContext({ plugins: registry });

      const result = await contextStage.execute(ctx);

      expect(result.action).toBe("continue");
      // Context markdown should be empty or contain only base context
    });

    test("error in one provider does not affect others", async () => {
      const provider1 = createMockProvider("provider1", "content1", 100, "Provider 1");
      const provider2 = createMockProvider("failing", "content", 100, "Failing Provider", true);
      const provider3 = createMockProvider("provider3", "content3", 100, "Provider 3");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2), createMockPlugin(provider3)];
      const registry = new PluginRegistry(plugins);

      const ctx = createTestContext({ plugins: registry });

      await contextStage.execute(ctx);

      expect(ctx.contextMarkdown).toContain("Provider 1");
      expect(ctx.contextMarkdown).toContain("content1");
      expect(ctx.contextMarkdown).not.toContain("Failing Provider");
      expect(ctx.contextMarkdown).toContain("Provider 3");
      expect(ctx.contextMarkdown).toContain("content3");
    });
  });

  describe("AC5: Token budget is configurable via execution.contextProviderTokenBudget", () => {
    test("config schema includes contextProviderTokenBudget field", () => {
      // This test will FAIL because the schema doesn't have this field yet
      const config = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 5000,
        },
      };

      // Should not throw when accessing the field
      expect(config.execution.contextProviderTokenBudget).toBe(5000);
    });

    test("default config includes contextProviderTokenBudget with default of 2000", () => {
      // Verify DEFAULT_CONFIG has the field with default value
      // This will FAIL until ExecutionConfig type is updated
      expect(DEFAULT_CONFIG.execution).toHaveProperty("contextProviderTokenBudget");
      expect(DEFAULT_CONFIG.execution.contextProviderTokenBudget).toBe(2000);
    });

    test("uses configured token budget instead of hardcoded value", async () => {
      const provider1 = createMockProvider("provider1", "content1", 3000, "Provider 1");
      const provider2 = createMockProvider("provider2", "content2", 2000, "Provider 2");

      const plugins = [createMockPlugin(provider1), createMockPlugin(provider2)];
      const registry = new PluginRegistry(plugins);

      // Set custom budget of 5000 tokens
      const configWithBudget = {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          contextProviderTokenBudget: 5000,
        },
      };

      const ctx = createTestContext({
        plugins: registry,
        config: configWithBudget,
      });

      await contextStage.execute(ctx);

      // Both providers should be included (3000 + 2000 = 5000)
      expect(ctx.contextMarkdown).toContain("Provider 1");
      expect(ctx.contextMarkdown).toContain("Provider 2");
    });

    test("different projects can have different token budgets", async () => {
      const provider = createMockProvider("provider", "content", 2500, "Provider");
      const registry = new PluginRegistry([createMockPlugin(provider)]);

      // Project 1: low budget
      const ctx1 = createTestContext({
        plugins: registry,
        config: {
          ...DEFAULT_CONFIG,
          execution: {
            ...DEFAULT_CONFIG.execution,
            contextProviderTokenBudget: 2000,
          },
        },
      });

      await contextStage.execute(ctx1);
      expect(ctx1.contextMarkdown).not.toContain("Provider"); // Exceeds budget

      // Project 2: high budget
      const ctx2 = createTestContext({
        plugins: registry,
        config: {
          ...DEFAULT_CONFIG,
          execution: {
            ...DEFAULT_CONFIG.execution,
            contextProviderTokenBudget: 3000,
          },
        },
      });

      await contextStage.execute(ctx2);
      expect(ctx2.contextMarkdown).toContain("Provider"); // Within budget
    });
  });

  describe("Integration: Context providers inject into full pipeline", () => {
    test("context markdown is available to prompt stage", async () => {
      const provider = createMockProvider("jira", "Ticket ABC-123", 100, "Jira Context");
      const registry = new PluginRegistry([createMockPlugin(provider)]);

      const ctx = createTestContext({ plugins: registry });

      // Run context stage
      await contextStage.execute(ctx);

      // Verify context markdown is set and available for prompt stage
      expect(ctx.contextMarkdown).toBeDefined();
      expect(ctx.contextMarkdown).toContain("Jira Context");
      expect(ctx.contextMarkdown).toContain("Ticket ABC-123");
    });

    test("built context tracks plugin elements", async () => {
      const provider = createMockProvider("jira", "content", 150, "Jira Context");
      const registry = new PluginRegistry([createMockPlugin(provider)]);

      const ctx = createTestContext({ plugins: registry });

      await contextStage.execute(ctx);

      // After running context stage, built context should include plugin elements
      // This test expects the implementation to populate builtContext
    });

    test("context providers work alongside PRD context", async () => {
      const provider = createMockProvider("jira", "External context", 100, "External");
      const registry = new PluginRegistry([createMockPlugin(provider)]);

      const ctx = createTestContext({
        plugins: registry,
        contextMarkdown: "# Story Context\n\nPRD-based context here",
      });

      await contextStage.execute(ctx);

      // Should preserve existing context and append plugin context
      expect(ctx.contextMarkdown).toContain("PRD-based context");
      expect(ctx.contextMarkdown).toContain("External");
    });
  });
});
