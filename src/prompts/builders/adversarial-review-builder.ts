/**
 * Adversarial Review Prompt Builder (REVIEW-003)
 *
 * Builds the LLM prompt for the adversarial reviewer.
 * Distinct cognitive stance from semantic review:
 *   - Semantic asks: "Does this satisfy the acceptance criteria?"
 *   - Adversarial asks: "Where does this break? What is missing?"
 */

import type { Iteration } from "../../findings";
import type { AdversarialLLMFinding } from "../../review/adversarial-helpers";
import type { AdversarialReviewConfig, SemanticStory } from "../../review/types";
import { buildPriorIterationsBlock } from "./prior-iterations-builder";

export interface TestInventory {
  /** Source files added in this story that have a matching test file */
  addedTestFiles: string[];
  /** Source files added in this story with NO matching test file */
  newSourceFilesWithoutTests: string[];
}

export interface AdversarialReviewPromptOptions {
  /** Diff access mode */
  mode: "embedded" | "ref";
  /** Used when mode === "embedded": full diff (excludes .nax/ metadata; includes test files) */
  diff?: string;
  /** Used when mode === "ref": git ref for self-serve diff commands */
  storyGitRef?: string;
  /** Diff stat summary (used in both modes when available) */
  stat?: string;
  /** Used when mode === "embedded": pre-computed test file audit */
  testInventory?: TestInventory;
  /** Project test file globs resolved by resolveTestFilePatterns(). */
  testGlobs?: readonly string[];
  /**
   * Pathspec exclusions for mode === "ref" git commands shown in prompt.
   * Always merged with ':!.nax/' and ':!.nax-pids'.
   * Adversarial does NOT exclude test files (unlike semantic).
   */
  excludePatterns?: string[];
  /**
   * Production-diff excludes derived from resolveReviewExcludePatterns().
   * Used for test-audit instructions in ref mode.
   */
  refExcludePatterns?: readonly string[];
  /**
   * Prior adversarial review iterations (ADR-022 phase 5).
   * When set, injects buildPriorIterationsBlock instructing the reviewer to verdict
   * on unresolved prior-round issues before scanning for new ones.
   *
   * Trade-off (accepted, ADR-022): the block shows aggregated finding counts per
   * iteration rather than per-finding detail (severity, file:line, message). This
   * is intentional — individual findings appear in the current diff, and the LLM
   * re-derives them from the code. The count table keeps token cost bounded across
   * many rounds without repeating the full finding list. fixesApplied may be []
   * for adversarial carry-forward iterations (fix ran in the implementation session).
   */
  priorAdversarialIterations?: Iteration[];
  /** Minimum severity that blocks the story for this run. Defaults to "error". */
  blockingThreshold?: "error" | "warning" | "info";
}

const ADVERSARIAL_ROLE = `You are an adversarial code reviewer with full access to the repository.

Your job is NOT to re-verify that the code satisfies the acceptance criteria — semantic review owns that question. Don't re-litigate AC correctness.

Your job is to find what is WRONG, what is MISSING, and what the implementer stubbed, faked, or stopped short of finishing — even when the production code looks superficially complete. Test files that don't exercise the implementation, error paths that silently swallow, inputs the code will mishandle, conventions broken, assumptions critical to correctness but unchecked — these are yours.

Be systematic and specific. Vague concerns ("this could be improved") are not useful.
Pinpoint the exact file and line where the problem exists.`;

const ADVERSARIAL_INSTRUCTIONS = `## Adversarial Review Heuristics

Apply each heuristic to every changed file. Flag any instance you find:

### 1. Input Handling
What inputs will this mishandle?
- Empty string, null, undefined, zero, negative numbers
- Unicode characters, very large inputs, concurrent calls
- Malformed data that passes type checks but violates invariants

### 2. Error Paths
What failure modes exist but are not exercised or surfaced?
- catch blocks that swallow errors silently
- Error values returned but never checked by callers
- Async operations with no timeout or cancellation
- Resource leaks on the unhappy path (file handles, connections)

### 3. Abandonment Signals
What did the implementer accept but not actually use?
- Parameters prefixed with \`_\` that are never referenced in the body
- Options passed in constructor/function that are stored but never read
- TODOs or FIXMEs introduced or left unaddressed
- Return values from called functions that are silently discarded

### 4. Test Audit Gap
What new exported units lack corresponding test files?
- New source modules with exports but no matching test file
- New public functions that only appear in implementation, not in tests
- Acceptance criteria that touch a code path with no test coverage

### 5. Convention Breaks
What pattern exists elsewhere that this code does not follow?
- Logger calls missing \`storyId\` as first key in data object
- Injectable \`_deps\` pattern missing from a function that calls external APIs
- Barrel exports missing from \`index.ts\` for new public symbols
- Error not wrapped in \`NaxError\` with \`stage\` context

### 6. Load-Bearing Assumptions
What assumption is critical but unchecked?
- "This array will always have at least one element"
- "This environment variable will always be set"
- "This git command will always succeed in CI"
- Race conditions in async code that is assumed to be sequential`;

const OUTPUT_SCHEMA = `## Output Format

Respond with ONLY a JSON object — no preamble, no explanation outside the JSON.

\`\`\`json
{
  "passed": true | false,
  "findings": [
    {
      "severity": "error" | "warning" | "info" | "unverifiable",
      "category": "input" | "error-path" | "abandonment" | "test-gap" | "convention" | "assumption",
      "file": "relative/path/to/file.ts",
      "line": 42,
      "issue": "Precise description of the weakness",
      "suggestion": "Concrete fix or mitigation",
      "acQuote": "<verbatim substring of one AC bullet constraining this locus — required for 'error'>",
      "acIndex": 2,
      "verifiedBy": {
        "command": "command used to inspect the current codebase",
        "file": "relative/path/to/file.ts",
        "line": 42,
        "observed": "verbatim 1-3 line code excerpt copy-pasted from the file (not a description)"
      }
    }
  ]
}
\`\`\`

Severity guide:
- \`"error"\`: confident this will cause real failure or regression
- \`"warning"\`: fragile or incomplete but may ship without immediate breakage
- \`"info"\`: noteworthy but not actionable as a blocker
- \`"unverifiable"\`: suspect problem but couldn't confirm from available artifacts

**Implementation-axis grounding — required for every blocking finding:**
- Every finding at or above the configured blocking threshold MUST include \`verifiedBy.observed\`: a verbatim 1–3 line code excerpt copy-pasted from the cited file that demonstrates the issue.
- A description like "function X does not check Y" is not a verifiable observation; quote the lines that prove the omission instead.
- The \`verifiedBy.observed\` field is substring-checked against the file at HEAD. If your quoted text does not appear in the file, the finding will be silently downgraded to \`"unverifiable"\`.
- If you cannot quote an exact excerpt that proves your point, downgrade the finding to \`"unverifiable"\` rather than fabricating a quote.

**AC-grounding rule — required for every "error" finding:**
- \`acQuote\` must be a verbatim substring of one AC bullet (from the Acceptance Criteria above) that names or constrains the exact **symbol** you are flagging — not merely the file the symbol lives in.
- \`acIndex\` is the 1-based position of that AC bullet in the list.
- Copy \`acQuote\` **exactly** from the AC text, including any backticks, asterisks, or punctuation. Do not paraphrase, strip formatting, or rewrite.

**The "AC names the file but not the symbol" trap (most common failure mode):**
If the AC bullet mentions a file or component but the **specific symbol you are flagging** (the function, class, interface, type, or convention) is not named in that bullet, the AC does **not** constrain your finding. Emit it as \`"info"\` — not \`"error"\`.

Worked example:
- AC#1 reads: \`\`\`\`AstIndexService.indexCommit() is called by the code_commit outbox handler\`\`\`\`
- You found that \`code-commit-outbox-handler.ts\` defines a custom \`ExtendedPrismaClient\` interface, violating a project convention rule.
- WRONG: severity \`"error"\`, \`acQuote: "AstIndexService.indexCommit() is called by the code_commit outbox handler"\`, \`acIndex: 1\`. — AC#1 is about *who calls indexCommit*; it says nothing about Prisma typing. Picking it because the file is named is mis-grounding.
- RIGHT: severity \`"info"\`, no \`acQuote\`. The convention violation is real, but no AC constrains \`ExtendedPrismaClient\`, so it cannot block the story.

**Convention / coding-standard violations almost always belong as \`"info"\`** unless an AC specifically names the convention or the symbol it concerns.

**Scope constraints are not Acceptance Criteria:**
The story description may contain a "Scope" section with "In:" and "Out:" bullets. These are implementation guidelines, not ACs. A finding about code changed outside the stated scope (e.g., a file listed under "Out:") cannot cite a scope constraint as its \`acQuote\`/\`acIndex\` because scope text is not in the numbered AC list. Emit scope-violation findings as \`"warning"\` — never \`"error"\`. Never use \`acIndex: 0\`; \`acIndex\` is 1-based (first AC bullet = 1).

If you cannot find an AC that names the **specific symbol** in your finding, downgrade to \`"info"\` or \`"warning"\`. A finding dropped by the validator is worse than one correctly classified as advisory.`;

function buildBlockingThresholdBlock(threshold: "error" | "warning" | "info"): string {
  const blocking =
    threshold === "info"
      ? '`"error"`, `"warning"`, and `"info"`'
      : threshold === "warning"
        ? '`"error"` and `"warning"`'
        : '`"error"`';
  const advisory =
    threshold === "info"
      ? '`"unverifiable"`'
      : threshold === "warning"
        ? '`"info"` and `"unverifiable"`'
        : '`"warning"`, `"info"`, and `"unverifiable"`';
  return `## Blocking Threshold

The configured blocking threshold is \`"${threshold}"\`. Findings with severity ${blocking} can block this story, so they MUST include \`verifiedBy.observed\`.

\`passed\` must be \`false\` if any finding has blocking severity ${blocking}.
\`passed\` may be \`true\` with findings only if all findings are advisory (${advisory}).

`;
}

/**
 * Build the diff section for "ref" mode.
 * Instructs the reviewer to self-serve the full diff (including tests) via git commands.
 * Always excludes .nax/ and .nax-pids metadata paths; test files are included.
 */
function buildAdversarialRefDiffSection(
  storyGitRef: string,
  stat?: string,
  excludePatterns: string[] = [],
  testGlobs: readonly string[] = [],
  refExcludePatterns: readonly string[] = [],
): string {
  const merged = [...new Set([...excludePatterns, ":!.nax/", ":!**/.nax/", ":!.nax-pids", ":!**/.nax-pids"])];
  const excludeArgs = merged.map((p) => `'${p}'`).join(" ");
  const productionExcludes = [
    ...new Set([...refExcludePatterns, ":!.nax/", ":!**/.nax/", ":!.nax-pids", ":!**/.nax-pids"]),
  ];
  const productionExcludeArgs = productionExcludes.map((p) => `'${p}'`).join(" ");
  const statBlock = stat ? `## Changed Files Summary\n\n\`\`\`\n${stat}\n\`\`\`\n\n` : "";
  const testPatternGuide =
    testGlobs.length > 0
      ? testGlobs.map((glob) => `\`${glob}\``).join(", ")
      : "the resolved project test-file patterns";

  return `${statBlock}## Diff Access

You have access to git commands. Fetch the diff yourself — do NOT ask for it to be provided.

**Baseline ref (story start):** \`${storyGitRef}\`

Recommended commands:

\`\`\`bash
# Full diff including tests (adversarial review sees everything except nax metadata):
git diff --unified=3 ${storyGitRef}..HEAD -- . ${excludeArgs}

# Commit history for this story:
git log --oneline ${storyGitRef}..HEAD

# Files added in this story (for test audit gap):
git diff --name-only --diff-filter=A ${storyGitRef}..HEAD -- . ${excludeArgs}

# Show a specific file's full content:
cat path/to/file.ts
\`\`\`

**Test audit workflow:**
1. Run: \`git diff --name-only --diff-filter=A ${storyGitRef}..HEAD -- . ${excludeArgs}\`
2. For each new source file, check whether a matching test file was added (patterns: ${testPatternGuide}).
3. If a new exported module has no test file, flag it as \`"test-gap"\`.
4. To focus only on production deltas while auditing test coverage, run:
  \`git diff --unified=3 ${storyGitRef}..HEAD -- . ${productionExcludeArgs}\`

`;
}

/**
 * Build the diff section for "embedded" mode.
 * Includes full diff (no excludePatterns — adversarial sees test files) + TestInventory.
 */
function buildAdversarialEmbeddedDiffSection(diff: string, testInventory?: TestInventory): string {
  const inventoryBlock =
    testInventory && testInventory.newSourceFilesWithoutTests.length > 0
      ? `## Test Audit

The following NEW source files were added but have no matching test file:
${testInventory.newSourceFilesWithoutTests.map((f) => `  - ${f}`).join("\n")}

${testInventory.addedTestFiles.length > 0 ? `Test files added:\n${testInventory.addedTestFiles.map((f) => `  - ${f}`).join("\n")}\n\n` : ""}Flag each untested source file as a test-gap finding.

`
      : "";

  return `${inventoryBlock}## Git Diff (full — includes test files)

\`\`\`diff
${diff}\`\`\`

`;
}

/**
 * Build an adversarial review prompt for the given story and diff context.
 */
export class AdversarialReviewPromptBuilder {
  buildAdversarialReviewPrompt(
    story: SemanticStory,
    config: AdversarialReviewConfig,
    options: AdversarialReviewPromptOptions,
  ): string {
    const {
      mode,
      diff,
      storyGitRef,
      stat,
      testInventory,
      excludePatterns,
      testGlobs,
      refExcludePatterns,
      priorAdversarialIterations,
      blockingThreshold,
    } = options;

    const priorFindingsBlock = buildPriorIterationsBlock(priorAdversarialIterations ?? []);

    const storyBlock = `## Story Under Review

**ID:** ${story.id}
**Title:** ${story.title}
**Description:** ${story.description || "(none)"}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

`;

    const customRulesBlock =
      config.rules.length > 0
        ? `## Project-Specific Adversarial Rules\n\n${config.rules.map((r) => `- ${r}`).join("\n")}\n\n`
        : "";

    let diffBlock: string;
    if (mode === "ref" && storyGitRef) {
      diffBlock = buildAdversarialRefDiffSection(
        storyGitRef,
        stat,
        excludePatterns ?? [],
        testGlobs ?? [],
        refExcludePatterns ?? [],
      );
    } else if (mode === "embedded" && diff) {
      diffBlock = buildAdversarialEmbeddedDiffSection(diff, testInventory);
    } else {
      diffBlock = "## Diff\n\n(No diff available — review based on story context only)\n\n";
    }

    return [
      ADVERSARIAL_ROLE,
      "\n\n",
      priorFindingsBlock,
      storyBlock,
      ADVERSARIAL_INSTRUCTIONS,
      "\n\n",
      customRulesBlock,
      buildBlockingThresholdBlock(blockingThreshold ?? "error"),
      OUTPUT_SCHEMA,
      "\n\n",
      diffBlock,
    ].join("");
  }

  /**
   * Build a same-session requote prompt for an adversarial finding whose
   * verifiedBy.observed did not match the file on disk.
   *
   * Mirrors ReviewPromptBuilder.requoteVerbatim for the adversarial finding shape.
   * Called from adversarialReviewOp.hopBody when requote is enabled.
   */
  static requoteVerbatim(opts: { finding: AdversarialLLMFinding }): string {
    const file = opts.finding.verifiedBy?.file ?? opts.finding.file;
    const line = opts.finding.verifiedBy?.line ?? opts.finding.line;
    return `Your previous verifiedBy.observed value did not match the referenced file on disk.

You MUST use your file-reading tool to open ${file} and copy the actual bytes around line ${line}. Do NOT quote from memory or from the prior conversation — the previous quote was wrong precisely because it was not read from disk. If you reply without a file-read tool call, the quote will be rejected.

Return ONLY this JSON object:
{"file":"${file}","line":${line},"observed":"exact 1-3 line quote"}

Finding issue: ${opts.finding.issue}
Referenced file: ${file}
Referenced line: ${line}

Rules:
- Read ${file} with your file tool first. Then copy observed verbatim from the read result.
- observed must be a 1-3 line excerpt that proves the claim, taken from at or near line ${line}.
- If after reading the file you cannot find anything that proves the claim, set observed to "".
- Do not return a full review. Do not include markdown fences or explanation.`;
  }
}
