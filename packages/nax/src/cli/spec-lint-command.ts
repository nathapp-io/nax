/**
 * `nax spec lint` — check a spec's machine-extracted sections before planning.
 *
 * The checks themselves live in `src/prd/spec-lint.ts`, which explains why they
 * exist and why they run nax's REAL parsers rather than a second copy of their
 * grammar. This file owns only spec resolution, presentation, and the exit code.
 *
 * ## Why a shipped command and not just the npm script
 *
 * `scripts/spec-lint.ts` is nax-repo-local: it sits behind this repo's own
 * `spec:lint` script, so a project consuming nax as a dependency could not run
 * it. Once `buildPlanModeContext` started refusing to plan a spec that drops
 * authorisations (#1989), that left consumers with a blocking gate and no way
 * to preflight it. This is the preflight.
 *
 * ## Why the exit code mirrors the gate
 *
 * The script exited 1 on ANY error. The plan gate blocks only on
 * `BLOCKING_SPEC_LINT_CODES`. Measured over this repo's 195 specs the two
 * disagreed on 12 of them — `SPEC-adversarial-review.md` printed "36 error(s)
 * — fix before running `nax plan`" for a spec `nax plan` would have run. A
 * linter that disagrees with the tool it guards is worse than no linter, so the
 * default exit answers exactly one question: would `nax plan` refuse this?
 * `--strict` is the opt-in for a CI job that wants the stricter bar.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SpecLintFinding } from "../prd";
import { BLOCKING_SPEC_LINT_CODES, lintSpecContent } from "../prd";
import type { ResolveResult } from "./features-resolve";
import { resolveFeatureSpec } from "./features-resolve";

export interface SpecLintCommandOptions {
  /** Project root. Spec-declared paths resolve against it. */
  readonly dir: string;
  /** Explicit spec paths. Takes precedence over `feature`. */
  readonly paths?: readonly string[];
  /** Feature whose `spec.md` to lint, when no path was given. */
  readonly feature?: string;
  /** Fail on every error, not only the ones that would block `nax plan`. */
  readonly strict?: boolean;
  /** Story-size cap from `precheck.storySizeGate.maxAcCount`. */
  readonly maxAcCount?: number;
}

export interface SpecLintFileReport {
  readonly specPath: string;
  /** Every finding, blocking or not. Empty when the spec round-trips. */
  readonly findings: readonly SpecLintFinding[];
  /** The subset `nax plan` would refuse to plan. */
  readonly blocking: readonly SpecLintFinding[];
  /** The spec could not be read at all. */
  readonly missing: boolean;
}

export interface SpecLintCommandResult {
  readonly reports: readonly SpecLintFileReport[];
  /** 0 clean, 1 findings that fail the chosen bar, 2 usage or a missing spec. */
  readonly exitCode: number;
}

export interface SpecLintCommandDeps {
  readFile: (path: string) => Promise<string>;
  fileExists: (path: string) => boolean;
  write: (line: string) => void;
  resolveFeatureSpec: (feature: string, workdir: string) => Promise<ResolveResult>;
}

export const _specLintCommandDeps: SpecLintCommandDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  fileExists: existsSync,
  write: (line: string): void => {
    console.log(line);
  },
  resolveFeatureSpec,
};

const USAGE = "usage: nax spec lint <spec.md> [...]  |  nax spec lint -f <feature>";

/** A resolution failure the caller must fix before anything can be linted. */
interface SpecResolutionFailure {
  readonly message: string;
}

/**
 * Which specs the caller asked for — explicit paths, else the feature's own.
 *
 * `-f` goes through `resolveFeatureSpec`, the same resolver `nax features
 * resolve` and the toolkit skills use. Hardcoding `.nax/features/<name>/spec.md`
 * here would miss `docs/specs/SPEC-<name>.md`, which is where this repo actually
 * keeps every one of its specs — including the one that produced #1989.
 */
async function resolveSpecPaths(
  options: SpecLintCommandOptions,
  deps: SpecLintCommandDeps,
): Promise<string[] | SpecResolutionFailure> {
  const explicit = (options.paths ?? []).filter((path) => path.trim().length > 0);
  if (explicit.length > 0) return [...explicit];
  if (!options.feature) return [];

  const resolved = await deps.resolveFeatureSpec(options.feature, options.dir);
  if (resolved.status !== "ok" || !resolved.specSource) {
    return { message: resolved.message };
  }
  if (resolved.specSource.kind === "prd") {
    return {
      message: `${options.feature} resolved to ${resolved.specSource.path}; a prd.json has no spec sections to lint. Pass the markdown spec explicitly.`,
    };
  }
  return [join(options.dir, resolved.specSource.path)];
}

async function lintOne(
  specPath: string,
  options: SpecLintCommandOptions,
  deps: SpecLintCommandDeps,
): Promise<SpecLintFileReport> {
  if (!deps.fileExists(specPath)) {
    return { specPath, findings: [], blocking: [], missing: true };
  }
  let content: string;
  try {
    content = await deps.readFile(specPath);
  } catch {
    return { specPath, findings: [], blocking: [], missing: true };
  }
  const findings = lintSpecContent(content, {
    maxAcCount: options.maxAcCount,
    fileExists: (path) => deps.fileExists(join(options.dir, path)),
  });
  return {
    specPath,
    findings,
    blocking: findings.filter((finding) => BLOCKING_SPEC_LINT_CODES.has(finding.code)),
    missing: false,
  };
}

/**
 * A finding's label is its CONSEQUENCE, not its level.
 *
 * `[ERROR]` told a reader a spec was broken without telling them whether the
 * plan would run. `[BLOCK]` answers the only question the reader has.
 */
function label(finding: SpecLintFinding): string {
  if (BLOCKING_SPEC_LINT_CODES.has(finding.code)) return "[BLOCK]";
  return finding.level === "error" ? "[error]" : "[warn] ";
}

function report(reports: readonly SpecLintFileReport[], deps: SpecLintCommandDeps): void {
  for (const file of reports) {
    if (file.missing) {
      deps.write(`[FAIL] spec not found: ${file.specPath}`);
      continue;
    }
    if (file.findings.length === 0) {
      deps.write(`[OK] ${file.specPath} — every machine-extracted section round-trips`);
      continue;
    }
    deps.write(`\n${file.specPath}`);
    for (const finding of file.findings) {
      deps.write(`  ${label(finding)} ${finding.code}: ${finding.message}`);
    }
  }
}

/**
 * Lint one or more specs and report whether `nax plan` would refuse them.
 *
 * Returns rather than exiting so the caller owns the process; `bin/nax.ts` maps
 * `exitCode` onto `process.exit`.
 */
export async function specLintCommand(
  options: SpecLintCommandOptions,
  deps: SpecLintCommandDeps = _specLintCommandDeps,
): Promise<SpecLintCommandResult> {
  const resolution = await resolveSpecPaths(options, deps);
  if (!Array.isArray(resolution)) {
    // A feature that resolves to nothing lintable is a usage error, not a
    // clean spec — reporting it as clean is the silence this command exists
    // to remove.
    deps.write(`[FAIL] ${resolution.message}`);
    return { reports: [], exitCode: 2 };
  }
  const specPaths = resolution;
  if (specPaths.length === 0) {
    deps.write(USAGE);
    return { reports: [], exitCode: 2 };
  }

  const reports = await Promise.all(specPaths.map((specPath) => lintOne(specPath, options, deps)));
  report(reports, deps);

  const missing = reports.filter((file) => file.missing).length;
  const blocking = reports.reduce((sum, file) => sum + file.blocking.length, 0);
  const errors = reports.reduce((sum, file) => sum + file.findings.filter((f) => f.level === "error").length, 0);
  const warnings = reports.reduce((sum, file) => sum + file.findings.filter((f) => f.level === "warn").length, 0);

  deps.write("");
  if (missing > 0) {
    deps.write(`[FAIL] ${missing} spec(s) could not be read.`);
    return { reports, exitCode: 2 };
  }
  const failed = options.strict === true ? errors > 0 : blocking > 0;
  if (failed) {
    deps.write(
      options.strict === true
        ? `[FAIL] ${errors} error(s), ${warnings} warning(s) — --strict fails on all of them.`
        : `[FAIL] ${blocking} blocking finding(s) — \`nax plan\` will refuse this spec. ${errors - blocking} other error(s), ${warnings} warning(s).`,
    );
    return { reports, exitCode: 1 };
  }
  deps.write(`[OK] 0 blocking, ${errors} other error(s), ${warnings} warning(s) — \`nax plan\` will accept this spec.`);
  return { reports, exitCode: 0 };
}
