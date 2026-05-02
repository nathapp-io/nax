/**
 * Finding — structured representation of "something is wrong"
 * shared across lint, typecheck, semantic review, adversarial review,
 * acceptance diagnosis, and TDD verifier outputs.
 *
 * Designed as a strict superset of:
 *   - src/plugins/extensions.ts ReviewFinding   (mechanical / plugin findings)
 *   - src/operations/types.ts   LlmReviewFinding (LLM reviewer ops)
 *   - src/acceptance/types.ts   DiagnosisResult.testIssues / sourceIssues (string-typed today)
 *
 * Producers convert to Finding[] at the boundary; the wire format is uniform
 * regardless of subsystem. See ADR-021 §3 for the file-path SSOT decision and
 * §4 for the field-by-field absorption table.
 *
 * This file holds ONLY the wire-format types (ADR-021 phase 1). Orchestration
 * types (Iteration, FixApplied, FixStrategy, FixCycleResult, …) belong to
 * ADR-022 and ship in a separate file when that ADR's phase 1 is implemented.
 */

/**
 * Producer category. Sub-tools (e.g. "biome" under "lint") go in `tool`.
 *
 * Includes acceptance sentinels (AC-HOOK / AC-ERROR) — see ADR-021 §5. They
 * are emitted by the acceptance-diagnose source with `category: "hook-failure"`
 * or `"test-runner-error"`.
 *
 * "plugin" is reserved for IReviewPlugin output where the actual producer
 * is identified by `tool`.
 */
export type FindingSource =
  | "lint"
  | "typecheck"
  | "test-runner"
  | "semantic-review"
  | "adversarial-review"
  | "acceptance-diagnose"
  | "tdd-verifier"
  | "plugin";

/**
 * Severity scale. Standardised on "warning" (not "warn") to align with
 * ReviewFinding. Adversarial review currently emits "warn" — its OUTPUT_SCHEMA
 * prompt block must rename when migrated (read-path normalizeSeverity adapters
 * already exist; see ADR-021 §2).
 *
 * "unverifiable" (adversarial-only today) means "suspect but unconfirmed".
 * "low" preserved for plugin compatibility.
 */
export type FindingSeverity = "critical" | "error" | "warning" | "info" | "low" | "unverifiable";

/**
 * Where a fix lands. Drives strategy selection in ADR-022's cycle layer.
 *
 * `fixTarget` reflects where the fix LANDS, not what produced the finding.
 * A lint or typecheck finding on `foo.test.ts` has fixTarget="test" because
 * the fix edits the test file. A semantic-review finding always lands in
 * source code (tests are gospel for semantic). An adversarial test-gap
 * finding is "test" — the fix adds a missing test file.
 *
 * Mechanical producers (lint, typecheck) typically leave this unset; the
 * cycle layer derives it from the file path against the project's test-file
 * patterns (resolveTestFilePatterns). LLM producers should tag explicitly
 * when the file alone doesn't disambiguate.
 */
export type FixTarget = "source" | "test";

/**
 * Free-form category convention per source. Not a closed enum — each producer
 * documents its own vocabulary. Listed below for the acceptance-diagnose
 * source as a reference (other sources follow ReviewFinding's `category`
 * convention or their own LLM-prompted enum).
 *
 * Acceptance-diagnose categories (ADR-021 §1):
 *   - "stdout-capture"      — wrong stream captured (e.g. bun test → stderr)
 *   - "ac-mismatch"         — assertion shape doesn't match AC text
 *   - "framework-misuse"    — wrong assertion API for the framework
 *   - "missing-impl"        — source code missing required behaviour
 *   - "import-path"         — wrong relative path / module resolution
 *   - "hook-failure"        — beforeAll / afterAll timeout (AC-HOOK sentinel)
 *   - "test-runner-error"   — runner crashed before test bodies (AC-ERROR sentinel)
 *   - "stub-test"           — detected stub via isStubTestFile heuristic
 *   - "other"
 *
 * Adversarial categories (existing): "input" | "error-path" | "abandonment" |
 * "test-gap" | "convention" | "assumption".
 */
export interface Finding {
  /** Producer of this finding. */
  source: FindingSource;

  /**
   * Tool sub-source — e.g. "biome" / "tsc" / "semgrep".
   * Required when source is "lint", "typecheck", or "plugin".
   */
  tool?: string;

  severity: FindingSeverity;

  /**
   * Free-form category. Each source documents its own enum (see top-of-file
   * comment for acceptance-diagnose; ReviewFinding.category for plugins).
   */
  category: string;

  /**
   * Rule identifier — biome rule id, TS error code (TS2304), AC id (AC-2),
   * or any stable handle the producer can attach. Optional because some
   * findings (free-form LLM observations) genuinely have no rule.
   */
  rule?: string;

  /**
   * Path to the offending file, ALWAYS relative to the repo root (the
   * directory containing `.nax/`). Producers normalise at their adapter
   * boundary. See ADR-021 §3.
   *
   * Optional — a finding may be repo-global (e.g. "package.json missing
   * required script"). Plugin contract (ReviewFinding.file: workdir-relative)
   * is preserved at the plugin boundary; only the internal Finding shape
   * is normalised.
   */
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;

  /** Human-readable description of the issue. */
  message: string;

  /** Concrete fix or mitigation, when the producer can suggest one. */
  suggestion?: string;

  /**
   * LLM producers only: 0..1 confidence in the finding. Mechanical producers
   * (lint, typecheck) omit this — their findings are deterministic.
   */
  confidence?: number;

  /**
   * Where the fix lands. Set explicitly by LLM producers (acceptance-diagnose
   * tags via its prompt; adversarial test-gap is always "test"). Mechanical
   * producers (lint, typecheck) typically leave this unset — the cycle layer
   * derives it from the file path against the project's test-file patterns.
   *
   * When unset and `file` is also unset, consumers treat the finding as
   * source-targeted by default.
   */
  fixTarget?: FixTarget;

  /**
   * Producer-specific extras — semantic review's verifiedBy evidence,
   * raw tool output, AC text, TS span, etc.
   *
   * Avoid putting load-bearing data here that downstream consumers must read.
   * Prefer promoting frequently-used fields to first-class properties.
   */
  meta?: Record<string, unknown>;
}
