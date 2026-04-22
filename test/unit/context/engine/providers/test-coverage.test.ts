import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TestCoverageProvider, _testCoverageProviderDeps } from "../../../../../src/context/engine/providers/test-coverage";
import type { ContextRequest } from "../../../../../src/context/engine/types";
import type { NaxConfig } from "../../../../../src/config/types";
import type { UserStory } from "../../../../../src/prd/types";

const STORY: UserStory = {
  id: "story-001",
  title: "Test story",
  description: "",
  acceptanceCriteria: [],
  status: "pending",
} as unknown as UserStory;

const CONFIG = {} as NaxConfig;

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "story-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

type ScannerResult = {
  summary: string;
  tokens: number;
  files: unknown[];
  totalTests: number;
};

let origGenerateSummary: typeof _testCoverageProviderDeps.generateTestCoverageSummary;
let origResolvePatterns: typeof _testCoverageProviderDeps.resolveTestFilePatterns;

function mockScanner(result: ScannerResult) {
  _testCoverageProviderDeps.generateTestCoverageSummary = async () => result as any;
}

function mockResolvePatterns(result: Awaited<ReturnType<typeof _testCoverageProviderDeps.resolveTestFilePatterns>>) {
  _testCoverageProviderDeps.resolveTestFilePatterns = async () => result as any;
}

beforeEach(() => {
  origGenerateSummary = _testCoverageProviderDeps.generateTestCoverageSummary;
  origResolvePatterns = _testCoverageProviderDeps.resolveTestFilePatterns;
});

afterEach(() => {
  _testCoverageProviderDeps.generateTestCoverageSummary = origGenerateSummary;
  _testCoverageProviderDeps.resolveTestFilePatterns = origResolvePatterns;
});

function makeConfigWithTestCoverage(overrides: Partial<{
  enabled: boolean;
  testDir?: string;
  maxTokens: number;
  detail: "names-only" | "names-and-counts" | "describe-blocks";
  scopeToStory: boolean;
  contextFiles: string[];
}> = {}): NaxConfig {
  return {
    context: {
      testCoverage: {
        enabled: true,
        maxTokens: 500,
        detail: "names-and-counts",
        scopeToStory: true,
        ...overrides,
      },
    },
  } as unknown as NaxConfig;
}

function sha256hex(content: string): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(content).digest("hex");
}

describe("TestCoverageProvider", () => {
  describe("AC1: id and kind", () => {
    test("id is 'test-coverage'", () => {
      const provider = new TestCoverageProvider(STORY, CONFIG);
      expect(provider.id).toBe("test-coverage");
    });

    test("kind is 'test-coverage'", () => {
      const provider = new TestCoverageProvider(STORY, CONFIG);
      expect(provider.kind).toBe("test-coverage");
    });
  });

  describe("AC2: constructor retains story and config", () => {
    test("stores story and config for use in fetch", () => {
      const provider = new TestCoverageProvider(STORY, CONFIG) as any;
      expect(provider.story).toBe(STORY);
      expect(provider.config).toBe(CONFIG);
    });
  });

  describe("AC3: short-circuits when enabled === false", () => {
    test("returns empty chunks when config.context.testCoverage.enabled === false", async () => {
      const cfg = makeConfigWithTestCoverage({ enabled: false });
      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());
      expect(result.chunks).toHaveLength(0);
      expect(result.pullTools).toEqual([]);
    });
  });

  describe("AC4: short-circuits when packageDir is empty", () => {
    test("returns empty chunks when request.packageDir is undefined", async () => {
      const cfg = makeConfigWithTestCoverage();
      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest({ packageDir: undefined as any }));
      expect(result.chunks).toHaveLength(0);
      expect(result.pullTools).toEqual([]);
    });

    test("returns empty chunks when request.packageDir is an empty string", async () => {
      const cfg = makeConfigWithTestCoverage();
      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest({ packageDir: "" }));
      expect(result.chunks).toHaveLength(0);
      expect(result.pullTools).toEqual([]);
    });
  });

  describe("AC5: workdir is set to request.packageDir", () => {
    test("calls generateTestCoverageSummary with workdir = request.packageDir", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedWorkdir: string | undefined;
      mockScanner({ summary: "", tokens: 0, files: [], totalTests: 0 });
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedWorkdir = opts.workdir;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest({ packageDir: "/repo/packages/api" }));

      expect(receivedWorkdir).toBe("/repo/packages/api");
    });
  });

  describe("AC6: forwards config options to scanner", () => {
    test("forwards testDir from config", async () => {
      const cfg = makeConfigWithTestCoverage({ testDir: "custom-test-dir" });
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedTestDir: string | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedTestDir = opts.testDir;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedTestDir).toBe("custom-test-dir");
    });

    test("forwards maxTokens with default 500", async () => {
      const cfg = makeConfigWithTestCoverage({ maxTokens: 1200 });
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedMaxTokens: number | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedMaxTokens = opts.maxTokens;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedMaxTokens).toBe(1200);
    });

    test("uses default maxTokens of 500 when not set", async () => {
      const cfg = makeConfigWithTestCoverage({ maxTokens: undefined as any });
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedMaxTokens: number | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedMaxTokens = opts.maxTokens;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedMaxTokens).toBe(500);
    });

    test("forwards detail with default 'names-and-counts'", async () => {
      const cfg = makeConfigWithTestCoverage({ detail: "describe-blocks" });
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedDetail: string | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedDetail = opts.detail;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedDetail).toBe("describe-blocks");
    });

    test("forwards scopeToStory with default true", async () => {
      const cfg = makeConfigWithTestCoverage({ scopeToStory: true });
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedScopeToStory: boolean | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedScopeToStory = opts.scopeToStory;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedScopeToStory).toBe(true);
    });

    test("forwards contextFiles from getContextFiles(story)", async () => {
      const storyWithContextFiles = {
        ...STORY,
        contextFiles: ["src/foo.ts", "src/bar.ts"],
      } as unknown as UserStory;
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);

      let receivedContextFiles: string[] | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedContextFiles = opts.contextFiles;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(storyWithContextFiles, cfg);
      await provider.fetch(makeRequest());

      expect(receivedContextFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
    });
  });

  describe("AC7: passes resolvedTestGlobs from resolveTestFilePatterns", () => {
    test("calls resolveTestFilePatterns with config, repoRoot, story.workdir", async () => {
      const storyWithWorkdir = { ...STORY, workdir: "packages/api" } as unknown as UserStory;
      const cfg = makeConfigWithTestCoverage();

      let receivedConfig: any;
      let receivedWorkdir: string | undefined;
      let receivedPackageDir: string | undefined;

      _testCoverageProviderDeps.resolveTestFilePatterns = async (
        config: any,
        workdir: string,
        packageDir?: string,
      ) => {
        receivedConfig = config;
        receivedWorkdir = workdir;
        receivedPackageDir = packageDir;
        return { patterns: [], strategy: "none" } as any;
      };

      const provider = new TestCoverageProvider(storyWithWorkdir, cfg);
      await provider.fetch(makeRequest({ repoRoot: "/repo", packageDir: "/repo/packages/api" }));

      expect(receivedConfig).toBe(cfg);
      expect(receivedWorkdir).toBe("/repo");
      expect(receivedPackageDir).toBe("/repo/packages/api");
    });

    test("passes resolvedTestGlobs to the scanner", async () => {
      const cfg = makeConfigWithTestCoverage();
      const resolvedPatterns = ["packages/api/**/*.test.ts", "packages/api/**/*.spec.ts"];

      _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
        ({ patterns: resolvedPatterns, strategy: "per-package" } as any);

      let receivedGlobs: readonly string[] | undefined;
      _testCoverageProviderDeps.generateTestCoverageSummary = async (opts: any) => {
        receivedGlobs = opts.resolvedTestGlobs;
        return { summary: "", tokens: 0, files: [], totalTests: 0 };
      };

      const provider = new TestCoverageProvider(STORY, cfg);
      await provider.fetch(makeRequest());

      expect(receivedGlobs).toEqual(resolvedPatterns);
    });
  });

  describe("AC8: returns empty chunks on empty summary", () => {
    test("returns empty chunks when scanner returns empty summary", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "", tokens: 0, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks).toHaveLength(0);
      expect(result.pullTools).toEqual([]);
    });
  });

  describe("AC9: emits correct chunk properties on non-empty summary", () => {
    test("emits one RawChunk when scanner returns non-empty summary", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({
        summary: "Test coverage summary content",
        tokens: 42,
        files: [],
        totalTests: 0,
      });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks).toHaveLength(1);
    });

    test("chunk content is byte-equal to scanner summary", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      const summaryText = "## Test Coverage\n\n- src/foo.test.ts: 5 tests\n- src/bar.test.ts: 3 tests";
      mockScanner({ summary: summaryText, tokens: 80, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].content).toBe(summaryText);
    });

    test("chunk tokens equals scanner-reported tokens", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "some tests", tokens: 99, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].tokens).toBe(99);
    });

    test("chunk kind is 'test-coverage'", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "tests", tokens: 10, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].kind).toBe("test-coverage");
    });

    test("chunk scope is 'story'", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "tests", tokens: 10, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].scope).toBe("story");
    });

    test("chunk role is ['implementer', 'tdd']", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "tests", tokens: 10, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].role).toEqual(["implementer", "tdd"]);
    });

    test("chunk rawScore is 0.85", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "tests", tokens: 10, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].rawScore).toBe(0.85);
    });
  });

  describe("AC10: chunk id has correct format", () => {
    test("id format is 'test-coverage:<8-hex-chars>'", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      mockScanner({ summary: "some test content", tokens: 10, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      expect(result.chunks[0].id).toMatch(/^test-coverage:[0-9a-f]{8}$/);
    });

    test("hex chars are first 8 chars of sha256 of content", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);
      const content = "The exact test coverage content";
      mockScanner({ summary: content, tokens: 50, files: [], totalTests: 0 });

      const provider = new TestCoverageProvider(STORY, cfg);
      const result = await provider.fetch(makeRequest());

      const expectedHash = sha256hex(content).slice(0, 8);
      expect(result.chunks[0].id).toBe(`test-coverage:${expectedHash}`);
    });
  });

  describe("AC11: error handling — logs warning and returns empty chunks", () => {
    test("logs warning with component 'test-coverage' on scanner error", async () => {
      const cfg = makeConfigWithTestCoverage();
      mockResolvePatterns(["**/*.test.ts"]);

      let loggedComponent: string | undefined;
      let loggedMessage: string | undefined;
      let loggedData: Record<string, unknown> | undefined;

      const mockLogger = {
        warn: (component: string, message: string, data?: Record<string, unknown>) => {
          loggedComponent = component;
          loggedMessage = message;
          loggedData = data;
        },
      };

      _testCoverageProviderDeps.generateTestCoverageSummary = async () => {
        throw new Error("scanner failed");
      };

      const TestCoverageProvider = (await import("../../../../../src/context/engine/providers/test-coverage")).TestCoverageProvider;
      const provider = new TestCoverageProvider(STORY, cfg);

      // The provider needs to use our mock logger — we test via the dep pattern
      // by checking that the deps call threw and the provider caught it
      // Note: actual logging tested in AC12
      const result = await provider.fetch(makeRequest());

      expect(result.chunks).toHaveLength(0);
      expect(result.pullTools).toEqual([]);
    });
  });

  describe("AC12: logger data key order — storyId then packageDir", () => {
    test("warning log includes storyId as first key and packageDir as second", async () => {
      const cfg = makeConfigWithTestCoverage();

      _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
        ({ patterns: [], strategy: "none" } as any);

      _testCoverageProviderDeps.generateTestCoverageSummary = async () => {
        throw new Error("simulated scan failure");
      };

      const { getLogger } = await import("../../../../../src/logger/logger");
      const logger = getLogger();

      const warnCalls: Array<{ component: string; message: string; data: Record<string, unknown> }> = [];
      const origWarn = logger.warn.bind(logger);
      logger.warn = ((component: string, message: string, data?: Record<string, unknown>) => {
        warnCalls.push({ component, message, data: data ?? {} });
        origWarn(component, message, data);
      }) as typeof logger.warn;

      try {
        const TestCoverageProvider = (await import("../../../../../src/context/engine/providers/test-coverage")).TestCoverageProvider;
        const provider = new TestCoverageProvider(STORY, cfg);
        await provider.fetch(makeRequest({ packageDir: "/repo/packages/api" }));

        const lastWarn = warnCalls[warnCalls.length - 1];
        const keys = Object.keys(lastWarn.data);
        expect(keys[0]).toBe("storyId");
        expect(keys[1]).toBe("packageDir");
        expect(lastWarn.data.storyId).toBe("story-001");
        expect(lastWarn.data.packageDir).toBe("/repo/packages/api");
        expect(lastWarn.data.error).toBeDefined();
      } finally {
        logger.warn = origWarn;
      }
    });
  });

  describe("AC13: _testCoverageProviderDeps is exported and used", () => {
    test("module exports _testCoverageProviderDeps", async () => {
      const mod = await import("../../../../../src/context/engine/providers/test-coverage");
      expect(mod._testCoverageProviderDeps).toBeDefined();
    });

    test("_testCoverageProviderDeps has generateTestCoverageSummary and resolveTestFilePatterns", async () => {
      const mod = await import("../../../../../src/context/engine/providers/test-coverage");
      expect(typeof mod._testCoverageProviderDeps.generateTestCoverageSummary).toBe("function");
      expect(typeof mod._testCoverageProviderDeps.resolveTestFilePatterns).toBe("function");
    });
  });
});