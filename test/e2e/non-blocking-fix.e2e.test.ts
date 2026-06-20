import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { NaxConfig } from "@/config";

const PASS_SEMANTIC = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });

// Adversarial PASSES (no blocking findings) but surfaces one advisory finding below the
// default "error" blocking threshold. The advisory finding seeds the ADR-024 non-blocking
// best-effort fix. `verifiedBy.observed` keeps it from being downgraded/dropped during
// substantiation (same technique as agent-fix.e2e.test.ts), and "warning" < "error" so it
// lands in advisoryFindings rather than the blocking set.
const ADVISORY_ADVERSARIAL = () => ({
  output: JSON.stringify({
    passed: true,
    findings: [
      {
        severity: "warning",
        category: "maintainability",
        file: "src/a.ts",
        line: 1,
        issue: "helper could be extracted for clarity",
        suggestion: "extract a named function",
        verifiedBy: { file: "src/a.ts", observed: "const x = 1" },
      },
    ],
  }),
});

const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

// Enable nbf in "source" scope (autofix-implementer only — no test edits, no verifier needed).
// Every field is set explicitly: makeNaxConfig deep-merges raw objects against DEFAULT_CONFIG,
// and nonBlockingFix is schema-`.optional()` (undefined by default), so zod defaults are NOT
// re-applied to a freshly-introduced object — omitted fields (e.g. sourceDiffCap) would be
// undefined and silently skip the cap check.
const NBF_CONFIG = {
  review: {
    adversarial: {
      nonBlockingFix: {
        enabled: true,
        scope: "source",
        regressionAttempts: 1,
        verifierGuard: true,
        sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      },
    },
  },
} as unknown as Partial<NaxConfig>;

describe("E2E: non-blocking fix (ADR-024)", () => {
  test("advisory findings + clean best-effort fix -> ran + kept", async () => {
    // The story is already green (adversarial passed). nbf runs over the advisory finding,
    // the implementer "fixes" it cleanly, the post-pass source diff is within sourceDiffCap
    // (empty in the scripted workdir), so the result is kept.
    const { result, nonBlockingFix } = await runOrchestratorE2E({
      strategy: "test-after",
      config: NBF_CONFIG,
      agent: {
        implementer: impl,
        "reviewer-semantic": PASS_SEMANTIC,
        "reviewer-adversarial": ADVISORY_ADVERSARIAL,
      },
    });

    // The main story passes regardless of nbf (nbf is non-blocking by construction).
    expect(result.success).toBe(true);
    expect(nonBlockingFix).toBeDefined();
    expect(nonBlockingFix?.ran).toBe(true);
    expect(nonBlockingFix?.kept).toBe(true);
    expect(nonBlockingFix?.restored).toBe(false);
  });

  test("advisory findings + best-effort fix exceeds sourceDiffCap -> ran + restored (fail-safe)", async () => {
    // Same setup and a clean fix, but the post-pass source diff exceeds sourceDiffCap
    // (default maxFiles: 10, maxLines: 500). nbf treats an over-cap pass as exhausted and
    // rolls back to the adversarial-passed snapshot → restored. This exercises the
    // un-reviewed-source-edit safety rail. The story still passes (nbf never blocks).
    const { result, nonBlockingFix } = await runOrchestratorE2E({
      strategy: "test-after",
      config: NBF_CONFIG,
      // Over the default cap (maxFiles 10 / maxLines 500) → restore.
      nonBlockingFixDiff: { fileCount: 42, sourceLineCount: 9000 },
      agent: {
        implementer: impl,
        "reviewer-semantic": PASS_SEMANTIC,
        "reviewer-adversarial": ADVISORY_ADVERSARIAL,
      },
    });

    expect(result.success).toBe(true);
    expect(nonBlockingFix).toBeDefined();
    expect(nonBlockingFix?.ran).toBe(true);
    expect(nonBlockingFix?.restored).toBe(true);
    expect(nonBlockingFix?.kept).toBe(false);
  });
});
