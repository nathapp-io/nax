/**
 * Finding — structured representation of "something is wrong"
 * shared across lint, typecheck, semantic review, adversarial review,
 * acceptance diagnosis, and TDD verifier outputs.
 *
 * Designed as a strict superset of:
 *   - src/plugins/extensions.ts ReviewFinding   (mechanical / plugin findings)
 *   - the (since deleted) semantic-review LLMFinding and adversarial-review
 *     AdversarialLLMFinding producer types — their last home,
 *     `src/review/{semantic,adversarial}-helpers.ts`, went with the pipeline
 *     review operations in C1 wave B2b-2
 *
 * Producers convert to Finding[] at the boundary; the wire format is uniform
 * regardless of subsystem. See ADR-021 §3 for the file-path SSOT decision and
 * §4 for the field-by-field absorption table.
 *
 * This file holds ONLY the wire-format types (ADR-021 phase 1). The ADR-022
 * orchestration types that once referenced them — `FixStrategy`, `FixCycle`,
 * `FixCycleResult`, the severity order table and the stable identity keys —
 * went with the findings fix cycle in C1 wave B2b-3; `Iteration`/`FixApplied`
 * live in `./cycle-types`.
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
  | "plugin"
  | "implementer-handoff";

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
   * Path to the offending file, ALWAYS relative to nax's workdir — the
   * directory where `.nax/` lives and where nax is invoked. In single-package
   * projects this is the project root; in monorepos with per-package nax
   * invocations this is the package directory (`packageDir`). Matches the
   * convention already used across nax for test-pattern resolution and
   * review artifact paths (see `.claude/rules/monorepo-awareness.md`).
   *
   * Optional — a finding may be workdir-global (e.g. "package.json missing
   * required script"). Plugin contract (`ReviewFinding.file: workdir-relative`)
   * is preserved as-is; this field uses the same convention internally.
   *
   * Cross-package aggregation across multiple monorepo packages is the
   * consumer's concern — they must thread workdir context per finding-batch.
   */
  file?: string;
  line?: number;
  column?: number;
  /**
   * Range end — 1-indexed, end-INCLUSIVE. Matches biome and tsc native
   * output. For LSP-style consumers (0-indexed, end-exclusive), convert at
   * the boundary.
   */
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
   * Does this finding ask for a change? `false` means the producer is REPORTING
   * rather than requesting — e.g. an adversarial reviewer confirming that the
   * implementation correctly honoured a declared out-of-scope boundary.
   *
   * Absent means actionable. Every producer predating #1359 omits the field, so the
   * default must not drop their findings.
   *
   * First-class rather than a `meta` entry deliberately: consumers branch on this to
   * decide whether to dispatch a paid fix pass (ADR-024 nbf seeding), and `meta` is
   * read-only-by-convention — see the note on `meta` below. Non-actionable findings
   * are still surfaced in the end-of-run advisory report; the filter applies only
   * where the decision is "spend an agent session on this".
   */
  actionRequired?: boolean;

  /**
   * True when the adversarial AC-quote grounding filter dropped this finding and
   * it was folded into `advisoryFindings` on a passing verdict (#1950), so it
   * reaches the end-of-run report instead of vanishing into `acDropped`.
   *
   * First-class for the same reason as `actionRequired` above: nbf seeding
   * branches on it to decide whether to spend an agent session.
   *
   * It is reported, not acted on — but NOT because a drop is weak evidence.
   * All three drops in the audit corpus carry `ac_quote_does_not_constrain_locus`
   * (the quote was verbatim-real; only the locus test failed), all three are
   * substantive, and one was a real defect that shipped (#1951). Nor does this
   * codebase hold "ungrounded ⇒ not worth fixing": `filterByAcQuote` is
   * blocking-only, so nbf already acts on sub-threshold findings that face no
   * grounding gate at all. AC grounding decides whether a finding may BLOCK.
   *
   * The exclusion is a HOLD. Whether an AC-ungrounded finding may drive action
   * is #1801, held pending #1910's telemetry; seeding these into nbf would
   * settle that ruling through a side door. When #1801 rules, this predicate
   * in `actionableAdvisoryFindings` is the only thing to revisit.
   */
  acDropped?: boolean;

  /**
   * Disposition set by `applyBaselineDispositions` (verification/test-baseline.ts):
   * "introduced" / "pre-existing" / "earlier-story" / "unattributed". Absent on
   * findings that have not yet been classified against a baseline.
   */
  baselineDisposition?: "introduced" | "pre-existing" | "earlier-story" | "unattributed";

  /**
   * Producer-specific extras — semantic review's verifiedBy evidence,
   * raw tool output, AC text, TS span, etc.
   *
   * **Read-only by convention** — this is for human inspection, debug
   * dumps, and forensic logs. Consumers must NOT branch on `meta` fields
   * for load-bearing logic; doing so couples consumers to producer
   * internals and turns `meta` into an unenforced contract. When a meta
   * field is being read by ≥2 consumers, promote it to a first-class
   * property in a follow-up. The shape is `Record<string, unknown>` to
   * make this discipline explicit at the type level — there's no
   * compile-time help here, so reviewers must enforce it.
   */
  meta?: Record<string, unknown>;
}
