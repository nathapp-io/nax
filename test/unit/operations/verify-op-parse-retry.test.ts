/**
 * Tests for verifierOp parse-retry contract and recover fail-closed behavior.
 *
 * Covers the unique concerns of this file:
 *   - op.parse success path (valid verdict JSON → VerifierOutput)
 *   - op.retry is declared
 *   - op.recover is fail-closed (always non-null) when disk is missing/invalid
 *
 * Parse *failure* cases (empty stdout, non-JSON, truncated) are covered in
 * verify-op.test.ts to avoid duplication.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { verifierOp } from "@/operations";
import { makeTempDir, cleanupTempDir } from "@test/helpers";

const VALID_VERDICT = {
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 17, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "n/a" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "Story complete and tests pass.",
};

const VALID_VERDICT_JSON = JSON.stringify(VALID_VERDICT);

function makeCtx(packageDir: string) {
  return { packageView: { packageDir } } as any;
}

const STORY = { id: "US-001", title: "t", workdir: "" } as any;
const INPUT = { story: STORY };

// ─────────────────────────────────────────────────────────────────────────────
// op.parse — success path: returns VerifierOutput when stdout is valid
// ─────────────────────────────────────────────────────────────────────────────

describe("verifierOp.parse — success: returns VerifierOutput for valid verdict JSON", () => {
  test("returns VerifierOutput with success=true when approved=true", () => {
    const out = verifierOp.parse(VALID_VERDICT_JSON, INPUT, makeCtx("/tmp"));
    expect(out.success).toBe(true);
    expect(out.filesChanged).toBeDefined();
    expect(typeof out.estimatedCostUsd).toBe("number");
    expect(typeof out.durationMs).toBe("number");
  });

  test("returns VerifierOutput with success=false when approved=false with illegitimate test mods", () => {
    // categorizeVerdict only blocks on illegitimate test mods or failing tests.
    // Use illegitimate test mods to trigger a real failure.
    const failedJson = JSON.stringify({
      ...VALID_VERDICT,
      approved: false,
      testModifications: { detected: true, files: ["foo.test.ts"], legitimate: false, reasoning: "weakened assertions" },
    });
    const out = verifierOp.parse(failedJson, INPUT, makeCtx("/tmp"));
    expect(out.success).toBe(false);
    expect(out.reviewReason).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// op.retry — declared
// ─────────────────────────────────────────────────────────────────────────────

describe("verifierOp.retry — parse-retry strategy", () => {
  test("retry strategy is declared on the op", () => {
    expect(verifierOp.retry).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// op.recover — always non-null (fail-closed when disk is missing/invalid)
// ─────────────────────────────────────────────────────────────────────────────

describe("verifierOp.recover — fail-closed when no usable disk verdict", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-verifier-recover-");
  });

  afterEach(() => {
    cleanupTempDir(workdir);
  });

  test("returns non-null fail-closed VerifierOutput when disk verdict is missing", async () => {
    const out = await verifierOp.recover!(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    expect(out!.success).toBe(false);
    expect(out!.reviewReason).toMatch(/verdict|unparseable|invalid/i);
  });

  test("returns non-null fail-closed VerifierOutput when disk verdict is invalid JSON", async () => {
    await Bun.write(join(workdir, ".nax-verifier-verdict.json"), '{"approved":');
    const out = await verifierOp.recover!(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    expect(out!.success).toBe(false);
  });

  test("returns success=true when disk verdict is valid and approved", async () => {
    await Bun.write(join(workdir, ".nax-verifier-verdict.json"), VALID_VERDICT_JSON);
    const out = await verifierOp.recover!(INPUT, makeCtx(workdir));
    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
  });
});
