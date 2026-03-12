// RE-ARCH: keep
/**
 * Tests for LLM Classifier
 */

import { describe, expect, test } from "bun:test";
import type { CodebaseScan } from "../../src/analyze";
import { classifyStories, _classifyDeps } from "../../src/analyze/classifier";
import { DEFAULT_CONFIG } from "../../src/config";
import type { UserStory } from "../../src/prd";

describe("classifyStories", () => {
  const mockScan: CodebaseScan = {
    fileTree: "src/\n├── index.ts\n└── utils/\n    └── helper.ts",
    dependencies: { zod: "^4.0.0" },
    devDependencies: { typescript: "^5.0.0" },
    testPatterns: ["Test framework: bun:test", "Test directory: test/"],
  };

  const mockStories: UserStory[] = [
    {
      id: "US-001",
      title: "Add input validation",
      description: "Validate user inputs with Zod schemas",
      acceptanceCriteria: ["Schema defined", "Validation works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
  ];

  test("falls back to keyword matching when LLM disabled", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const result = await classifyStories(mockStories, mockScan, config);

    expect(result.method).toBe("keyword-fallback");
    expect(result.fallbackReason).toBe("LLM-enhanced analysis disabled in config");
    expect(result.classifications).toHaveLength(1);
    expect(result.classifications[0].storyId).toBe("US-001");
  });

  test("falls back to keyword matching when ANTHROPIC_API_KEY missing", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: true,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    // Simulate adapter failure (e.g., no API key configured)
    const originalAdapter = _classifyDeps.adapter;
    _classifyDeps.adapter = {
      execute: async () => ({ success: false, output: "", exitCode: 1, estimatedCost: 0, rateLimited: false, durationMs: 0 }),
      complete: async () => { throw new Error("No API key configured"); },
      resolveModel: () => ({ model: "test", provider: "test" }),
      checkAvailability: async () => ({ available: false, binary: "test", reason: "test" }),
    } as any;

    try {
      const result = await classifyStories(mockStories, mockScan, config);

      expect(result.method).toBe("keyword-fallback");
      expect(result.fallbackReason).toContain("No API key configured");
      expect(result.classifications).toHaveLength(1);
    } finally {
      // Restore adapter
      _classifyDeps.adapter = originalAdapter;
    }
  });

  test("keyword fallback classification includes all required fields", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const result = await classifyStories(mockStories, mockScan, config);

    const classification = result.classifications[0];
    expect(classification.storyId).toBe("US-001");
    expect(classification.complexity).toMatch(/simple|medium|complex|expert/);
    expect(classification.contextFiles).toEqual([]);
    expect(classification.reasoning).toContain("Keyword-based classification");
    expect(typeof classification.estimatedLOC).toBe("number");
    expect(classification.estimatedLOC).toBeGreaterThan(0);
    expect(classification.risks).toEqual([]);
  });

  test("classifies simple stories correctly in keyword mode", async () => {
    const simpleStory: UserStory = {
      id: "US-002",
      title: "Update button color",
      description: "Change primary button to blue",
      acceptanceCriteria: ["Button is blue"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const result = await classifyStories([simpleStory], mockScan, config);

    expect(result.classifications[0].complexity).toBe("simple");
    expect(result.classifications[0].estimatedLOC).toBe(50); // Simple = 50 LOC
  });

  test("classifies complex stories correctly in keyword mode", async () => {
    const complexStory: UserStory = {
      id: "US-003",
      title: "Add JWT authentication",
      description: "Implement secure JWT authentication with refresh tokens",
      acceptanceCriteria: [
        "Token generation",
        "Token validation",
        "Refresh logic",
        "Expiry handling",
        "Secure storage",
      ],
      tags: ["security", "auth"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const result = await classifyStories([complexStory], mockScan, config);

    expect(result.classifications[0].complexity).toBe("complex");
    expect(result.classifications[0].estimatedLOC).toBe(400); // Complex = 400 LOC
  });

  test("processes multiple stories", async () => {
    const stories: UserStory[] = [
      {
        id: "US-001",
        title: "Story 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
      {
        id: "US-002",
        title: "Story 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const result = await classifyStories(stories, mockScan, config);

    expect(result.classifications).toHaveLength(2);
    expect(result.classifications[0].storyId).toBe("US-001");
    expect(result.classifications[1].storyId).toBe("US-002");
  });
});
