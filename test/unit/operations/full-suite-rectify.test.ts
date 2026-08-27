import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockCallContext, makeNaxConfig } from "@test/helpers";
import type { Finding, FixCycleContext } from "@/findings";
import type { FullSuiteRectifyInput, FullSuiteRectifyOutput, TestEditDeclaration } from "@/operations";
import {
  _repoScopedFixDeps,
  fullSuiteRectifyOp,
  makeDeclarationSink,
  makeFullSuiteRectifyStrategy,
  makeRepoScopedTestFixStrategy,
} from "@/operations";
import type { UserStory } from "@/prd";

function makeTestFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "some test",
    file: "test/unit/foo.test.ts",
    message: "Expected true but got false",
    ...overrides,
  };
}

function makeTestStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    workdir: ".",
    ...overrides,
  } as UserStory;
}

/** Mock CallContext with storyId pinned — FixCycleContext requires it. */
function makeFixCycleContext(packageDir?: string): FixCycleContext {
  return { ...makeMockCallContext({ packageDir }), storyId: "US-001" };
}

/** Minimal FullSuiteRectifyInput — `extractApplied` does not read it, but the
 *  FixStrategy type requires a complete value so the test asserts against the
 *  shape, not a `{} as never` cargo. */
function makeRectifyInput(scope: "story" | "repo" = "repo"): FullSuiteRectifyInput {
  return { story: makeTestStory(), findings: [], scope };
}

describe("makeFullSuiteRectifyStrategy", () => {
  test("name is full-suite-rectify", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.name).toBe("full-suite-rectify");
  });

  test("coRun is exclusive", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.coRun).toBe("exclusive");
  });

  test("appliesTo returns true for test-runner + failed-test findings", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding();
    expect(strategy.appliesTo(finding)).toBe(true);
  });

  test("appliesTo returns false for other sources", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ source: "lint" });
    expect(strategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns false for other categories (e.g. assertion-failure from acceptance-diagnose)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ category: "assertion-failure" });
    expect(strategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns true for test-runner + execution-failed (synth finding from gate)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    const finding = makeTestFinding({ category: "execution-failed" });
    expect(strategy.appliesTo(finding)).toBe(true);
  });

  test("fixOp references implementerOp (name=implementer)", () => {
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig());
    expect(strategy.fixOp.name).toBe("implementer");
  });

  test("buildInput produces ImplementerInput with story and contextMarkdown", () => {
    const story = makeTestStory();
    const strategy = makeFullSuiteRectifyStrategy(story, makeNaxConfig());
    const finding = makeTestFinding();
    const input = strategy.buildInput([finding], [], makeFixCycleContext());
    expect(input.story).toBe(story);
    expect(typeof input.contextMarkdown).toBe("string");
    const contextMarkdown = input.contextMarkdown;
    assertDefined(contextMarkdown, "input.contextMarkdown");
    expect(contextMarkdown.length).toBeGreaterThan(0);
  });

  test("each call returns a new strategy instance closing over its own story", () => {
    const story1 = makeTestStory({ id: "US-001" });
    const story2 = makeTestStory({ id: "US-002" });
    const s1 = makeFullSuiteRectifyStrategy(story1, makeNaxConfig());
    const s2 = makeFullSuiteRectifyStrategy(story2, makeNaxConfig());
    const input1 = s1.buildInput([], [], makeFixCycleContext());
    const input2 = s2.buildInput([], [], makeFixCycleContext());
    expect(input1.story.id).toBe("US-001");
    expect(input2.story.id).toBe("US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1/2/3/6/7: DeclarationSink parameter wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("makeFullSuiteRectifyStrategy — with DeclarationSink", () => {
  test("AC1: fixOp is fullSuiteRectifyOp when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.fixOp.name).toBe(fullSuiteRectifyOp.name);
  });

  test("AC2: appliesTo returns true for test-runner failed-test when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.appliesTo(makeTestFinding({ source: "test-runner", category: "failed-test" }))).toBe(true);
  });

  test("AC3: appliesTo returns false for semantic-review when sink provided", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    expect(strategy.appliesTo(makeTestFinding({ source: "semantic-review", category: "x" }))).toBe(false);
  });

  test("AC6: extractApplied with mock_structure declaration pushes files to sink.mockHandoffs", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [
        {
          reason: "mock_structure",
          file: "test/unit/foo.test.ts",
          files: ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
          reasonDetail: "mock setup needs restructuring",
        },
      ],
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied(output, input);
    expect(sink.mockHandoffs).toHaveLength(1);
    expect(sink.mockHandoffs[0]?.files).toEqual(["test/unit/foo.test.ts", "test/unit/bar.test.ts"]);
    expect(sink.mockHandoffs[0]?.reasonDetail).toBe("mock setup needs restructuring");
  });

  test("AC6 boundary: extractApplied with mock_structure missing files does not push to sink.mockHandoffs", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const declWithoutFiles: TestEditDeclaration = {
      reason: "mock_structure",
      file: "test/unit/foo.test.ts",
      // no files, no reasonDetail
    };
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [declWithoutFiles] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied(output, input);
    expect(sink.mockHandoffs).toHaveLength(0);
  });

  test("AC7: extractApplied with prd_contract declaration pushes to sink.testEdits", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const decl: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/foo.test.ts",
      prdQuote: "doSomething()",
      testBefore: "old assertion",
      testAfter: "new assertion",
    };
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [decl] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied(output, input);
    expect(sink.testEdits).toHaveLength(1);
    expect(sink.testEdits[0]).toEqual(decl);
  });

  test("AC7 boundary: extractApplied with no declarations does not push to sink", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    strategy.extractApplied(output, input);
    expect(sink.testEdits).toHaveLength(0);
    expect(sink.mockHandoffs).toHaveLength(0);
  });

  test("AC8: extractApplied forwards unresolvedReason as unresolved when no testEditDeclarations", async () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [],
      unresolvedReason: "Test uses relative URLs that the library rejects",
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = await strategy.extractApplied(output, input);
    expect(result.unresolved).toBe("Test uses relative URLs that the library rejects");
    expect(result.summary).toBe("Test uses relative URLs that the library rejects");
  });

  test("AC8 boundary: extractApplied without unresolvedReason leaves unresolved undefined", async () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const output: FullSuiteRectifyOutput = { applied: true, testEditDeclarations: [] };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = await strategy.extractApplied(output, input);
    expect(result.unresolved).toBeUndefined();
    expect(result.summary).toBe("Fixed failing tests");
  });

  test("AC8 priority: UNRESOLVED + testEditDeclarations → testEditDeclarations win, unresolved suppressed", async () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    const decl: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/oauth/admin-client.guard.route.spec.ts",
    };
    const output: FullSuiteRectifyOutput = {
      applied: true,
      testEditDeclarations: [decl],
      unresolvedReason: "Test uses relative URLs",
    };
    const input: FullSuiteRectifyInput = { story: makeTestStory(), findings: [] };
    const result = await strategy.extractApplied(output, input);
    // Declaration flows through to sink so test-writer handoff can fire via postValidate
    expect(sink.testEdits).toHaveLength(1);
    // unresolved is suppressed — agent-gave-up must NOT fire when a handoff can still run
    expect(result.unresolved).toBeUndefined();
    // summary must not echo the UNRESOLVED text either: this iteration is a handoff, not a give-up
    expect(result.summary).toBe("Fixed failing tests");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1352: mock_structure handoff short-circuit — the exclusive implementer must
// stop claiming failing-test findings while a handoff is pending SO the co-run
// autofix-test-writer is selected, but only when a test-writer drainer exists.
// ─────────────────────────────────────────────────────────────────────────────

describe("makeFullSuiteRectifyStrategy — mock_structure handoff short-circuit (#1352)", () => {
  const pushHandoff = (sink: ReturnType<typeof makeDeclarationSink>) =>
    sink.mockHandoffs.push({ files: ["test/unit/foo.test.ts"], reasonDetail: "mock cache reuse" });

  test("drainer + pending handoff → appliesTo false (hands selection to test-writer)", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink, true);
    pushHandoff(sink);
    expect(strategy.appliesTo(makeTestFinding())).toBe(false);
  });

  test("drainer + no pending handoff → appliesTo true (claims normally)", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink, true);
    expect(strategy.appliesTo(makeTestFinding())).toBe(true);
  });

  test("no drainer + pending handoff → appliesTo STAYS true (no orphan when no test-writer registered)", () => {
    // Single-session verify-scoped and three-session nbf scope:"source" register
    // full-suite-rectify without an autofix-test-writer. Suppressing there would
    // strand the finding (exitReason "no-strategy" — #1330/#1327).
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink, false);
    pushHandoff(sink);
    expect(strategy.appliesTo(makeTestFinding())).toBe(true);
  });

  test("drainer default (omitted) → treated as no drainer → appliesTo stays true with pending handoff", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink);
    pushHandoff(sink);
    expect(strategy.appliesTo(makeTestFinding())).toBe(true);
  });

  test("self-correcting window: suppressed while pending, reclaims after test-writer drains the sink", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink, true);
    pushHandoff(sink);
    expect(strategy.appliesTo(makeTestFinding())).toBe(false);
    // autofix-test-writer.buildInput drains via splice(0); a later regression re-selects us.
    sink.mockHandoffs.splice(0);
    expect(strategy.appliesTo(makeTestFinding())).toBe(true);
  });

  test("suppression only relaxes claiming — non-failing-test findings are still not claimed", () => {
    const sink = makeDeclarationSink();
    const strategy = makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig(), sink, true);
    pushHandoff(sink);
    // A lint finding never matched regardless of handoff state.
    expect(strategy.appliesTo(makeTestFinding({ source: "lint" }))).toBe(false);
  });
});

// ─── makeRepoScopedTestFixStrategy (#1654) ───────────────────────────────────────
//
// The fallthrough claimant for failing tests the story-scoped rectifier
// declined. Registered alongside `full-suite-rectify`, it shares that
// strategy's op but runs it with the scope constraint lifted, under its own
// session role so it does not inherit the refusal it is meant to overturn.

describe("makeRepoScopedTestFixStrategy", () => {
  const strategy = () => makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());

  test("name is repo-scoped-test-fix so it retires independently of full-suite-rectify", () => {
    // Retirement and attempt caps are both keyed on the strategy name. A shared
    // name would make the story-scoped give-up retire this strategy too, and the
    // fallthrough would never dispatch.
    expect(strategy().name).toBe("repo-scoped-test-fix");
    expect(strategy().name).not.toBe(makeFullSuiteRectifyStrategy(makeTestStory(), makeNaxConfig()).name);
  });

  test("claims the same failing-test findings full-suite-rectify claims", () => {
    expect(strategy().appliesTo(makeTestFinding({ category: "failed-test" }))).toBe(true);
    expect(strategy().appliesTo(makeTestFinding({ category: "execution-failed" }))).toBe(true);
  });

  test("does not claim findings from other sources", () => {
    expect(strategy().appliesTo(makeTestFinding({ source: "lint", category: "lint-error" }))).toBe(false);
  });

  test("runs under its own session role", () => {
    expect(strategy().sessionRole).toBe("repo-scoped-test-fix");
  });

  test("reuses fullSuiteRectifyOp rather than declaring a second op", () => {
    expect(strategy().fixOp).toBe(fullSuiteRectifyOp);
  });

  test("buildInput requests repo scope", () => {
    const input = strategy().buildInput([makeTestFinding()], [], makeFixCycleContext());
    expect(input.scope).toBe("repo");
  });

  test("gets one attempt — it is the last claimant, not another ladder rung", () => {
    expect(strategy().maxAttempts).toBe(1);
  });

  test("is exclusive so it does not co-run with the strategy that declined", () => {
    expect(strategy().coRun).toBe("exclusive");
  });

  test("propagates UNRESOLVED so the cycle still exits agent-gave-up", async () => {
    const output = {
      applied: true,
      testEditDeclarations: [],
      unresolvedReason: "tests contradict",
    } as FullSuiteRectifyOutput;
    const applied = await strategy().extractApplied?.(output, makeRectifyInput());
    expect(applied?.unresolved).toBe("tests contradict");
  });

  test("reports no unresolved when the agent fixed the tests", async () => {
    const output = { applied: true, testEditDeclarations: [] } as FullSuiteRectifyOutput;
    const applied = await strategy().extractApplied?.(output, makeRectifyInput());
    expect(applied?.unresolved).toBeUndefined();
  });
});

// ─── repo-scoped dispatch records what it changed (#1658) ────────────────────
//
// The dispatch's edits land in the STORY's commit, so a story can ship a repair
// to something it did not break. `targetFiles` is what makes that visible, and
// it comes from git rather than the agent's own report: the op's output is
// free-form prose with declaration markers, not a `filesChanged` envelope, and
// a self-report is exactly the thing that goes stale when the agent is wrong.

describe("makeRepoScopedTestFixStrategy — change attribution", () => {
  const origDeps = { ..._repoScopedFixDeps };
  afterEach(() => Object.assign(_repoScopedFixDeps, origDeps));

  const output = { applied: true, testEditDeclarations: [] } as FullSuiteRectifyOutput;
  const ctx = makeFixCycleContext("/repo");

  test("reports the files changed since the ref captured before the dispatch", async () => {
    _repoScopedFixDeps.captureGitRef = async () => "abc123";
    _repoScopedFixDeps.captureWorkingTreeChanges = async (_workdir, baseRef) =>
      baseRef === "abc123" ? ["src/legacy/auth.ts", "test/legacy/auth.spec.ts"] : [];

    const strategy = makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());
    strategy.buildInput([makeTestFinding()], [], ctx);
    const applied = await strategy.extractApplied?.(output, makeRectifyInput());
    expect(applied?.targetFiles).toEqual(["src/legacy/auth.ts", "test/legacy/auth.spec.ts"]);
  });

  test("diffs against the package the dispatch actually ran in", async () => {
    let seenWorkdir: string | undefined;
    _repoScopedFixDeps.captureGitRef = async () => "abc123";
    _repoScopedFixDeps.captureWorkingTreeChanges = async (workdir) => {
      seenWorkdir = workdir;
      return [];
    };

    const strategy = makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());
    strategy.buildInput([makeTestFinding()], [], ctx);
    await strategy.extractApplied?.(output, makeRectifyInput());
    expect(seenWorkdir).toBe("/repo");
  });

  test("degrades to an empty list when the ref cannot be read", async () => {
    // Attribution is a reporting concern — it must never fail the dispatch that
    // produced it. A detached or absent repo yields no ref and no record.
    _repoScopedFixDeps.captureGitRef = async () => undefined;
    _repoScopedFixDeps.captureWorkingTreeChanges = async () => {
      throw new Error("should not be called without a ref");
    };

    const strategy = makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());
    strategy.buildInput([makeTestFinding()], [], ctx);
    const applied = await strategy.extractApplied?.(output, makeRectifyInput());
    expect(applied?.targetFiles).toEqual([]);
  });

  test("degrades to an empty list when the diff itself throws", async () => {
    _repoScopedFixDeps.captureGitRef = async () => "abc123";
    _repoScopedFixDeps.captureWorkingTreeChanges = async () => {
      throw new Error("git exploded");
    };

    const strategy = makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());
    strategy.buildInput([makeTestFinding()], [], ctx);
    const applied = await strategy.extractApplied?.(output, makeRectifyInput());
    expect(applied?.targetFiles).toEqual([]);
  });

  test("still reports UNRESOLVED alongside the attribution", async () => {
    _repoScopedFixDeps.captureGitRef = async () => "abc123";
    _repoScopedFixDeps.captureWorkingTreeChanges = async () => ["src/a.ts"];

    const strategy = makeRepoScopedTestFixStrategy(makeTestStory(), makeDeclarationSink());
    strategy.buildInput([makeTestFinding()], [], ctx);
    const applied = await strategy.extractApplied?.(
      { applied: true, testEditDeclarations: [], unresolvedReason: "cannot fix" } as FullSuiteRectifyOutput,
      makeRectifyInput(),
    );
    expect(applied?.unresolved).toBe("cannot fix");
    expect(applied?.targetFiles).toEqual(["src/a.ts"]);
  });
});
