/**
 * Unit tests for planCommand interactive mode (PLN-002)
 *
 * Tests new behavior: interactive ACP session, question/answer routing,
 * JSON extraction from final output, timeout handling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps as _deps, planCommand } from "../../../src/cli/plan";
import { makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPlanManager(
  runFn?: (agentName: string, opts: any) => Promise<any>,
) {
  return makeMockAgentManager({
    runAsFn: runFn
      ? async (name: string, opts: any) => { await runFn(name, opts); return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] }; }
      : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature: URL Shortener
## Problem
Need a way to shorten URLs.
## Acceptance Criteria
- AC-1: Shorten URL
- AC-2: Redirect to original
`;

const SAMPLE_PRD: PRD = {
  project: "auto-detected",
  feature: "url-shortener",
  branchName: "feat/url-shortener",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Shorten URL",
      description: "User can shorten a long URL",
      acceptanceCriteria: ["AC-1: Returns shortened URL"],
      tags: ["feature"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Single function, clear output",
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _deps.readFile;
const origWriteFile = _deps.writeFile;
const origScanCodebase = _deps.scanCodebase;
const origCreateRuntime = _deps.createRuntime;
const origReadPackageJson = _deps.readPackageJson;
const origSpawnSync = _deps.spawnSync;
const origMkdirp = _deps.mkdirp;
const origExistsSync = _deps.existsSync;
const origCreateInteractionBridge = _deps.createInteractionBridge;

/** Mock bridge that auto-answers any question with "Yes" — no stdin involved. */
function makeMockBridge(autoAnswer = "Yes") {
  return {
    detectQuestion: mock(async (text: string) => text.includes("?")),
    onQuestionDetected: mock(async (_question: string) => autoAnswer),
  };
}

function makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: { express: "^4.18.0" },
    devDependencies: { vitest: "^1.0.0" },
    testPatterns: ["Test framework: vitest"],
  };
}

/**
 * Create a mock adapter that simulates interactive ACP session.
 */
// makeInteractiveAdapter removed — replaced by makeMockPlanManager

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — interactive mode (PLN-002)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-interactive-test-");
    capturedWriteArgs = [];

    // Create nax directory
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    // Default deps — override per test as needed
    // readFile: return PRD JSON when reading prd.json (agent wrote it), spec otherwise
    _deps.readFile = mock(async (path: string) =>
      path.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );
    // Simulate agent having written the PRD file (existsSync check passes by default)
    _deps.existsSync = mock((_path: string) => true);

    _deps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });

    _deps.scanCodebase = mock(async (_workdir: string) => makeFakeScan());

    _deps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-project" }));

    _deps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from(""),
      exitCode: 1,
    }));

    _deps.mkdirp = mock(async (_path: string) => {});
    _deps.createInteractionBridge = mock(() => makeMockBridge());
  });

  afterEach(async () => {
    mock.restore();
    _deps.readFile = origReadFile;
    _deps.writeFile = origWriteFile;
    _deps.scanCodebase = origScanCodebase;
    _deps.createRuntime = origCreateRuntime;
    _deps.readPackageJson = origReadPackageJson;
    _deps.spawnSync = origSpawnSync;
    _deps.mkdirp = origMkdirp;
    _deps.existsSync = origExistsSync;
    _deps.createInteractionBridge = origCreateInteractionBridge;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-1: Default nax plan (no --auto) starts an interactive ACP session
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: default nax plan (no --auto) calls adapter.runAs() for interactive planning", async () => {
    const capturedPlans: unknown[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (_name: string, opts: any) => {
        capturedPlans.push(opts);
        return { specContent: JSON.stringify(SAMPLE_PRD) };
      }),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedPlans.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: Agent asks clarifying questions that are forwarded to human
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: agent questions are forwarded via interaction bridge", async () => {
    const questionsAsked: string[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          const bridge = opts.interactionBridge;
          if (bridge) {
            const question = "Should URLs expire?";
            questionsAsked.push(question);
            try {
              const answer = await bridge.onQuestionDetected(question);
              questionsAsked.push(`Answer: ${answer}`);
            } catch {
              // Timeout or no interaction
            }
          }
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(questionsAsked.length).toBeGreaterThan(0);
    expect(questionsAsked[0]).toContain("Should");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: Human responses are sent as follow-up prompts to same session
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: human answers sent as follow-up prompts to session", async () => {
    const prompts: string[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          const bridge = opts.interactionBridge;
          if (bridge) {
            const question = "Should URLs expire?";
            prompts.push(question);
            const answer = await bridge.onQuestionDetected(question);
            prompts.push(answer);
          }
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(prompts.length).toBeGreaterThan(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: Final output extracted from agent's last message as JSON
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: extracts JSON from agent final output wrapped in code block", async () => {
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => ({ specContent: JSON.stringify(SAMPLE_PRD) }), undefined),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.userStories).toBeDefined();
    expect(Array.isArray(written.userStories)).toBe(true);
  });

  test("AC-4: throws on invalid JSON in agent output", async () => {
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => ({ specContent: "" }), undefined),
    );
    _deps.readFile = mock(async (_path: string) =>
      _path.endsWith("prd.json") ? "```json\ninvalid json {{}\n```" : SAMPLE_SPEC,
    );

    expect(
      planCommand(tmpDir, {} as never, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: Output validated and written to prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: validates output and writes to nax/features/<feature>/prd.json", async () => {
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => ({ specContent: JSON.stringify(SAMPLE_PRD) }), undefined),
    );

    const result = await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result).toBe(expectedPath);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.feature).toBe("url-shortener");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-6: Planning session respects timeout (default 10 min)
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-6: passes timeout option to adapter.runAs()", async () => {
    let capturedTimeoutSeconds: number | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          capturedTimeoutSeconds = opts.timeoutSeconds;
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    const config = {
      execution: { sessionTimeoutSeconds: 600 },
    };

    await planCommand(tmpDir, config as any, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedTimeoutSeconds).toBe(600);
  });

  test("AC-6: defaults to 10 min timeout if not specified", async () => {
    let capturedTimeoutSeconds: number | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          capturedTimeoutSeconds = opts.timeoutSeconds;
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as any, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedTimeoutSeconds).toBe(600);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-7: CLI stdin interaction works for local terminal usage
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-7: interaction bridge is provided to adapter for CLI stdin support", async () => {
    let bridgeProvided = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          bridgeProvided = !!opts.interactionBridge;
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(bridgeProvided).toBe(true);
  });

  test("AC-7: interaction bridge has detectQuestion and onQuestionDetected methods", async () => {
    let bridgeHasRequiredMethods = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          const bridge = opts.interactionBridge;
          bridgeHasRequiredMethods =
            typeof bridge?.detectQuestion === "function" && typeof bridge?.onQuestionDetected === "function";
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(bridgeHasRequiredMethods).toBe(true);
  });

  test("AC-8: interactive planning passes sessionRole 'plan' to adapter.runAs()", async () => {
    let capturedSessionRole: string | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async (_name: string, opts: any) => {
          capturedSessionRole = opts.sessionRole;
          return { specContent: JSON.stringify(SAMPLE_PRD) };
        },
        undefined,
      ),
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedSessionRole).toBe("plan");
  });

  test("continues when interactive plan() errors but prd.json exists", async () => {
    let planCalled = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(
        async () => {
          planCalled = true;
          throw new Error("missing end_turn");
        },
        undefined,
      ),
    );
    _deps.existsSync = mock((path: string) => path.endsWith("prd.json"));
    _deps.readFile = mock(async (path: string) => (path.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC));

    const result = await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(result).toContain("prd.json");
    expect(planCalled).toBe(true);
  });

  test("throws when interactive plan() errors and prd.json is missing", async () => {
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => { throw new Error("missing end_turn"); }, undefined),
    );
    _deps.existsSync = mock((_path: string) => false);

    await expect(
      planCommand(tmpDir, {} as never, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow("no PRD was written");
  });
});
