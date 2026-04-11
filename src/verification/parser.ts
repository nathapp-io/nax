/**
 * @deprecated Import from "src/test-runners" instead.
 *
 * Re-exports for backward compatibility — implementation moved to src/test-runners/.
 * The verification barrel (index.ts) re-exports this, so callers using
 * `import { parseTestOutput } from "../verification"` continue to work.
 */

export {
  analyzeTestExitCode,
  detectFramework,
  formatFailureSummary,
  parseBunTestOutput,
  parseTestOutput,
} from "../test-runners";
export type { Framework } from "../test-runners";
export type { TestFailure, TestSummary } from "../test-runners/types";
