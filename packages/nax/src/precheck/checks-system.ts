/**
 * System-level precheck implementations
 */

import { existsSync, statSync } from "node:fs";
import type { PrecheckConfig } from "../config/selectors";
import { loadCanonicalRules, NeutralityLintError } from "../context/rules/canonical-loader";
import { errorMessage } from "../utils/errors";
import type { Check } from "./types";

function discoverCanonicalRuleRoots(workdir: string): string[] {
  return [workdir];
}

export const _checkCanonicalRulesDeps = {
  discoverRoots: discoverCanonicalRuleRoots,
  loadCanonicalRules,
};

/** Check if dependencies are installed (language-aware). Detects: node_modules, target, venv, vendor */
export async function checkDependenciesInstalled(workdir: string): Promise<Check> {
  const depPaths = [
    { path: "node_modules" },
    { path: "target" },
    { path: "venv" },
    { path: ".venv" },
    { path: "vendor" },
  ];

  const found: string[] = [];
  for (const { path } of depPaths) {
    const fullPath = `${workdir}/${path}`;
    if (existsSync(fullPath)) {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        found.push(path);
      }
    }
  }

  const passed = found.length > 0;

  return {
    name: "dependencies-installed",
    tier: "blocker",
    passed,
    message: passed ? `Dependencies found: ${found.join(", ")}` : "No dependency directories detected",
  };
}

/** Check if test command is configured. Downgraded to warning since the verify stage will catch actual failures. */
export async function checkTestCommand(config: PrecheckConfig): Promise<Check> {
  const testCommand = config.execution.testCommand || (config.quality?.commands?.test as string | undefined);

  if (!testCommand || testCommand === null) {
    return {
      name: "test-command-works",
      tier: "warning",
      passed: true,
      message: "Test command not configured (will use default: bun test)",
    };
  }

  return {
    name: "test-command-works",
    tier: "warning",
    passed: true,
    message: `Test command configured: ${testCommand}`,
  };
}

/** Check if lint command is configured. Downgraded to warning since the verify stage will catch actual failures. */
export async function checkLintCommand(config: PrecheckConfig): Promise<Check> {
  const lintCommand = config.execution.lintCommand;

  if (!lintCommand || lintCommand === null) {
    return {
      name: "lint-command-works",
      tier: "warning",
      passed: true,
      message: "Lint command not configured (skipped)",
    };
  }

  return {
    name: "lint-command-works",
    tier: "warning",
    passed: true,
    message: `Lint command configured: ${lintCommand}`,
  };
}

/** Check if typecheck command is configured. Downgraded to warning since the verify stage will catch actual failures. */
export async function checkTypecheckCommand(config: PrecheckConfig): Promise<Check> {
  const typecheckCommand = config.execution.typecheckCommand;

  if (!typecheckCommand || typecheckCommand === null) {
    return {
      name: "typecheck-command-works",
      tier: "warning",
      passed: true,
      message: "Typecheck command not configured (skipped)",
    };
  }

  return {
    name: "typecheck-command-works",
    tier: "warning",
    passed: true,
    message: `Typecheck command configured: ${typecheckCommand}`,
  };
}

/**
 * Check if canonical rules lint passes for the repository root store.
 *
 * Minimal integration scope: root-only. Package overlays are intentionally
 * excluded for this first rollout.
 */
export async function checkCanonicalRulesLint(workdir: string): Promise<Check> {
  const roots = _checkCanonicalRulesDeps.discoverRoots(workdir);
  let ruleCount = 0;

  try {
    for (const root of roots) {
      const rules = await _checkCanonicalRulesDeps.loadCanonicalRules(root);
      ruleCount += rules.length;
    }
  } catch (err) {
    if (err instanceof NeutralityLintError) {
      const first = err.violations[0];
      const detail = first ? `${first.file}:${first.lineNumber} (${first.ruleId})` : "unknown location";
      return {
        name: "canonical-rules-lint",
        tier: "blocker",
        passed: false,
        message: `Canonical rules lint failed (${err.violations.length} violation(s)): ${detail}`,
      };
    }

    return {
      name: "canonical-rules-lint",
      tier: "blocker",
      passed: false,
      message: `Canonical rules lint failed: ${errorMessage(err)}`,
    };
  }

  return {
    name: "canonical-rules-lint",
    tier: "blocker",
    passed: true,
    message: `Canonical rules lint passed (${ruleCount} file(s) across ${roots.length} root(s))`,
  };
}
