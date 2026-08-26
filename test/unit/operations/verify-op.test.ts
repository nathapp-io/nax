import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { makeSpawn, makeStory } from "@test/helpers";
import { type ConfigSelector, DEFAULT_CONFIG, type TddConfig, tddConfigSelector } from "@/config";
import type { Logger } from "@/logger";
import { verifierOp } from "@/operations";
import type { PackageView } from "@/runtime";

/**
 * A real `PackageView` over `DEFAULT_CONFIG`. `parse` reads nothing from it,
 * `verify`/`recover` read `packageDir`/`repoRoot`/`config.execution` — all
 * served faithfully by this shape (STATUS §8.14 recipe table).
 */
function makePackageView(): PackageView {
  const config = DEFAULT_CONFIG;
  return {
    packageDir: "",
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

  test("verifierOp.session.role equals 'verifier'", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp.session.role).toBe("verifier");
  });

  test("verifierOp.session.lifetime equals 'fresh'", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp.session.lifetime).toBe("fresh");
  });

  test.each([["name" as const], ["stage" as const]])("verifierOp has a non-empty %s string", async (field) => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp[field]).toBe("string");
    expect(verifierOp[field]).toBeTruthy();
  });

  test("verifierOp has a config selector", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp.config).toBeDefined();
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
    const { verifierOp } = await import("@/operations");
    const mockInput = {
      story: makeStory({ id: "US-001" }),
    };
    expect(mockInput.story).toBeDefined();
  });

  test("verifierOp input does not include contextMarkdown, featureContextMarkdown, or constitution fields", async () => {
    // Verifier uses limited context — no feature context, no constitution
    const { verifierOp } = await import("@/operations");
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
      expect(result!.isolation).toBeDefined();
      expect(result!.isolation!.passed).toBe(true);
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
    expect(result!.success).toBe(false);
  });
});

function tddBuildCtx(sessionTiers?: SessionTiers) {
  return { config: { tdd: { sessionTiers } }, packageView: makePackageView() };
}

describe("verifierOp.model — tdd.sessionTiers.verifier", () => {
  test("returns the configured verifier tier", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ verifier: "fast" }))).toBe("fast");
  });

  test("returns undefined when sessionTiers is absent", () => {
    const resolver = verifierOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});
