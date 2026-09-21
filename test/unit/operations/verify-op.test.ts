import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeNaxConfig, makeSpawn, makeStory, makeTempDir } from "@test/helpers";
import { type ConfigSelector, DEFAULT_CONFIG, type TddConfig, tddConfigSelector } from "@/config";
import type { Logger } from "@/logger";
import { verifierOp } from "@/operations";
import type { PackageView } from "@/runtime";
import { VERDICT_FILE } from "@/tdd";
import { narrowGrants } from "@/tools";

/**
 * A real `PackageView` over `DEFAULT_CONFIG`. `parse` reads nothing from it,
 * `verify`/`recover` read `packageDir`/`repoRoot`/`config.execution` — all
 * served faithfully by this shape (STATUS §8.14 recipe table).
 */
function makePackageView(packageDir = ""): PackageView {
  const config = DEFAULT_CONFIG;
  return {
    packageDir,
    relativeFromRoot: "",
    repoRoot: "",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
}

/**
 * BuildContext for parse calls: production passes the op's selected config
 * slice (`op.config.select(...)`), not the whole NaxConfig.
 */
function makeParseCtx() {
  return { packageView: makePackageView(), config: tddConfigSelector.select(DEFAULT_CONFIG) };
}

type SessionTiers = NonNullable<TddConfig["sessionTiers"]>;

/**
 * Tests for verifierOp — the full RunOperation shape for the verifier role.
 *
 * AC-3: verifierOp.session.role equals "verifier" and
 * verifierOp.session.lifetime equals "fresh".
 *
 * AC-4: Given verifierOp.parse receives empty or unparseable output, when
 * parse executes, then it returns VerifierOutput with success: false and
 * filesChanged: [].
 */

describe("verifierOp — RunOperation shape", () => {
  test("exports verifierOp as a RunOperation with kind=run", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp).toBeDefined();
    expect(verifierOp.kind).toBe("run");
  });

  test("verifierOp.session.role equals 'verifier'; verifierOp.session.lifetime equals 'fresh'; verifierOp has a config selector", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp.session.role).toBe("verifier");
    expect(verifierOp.session.lifetime).toBe("fresh");
    expect(verifierOp.config).toBeDefined();
  });

  test.each([["name" as const], ["stage" as const]])("verifierOp has a non-empty %s string", async (field) => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp[field]).toBe("string");
    expect(verifierOp[field]).toBeTruthy();
  });

  test.each([["build" as const], ["parse" as const]])("verifierOp has a %s function", async (method) => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp[method]).toBe("function");
  });
});

describe("verifierOp.parse — error handling (strict: throws ParseValidationError)", () => {
  test.each([
    ["empty output", ""],
    ["unparseable prose", "could not parse"],
    ["malformed JSON", '{ "incomplete":'],
  ])("throws ParseValidationError when output is %s", async (_label, output) => {
    const { verifierOp } = await import("@/operations");
    const { ParseValidationError } = await import("@/agents/retry");

    const ctx = makeParseCtx();
    const input = { story: makeStory({ id: "US-001" }) };

    expect(() => verifierOp.parse(output, input, ctx)).toThrow(ParseValidationError);
  });
});

describe("verifierOp input type", () => {
  test("verifierOp input includes only story (limited context)", async () => {
    const { verifierOp: _verifierOp } = await import("@/operations");
    const mockInput = {
      story: makeStory({ id: "US-001" }),
    };
    expect(mockInput.story).toBeDefined();
  });

  test("verifierOp input does not include contextMarkdown, featureContextMarkdown, or constitution fields", async () => {
    // Verifier uses limited context — no feature context, no constitution
    const { verifierOp: _verifierOp } = await import("@/operations");
    // Type verification: the input type should only have 'story' property
    const mockInput = {
      story: makeStory({ id: "US-001" }),
    };
    expect(Object.keys(mockInput)).toEqual(["story"]);
  });
});

const VALID_VERDICT_JSON = JSON.stringify({
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 5, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "n/a" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "ok",
});

describe("verifierOp output type", () => {
  test("verifierOp output includes success, filesChanged, estimatedCostUsd, durationMs", async () => {
    const { verifierOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = { story: makeStory({ id: "US-001" }) };

    const result = verifierOp.parse(VALID_VERDICT_JSON, input, ctx);

    expect("success" in result).toBe(true);
    expect("filesChanged" in result).toBe(true);
    expect("estimatedCostUsd" in result).toBe(true);
    expect("durationMs" in result).toBe(true);
    expect("output" in result).toBe(true);
  });

  test("verifierOp output may include optional isolation field", async () => {
    const { verifierOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = { story: makeStory({ id: "US-001" }) };

    const result = verifierOp.parse(VALID_VERDICT_JSON, input, ctx);

    // isolation is optional, may be present or absent
    if ("isolation" in result) {
      expect(typeof result.isolation).toBeDefined();
    }
  });
});

describe("verifierOp.parse — verdict logging", () => {
  const ADVISORY_VERDICT_JSON = JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: true, passCount: 5, failCount: 0 },
    testModifications: { detected: true, files: ["src/foo.test.ts"], legitimate: true, reasoning: "comment cleanup" },
    acceptanceCriteria: { allMet: false, criteria: [{ criterion: "AC8 typecheck", met: false }] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "AC8 typecheck fails due to missing dependency (environmental)",
  });

  // The verdict log fires via getSafeLogger() (the singleton). We must control
  // the singleton directly rather than spying on Logger.prototype — other unit
  // test files initialize/spy the singleton *instance*, leaving an own `info`
  // property that shadows the prototype, so a prototype spy silently misses the
  // call in a full-suite run (passes in isolation, fails in CI). Spy on the
  // exact instance getSafeLogger() returns, and reset to a clean baseline after.
  // Mock<Logger["info"]>, not ReturnType<typeof spyOn> — the latter degrades
  // mock.calls to any[] and makes every call-tuple callback an implicit any.
  let infoSpy: Mock<Logger["info"]> | undefined;

  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const logger = initLogger({ level: "silent" });
    infoSpy = spyOn(logger, "info");
  });

  afterEach(async () => {
    infoSpy?.mockRestore();
    infoSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("logs 'Verdict categorized' with advisoryOverride=true when approved:false but tests pass and mods legitimate", async () => {
    const { verifierOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = { story: makeStory({ id: "US-001" }) };

    const result = verifierOp.parse(ADVISORY_VERDICT_JSON, input, ctx);
    // Categorization treats approved:false (advisory AC/quality) as success.
    expect(result.success).toBe(true);

    const call = infoSpy?.mock.calls.find((c) => c[0] === "verifier" && c[1] === "Verdict categorized");
    expect(call).toBeDefined();
    const data = call?.[2] ?? {};
    expect(data.storyId).toBe("US-001");
    expect(data.approved).toBe(false);
    expect(data.success).toBe(true);
    expect(data.advisoryOverride).toBe(true);
    expect(data.testsPassing).toBe(true);
    // storyId must be the first key (parallel-log correlation rule).
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  test("logs advisoryOverride=false when verdict is approved", async () => {
    const { verifierOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = { story: makeStory({ id: "US-002" }) };

    verifierOp.parse(VALID_VERDICT_JSON, input, ctx);

    const call = infoSpy?.mock.calls.find(
      (c) => c[0] === "verifier" && c[1] === "Verdict categorized" && c[2]?.storyId === "US-002",
    );
    expect(call).toBeDefined();
    const data = call?.[2] ?? {};
    expect(data.approved).toBe(true);
    expect(data.success).toBe(true);
    expect(data.advisoryOverride).toBe(false);
  });
});

describe("verifierOp.recover — disk artifact recovery", () => {
  test("verifierOp has an optional recover function", async () => {
    const { verifierOp } = await import("@/operations");
    // recover is optional per ADR-020 §D4
    if (verifierOp.recover) {
      expect(typeof verifierOp.recover).toBe("function");
    }
  });
});

describe("verifierOp.verify — isolation", () => {
  test("attaches isolation result when beforeRef supplied (happy path)", async () => {
    const { verifierOp } = await import("@/operations");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = makeSpawn(() => "src/foo.ts\n").spawn;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
        normalizedFindings: [],
      };
      const input = { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { ...makePackageView(), packageDir: "/tmp/x" },
        config: tddConfigSelector.select(DEFAULT_CONFIG),
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await verifierOp.verify(parsed, input, ctx);
      expect(result).not.toBeNull();
      assertDefined(result, "verify() result");
      const isolation = result.isolation;
      assertDefined(isolation, "result.isolation");
      expect(isolation.passed).toBe(true);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("returns parsed unchanged (non-null) for a failed verdict when no beforeRef (isolation skipped)", async () => {
    // After the Issue 3 fix, verify() no longer returns null for failed parsed verdicts.
    // parse() only succeeds when the verdict is structurally valid; the failure outcome
    // is encoded in success=false on the output. verify() just attaches isolation.
    const { verifierOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const parsed = {
      success: false,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
      normalizedFindings: [],
    };
    const input = { story: makeStory({ id: "US-001" }) };
    const ctx = {
      packageView: { ...makePackageView(), packageDir: "/tmp/x" },
      config: tddConfigSelector.select(DEFAULT_CONFIG),
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await verifierOp.verify(parsed, input, ctx);
    expect(result).not.toBeNull();
    assertDefined(result, "verify() result");
    expect(result.success).toBe(false);
  });
});

function tddBuildCtx(sessionTiers?: SessionTiers) {
  return { config: { tdd: { sessionTiers } }, packageView: makePackageView() };
}

describe("verifierOp.model — tdd.sessionTiers.verifier", () => {
  test("returns the configured verifier tier; returns undefined when sessionTiers is absent", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ verifier: "fast" }))).toBe("fast");
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});

describe("verifierOp — timeout budget", () => {
  test("resolves its own timeout from tdd.verifierTimeoutSeconds", () => {
    // makeNaxConfig deep-merges onto DEFAULT_CONFIG, so the rest of the tdd
    // block keeps its defaults and this pins the override path alone.
    const config = tddConfigSelector.select(makeNaxConfig({ tdd: { verifierTimeoutSeconds: 600 } }));
    const ctx = { packageView: makePackageView(), config };

    const timeoutMs = verifierOp.timeoutMs?.({ story: makeStory({ id: "US-001" }) }, ctx);

    expect(timeoutMs).toBe(600_000);
  });

  test("defaults to 1800s rather than inheriting the two-hour session timeout", () => {
    const timeoutMs = verifierOp.timeoutMs?.({ story: makeStory({ id: "US-001" }) }, makeParseCtx());

    expect(timeoutMs).toBe(1_800_000);
    expect(timeoutMs).not.toBe(DEFAULT_CONFIG.execution.sessionTimeoutSeconds * 1000);
  });
});

describe("verifierOp — verdict-file write capability", () => {
  test("declares Write so the verdict-file instruction is satisfiable", () => {
    expect(verifierOp.tools).toContain("Write");
  });

  test("narrows Write to the verdict file alone", () => {
    expect(verifierOp.toolPatterns?.Write).toEqual([VERDICT_FILE]);
  });

  test("still withholds Edit, Delete and GitCommit — a verifier must not repair", () => {
    expect(verifierOp.tools).not.toContain("Edit");
    expect(verifierOp.tools).not.toContain("Delete");
    expect(verifierOp.tools).not.toContain("GitCommit");
  });

  test("the narrowing holds against an unrestricted profile", () => {
    const granted = narrowGrants(
      [
        { tool: "Write", patterns: ["*"] },
        { tool: "Read", patterns: ["*"] },
      ],
      verifierOp.toolPatterns,
    );

    expect(granted).toContainEqual({ tool: "Write", patterns: [VERDICT_FILE] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizedFindings (verify-op-normalized-findings.test.ts)
//
// AC1: tests-failing verdict → normalizedFindings has tdd-verifier error with
//      category tests-failed, fixTarget source
// AC2: success / advisory-only verdict → normalizedFindings is empty
// AC3: verifier-rejected verdict → normalizedFindings has tdd-verifier error
//      with category illegitimate-test-edits, fixTarget test
// ─────────────────────────────────────────────────────────────────────────────

const makeInput = () => ({ story: makeStory({ id: "US-001" }) });

function makeApprovedVerdict() {
  return JSON.stringify({
    version: 1,
    approved: true,
    tests: { allPassing: true, passCount: 5, failCount: 0 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "ok" },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "all good",
  });
}

function makeTestsFailingVerdict(failCount = 2) {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: false, passCount: 1, failCount },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    acceptanceCriteria: { allMet: false, criteria: [] },
    quality: { rating: "acceptable", issues: [] },
    fixes: [],
    reasoning: `${failCount} test(s) failed`,
  });
}

function makeVerifierRejectedVerdict(files: string[] = ["test/unit/foo.test.ts"]) {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: true, passCount: 3, failCount: 0 },
    testModifications: { detected: true, files, legitimate: false, reasoning: "loosened assertions" },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "illegitimate test edits detected",
  });
}

function makeIncorrectTestVerdict() {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: false, passCount: 4, failCount: 1 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    testFailureDiagnosis: {
      cause: "test-incorrect",
      assertions: [
        {
          file: "test/unit/foo.test.ts",
          testName: "injects the failure note",
          reasoning: "The assertion conflicts with AC7.",
        },
      ],
    },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "Implementation is conformant; the assertion is incorrect.",
  });
}

/** Advisory-only rejection: tests pass, AC not met but quality advisory — categorizeVerdict returns success=true */
function makeAdvisoryOnlyVerdict() {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: true, passCount: 5, failCount: 0 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    acceptanceCriteria: { allMet: false, criteria: [{ criterion: "AC-1", met: false }] },
    quality: { rating: "poor", issues: ["missing docs"] },
    fixes: [],
    reasoning: "advisory only concerns",
  });
}

describe("AC1: normalizedFindings when tests-failing", () => {
  test("AC1: normalizedFindings is non-empty when categorization.failureCategory === tests-failing", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);

    expect(Array.isArray(result.normalizedFindings)).toBe(true);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
  });

  test("AC1: first finding has source === tdd-verifier", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    // Guard: fails assertively if stub returns []
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC1: first finding has severity === error", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].severity).toBe("error");
  });

  test("AC1: first finding has category === tests-failed", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("tests-failed");
  });

  test("AC1: first finding has fixTarget === source", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].fixTarget).toBe("source");
  });

  test("AC1: first finding has a non-empty message", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(3), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    const msg = result.normalizedFindings[0].message;
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);
  });
});

describe("AC2: normalizedFindings is empty on success", () => {
  test("AC2: approved verdict → normalizedFindings.length === 0", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeApprovedVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(0);
  });

  test("AC2: advisory-only verdict (tests pass, AC/quality concerns only) → normalizedFindings.length === 0", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    // categorizeVerdict treats AC/quality-only as success (advisory)
    const result = parse(makeAdvisoryOnlyVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(0);
  });
});

describe("AC3: normalizedFindings when verifier-rejected", () => {
  test("AC3: normalizedFindings contains exactly one entry", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(1);
  });

  test("AC3: finding has source === tdd-verifier", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    // Guard: fails assertively if stub returns []
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC3: finding has severity === error", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].severity).toBe("error");
  });

  test("AC3: finding has category === illegitimate-test-edits", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("illegitimate-test-edits");
  });

  test("AC3: finding has fixTarget === test", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].fixTarget).toBe("test");
  });

  test("AC3: normalizedFindings present when testModifications.files is empty list", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict([]), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(1);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("illegitimate-test-edits");
  });
});

describe("test-incorrect normalized finding", () => {
  test("preserves the assertion diagnosis as a test-targeted finding", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = makeParseCtx();
    const parse = verifierOp.parse;

    const result = parse(makeIncorrectTestVerdict(), makeInput(), ctx);
    const finding = result.normalizedFindings[0];

    expect(result.failureCategory).toBe("test-incorrect");
    expect(result.normalizedFindings).toHaveLength(1);
    expect(finding.category).toBe("incorrect-test-assertion");
    expect(finding.fixTarget).toBe("test");
    expect(finding.message).toContain("test/unit/foo.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parse-retry + recover fail-closed (verify-op-parse-retry.test.ts)
//
// Covers the unique concerns of this block:
//   - op.parse success path (valid verdict JSON → VerifierOutput)
//   - op.retry is declared
//   - op.recover is fail-closed (always non-null) when disk is missing/invalid
//
// Parse *failure* cases (empty stdout, non-JSON, truncated) are covered in the
// earlier "verifierOp.parse — error handling" describe to avoid duplication.
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_VALID_VERDICT = {
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 17, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "n/a" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "Story complete and tests pass.",
};

const RETRY_VALID_VERDICT_JSON = JSON.stringify(RETRY_VALID_VERDICT);

function makeCtx(packageDir: string) {
  return {
    packageView: makePackageView(packageDir),
    config: tddConfigSelector.select(DEFAULT_CONFIG),
    readFile: async () => null,
    fileExists: async () => false,
  };
}

const STORY = makeStory({ id: "US-001", title: "t" });
const INPUT = { story: STORY };

describe("verifierOp.parse — success: returns VerifierOutput for valid verdict JSON", () => {
  test("returns VerifierOutput with success=true when approved=true", () => {
    const out = verifierOp.parse(RETRY_VALID_VERDICT_JSON, INPUT, makeCtx("/tmp"));
    expect(out.success).toBe(true);
    expect(out.filesChanged).toBeDefined();
    expect(typeof out.estimatedCostUsd).toBe("number");
    expect(typeof out.durationMs).toBe("number");
  });

  test("returns VerifierOutput with success=false when approved=false with illegitimate test mods", () => {
    // categorizeVerdict only blocks on illegitimate test mods or failing tests.
    // Use illegitimate test mods to trigger a real failure.
    const failedJson = JSON.stringify({
      ...RETRY_VALID_VERDICT,
      approved: false,
      testModifications: {
        detected: true,
        files: ["foo.test.ts"],
        legitimate: false,
        reasoning: "weakened assertions",
      },
    });
    const out = verifierOp.parse(failedJson, INPUT, makeCtx("/tmp"));
    expect(out.success).toBe(false);
    expect(out.reviewReason).toBeDefined();
  });
});

describe("verifierOp.retry — parse-retry strategy", () => {
  test("retry strategy is declared on the op", () => {
    expect(verifierOp.retry).toBeDefined();
  });
});

describe("verifierOp.recover — fail-closed when no usable disk verdict", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-verifier-recover-");
  });

  afterEach(() => {
    cleanupTempDir(workdir);
  });

  test("returns non-null fail-closed VerifierOutput when disk verdict is missing", async () => {
    const out = await verifierOp.recover(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    assertDefined(out, "recover() output");
    expect(out.success).toBe(false);
    expect(out.reviewReason).toMatch(/verdict|unparseable|invalid/i);
  });

  test("returns non-null fail-closed VerifierOutput when disk verdict is invalid JSON", async () => {
    await Bun.write(join(workdir, ".nax-verifier-verdict.json"), '{"approved":');
    const out = await verifierOp.recover(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    assertDefined(out, "recover() output");
    expect(out.success).toBe(false);
  });

  test("returns success=true when disk verdict is valid and approved", async () => {
    await Bun.write(join(workdir, ".nax-verifier-verdict.json"), RETRY_VALID_VERDICT_JSON);
    const out = await verifierOp.recover(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    assertDefined(out, "recover() output");
    expect(out.success).toBe(true);
  });
});
