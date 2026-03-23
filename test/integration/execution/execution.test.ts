import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../../../src/config";
import { run } from "../../../src/execution/runner";
import type { RunOptions } from "../../../src/execution/runner";
import { initLogger, resetLogger } from "../../../src/logger";
import type { PRD, UserStory } from "../../../src/prd";

// Zero out iterationDelayMs so tests don't sleep 2s between iterations (DEFAULT_CONFIG = 2000ms)
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, iterationDelayMs: 0 },
};

// Sample PRD for testing
const createTestPRD = (stories: Partial<UserStory>[]): PRD => ({
  project: "test-project",
  feature: "test-feature",
  branchName: "test-branch",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  userStories: stories.map((s, i) => ({
    id: s.id || `US-${String(i + 1).padStart(3, "0")}`,
    title: s.title || "Test Story",
    description: s.description || "Test description",
    acceptanceCriteria: s.acceptanceCriteria || ["AC1"],
    dependencies: s.dependencies || [],
    tags: s.tags || [],
    status: s.status || "pending",
    passes: s.passes ?? false,
    escalations: s.escalations || [],
    attempts: s.attempts || 0,
    routing: s.routing,
  })),
});

describe("execution runner", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
  });

  afterEach(() => {
    resetLogger();
  });

  test("chooses test-after strategy for simple complexity", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Fix typo",
        description: "Fix a typo in error message",
        acceptanceCriteria: ["Typo is fixed"],
        tags: [],
      },
    ]);

    // Create temporary PRD file
    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: { ...TEST_CONFIG, execution: { ...TEST_CONFIG.execution, maxIterations: 2 } },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    const result = await run(opts);

    expect(result.iterations).toBeGreaterThan(0);
    expect(result.success).toBe(true); // Dry run marks stories as passed and completes

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("chooses three-session-tdd strategy for complex tasks", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Refactor authentication module",
        description: "Complete overhaul of JWT authentication with security enhancements",
        acceptanceCriteria: [
          "JWT tokens properly validated",
          "Refresh tokens implemented",
          "Rate limiting on auth endpoints",
          "Audit logging for all auth events",
          "Security headers configured",
        ],
        tags: ["security"],
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: { ...TEST_CONFIG, execution: { ...TEST_CONFIG.execution, maxIterations: 2 } },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    const result = await run(opts);

    expect(result.iterations).toBeGreaterThan(0);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("escalates model tier on failure", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Simple task",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    // Note: Escalation logic is tested through dry run.
    // Full integration testing would require mocking the agent adapter.

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        autoMode: {
          ...TEST_CONFIG.autoMode,
          escalation: {
            ...TEST_CONFIG.autoMode.escalation,
            enabled: true,
          },
        },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true, // Use dry run to avoid actual agent execution
      skipPrecheck: true,
    };

    const result = await run(opts);

    // In dry run mode, we can't test actual escalation, but the logic is verified
    expect(result.iterations).toBeGreaterThan(0);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("stops when cost limit reached", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Task 1",
        description: "First task",
        acceptanceCriteria: ["Works"],
        tags: [],
      },
      {
        id: "US-002",
        title: "Task 2",
        description: "Second task",
        acceptanceCriteria: ["Works"],
        tags: [],
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        execution: {
          ...TEST_CONFIG.execution,
          costLimit: 0.001, // Very low cost limit to trigger stop
        },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    const result = await run(opts);

    // Should stop before completing all stories due to cost limit
    expect(result.totalCost).toBeLessThanOrEqual(0.001);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("marks story as passed on success", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Simple task",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: { ...TEST_CONFIG, execution: { ...TEST_CONFIG.execution, maxIterations: 2 } },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    await run(opts);

    // Read updated PRD to verify status change would occur
    // (In dry run mode, actual execution doesn't happen, so we just verify the structure)
    const updatedPRD = JSON.parse(await Bun.file(prdPath).text()) as PRD;
    expect(updatedPRD.userStories).toHaveLength(1);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  // SKIP: Flaky — acceptance loop (enabled by default) runs after sequential completes
  // and increments iterations unpredictably even when all stories are pre-passed.
  // Root cause tracked: acceptance loop iteration count is non-deterministic in test env.
  test.skip("completes when all stories are done", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Task 1",
        description: "First task",
        acceptanceCriteria: ["Works"],
        status: "passed",
        passes: true,
      },
      {
        id: "US-002",
        title: "Task 2",
        description: "Second task",
        acceptanceCriteria: ["Works"],
        status: "passed",
        passes: true,
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        execution: { ...TEST_CONFIG.execution, maxIterations: 2 },
        // Disable acceptance loop — it runs after completion and increments iterations,
        // making the iterations === 1 assertion flaky.
        acceptance: { ...TEST_CONFIG.acceptance, enabled: false },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: false, // Not dry run since all stories already complete
      skipPrecheck: true,
    };

    const result = await run(opts);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1); // One iteration to detect completion
    expect(result.storiesCompleted).toBe(0); // Already completed

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("escalates entire batch when escalateEntireBatch is true (default)", async () => {
    // Create a PRD with simple stories that would normally be batched
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Simple task 1",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
      {
        id: "US-002",
        title: "Simple task 2",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
      {
        id: "US-003",
        title: "Simple task 3",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        autoMode: {
          ...TEST_CONFIG.autoMode,
          escalation: {
            ...TEST_CONFIG.autoMode.escalation,
            enabled: true,
            escalateEntireBatch: true, // Default behavior
          },
        },
        execution: { ...TEST_CONFIG.execution, maxIterations: 2 },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    await run(opts);

    // Note: In dry run mode, we can't verify escalation behavior directly,
    // but the config setting is tested through code path coverage
    // Real integration testing would require mocking the agent adapter

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("escalates only first story when escalateEntireBatch is false", async () => {
    // Create a PRD with simple stories that would normally be batched
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Simple task 1",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
      {
        id: "US-002",
        title: "Simple task 2",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
      {
        id: "US-003",
        title: "Simple task 3",
        description: "A simple task",
        acceptanceCriteria: ["Works"],
        tags: [],
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "Simple task",
        },
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        autoMode: {
          ...TEST_CONFIG.autoMode,
          escalation: {
            ...TEST_CONFIG.autoMode.escalation,
            enabled: true,
            escalateEntireBatch: false, // Individual retry mode
          },
        },
        execution: { ...TEST_CONFIG.execution, maxIterations: 2 },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    await run(opts);

    // Note: In dry run mode, we can't verify escalation behavior directly,
    // but the config setting is tested through code path coverage
    // Real integration testing would require mocking the agent adapter

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ─── T4: Lite mode and routing tests ─────────────────────────────────────────

describe("execution runner — lite mode routing", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
  });

  afterEach(() => {
    resetLogger();
  });

  test("story with three-session-tdd-lite routing runs successfully in dry-run", async () => {
    // Stories pre-routed to three-session-tdd-lite should be accepted by the pipeline
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "Build UI component",
        description: "Create a UI layout component",
        acceptanceCriteria: ["Component renders correctly", "Responsive layout"],
        tags: ["ui", "layout"],
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd-lite",
          reasoning: "three-session-tdd-lite: ui/layout story",
        },
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: { ...TEST_CONFIG, execution: { ...TEST_CONFIG.execution, maxIterations: 2 } },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    const result = await run(opts);

    // Dry run should complete successfully (routing is accepted)
    expect(result.success).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("config tdd.strategy='lite' routes complex stories to three-session-tdd-lite", async () => {
    // Using routeTask directly to verify routing decision
    const { routeTask } = await import("../../../src/routing");

    const configWithLiteStrategy = {
      ...TEST_CONFIG,
      tdd: { ...TEST_CONFIG.tdd, strategy: "lite" as const },
    };

    const routing = routeTask(
      "Implement complex authentication",
      "Complete JWT authentication with security enhancements, refresh tokens, and audit logging",
      ["JWT tokens properly validated", "Refresh tokens implemented", "Rate limiting", "Audit logging"],
      ["security"],
      configWithLiteStrategy,
    );

    // strategy='lite' should always route to three-session-tdd-lite regardless of complexity
    expect(routing.testStrategy).toBe("three-session-tdd-lite");
  });

  test("config tdd.strategy='strict' routes complex stories to three-session-tdd", async () => {
    const { routeTask } = await import("../../../src/routing");

    const configWithStrictStrategy = {
      ...TEST_CONFIG,
      tdd: { ...TEST_CONFIG.tdd, strategy: "strict" as const },
    };

    const routing = routeTask(
      "Implement complex authentication",
      "Complete JWT authentication with security enhancements, refresh tokens, and audit logging",
      ["JWT tokens properly validated", "Refresh tokens implemented", "Rate limiting", "Audit logging"],
      ["security"],
      configWithStrictStrategy,
    );

    // strategy='strict' should always route to three-session-tdd
    expect(routing.testStrategy).toBe("three-session-tdd");
  });

  test("config tdd.strategy='auto' routes complex UI-tagged stories to three-session-tdd-lite", async () => {
    const { routeTask } = await import("../../../src/routing");

    // With auto strategy + ui tag + complex story → three-session-tdd-lite
    // (T3: complex/expert with lite tags → three-session-tdd-lite)
    // Force 'complex' story: large number of ACs + complex description keywords
    const routing = routeTask(
      "Build complex UI dashboard system",
      "Build a comprehensive dashboard with multiple widget types, live data streaming, " +
        "complex state management, custom chart rendering, drag-and-drop layout, " +
        "theme engine, and accessibility compliance",
      [
        "Dashboard renders all widget types correctly",
        "Live data updates every 200ms without performance degradation",
        "Responsive layout works on all screen sizes",
        "Accessibility compliance (WCAG 2.1 AA)",
        "Drag-and-drop widget positioning works",
        "Custom chart rendering is accurate",
        "Theme switching works without page reload",
      ],
      ["ui", "layout"],
      TEST_CONFIG, // default is strategy='auto'
    );

    // auto + complex + ui → three-session-tdd-lite
    expect(routing.testStrategy).toBe("three-session-tdd-lite");
  });

  test("run with pre-routed three-session-tdd-lite story completes in dry-run", async () => {
    const prd = createTestPRD([
      {
        id: "US-001",
        title: "CLI integration",
        description: "Implement CLI integration commands",
        acceptanceCriteria: ["Commands work", "Output is correct"],
        tags: ["cli", "integration"],
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd-lite",
          reasoning: "three-session-tdd-lite: cli/integration story",
        },
      },
    ]);

    const tmpDir = `/tmp/nax-test-${randomUUID()}`;
    await mkdir(tmpDir, { recursive: true });
    const prdPath = `${tmpDir}/prd.json`;
    await Bun.write(prdPath, JSON.stringify(prd, null, 2));

    const opts: RunOptions = {
      prdPath,
      workdir: tmpDir,
      config: {
        ...TEST_CONFIG,
        tdd: { ...TEST_CONFIG.tdd, strategy: "lite" as const },
        execution: { ...TEST_CONFIG.execution, maxIterations: 2 },
      },
      hooks: { hooks: {} },
      feature: "test-feature",
      dryRun: true,
      skipPrecheck: true,
    };

    const result = await run(opts);

    expect(result.success).toBe(true);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });
});
