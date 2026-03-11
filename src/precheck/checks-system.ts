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

/** Check if test command works. Skips silently if command is null/false. */
export async function checkTestCommand(config: NaxConfig): Promise<Check> {
  const testCommand = config.execution.testCommand || (config.quality?.commands?.test as string | undefined);

  if (!testCommand || testCommand === null) {
    return {
      name: "test-command-works",
      tier: "blocker",
      passed: true,
      message: "Test command not configured (skipped)",
    };
  }

  const parts = testCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "test-command-works",
      tier: "blocker",
      passed,
      message: passed ? "Test command is available" : `Test command failed: ${testCommand}`,
    };
  } catch {
    return {
      name: "test-command-works",
      tier: "blocker",
      passed: false,
      message: `Test command failed: ${testCommand}`,
    };
  }
}

/** Check if lint command works. Skips silently if command is null/false. */
export async function checkLintCommand(config: NaxConfig): Promise<Check> {
  const lintCommand = config.execution.lintCommand;

  if (!lintCommand || lintCommand === null) {
    return {
      name: "lint-command-works",
      tier: "blocker",
      passed: true,
      message: "Lint command not configured (skipped)",
    };
  }

  const parts = lintCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "lint-command-works",
      tier: "blocker",
      passed,
      message: passed ? "Lint command is available" : `Lint command failed: ${lintCommand}`,
    };
  } catch {
    return {
      name: "lint-command-works",
      tier: "blocker",
      passed: false,
      message: `Lint command failed: ${lintCommand}`,
    };
  }
}

/** Check if typecheck command works. Skips silently if command is null/false. */
export async function checkTypecheckCommand(config: NaxConfig): Promise<Check> {
  const typecheckCommand = config.execution.typecheckCommand;

  if (!typecheckCommand || typecheckCommand === null) {
    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed: true,
      message: "Typecheck command not configured (skipped)",
    };
  }

  const parts = typecheckCommand.split(" ");
  const [cmd, ...args] = parts;

  try {
    const proc = Bun.spawn([cmd, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const passed = exitCode === 0;

    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed,
      message: passed
        ? `Typecheck command is available: ${typecheckCommand}`
        : `Typecheck command failed: ${typecheckCommand}`,
    };
  } catch {
    return {
      name: "typecheck-command-works",
      tier: "blocker",
      passed: false,
      message: `Typecheck command failed: ${typecheckCommand}`,
    };
  }
}
