/**
 * Acceptance tests for the "acceptance-verdict-integrity" feature.
 *
 * One test per AC, named exactly "AC-N: <description>". Every test is a
 * runtime check: it imports the module under test (dynamically inside the
 * test when the module is new, so a missing module fails only the tests
 * that use it), calls it, and asserts on return values, thrown errors,
 * logged records, or observable side effects.
 *
 * Feature scope:
 *   US-001 — acceptance generator / plan-refine gain scoped Edit + one-file, load-safe prompts
 *   US-002 — AC count check (acTestCoverage / checkAcceptanceCoverage) + missing-file regeneration
 *   US-003 — acceptance-refine fails loud (ParseValidationError + refinementFallback)
 *   US-004 — classifyAcceptanceCrash + acceptanceRepairOp
 *   US-005 — RED gate repairs a crashing acceptance file (runAcceptanceRedGate)
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { acceptanceTestFilename } from "@/acceptance";
import { ParseValidationError } from "@/agents/retry";
import { DEFAULT_CONFIG, featureDir } from "@/config";
import { acceptanceGenerateOp, acceptanceRefineOp, planRefineOp, type PlanRefineInput } from "@/operations";
import { pipelineEventBus, type PostRunPhaseCompletedEvent } from "@/pipeline/event-bus";
import {
  _acceptanceSetupDeps,
  acceptanceSetupStage,
  computeACFingerprint,
  computeAcceptanceLayoutFingerprint,
} from "@/pipeline/stages/acceptance-setup";
import { acceptanceStage } from "@/pipeline/stages/acceptance";
import type { PipelineContext } from "@/pipeline/types";
import { AcceptancePromptBuilder } from "@/prompts";
import { MAX_RAW_TAIL_CHARS } from "@/quality";
import { compileToolPolicy, type ToolScope } from "@/tools";
import { makeDispatchContext } from "@test/helpers/dispatch-context";
import { makeLogger, type MockLogger } from "@test/helpers/mock-logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers/temp";
import { withInfoSpy, withWarnSpy } from "@test/helpers/warn-spy";

// ============================================================================
// Verbatim prompt sentences under test (spec "Prompt sentences")
// ============================================================================

const G1 =
  "nax runs this file as soon as you finish, before any implementation exists; a file that fails to load is sent back for repair.";
const G2 =
  "The file must load before the implementation exists. In languages that resolve imports at runtime (TypeScript, JavaScript, Python), import modules this feature adds inside each test rather than at the top of the file, so a missing module fails only the tests that use it.";
const G3 =
  "Write every AC-N test into this one file. To add or change tests in a file you already wrote, use Edit; do not create a second test file.";
const P1 = "Keep every acceptance test in this one file; do not create a second test file.";

const EXPECTED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "RequestCapability"];

const FEATURE = "test-feature";

// ============================================================================
// Shared fixtures & helpers
// ============================================================================

function makeStory(id: string, acceptanceCriteria: string[], workdir?: string) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria,
    ...(workdir !== undefined ? { workdir } : {}),
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]) {
  return {
    project: "test-project",
    feature: FEATURE,
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

/** Per-test temp dirs, cleaned up in afterEach. */
const tempDirs: string[] = [];
function newTempDir(): string {
  const dir = makeTempDir("nax-avi-");
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTempDir(tempDirs.pop());
  }
});

function stageCtx(
  stories: ReturnType<typeof makeStory>[],
  acceptanceOverrides: Record<string, unknown> = {},
): PipelineContext {
  const workdir = newTempDir();
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: true,
        redGate: true,
        ...acceptanceOverrides,
      },
    },
    rootConfig: DEFAULT_CONFIG,
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir,
    projectDir: workdir,
    featureDir: join(workdir, ".nax", "features", FEATURE),
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  } as unknown as PipelineContext;
}

/** Generated acceptance test code titling exactly AC-1 .. AC-count. */
function genCodeWithTitles(count: number): string {
  const lines: string[] = ['import { expect, test } from "bun:test";'];
  for (let i = 1; i <= count; i++) {
    lines.push(`test("AC-${i}: generated case ${i}", () => { expect(${i}).toBe(${i}); });`);
  }
  return lines.join("\n");
}

interface SetupWireOptions {
  generateResult?: { testCode: string | null; adapterFailure?: unknown };
  refineImpl?: (input: { criteria: string[]; storyId: string }) => unknown[];
  refineRejectFor?: ReadonlySet<string>;
  repairResult?: { testCode: string | null } | Error;
  runTest?: (testPath: string, callIndexForPath: number) => { exitCode: number; output: string };
  readMeta?: () => unknown;
  fileExists?: (testPath: string) => boolean;
}

interface WireRecorders {
  written: Array<{ path: string; content: string }>;
  metas: Array<Record<string, unknown>>;
  generateCalls: Array<{ packageDir: string; input: Record<string, unknown> }>;
  refineCalls: Array<{ storyId: string }>;
  repairCalls: Array<{ packageDir: string; input: Record<string, unknown> }>;
  runTestCalls: string[];
  writtenTestPaths: string[];
}

/** Wire the standard mock seams for acceptanceSetupStage and return recorders. */
function wireSetupDeps(opts: SetupWireOptions = {}): WireRecorders {
  const rec: WireRecorders = {
    written: [],
    metas: [],
    generateCalls: [],
    refineCalls: [],
    repairCalls: [],
    runTestCalls: [],
    writtenTestPaths: [],
  };

  _acceptanceSetupDeps.fileExists = async (p: string) => (opts.fileExists ? opts.fileExists(p) : false);
  _acceptanceSetupDeps.readMeta = async () => (opts.readMeta ? (opts.readMeta() as never) : null);
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.writeFile = async (filePath: string, content: string) => {
    rec.written.push({ path: filePath, content });
    if (filePath.endsWith(".nax-acceptance.test.ts")) rec.writtenTestPaths.push(filePath);
  };
  _acceptanceSetupDeps.writeMeta = async (_metaPath: string, meta: Record<string, unknown>) => {
    rec.metas.push(meta);
  };
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.loadGroupConfig = async (_root: string, _rel: string, base: typeof DEFAULT_CONFIG) => base;

  const perPathRunCounts = new Map<string, number>();
  _acceptanceSetupDeps.runTest = async (testPath: string) => {
    const n = (perPathRunCounts.get(testPath) ?? 0) + 1;
    perPathRunCounts.set(testPath, n);
    rec.runTestCalls.push(testPath);
    return opts.runTest ? opts.runTest(testPath, n) : { exitCode: 1, output: "(fail) AC-1: x" };
  };

  _acceptanceSetupDeps.callOp = async (
    _ctx: unknown,
    packageDir: string,
    op: { name: string },
    input: Record<string, unknown>,
    storyId?: string,
  ) => {
    if (op.name === "acceptance-refine") {
      const sid = String(input.storyId ?? storyId ?? "");
      rec.refineCalls.push({ storyId: sid });
      if (opts.refineRejectFor?.has(sid)) throw new Error("refinement unusable after retries");
      const criteria = (input.criteria ?? []) as string[];
      if (opts.refineImpl) return opts.refineImpl({ criteria, storyId: sid });
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: sid }));
    }
    if (op.name === "acceptance-generate") {
      rec.generateCalls.push({ packageDir, input });
      return opts.generateResult ?? { testCode: genCodeWithTitles(1) };
    }
    if (op.name === "acceptance-repair") {
      rec.repairCalls.push({ packageDir, input });
      if (opts.repairResult instanceof Error) throw opts.repairResult;
      return opts.repairResult ?? { testCode: "REPAIRED" };
    }
    throw new Error(`unexpected op: ${op.name}`);
  };

  return rec;
}

function coverageWarns(spy: MockLogger["warn"]) {
  return spy.mock.calls.filter((c) => c[1] === "Acceptance test file does not cover every AC");
}

// ─── Loose-typed dynamic loaders for modules this feature introduces ─────────

type AcCoverage = { expected: number; found: number; missing: string[] };
type AcCoverageFn = (source: string, expected: number) => AcCoverage;

async function loadAcTestCoverage(): Promise<AcCoverageFn> {
  const mod = (await import("@/test-runners")) as unknown as { acTestCoverage?: AcCoverageFn };
  if (typeof mod.acTestCoverage !== "function") {
    throw new Error("acTestCoverage is not exported from @/test-runners");
  }
  return mod.acTestCoverage;
}

interface CoverageEntry {
  testPath: string;
  expected: number;
  found: number;
  missing: string[];
}
type CheckCoverageFn = (args: { testPath: string; source: string; expected: number; storyId?: string }) => CoverageEntry;

async function loadCheckAcceptanceCoverage(): Promise<CheckCoverageFn> {
  const mod = (await import("@/acceptance")) as unknown as {
    checkAcceptanceCoverage?: CheckCoverageFn;
  };
  if (typeof mod.checkAcceptanceCoverage !== "function") {
    throw new Error("checkAcceptanceCoverage is not exported from @/acceptance");
  }
  return mod.checkAcceptanceCoverage;
}

type ClassifyFn = (output: string, language?: string) => "expected-red" | "repairable";

async function loadClassifyAcceptanceCrash(): Promise<ClassifyFn> {
  const mod = (await import("@/test-runners")) as unknown as { classifyAcceptanceCrash?: ClassifyFn };
  if (typeof mod.classifyAcceptanceCrash !== "function") {
    throw new Error("classifyAcceptanceCrash is not exported from @/test-runners");
  }
  return mod.classifyAcceptanceCrash;
}

interface RepairOpLike {
  kind: string;
  name: string;
  stage: string;
  session: Record<string, unknown>;
  tools: string[];
  build: (input: { targetTestFilePath: string; outputTail: string }, ctx?: unknown) => unknown;
  verify: (
    parsed: { testCode: string | null },
    input: { targetTestFilePath: string; outputTail: string },
    ctx?: unknown,
  ) => Promise<{ testCode: string | null } | null> | { testCode: string | null } | null;
}

async function loadAcceptanceRepairOp(): Promise<RepairOpLike> {
  const mod = (await import("@/operations")) as unknown as { acceptanceRepairOp?: RepairOpLike };
  if (!mod.acceptanceRepairOp || typeof mod.acceptanceRepairOp !== "object") {
    throw new Error("acceptanceRepairOp is not exported from @/operations");
  }
  return mod.acceptanceRepairOp;
}

interface RedGateEntry {
  testPath: string;
  packageDir: string;
  testFramework?: string;
  commandOverride?: string;
  language?: string;
  storyId?: string;
  config: typeof DEFAULT_CONFIG;
}

type RunAcceptanceRedGateFn = (
  ctx: PipelineContext,
  entries: readonly RedGateEntry[],
  deps: Pick<typeof _acceptanceSetupDeps, "runTest" | "callOp" | "writeFile" | "autoCommitIfDirty">,
) => Promise<number>;

async function loadRunAcceptanceRedGate(): Promise<RunAcceptanceRedGateFn> {
  const mod = (await import("@/pipeline/stages/acceptance-red-gate")) as unknown as {
    runAcceptanceRedGate?: RunAcceptanceRedGateFn;
  };
  if (typeof mod.runAcceptanceRedGate !== "function") {
    throw new Error("runAcceptanceRedGate is not exported from @/pipeline/stages/acceptance-red-gate");
  }
  return mod.runAcceptanceRedGate;
}

type RefineCriteriaFn = (
  ctx: PipelineContext,
  stories: readonly ReturnType<typeof makeStory>[],
  groupConfigs: Map<string, unknown>,
  callOp: (
    ctx: unknown,
    packageDir: string,
    op: unknown,
    input: unknown,
    storyId?: string,
    config?: unknown,
  ) => Promise<unknown>,
) => Promise<{ criteria: Array<Record<string, unknown>>; fallbackStoryIds: string[] }>;

async function loadRefineAcceptanceCriteria(): Promise<RefineCriteriaFn> {
  const mod = (await import("@/pipeline/stages/acceptance-refine-criteria")) as unknown as {
    refineAcceptanceCriteria?: RefineCriteriaFn;
  };
  if (typeof mod.refineAcceptanceCriteria !== "function") {
    throw new Error("refineAcceptanceCriteria is not exported from @/pipeline/stages/acceptance-refine-criteria");
  }
  return mod.refineAcceptanceCriteria;
}

/** Flatten any op build() return into the prompt text it carries. */
function buildText(built: unknown): string {
  if (typeof built === "string") return built;
  const parts: string[] = [];
  const b = built as {
    task?: { content?: unknown };
    role?: { content?: unknown };
    sections?: Array<{ content?: unknown }>;
  };
  if (b && typeof b === "object") {
    if (typeof b.task?.content === "string") parts.push(b.task.content);
    if (typeof b.role?.content === "string") parts.push(b.role.content);
    if (Array.isArray(b.sections)) {
      for (const s of b.sections) if (typeof s?.content === "string") parts.push(s.content);
    }
  }
  return parts.join("\n");
}

// ============================================================================
// Deps save/restore — every stage test mutates _acceptanceSetupDeps
// ============================================================================

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
});

// ============================================================================
// US-001 — Acceptance generator and plan-refine can edit what they wrote
// ============================================================================

test("AC-1: acceptanceGenerateOp.tools equals the six-tool grant with Edit and no Exec/Bash/Delete", () => {
  const tools = acceptanceGenerateOp.tools ?? [];
  expect(tools).toEqual(EXPECTED_TOOLS);
  expect(tools).toHaveLength(6);
  expect(tools[0]).toBe("Read");
  expect(tools[5]).toBe("RequestCapability");
  for (const banned of ["Exec", "Bash", "Delete"]) {
    expect(tools).not.toContain(banned);
  }
});

test("AC-2: planRefineOp.tools equals the six-tool grant with Edit and no Exec/Bash/Delete", () => {
  const tools = planRefineOp.tools ?? [];
  expect(tools).toEqual(EXPECTED_TOOLS);
  expect(tools).toHaveLength(6);
  expect(tools[0]).toBe("Read");
  expect(tools[5]).toBe("RequestCapability");
  for (const banned of ["Exec", "Bash", "Delete"]) {
    expect(tools).not.toContain(banned);
  }
});

test("AC-3: compiled policy permits Edit on the op's own fileOutput and denies another feature's PRD", () => {
  const root = newTempDir();
  const outputPath = join(root, ".nax", "features", "auth", "prd.json");
  const refineInput: PlanRefineInput = {
    specContent: "spec",
    codebaseContext: "context",
    featureName: "auth",
    branchName: "feat/auth",
    outputPath,
  };

  const fileOutput = planRefineOp.fileOutput?.(refineInput);
  expect(fileOutput).toBe(outputPath);

  const editGrants = (planRefineOp.tools ?? [])
    .filter((tool) => tool === "Edit")
    .map((tool) => ({ tool, patterns: ["**"] }));
  expect(editGrants.length).toBe(1);

  const policy = compileToolPolicy(editGrants, root, { ownedWriteExemption: fileOutput });
  const EDIT_SCOPE: ToolScope = { pathFields: ["path"] };

  const ownedRel = relative(root, outputPath);
  const owned = policy.check("Edit", EDIT_SCOPE, { path: ownedRel });
  expect(owned.allowed).toBe(true);

  const other = policy.check("Edit", EDIT_SCOPE, { path: ".nax/features/other/prd.json" });
  expect(other.allowed).toBe(false);
});

test("AC-4: buildGeneratorFromPRDPrompt includes G1 verbatim", () => {
  const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
    featureName: "demo-feature",
    criteriaList: "AC-1: does the thing\nAC-2: handles the empty case",
    frameworkOverrideLine: "",
    targetTestFilePath: "/r/.nax/features/demo-feature/.nax-acceptance.test.ts",
  });
  expect(prompt).toContain(G1);
});

test("AC-5: buildGeneratorFromPRDPrompt includes G2 verbatim", () => {
  const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
    featureName: "demo-feature",
    criteriaList: "AC-1: does the thing",
    frameworkOverrideLine: "",
    targetTestFilePath: "/r/.nax/features/demo-feature/.nax-acceptance.test.ts",
  });
  expect(prompt).toContain(G2);
});

test("AC-6: buildGeneratorFromPRDPrompt includes G3 verbatim", () => {
  const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
    featureName: "demo-feature",
    criteriaList: "AC-1: does the thing",
    frameworkOverrideLine: "",
    targetTestFilePath: "/r/.nax/features/demo-feature/.nax-acceptance.test.ts",
  });
  expect(prompt).toContain(G3);
});

test("AC-7: buildPathCorrection names the target path, includes P1, and drops delete/remove instructions", () => {
  const target = "/r/.nax/features/f/.nax-acceptance.test.ts";
  const text = new AcceptancePromptBuilder().buildPathCorrection(target);
  expect(text).toContain(P1);
  expect(text).toContain(target);
  expect(/delete|remove the file/i.test(text)).toBe(false);
});

test("AC-8: acceptanceGenerateOp.build returns a task section carrying sentence G3", () => {
  const built = acceptanceGenerateOp.build(
    {
      featureName: "demo-feature",
      criteriaList: "AC-1: first criterion\nAC-2: second criterion",
      frameworkOverrideLine: "",
      targetTestFilePath: "/r/.nax/features/demo-feature/.nax-acceptance.test.ts",
    },
    undefined as never,
  );
  const sections = [built.task?.content ?? "", built.role?.content ?? ""].filter(
    (c): c is string => typeof c === "string",
  );
  expect(sections.length).toBeGreaterThan(0);
  expect(sections.some((content) => content.includes(G3))).toBe(true);
});

// ============================================================================
// US-002 — AC count check and missing-file regeneration
// ============================================================================

test("AC-9: acTestCoverage finds all three titled ACs with expected 3", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ['test("AC-1: a", () => {});', 'test("AC-2: b", () => {});', 'test("AC-3: c", () => {});'].join("\n");
  expect(acTestCoverage(source, 3)).toEqual({ expected: 3, found: 3, missing: [] });
});

test("AC-10: acTestCoverage reports AC-2 missing when only AC-1 and AC-3 are titled", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ['test("AC-1: a", () => {});', 'test("AC-3: c", () => {});'].join("\n");
  expect(acTestCoverage(source, 3)).toEqual({ expected: 3, found: 2, missing: ["AC-2"] });
});

test("AC-11: acTestCoverage counts distinct AC numbers — duplicate AC-2 titles count once", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ['test("AC-2: x", () => {});', 'test("AC-2: y", () => {});', 'test("AC-1: a", () => {});'].join("\n");
  const result = acTestCoverage(source, 2);
  expect(result).toEqual({ expected: 2, found: 2, missing: [] });
  expect(result.found).toBe(2);
});

test("AC-12: acTestCoverage recognizes Go TestAC<N> and TestAC_<N> names", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ["func TestAC1_Parses(t *testing.T) {", "func TestAC_2Rejects(t *testing.T) {"].join("\n");
  expect(acTestCoverage(source, 2)).toEqual({ expected: 2, found: 2, missing: [] });
});

test("AC-13: acTestCoverage recognizes pytest test_ac_<N> names case-insensitively", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ["def test_ac_1_parses():", "def test_AC2_rejects():"].join("\n");
  expect(acTestCoverage(source, 2)).toEqual({ expected: 2, found: 2, missing: [] });
});

test("AC-14: acTestCoverage recognizes Rust fn ac<N>/fn ac_<N> names case-insensitively", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ["fn ac_1_parses() {", "fn ac2_rejects() {"].join("\n");
  expect(acTestCoverage(source, 2)).toEqual({ expected: 2, found: 2, missing: [] });
});

test("AC-15: acTestCoverage ignores numbers above expected and lists missing ascending", async () => {
  const acTestCoverage = await loadAcTestCoverage();
  const source = ['test("AC-1: a", () => {});', 'test("AC-5: e", () => {});'].join("\n");
  expect(acTestCoverage(source, 3)).toEqual({ expected: 3, found: 1, missing: ["AC-2", "AC-3"] });
});

test("AC-16: checkAcceptanceCoverage logs exactly one warn and returns the matching entry on a 3-of-5 gap", async () => {
  const checkAcceptanceCoverage = await loadCheckAcceptanceCoverage();
  const testPath = "/r/.nax/features/f/.nax-acceptance.test.ts";
  const source = ['test("AC-1: a", () => {});', 'test("AC-2: b", () => {});', 'test("AC-3: c", () => {});'].join("\n");

  await withWarnSpy(async (warn) => {
    const entry = checkAcceptanceCoverage({ testPath, source, expected: 5, storyId: "US-001" });

    const gapWarns = coverageWarns(warn);
    expect(gapWarns).toHaveLength(1);
    expect(gapWarns[0]?.[2]).toMatchObject({
      storyId: "US-001",
      testPath,
      expected: 5,
      found: 3,
      missing: ["AC-4", "AC-5"],
    });
    expect(entry).toEqual({ testPath, expected: 5, found: 3, missing: ["AC-4", "AC-5"] });
  });
});

test("AC-17: checkAcceptanceCoverage logs no warn and reports full coverage when every AC is titled", async () => {
  const checkAcceptanceCoverage = await loadCheckAcceptanceCoverage();
  const testPath = "/r/.nax/features/f/.nax-acceptance.test.ts";
  const source = [1, 2, 3, 4, 5].map((n) => `test("AC-${n}: case ${n}", () => {});`).join("\n");

  await withWarnSpy(async (warn) => {
    const entry = checkAcceptanceCoverage({ testPath, source, expected: 5, storyId: "US-001" });

    expect(warn.mock.calls).toHaveLength(0);
    expect(entry.found).toBe(5);
    expect(entry.found).toBe(entry.expected);
    expect(entry.missing).toEqual([]);
  });
});

test("AC-18: checkAcceptanceCoverage on empty source returns found 0 without throwing and logs the warn", async () => {
  const checkAcceptanceCoverage = await loadCheckAcceptanceCoverage();
  const testPath = "/r/.nax/features/f/.nax-acceptance.test.ts";

  await withWarnSpy(async (warn) => {
    const entry = checkAcceptanceCoverage({ testPath, source: "", expected: 2, storyId: "US-001" });

    expect(entry).toEqual({ testPath, expected: 2, found: 0, missing: ["AC-1", "AC-2"] });
    const gapWarns = coverageWarns(warn);
    expect(gapWarns.length).toBeGreaterThanOrEqual(1);
  });
});

test("AC-19: setup stage warns on the coverage gap and persists relative coverage in meta", async () => {
  const criteria = ["AC-1: alpha", "AC-2: beta", "AC-3: gamma", "AC-4: delta", "AC-5: epsilon"];
  const ctx = stageCtx([makeStory("US-001", criteria)]);
  const rec = wireSetupDeps({ generateResult: { testCode: genCodeWithTitles(3) } });

  await withWarnSpy(async (warn) => {
    const result = await acceptanceSetupStage.execute(ctx);
    expect(result.action).toBe("continue");

    const gapWarns = coverageWarns(warn);
    expect(gapWarns.length).toBeGreaterThanOrEqual(1);
    const warnWithGap = gapWarns.find((c) => (c[2] as { missing?: string[] } | undefined)?.missing !== undefined);
    expect(warnWithGap).toBeDefined();
    expect((warnWithGap?.[2] as { missing: string[] }).missing).toEqual(["AC-4", "AC-5"]);

    expect(rec.metas).toHaveLength(1);
    const meta = rec.metas[0] as { coverage?: CoverageEntry[] };
    expect(meta.coverage).toHaveLength(1);

    const writtenTestPath = rec.writtenTestPaths[0];
    expect(writtenTestPath).toBeDefined();
    const expectedRel = relative(ctx.workdir, writtenTestPath);
    const entry = meta.coverage?.[0] as CoverageEntry;
    expect(isAbsolute(entry.testPath)).toBe(false);
    expect(entry.testPath).toBe(expectedRel);
    expect(entry).toEqual({
      testPath: expectedRel,
      expected: 5,
      found: 3,
      missing: ["AC-4", "AC-5"],
    });
  });
});

test("AC-20: two fully covered groups log no coverage warn and meta records two clean entries", async () => {
  const stories = [
    makeStory("US-001", ["AC-1: api alpha", "AC-2: api beta"], "apps/a"),
    makeStory("US-002", ["AC-1: cli alpha", "AC-2: cli beta", "AC-3: cli gamma"], "apps/b"),
  ];
  const ctx = stageCtx(stories);
  const rec = wireSetupDeps();
  // Generate per-group code sized to each group's own AC count.
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if ((op as { name: string }).name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if ((op as { name: string }).name === "acceptance-generate") {
      const { criteriaList } = input as { criteriaList: string };
      const count = criteriaList.split("\n").filter((line) => line.trim().length > 0).length;
      return { testCode: genCodeWithTitles(count) };
    }
    throw new Error(`unexpected op: ${(op as { name: string }).name}`);
  };

  await withWarnSpy(async (warn) => {
    await acceptanceSetupStage.execute(ctx);
    expect(coverageWarns(warn)).toHaveLength(0);

    expect(rec.metas).toHaveLength(1);
    const meta = rec.metas[0] as { coverage?: CoverageEntry[] };
    const coverage = meta.coverage ?? [];
    expect(coverage).toHaveLength(2);
    expect(coverage.every((e) => !isAbsolute(e.testPath))).toBe(true);

    const a = coverage.find((e) => e.testPath.includes("apps/a"));
    const b = coverage.find((e) => e.testPath.includes("apps/b"));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.expected).toBe(2);
    expect(a?.found).toBe(2);
    expect(a?.missing).toEqual([]);
    expect(b?.expected).toBe(3);
    expect(b?.found).toBe(3);
    expect(b?.missing).toEqual([]);
  });
});

test("AC-21: a coverage gap never alters the stage result — action is 'continue' with and without a gap", async () => {
  const runScenario = async (titles: number): Promise<string> => {
    const ctx = stageCtx([makeStory("US-001", ["AC-1: a", "AC-2: b", "AC-3: c"])]);
    wireSetupDeps({
      generateResult: { testCode: genCodeWithTitles(titles) },
      runTest: () => ({ exitCode: 1, output: "(fail) AC-1: x" }),
    });
    const result = await acceptanceSetupStage.execute(ctx);
    return result.action;
  };

  const gapAction = await runScenario(1); // only AC-1 covered of 3 expected
  const fullAction = await runScenario(3); // fully covered

  expect(gapAction).toBe("continue");
  expect(fullAction).toBe("continue");
  expect(gapAction).toBe(fullAction);
});

test("AC-22: post-run stage warns on the AC gap and returns the identical action as the covered file", async () => {
  const testPath = join(newTempDir(), ".nax-acceptance.test.ts");
  const story = makeStory("US-001", ["AC-1: a", "AC-2: b", "AC-3: c"]);
  const ctx = stageCtx([story]);
  ctx.acceptanceTestPaths = [
    {
      testPath,
      packageDir: ctx.workdir,
      storyCount: 1,
      acceptanceEnabled: true,
      commandOverride: "echo ok",
    },
  ] as NonNullable<PipelineContext["acceptanceTestPaths"]>;

  // Scenario A: the existing file titles only AC-1 and AC-2 of the 3 in-scope ACs.
  // Assert inside the spy callback: withWarnSpy restores (and clears) the spy when
  // it resolves, so the warn records must be inspected while the spy is live.
  writeFileSync(testPath, 'test("AC-1: a", () => {});\ntest("AC-2: b", () => {});\n');
  const gapAction = await withWarnSpy(async (warn) => {
    const result = await acceptanceStage.execute(ctx);
    const gapWarns = coverageWarns(warn);
    expect(gapWarns).toHaveLength(1);
    expect(gapWarns[0]?.[2]).toMatchObject({ testPath, expected: 3, found: 2, missing: ["AC-3"] });
    return result.action;
  });
  expect(gapAction).toBe("continue");

  // Scenario B: the file titles AC-1 through AC-3, identical runner outcome.
  writeFileSync(
    testPath,
    ['test("AC-1: a", () => {});', 'test("AC-2: b", () => {});', 'test("AC-3: c", () => {});'].join("\n"),
  );
  const fullAction = await withWarnSpy(async (warn) => {
    const result = await acceptanceStage.execute(ctx);
    expect(coverageWarns(warn)).toHaveLength(0);
    return result.action;
  });
  expect(fullAction).toBe(gapAction);
  expect(story.status).toBe("pending");
});

test("AC-23: fingerprint match with a missing file regenerates once and warns with missingTestPaths", async () => {
  const criteria = ["AC-1: alpha", "AC-2: beta"];
  const ctx = stageCtx([makeStory("US-001", criteria)]);
  const expectedTestPath = join(featureDir(ctx.workdir, FEATURE), acceptanceTestFilename(undefined));

  const rec = wireSetupDeps({
    generateResult: { testCode: genCodeWithTitles(2) },
    fileExists: () => false,
    readMeta: () => ({
      generatedAt: new Date().toISOString(),
      acFingerprint: computeACFingerprint(criteria),
      layoutFingerprint: computeAcceptanceLayoutFingerprint(ctx.workdir, [
        { testPath: expectedTestPath, stories: [{ id: "US-001" }] },
      ]),
      storyCount: 1,
      acCount: 2,
      generator: "nax",
    }),
  });

  await withWarnSpy(async (warn) => {
    await acceptanceSetupStage.execute(ctx);

    expect(rec.generateCalls).toHaveLength(1);
    const missingWarns = warn.mock.calls.filter(
      (c) => c[1] === "Acceptance test file missing despite fingerprint match — regenerating",
    );
    expect(missingWarns).toHaveLength(1);
    const payload = (missingWarns[0]?.[2] ?? {}) as { storyId?: string; missingTestPaths?: string[] };
    // The caller may report the vanished file relative to the workdir or as the
    // absolute path on disk; both name the group's test file. Assert on the
    // basename-bearing path rather than one exact framing.
    const expectedRelPath = relative(ctx.workdir, expectedTestPath);
    expect(payload.missingTestPaths).toHaveLength(1);
    expect([expectedRelPath, expectedTestPath]).toContain(payload.missingTestPaths?.[0]);
    const storyId = payload.storyId ?? (missingWarns[0]?.[3] as string | undefined);
    expect(storyId).toBe("US-001");
  });
});

test("AC-24: fingerprint match with every file present calls neither op and leaves files untouched", async () => {
  const criteria = ["AC-1: alpha", "AC-2: beta"];
  const ctx = stageCtx([makeStory("US-001", criteria)]);
  const expectedTestPath = join(featureDir(ctx.workdir, FEATURE), acceptanceTestFilename(undefined));

  const rec = wireSetupDeps({
    fileExists: () => true,
    readMeta: () => ({
      generatedAt: new Date().toISOString(),
      acFingerprint: computeACFingerprint(criteria),
      layoutFingerprint: computeAcceptanceLayoutFingerprint(ctx.workdir, [
        { testPath: expectedTestPath, stories: [{ id: "US-001" }] },
      ]),
      storyCount: 1,
      acCount: 2,
      generator: "nax",
    }),
  });

  await acceptanceSetupStage.execute(ctx);

  expect(rec.refineCalls).toHaveLength(0);
  expect(rec.generateCalls).toHaveLength(0);
  expect(rec.repairCalls).toHaveLength(0);
  expect(rec.written.some((w) => w.path === expectedTestPath)).toBe(false);
});

test("AC-25: after missing-file regeneration the writeMeta meta carries the fresh AC fingerprint and prior fields", async () => {
  const criteria = ["AC-1: alpha", "AC-2: beta"];
  const ctx = stageCtx([makeStory("US-001", criteria)]);
  const expectedTestPath = join(featureDir(ctx.workdir, FEATURE), acceptanceTestFilename(undefined));
  const layoutFingerprint = computeAcceptanceLayoutFingerprint(ctx.workdir, [
    { testPath: expectedTestPath, stories: [{ id: "US-001" }] },
  ]);

  const rec = wireSetupDeps({
    generateResult: { testCode: genCodeWithTitles(2) },
    fileExists: () => false,
    readMeta: () => ({
      generatedAt: new Date().toISOString(),
      acFingerprint: computeACFingerprint(criteria),
      layoutFingerprint,
      storyCount: 1,
      acCount: 2,
      generator: "nax",
    }),
  });

  await acceptanceSetupStage.execute(ctx);

  expect(rec.metas).toHaveLength(1);
  const meta = rec.metas[0] as Record<string, unknown>;
  expect(meta.acFingerprint).toBe(computeACFingerprint(criteria));
  expect(typeof meta.generatedAt).toBe("string");
  expect((meta.generatedAt as string).length).toBeGreaterThan(0);
  expect(meta.layoutFingerprint).toBe(layoutFingerprint);
  expect(meta.storyCount).toBe(1);
  expect(meta.acCount).toBe(2);
  expect(meta.generator).toBe("nax");
});

test("AC-26: a dispatch failure completes quietly and adds no coverage entry for the fileless group", async () => {
  const ctx = stageCtx([makeStory("US-001", ["AC-1: only criterion"])]);
  const expectedTestPath = join(featureDir(ctx.workdir, FEATURE), acceptanceTestFilename(undefined));
  const expectedRel = relative(ctx.workdir, expectedTestPath);

  const rec = wireSetupDeps({
    generateResult: {
      testCode: null,
      adapterFailure: { category: "availability", outcome: "fail-service-down", message: "vendor down" },
    },
  });

  await withWarnSpy(async (warn) => {
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBeDefined();
    expect(coverageWarns(warn)).toHaveLength(0);

    const persistedCoverage = rec.metas.flatMap((m) => (m.coverage as CoverageEntry[] | undefined) ?? []);
    expect(persistedCoverage.some((e) => e.testPath === expectedRel || isAbsolute(e.testPath))).toBe(false);
  });
});

// ============================================================================
// US-003 — acceptance-refine fails loud
// ============================================================================

const refineInput = {
  criteria: ["a criterion", "b criterion", "c criterion"],
  codebaseContext: "",
  storyId: "US-042",
};

test("AC-27: acceptanceRefineOp.parse rejects with ParseValidationError on unusable output", async () => {
  let caught: unknown = null;
  let resolved: unknown = "unset";
  try {
    resolved = await acceptanceRefineOp.parse("I could not refine these criteria", refineInput, undefined as never);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ParseValidationError);
  expect(resolved).toBe("unset");
});

test("AC-28: a 2-item array for 3 criteria rejects with 'returned 2 of 3 criteria'", async () => {
  const output = JSON.stringify([
    { original: "a criterion", refined: "ra", testable: true },
    { original: "b criterion", refined: "rb", testable: true },
  ]);
  let caught: unknown = null;
  try {
    await acceptanceRefineOp.parse(output, refineInput, undefined as never);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ParseValidationError);
  expect((caught as Error).message).toContain("acceptance-refine: returned 2 of 3 criteria");
});

test("AC-29: a 4-item array for 3 criteria rejects with 'returned 4 of 3 criteria'", async () => {
  const output = JSON.stringify([
    { original: "a criterion", refined: "ra", testable: true },
    { original: "b criterion", refined: "rb", testable: true },
    { original: "c criterion", refined: "rc", testable: true },
    { original: "extra", refined: "rx", testable: true },
  ]);
  let caught: unknown = null;
  try {
    await acceptanceRefineOp.parse(output, refineInput, undefined as never);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ParseValidationError);
  expect((caught as Error).message).toContain("acceptance-refine: returned 4 of 3 criteria");
});

test("AC-30: a well-sized array without storyIds resolves with every entry stamped from input.storyId", async () => {
  const output = JSON.stringify([
    { original: "a criterion", refined: "ra", testable: true },
    { original: "b criterion", refined: "rb", testable: true },
    { original: "c criterion", refined: "rc", testable: false },
  ]);
  const result = await acceptanceRefineOp.parse(output, refineInput, undefined as never);
  expect(Array.isArray(result)).toBe(true);
  expect(result).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    expect(result[i]?.storyId).toBe(refineInput.storyId);
  }
});

function refineCtxWithLogger(concurrency: number): { ctx: PipelineContext; log: MockLogger } {
  const ctx = stageCtx([makeStory("US-001", ["seed criterion"])], {
    refinement: true,
    refinementConcurrency: concurrency,
  });
  const log = makeLogger();
  (ctx as unknown as { logger: MockLogger }).logger = log;
  return { ctx, log };
}

test("AC-31: refineAcceptanceCriteria marks only the rejected story's criteria as fallback", async () => {
  const refine = await loadRefineAcceptanceCriteria();
  const { ctx } = refineCtxWithLogger(3);
  const us001 = ["US-001 alpha"];
  const us002 = ["US-002 first", "US-002 second"];
  const us003 = ["US-003 alpha"];
  const stories = [makeStory("US-001", us001), makeStory("US-002", us002), makeStory("US-003", us003)];

  const callOp = async (
    _ctx: unknown,
    _packageDir: string,
    _op: unknown,
    input: unknown,
    storyId?: string,
  ): Promise<unknown> => {
    const { criteria, storyId: inputStoryId } = input as { criteria: string[]; storyId?: string };
    const sid = inputStoryId ?? storyId;
    if (sid === "US-002") throw new Error("refine exploded for US-002");
    return criteria.map((c) => ({ original: c, refined: `refined::${c}`, testable: true, storyId: sid }));
  };

  const result = await refine(ctx, stories, new Map([[ctx.workdir, ctx.config]]), callOp);

  expect(result.fallbackStoryIds).toEqual(["US-002"]);
  for (const c of us002) {
    const entry = result.criteria.find((e) => e.original === c);
    expect(entry).toBeDefined();
    expect(entry?.refined).toBe(c);
    expect(entry?.testable).toBe(true);
    expect(entry?.storyId).toBe("US-002");
    expect(entry?.refinementFallback).toBe(true);
  }
  const otherEntries = result.criteria.filter((e) => e.storyId !== "US-002");
  expect(otherEntries.length).toBe(us001.length + us003.length);
  expect(otherEntries.some((e) => e.refinementFallback === true)).toBe(false);
});

test("AC-32: two failed stories produce exactly one run-level warn naming both story ids", async () => {
  const refine = await loadRefineAcceptanceCriteria();
  // Observe the run-level warn on the process logger the stage resolves via
  // getSafeLogger(); assert inside the spy callback because withWarnSpy restores
  // (and clears) the spy when it resolves.
  const ctx = stageCtx([makeStory("US-001", ["seed criterion"])], {
    refinement: true,
    refinementConcurrency: 3,
  });
  const stories = [
    makeStory("US-001", ["US-001 alpha"]),
    makeStory("US-002", ["US-002 alpha"]),
    makeStory("US-003", ["US-003 alpha"]),
  ];

  const callOp = async (
    _ctx: unknown,
    _packageDir: string,
    _op: unknown,
    input: unknown,
    storyId?: string,
  ): Promise<unknown> => {
    const { criteria, storyId: inputStoryId } = input as { criteria: string[]; storyId?: string };
    const sid = inputStoryId ?? storyId;
    if (sid === "US-001" || sid === "US-003") throw new Error("refine unusable");
    return criteria.map((c) => ({ original: c, refined: `refined::${c}`, testable: true, storyId: sid }));
  };

  const result = await withWarnSpy(async (warn) => {
    const refined = await refine(ctx, stories, new Map([[ctx.workdir, ctx.config]]), callOp);

    const calls = warn.mock.calls as unknown[][];
    expect(calls).toHaveLength(1);
    const call = calls[0] ?? [];
    const messageArg = call.find((a) => a === "AC refinement unusable after retries — using unrefined criteria");
    expect(messageArg).toBeDefined();
    const payloadArg = call.find(
      (a) => a !== null && typeof a === "object" && !Array.isArray(a),
    ) as Record<string, unknown> | undefined;
    expect(payloadArg?.storyIds).toEqual(["US-001", "US-003"]);
    expect("storyId" in (payloadArg ?? {})).toBe(true);

    return refined;
  });

  expect(result.fallbackStoryIds).toEqual(["US-001", "US-003"]);
});

test("AC-33: all stories refining cleanly yields no fallback ids and no run-level warn", async () => {
  const refine = await loadRefineAcceptanceCriteria();
  const { ctx, log } = refineCtxWithLogger(3);
  const stories = [makeStory("US-001", ["US-001 alpha"]), makeStory("US-002", ["US-002 alpha"])];

  const callOp = async (
    _ctx: unknown,
    _packageDir: string,
    _op: unknown,
    input: unknown,
    storyId?: string,
  ): Promise<unknown> => {
    const { criteria, storyId: inputStoryId } = input as { criteria: string[]; storyId?: string };
    const sid = inputStoryId ?? storyId;
    return criteria.map((c) => ({ original: c, refined: `refined::${c}`, testable: true, storyId: sid }));
  };

  const result = await refine(ctx, stories, new Map([[ctx.workdir, ctx.config]]), callOp);

  expect(result.fallbackStoryIds).toEqual([]);
  const matching = log.warn.mock.calls.filter((c) =>
    (c as unknown[]).includes("AC refinement unusable after retries — using unrefined criteria"),
  );
  expect(matching).toHaveLength(0);
});

test("AC-34: refine rejection for US-002 still generates from originals and persists fallback flags", async () => {
  const ctx = stageCtx([
    makeStory("US-001", ["US-001 first criterion", "US-001 second criterion"]),
    makeStory("US-002", ["US-002 retry backoff criterion"]),
  ]);
  const rec = wireSetupDeps({
    refineImpl: ({ criteria, storyId }) =>
      criteria.map((c) => ({ original: c, refined: `refined::${c}`, testable: true, storyId })),
    refineRejectFor: new Set(["US-002"]),
    generateResult: { testCode: genCodeWithTitles(3) },
  });

  await acceptanceSetupStage.execute(ctx);

  expect(rec.generateCalls).toHaveLength(1);
  const criteriaList = String(rec.generateCalls[0]?.input.criteriaList ?? "");
  expect(criteriaList).toContain("US-002 retry backoff criterion");

  const refinedWrite = rec.written.find((w) => w.path.endsWith("acceptance-refined.json"));
  expect(refinedWrite).toBeDefined();
  const entries = JSON.parse(refinedWrite?.content ?? "[]") as Array<{
    storyId: string;
    refinementFallback?: boolean;
  }>;
  expect(entries.length).toBeGreaterThan(0);
  const us002Entries = entries.filter((e) => e.storyId === "US-002");
  expect(us002Entries.length).toBe(1);
  expect(us002Entries.every((e) => e.refinementFallback === true)).toBe(true);
  const otherEntries = entries.filter((e) => e.storyId !== "US-002");
  expect(otherEntries.length).toBe(2);
  expect(otherEntries.every((e) => e.refinementFallback === false)).toBe(true);
});

test("AC-35: refinement disabled persists acceptance-refined.json with every entry refinementFallback false", async () => {
  const ctx = stageCtx([makeStory("US-001", ["US-001 alpha"]), makeStory("US-002", ["US-002 beta"])], {
    refinement: false,
  });
  const rec = wireSetupDeps({ generateResult: { testCode: genCodeWithTitles(2) } });

  await acceptanceSetupStage.execute(ctx);

  const refinedWrite = rec.written.find((w) => w.path.endsWith("acceptance-refined.json"));
  expect(refinedWrite).toBeDefined();
  const entries = JSON.parse(refinedWrite?.content ?? "[]") as Array<{ refinementFallback?: boolean }>;
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((e) => e.refinementFallback === false)).toBe(true);
});

test("AC-36: concurrency 1 preserves input story order in the concatenated criteria", async () => {
  const refine = await loadRefineAcceptanceCriteria();
  const { ctx } = refineCtxWithLogger(1);
  const stories = [
    makeStory("US-001", ["S1 criterion"]),
    makeStory("US-002", ["S2 criterion one", "S2 criterion two"]),
    makeStory("US-003", ["S3 criterion"]),
  ];

  const callOp = async (
    _ctx: unknown,
    _packageDir: string,
    _op: unknown,
    input: unknown,
    storyId?: string,
  ): Promise<unknown> => {
    const { criteria, storyId: inputStoryId } = input as { criteria: string[]; storyId?: string };
    const sid = inputStoryId ?? storyId;
    return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: sid }));
  };

  const result = await refine(ctx, stories, new Map([[ctx.workdir, ctx.config]]), callOp);

  expect(result.criteria).toHaveLength(4);
  expect(result.criteria.map((c) => c.storyId)).toEqual(["US-001", "US-002", "US-002", "US-003"]);
  expect(result.criteria.map((c) => c.original)).toEqual([
    "S1 criterion",
    "S2 criterion one",
    "S2 criterion two",
    "S3 criterion",
  ]);
});

// ============================================================================
// US-004 — Crash classifier and acceptance repair op
// ============================================================================

test("AC-37: Go missing-symbol error line with FAIL trailer classifies expected-red", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  const output = "./acceptance_test.go:12:5: undefined: ParseConfig\nFAIL\texample.com/pkg [build failed]";
  expect(classify(output, "go")).toBe("expected-red");
});

test("AC-38: Go '<expr> undefined (type ...)' message classifies expected-red", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  const output = "./acceptance_test.go:9:14: cfg.Parse undefined (type *Config has no field or method Parse)";
  expect(classify(output, "go")).toBe("expected-red");
});

test("AC-39: a Go syntax error mixed with a missing symbol classifies repairable", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  const output =
    "./acceptance_test.go:12:5: undefined: ParseConfig\n./acceptance_test.go:20:1: syntax error: unexpected }";
  expect(classify(output, "go")).toBe("repairable");
});

test("AC-40: Go output with no error line classifies repairable", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("panic: runtime error: invalid memory address", "go")).toBe("repairable");
});

test("AC-41: Rust E0425 with a compile summary line classifies expected-red", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  const output =
    'error[E0425]: cannot find function `parse_config` in this scope\nerror: could not compile `ex` (test "acceptance") due to 1 previous error';
  expect(classify(output, "rust")).toBe("expected-red");
});

test("AC-42: Rust E0432 is in the allowed code set", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error[E0432]: unresolved import `crate::config`", "rust")).toBe("expected-red");
});

test("AC-43: Rust E0433 is in the allowed code set", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error[E0433]: failed to resolve: could not find `config` in `crate`", "rust")).toBe("expected-red");
});

test("AC-44: Rust E0412 is in the allowed code set", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error[E0412]: cannot find type `Config` in this scope", "rust")).toBe("expected-red");
});

test("AC-45: Rust E0599 is in the allowed code set", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(
    classify("error[E0599]: no method named `parse_config` found for struct `Parser` in the current scope", "rust"),
  ).toBe("expected-red");
});

test("AC-46: Rust E0308 is not in the allowed code set", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error[E0308]: mismatched types", "rust")).toBe("repairable");
});

test("AC-47: an uncoded Rust 'error: ' syntax line classifies repairable", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error: expected one of `;` or `}`, found `let`", "rust")).toBe("repairable");
});

test("AC-48: any non-Go/Rust language classifies repairable", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("error: Cannot find module '../src/new-module'", "typescript")).toBe("repairable");
});

test("AC-49: an undefined language always classifies repairable", async () => {
  const classify = await loadClassifyAcceptanceCrash();
  expect(classify("./acceptance_test.go:12:5: undefined: ParseConfig", undefined)).toBe("repairable");
});

test("AC-50: acceptanceRepairOp declares the repair identity, session and six-tool grant", async () => {
  const repairOp = await loadAcceptanceRepairOp();
  expect(repairOp.kind).toBe("run");
  expect(repairOp.name).toBe("acceptance-repair");
  expect(repairOp.stage).toBe("acceptance");
  expect(repairOp.session).toEqual({ role: "acceptance-gen", lifetime: "fresh" });
  expect(repairOp.tools).toEqual(EXPECTED_TOOLS);
});

test("AC-51: acceptanceRepairOp.build names the path, fences the output tail, and carries G2", async () => {
  const repairOp = await loadAcceptanceRepairOp();
  const outputTail = "error: Cannot find module 'x'";
  const built = repairOp.build({ targetTestFilePath: "/r/t.test.ts", outputTail }, {});
  const text = buildText(built);

  expect(text).toContain("/r/t.test.ts");

  const tailIdx = text.indexOf(outputTail);
  expect(tailIdx).toBeGreaterThanOrEqual(0);
  const openFence = text.lastIndexOf("```", tailIdx);
  const closeFence = text.indexOf("```", tailIdx + outputTail.length);
  expect(openFence).toBeGreaterThanOrEqual(0);
  expect(closeFence).toBeGreaterThan(tailIdx);

  expect(text).toContain(G2);
});

test("AC-52: verify with null parsed testCode recovers the exact existing file content", async () => {
  const repairOp = await loadAcceptanceRepairOp();
  const dir = newTempDir();
  const target = join(dir, "t.test.ts");
  const content = [
    'import { expect, test } from "bun:test";',
    'test("AC-1: computes the total", () => {',
    "  expect(computeTotal([1, 2])).toBe(3);",
    "});",
  ].join("\n");
  writeFileSync(target, content);

  const result = await repairOp.verify(
    { testCode: null },
    { targetTestFilePath: target, outputTail: "error: Cannot find module './totals'" },
    { readFile: async () => content },
  );

  expect(result).not.toBeNull();
  expect((result as { testCode: string | null }).testCode).toBe(content);
});

test("AC-53: verify with null parsed testCode and no file on disk returns exactly null", async () => {
  const repairOp = await loadAcceptanceRepairOp();
  const target = join(newTempDir(), "absent.test.ts");

  const result = await repairOp.verify(
    { testCode: null },
    { targetTestFilePath: target, outputTail: "error: Cannot find module './totals'" },
    { readFile: async () => null },
  );

  expect(result).toBeNull();
});

test("AC-54: both barrels export acceptanceRepairOp and classifyAcceptanceCrash", async () => {
  const operations = (await import("@/operations")) as unknown as Record<string, unknown>;
  const op = operations.acceptanceRepairOp as { name?: string } | undefined;
  expect(op).toBeDefined();
  expect(op?.name).toBe("acceptance-repair");

  const testRunners = (await import("@/test-runners")) as unknown as Record<string, unknown>;
  const classify = testRunners.classifyAcceptanceCrash;
  expect(typeof classify).toBe("function");
  const sample = (classify as ClassifyFn)("error: Cannot find module '../src/new-module'", undefined);
  expect(sample).toBe("repairable");
});

// ============================================================================
// US-005 — RED gate repairs a crashing acceptance file
// ============================================================================

interface GateHarness {
  deps: Pick<typeof _acceptanceSetupDeps, "runTest" | "callOp" | "writeFile" | "autoCommitIfDirty">;
  callsOf: (api: string) => Array<{ api: string; testPath: string | undefined; seq: number }>;
  writes: Array<{ path: string; content: string }>;
  opCalls: Array<{ opName: string; op: unknown; input: Record<string, unknown> }>;
}

function gateHarness(opts: {
  runTest: (testPath: string, callIndexForPath: number) => { exitCode: number; output: string };
  repairResult?: { testCode: string | null } | Error;
}): GateHarness {
  const order: Array<{ api: string; testPath: string | undefined; seq: number }> = [];
  let seq = 0;
  const mark = (api: string, testPath?: string) => {
    const s = seq++;
    order.push({ api, testPath, seq: s });
    return s;
  };
  const writes: Array<{ path: string; content: string }> = [];
  const opCalls: Array<{ opName: string; op: unknown; input: Record<string, unknown> }> = [];
  const perPath = new Map<string, number>();

  const deps = {
    runTest: async (testPath: string) => {
      const n = (perPath.get(testPath) ?? 0) + 1;
      perPath.set(testPath, n);
      mark("runTest", testPath);
      return opts.runTest(testPath, n);
    },
    callOp: async (
      _ctx: unknown,
      _packageDir: string,
      op: { name: string },
      input: Record<string, unknown>,
    ) => {
      mark("callOp", (input as { targetTestFilePath?: string }).targetTestFilePath);
      opCalls.push({ opName: op.name, op, input });
      if (opts.repairResult instanceof Error) throw opts.repairResult;
      return opts.repairResult ?? { testCode: "REPAIRED" };
    },
    writeFile: async (p: string, content: string) => {
      mark("writeFile", p);
      writes.push({ path: p, content });
    },
    autoCommitIfDirty: async () => {
      mark("autoCommit");
    },
  };

  return {
    deps,
    callsOf: (api: string) => order.filter((o) => o.api === api),
    writes,
    opCalls,
  };
}

function gateEntry(testPath: string, packageDir: string, overrides: Partial<RedGateEntry> = {}): RedGateEntry {
  return { testPath, packageDir, language: "ts", storyId: "US-001", config: DEFAULT_CONFIG, ...overrides };
}

test("AC-55: repairable TS crash dispatches acceptanceRepairOp once with the bounded output tail", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const repairOp = await loadAcceptanceRepairOp();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");
  const rawOutput = "error: Cannot find module ../src/x";

  const h = gateHarness({ runTest: () => ({ exitCode: 1, output: rawOutput }) });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  const repairs = h.opCalls.filter((c) => c.opName === "acceptance-repair");
  expect(repairs).toHaveLength(1);
  expect(repairs[0]?.op).toBe(repairOp);
  expect(repairs[0]?.input.targetTestFilePath).toBe(T);
  expect(repairs[0]?.input.outputTail).toBe(rawOutput.slice(-MAX_RAW_TAIL_CHARS));
});

test("AC-56: a repairable crash reruns the same testPath after the repair turn", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({ runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/x'" }) });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  const runTestCalls = h.callsOf("runTest").filter((c) => c.testPath === T);
  expect(runTestCalls).toHaveLength(2);
  const callOpCalls = h.callsOf("callOp");
  expect(callOpCalls).toHaveLength(1);
  expect(runTestCalls[1]?.seq).toBeGreaterThan(callOpCalls[0]?.seq ?? 0);
});

test("AC-57: a non-null repair result is written to the target path before the rerun", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({
    runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/x'" }),
    repairResult: { testCode: "REPAIRED" },
  });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]?.path).toBe(T);
  expect(h.writes[0]?.content).toBe("REPAIRED");

  const writeFileSeq = h.callsOf("writeFile")[0]?.seq ?? 0;
  const callOpSeq = h.callsOf("callOp")[0]?.seq ?? 0;
  const runTestSeqs = h.callsOf("runTest").map((c) => c.seq);
  expect(writeFileSeq).toBeGreaterThan(callOpSeq);
  expect(writeFileSeq).toBeLessThan(runTestSeqs[1] ?? Number.MAX_SAFE_INTEGER);
});

test("AC-58: the post-repair commit runs after the repair and before the rerun", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({
    runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/x'" }),
    repairResult: { testCode: "REPAIRED" },
  });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  const commits = h.callsOf("autoCommit");
  expect(commits).toHaveLength(1);
  const callOpSeq = h.callsOf("callOp")[0]?.seq ?? 0;
  const runTestSeqs = h.callsOf("runTest").map((c) => c.seq);
  expect(commits[0]?.seq).toBeGreaterThan(callOpSeq);
  expect(commits[0]?.seq).toBeLessThan(runTestSeqs[1] ?? Number.MAX_SAFE_INTEGER);
});

test("AC-59: a second crash after repair logs the still-crashes warn once with the testPath", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({ runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/x'" }) });

  await withWarnSpy(async (warn) => {
    await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

    expect(h.callsOf("runTest")).toHaveLength(2);
    expect(h.callsOf("callOp")).toHaveLength(1);
    const stillCrash = warn.mock.calls.filter((c) => c[1] === "RED gate: acceptance file still crashes after repair");
    expect(stillCrash).toHaveLength(1);
    expect((stillCrash[0]?.[2] as { testPath?: string } | undefined)?.testPath).toBe(T);
  });
});

test("AC-60: Go missing-symbol crashes count RED with an info log and no repair dispatch", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance_test.go");
  const output = "./acceptance_test.go:12:5: undefined: ParseConfig";

  const h = gateHarness({ runTest: () => ({ exitCode: 1, output }) });

  await withInfoSpy(async (info) => {
    const redCount = await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir, { language: "go" })], h.deps);

    expect(h.opCalls.filter((c) => c.opName === "acceptance-repair")).toHaveLength(0);
    expect(h.callsOf("runTest")).toHaveLength(1);
    expect(redCount).toBe(1);

    const expectedRedLogs = info.mock.calls.filter(
      (c) => c[1] === "RED gate: compile errors are all missing-symbol — expected RED",
    );
    expect(expectedRedLogs).toHaveLength(1);
    expect(expectedRedLogs[0]?.[2]).toMatchObject({ testPath: T, language: "go" });
  });
});

test("AC-61: a Go syntax-error crash is repairable and dispatches the repair op once", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const repairOp = await loadAcceptanceRepairOp();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance_test.go");

  const h = gateHarness({
    runTest: () => ({ exitCode: 1, output: "./acceptance_test.go:20:1: syntax error: unexpected }" }),
  });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir, { language: "go" })], h.deps);

  const repairs = h.opCalls.filter((c) => c.opName === "acceptance-repair");
  expect(repairs).toHaveLength(1);
  expect(repairs[0]?.op).toBe(repairOp);
  expect(repairs[0]?.input.targetTestFilePath).toBe(T);
});

test("AC-62: a genuine RED with an AC-tagged failure triggers no repair and no rerun", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({ runTest: () => ({ exitCode: 1, output: "(fail) AC-1: x" }) });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  expect(h.opCalls.filter((c) => c.opName === "acceptance-repair")).toHaveLength(0);
  expect(h.callsOf("runTest")).toHaveLength(1);
});

test("AC-63: a green run triggers nothing and contributes zero to the RED count", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({ runTest: () => ({ exitCode: 0, output: "1 passed" }) });
  const redCount = await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  expect(h.opCalls.filter((c) => c.opName === "acceptance-repair")).toHaveLength(0);
  expect(h.callsOf("runTest")).toHaveLength(1);
  expect(redCount).toBe(0);
});

test("AC-64: a rejected repair logs the failure, skips the rerun, and the stage still continues", async () => {
  const ctx = stageCtx([makeStory("US-001", ["AC-1: only criterion"])], { refinement: false });
  const expectedTestPath = join(featureDir(ctx.workdir, FEATURE), acceptanceTestFilename(undefined));
  const repairError = new Error("repair dispatch exploded");

  const rec = wireSetupDeps({
    generateResult: { testCode: genCodeWithTitles(1) },
    repairResult: repairError,
    runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/never-created'" }),
  });

  await withWarnSpy(async (warn) => {
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("continue");

    const failed = warn.mock.calls.filter((c) => c[1] === "RED gate: acceptance repair failed");
    expect(failed).toHaveLength(1);
    const payload = (failed[0]?.[2] ?? {}) as { testPath?: string; error?: unknown };
    expect(payload.testPath).toBe(expectedTestPath);
    const errText =
      payload.error instanceof Error
        ? payload.error.message
        : typeof payload.error === "string"
          ? payload.error
          : undefined;
    expect(errText).toBe("repair dispatch exploded");

    expect(rec.runTestCalls.filter((p) => p === expectedTestPath)).toHaveLength(1);
  });
});

test("AC-65: crashing entries count once in the phase-completed redFailCount — one entry then two", async () => {
  const crashThenRed = (_p: string, n: number) =>
    n === 1
      ? { exitCode: 1, output: "error: Cannot find module '../src/x'" }
      : { exitCode: 1, output: "(fail) AC-1: x" };

  // Scenario 1: one crashing entry contributes exactly 1.
  const ctx1 = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  wireSetupDeps({ generateResult: { testCode: genCodeWithTitles(1) }, runTest: crashThenRed });
  const events1: PostRunPhaseCompletedEvent[] = [];
  const off1 = pipelineEventBus.on("postrun:phase:completed", (e) => {
    if (e.phase === "acceptance-setup") events1.push(e);
  });
  try {
    await acceptanceSetupStage.execute(ctx1);
  } finally {
    off1();
  }
  expect(events1).toHaveLength(1);
  expect((events1[0]?.details as { redFailCount?: number } | undefined)?.redFailCount).toBe(1);

  // Scenario 2: two crashing entries contribute exactly 2.
  const ctx2 = stageCtx([makeStory("US-001", ["AC-1: x"], "apps/x"), makeStory("US-002", ["AC-1: y"], "apps/y")]);
  wireSetupDeps({ generateResult: { testCode: genCodeWithTitles(1) }, runTest: crashThenRed });
  const events2: PostRunPhaseCompletedEvent[] = [];
  const off2 = pipelineEventBus.on("postrun:phase:completed", (e) => {
    if (e.phase === "acceptance-setup") events2.push(e);
  });
  try {
    await acceptanceSetupStage.execute(ctx2);
  } finally {
    off2();
  }
  expect(events2).toHaveLength(1);
  expect((events2[0]?.details as { redFailCount?: number } | undefined)?.redFailCount).toBe(2);
});

test("AC-66: a null repair result writes nothing and still reruns after the repair call", async () => {
  const runAcceptanceRedGate = await loadRunAcceptanceRedGate();
  const ctx = stageCtx([makeStory("US-001", ["AC-1: x"])]);
  const T = join(ctx.workdir, "pkg-a", ".nax-acceptance.test.ts");

  const h = gateHarness({
    runTest: () => ({ exitCode: 1, output: "error: Cannot find module '../src/x'" }),
    repairResult: { testCode: null },
  });
  await runAcceptanceRedGate(ctx, [gateEntry(T, ctx.workdir)], h.deps);

  expect(h.writes.some((w) => w.path === T)).toBe(false);
  const runTestCalls = h.callsOf("runTest").filter((c) => c.testPath === T);
  expect(runTestCalls).toHaveLength(2);
  const callOpSeq = h.callsOf("callOp")[0]?.seq ?? 0;
  expect(runTestCalls[1]?.seq).toBeGreaterThan(callOpSeq);
});
