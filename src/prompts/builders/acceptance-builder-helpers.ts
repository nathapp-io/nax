import { detectFramework, formatFailureSummary, parseTestOutput } from "../../test-runners";

const MAX_FAILURE_CHARS = 4000;
const TAIL_FALLBACK_LINES = 60;
const MAX_ENV_FAILURE_CHARS = 4000;

/**
 * Convert raw test-runner stdout into a compact, language-agnostic failure summary.
 *
 * Decision tree:
 *   1. structured failures available → formatFailureSummary
 *   2. failed > 0 but no structured failures → tail of last N lines (failures cluster at end)
 *   3. no failures AND no passes → likely environmental failure (compile error, missing binary)
 *   4. all passed → summary header only (caller invoked fix path unexpectedly)
 */
export function formatTestOutputForFix(rawOutput: string): string {
  const summary = parseTestOutput(rawOutput);
  const framework = detectFramework(rawOutput);
  const header = `Test runner: ${framework}\nResult: ${summary.passed} passed, ${summary.failed} failed`;

  if (summary.failures.length > 0) {
    return `${header}\n\nFailures:\n${formatFailureSummary(summary.failures, MAX_FAILURE_CHARS)}`;
  }

  if (summary.failed > 0) {
    const lines = rawOutput.trim().split("\n");
    const tail = lines.slice(-TAIL_FALLBACK_LINES).join("\n");
    return `${header}\n\nTest output (last ${TAIL_FALLBACK_LINES} lines — structured parse unavailable):\n${tail}`;
  }

  if (summary.passed === 0) {
    const capped =
      rawOutput.length > MAX_ENV_FAILURE_CHARS
        ? `${rawOutput.slice(0, MAX_ENV_FAILURE_CHARS)}\n... (truncated — environmental failure suspected)`
        : rawOutput;
    return `${header}\n\nNo structured tests detected — environmental failure suspected:\n${capped}`;
  }

  return header;
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".py": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".php": "php",
};

/** Derive the markdown code-fence language hint from a file path extension. Returns "" for unknown extensions. */
export function fenceLangFor(filePath: string | undefined): string {
  if (!filePath) return "";
  const ext = filePath.match(/\.[^./]+$/)?.[0] ?? "";
  return LANG_BY_EXT[ext.toLowerCase()] ?? "";
}
