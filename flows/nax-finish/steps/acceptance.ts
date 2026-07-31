import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runShell } from "../exec";
import type { AcceptanceGroup, ShellRunFn } from "../types";

export const _acceptanceDeps: { runShell: ShellRunFn } = { runShell };

/** Single-quote a path for `/bin/sh -c`, so spaces in a repo path can't split the command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the acceptance command for one group, mirroring nax's own execution:
 * the configured `command` template (any `{{FILE}}` / `{{file}}` / `{{files}}`
 * placeholder replaced by the **absolute** test path) run from the group's
 * package dir. The command is a string, run through `/bin/sh -c`, because
 * configured commands legitimately contain `&&`, quotes and flags.
 */
export function buildAcceptanceCommand(repoRoot: string, group: AcceptanceGroup): string {
  const absFile = shellQuote(`${repoRoot}/${group.testPath}`);
  const template = group.command ?? `${languageRunner(group.language)} {{FILE}}`;
  return template.replace(/\{\{FILE\}\}|\{\{file\}\}|\{\{files\}\}/g, absFile);
}

export interface AcceptanceGateOutcome {
  /** Every group that ran exited 0. Says nothing about groups that could not run. */
  passed: boolean;
  ran: number;
  /**
   * Package names whose acceptance test the resolver expected at its canonical
   * path but which is absent on disk — never generated, or generation failed.
   * The caller must treat a non-empty list as a coverage hole rather than a
   * pass: skipping these silently is how a feature reached a "ready" PR with
   * nothing verified.
   */
  missing: string[];
  output: string;
}

export async function runAcceptanceGate(
  repoRoot: string,
  groups: AcceptanceGroup[],
  opts: { timeoutMs?: number } = {},
): Promise<AcceptanceGateOutcome> {
  const chunks: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  const missing: string[] = [];
  let ran = 0;
  for (const g of groups) {
    const name = g.packageDir || "root";
    if (!g.exists) {
      missing.push(name);
      continue;
    }
    const cwd = g.packageDir ? `${repoRoot}/${g.packageDir}` : repoRoot;
    ran += 1;
    const res = await _acceptanceDeps.runShell(buildAcceptanceCommand(repoRoot, g), { cwd, timeoutMs });
    chunks.push(`[${name}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) return { passed: false, ran, missing, output: chunks.join("\n\n") };
  }
  if (missing.length > 0) {
    chunks.push(`[acceptance] no acceptance test file on disk for: ${missing.join(", ")}`);
  }
  if (ran === 0) chunks.push("[acceptance] no acceptance test files present — nothing to run");
  return { passed: true, ran, missing, output: chunks.join("\n\n") };
}

function languageRunner(language: string): string {
  switch (language) {
    case "python":
      return "uv run pytest";
    case "go":
      return "go test";
    default:
      return "bun test";
  }
}
