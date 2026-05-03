/**
 * Adversarial Review Prompt Builder (REVIEW-003)
 *
 * Builds the LLM prompt for the adversarial reviewer.
 * Distinct cognitive stance from semantic review:
 *   - Semantic asks: "Does this satisfy the acceptance criteria?"
 *   - Adversarial asks: "Where does this break? What is missing?"
 */

import type { Iteration } from "../../findings";
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
}

const ADVERSARIAL_ROLE = `You are an adversarial code reviewer with full access to the repository.

Your job is NOT to confirm correctness — semantic review handles that.
Your job is to find what is WRONG, what is MISSING, and what the implementer stopped short of finishing.

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
      "suggestion": "Concrete fix or mitigation"
    }
  ]
}
\`\`\`

Severity guide:
- \`"error"\`: confident this will cause real failure or regression
- \`"warning"\`: fragile or incomplete but may ship without immediate breakage
- \`"info"\`: noteworthy but not actionable as a blocker
- \`"unverifiable"\`: suspect problem but couldn't confirm from available artifacts

\`passed\` must be \`false\` if any finding has severity \`"error"\` or \`"warning"\`.
\`passed\` may be \`true\` with findings if all findings are \`"info"\` or \`"unverifiable"\`.`;

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
      OUTPUT_SCHEMA,
      "\n\n",
      diffBlock,
    ].join("");
  }
}
