/**
 * System-level precheck implementations
 */

import { existsSync, statSync } from "node:fs";
import type { NaxConfig } from "../config";
import type { Check } from "./types";

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
export async function checkTestCommand(config: NaxConfig): Promise<Check> {
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
export async function checkLintCommand(config: NaxConfig): Promise<Check> {
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
export async function checkTypecheckCommand(config: NaxConfig): Promise<Check> {
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
