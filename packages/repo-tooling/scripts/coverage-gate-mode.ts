export type CoverageGateMode = "sandboxed" | "enforce";
export type CoverageEnvironment = Readonly<Record<string, string | undefined>>;

interface CoverageResults {
  aggregateFailures: readonly string[];
  perFileOk: boolean;
  allFilesOk: boolean;
}

export const SANDBOXED_COVERAGE_NOTE =
  "[coverage] sandboxed run (NAX_SANDBOXED=1): per-file floors not enforced (CI enforces them)";

export function coverageGateMode(env: CoverageEnvironment): CoverageGateMode {
  return env.NAX_SANDBOXED === "1" ? "sandboxed" : "enforce";
}

export function coverageExitCode({
  aggregateFailures,
  perFileOk,
  allFilesOk,
  mode,
}: CoverageResults & { mode: CoverageGateMode }): 0 | 1 {
  if (aggregateFailures.length > 0) return 1;
  return mode === "enforce" && (!perFileOk || !allFilesOk) ? 1 : 0;
}

export function finishCoverage({
  aggregateFailures,
  perFileOk,
  allFilesOk,
  env,
  log,
  error,
}: CoverageResults & {
  env: CoverageEnvironment;
  log: (message: string) => void;
  error: (message: string) => void;
}): 0 | 1 {
  const mode = coverageGateMode(env);
  const code = coverageExitCode({ aggregateFailures, perFileOk, allFilesOk, mode });
  if (mode === "sandboxed") log(SANDBOXED_COVERAGE_NOTE);
  if (aggregateFailures.length > 0) {
    error(`\n[coverage] FAIL — ${aggregateFailures.join("; ")}`);
    error("Add tests for the uncovered code (see the per-file report above), or");
    error("if the floor is genuinely too high, adjust FLOOR in packages/repo-tooling/scripts/check-coverage.ts.");
  } else if (code === 0) {
    log(
      perFileOk && allFilesOk
        ? "\n[coverage] OK — at or above floor."
        : "\n[coverage] OK (sandboxed) — aggregate at or above floor; per-file results above are report-only.",
    );
  }
  return code;
}
