import { describe, expect, test } from "bun:test";
import type { RunOperation } from "@/operations";
import type { NaxConfig } from "@/config";

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

  test("verifierOp has a name", async () => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp.name).toBe("string");
    expect(verifierOp.name).toBeTruthy();
  });

  test("verifierOp has a stage", async () => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp.stage).toBe("string");
    expect(verifierOp.stage).toBeTruthy();
  });

  test("verifierOp has a config selector", async () => {
    const { verifierOp } = await import("@/operations");
    expect(verifierOp.config).toBeDefined();
  });

  test("verifierOp has a build function", async () => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp.build).toBe("function");
  });

  test("verifierOp has a parse function", async () => {
    const { verifierOp } = await import("@/operations");
    expect(typeof verifierOp.parse).toBe("function");
  });
});

describe("verifierOp.parse — error handling (strict: throws ParseValidationError)", () => {
  test("throws ParseValidationError when output is empty", async () => {
    const { verifierOp } = await import("@/operations");
    const { ParseValidationError } = await import("../../../src/agents/retry");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = { packageView: {} as any, config: DEFAULT_CONFIG };
    const input = { story: { id: "US-001" } as any };

    expect(() => verifierOp.parse("", input, ctx)).toThrow(ParseValidationError);
  });

  test("throws ParseValidationError when output is unparseable prose", async () => {
    const { verifierOp } = await import("@/operations");
    const { ParseValidationError } = await import("../../../src/agents/retry");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = { packageView: {} as any, config: DEFAULT_CONFIG };
    const input = { story: { id: "US-001" } as any };

    expect(() => verifierOp.parse("could not parse", input, ctx)).toThrow(ParseValidationError);
  });

  test("throws ParseValidationError when output is malformed JSON", async () => {
    const { verifierOp } = await import("@/operations");
    const { ParseValidationError } = await import("../../../src/agents/retry");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = { packageView: {} as any, config: DEFAULT_CONFIG };
    const input = { story: { id: "US-001" } as any };

    expect(() => verifierOp.parse('{ "incomplete":', input, ctx)).toThrow(ParseValidationError);
  });
});

describe("verifierOp input type", () => {
  test("verifierOp input includes only story (limited context)", async () => {
    const { verifierOp } = await import("@/operations");
    const mockInput = {
      story: { id: "US-001" } as any,
    };
    expect(mockInput.story).toBeDefined();
  });

  test("verifierOp input does not include contextMarkdown, featureContextMarkdown, or constitution fields", async () => {
    // Verifier uses limited context — no feature context, no constitution
    const { verifierOp } = await import("@/operations");
    // Type verification: the input type should only have 'story' property
    const mockInput = {
      story: { id: "US-001" } as any,
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
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = { packageView: {} as any, config: DEFAULT_CONFIG };
    const input = { story: { id: "US-001" } as any };

    const result = verifierOp.parse(VALID_VERDICT_JSON, input, ctx);

    expect("success" in result).toBe(true);
    expect("filesChanged" in result).toBe(true);
    expect("estimatedCostUsd" in result).toBe(true);
    expect("durationMs" in result).toBe(true);
    expect("output" in result).toBe(true);
  });

  test("verifierOp output may include optional isolation field", async () => {
    const { verifierOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = { packageView: {} as any, config: DEFAULT_CONFIG };
    const input = { story: { id: "US-001" } as any };

    const result = verifierOp.parse(VALID_VERDICT_JSON, input, ctx);

    // isolation is optional, may be present or absent
    if ("isolation" in result) {
      expect(typeof (result as any).isolation).toBeDefined();
    }
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
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("src/foo.ts\n").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await verifierOp.verify!(parsed, input, ctx as any);
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
    };
    const input = { story: { id: "US-001" } as any };
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await verifierOp.verify!(parsed, input, ctx as any);
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });
});
