/**
 * The acceptance gate: runs each resolved feature acceptance-test group and
 * reports what happened. Ported from `runAcceptanceGate` /
 * `buildAcceptanceCommand` in `flows/nax-finish/steps/acceptance.ts`
 * (read-only reference — `flows/` is a separate module system and is never
 * imported from `src/`).
 *
 * This function only runs groups and reports the outcome. It does not decide
 * whether the outcome is acceptable — `routeAcceptance` (./route, Task 2)
 * owns that: an empty `groups` array yields `ran: 0, passed: true` here, and
 * it is `routeAcceptance` that turns "nothing ran" into an escalation. That
 * split is what makes both halves testable independently (I1).
 *
 * Differs from the flow original in one respect: groups now come from
 * `AcceptanceGroupResult` (`@/cli`), which resolves through nax's live
 * config/PRD pipeline rather than the flow's own `AcceptanceGroup` shape.
 * `AcceptanceGroupResult`'s own doc suggests a `{{FILE}}` substitution made
 * relative to `cwd` — this port keeps the flow's proven behaviour instead
 * (an **absolute** path), because that is what ships in production today and
 * works regardless of what cwd the substitution site itself runs from. The
 * group's own `cwd` field is still honoured for where the command is spawned.
 */
import type { AcceptanceGroupResult } from "@/cli";
import { runQualityCommand } from "@/quality";
import type { AcceptanceGateResult } from "../types";

/** Default timeout for one acceptance-test group, mirroring the flow original. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 600_000;

export const _acceptanceGateDeps = { run: runQualityCommand };

/** Single-quote a path for `/bin/sh -c`, so spaces in a repo path can't split the command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Per-language default test runner, used when a group has no configured command. */
function languageRunner(language: string | undefined): string {
  switch (language) {
    case "python":
      return "uv run pytest";
    case "go":
      return "go test";
    default:
      return "bun test";
  }
}

/**
 * Build the acceptance command for one group: the configured `command`
 * template (any `{{FILE}}` / `{{file}}` / `{{files}}` placeholder replaced by
 * the **absolute, shell-quoted** test path), or the language-appropriate
 * default runner when the group has none.
 */
export function buildAcceptanceCommand(repoRoot: string, group: AcceptanceGroupResult): string {
  const absFile = shellQuote(`${repoRoot}/${group.testPath}`);
  const template = group.command ?? `${languageRunner(group.language)} {{FILE}}`;
  return template.replace(/\{\{FILE\}\}|\{\{file\}\}|\{\{files\}\}/g, absFile);
}

/**
 * Run each group's acceptance test in turn, stopping at the first non-zero
 * exit — the fix loop that follows only needs the first failure to act on. A
 * group with `exists: false` is counted in `missing` and never spawned.
 */
export async function runAcceptanceGate(
  repoRoot: string,
  groups: AcceptanceGroupResult[],
  opts: { timeoutMs?: number } = {},
): Promise<AcceptanceGateResult> {
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
    const workdir = g.cwd ? `${repoRoot}/${g.cwd}` : repoRoot;
    const command = buildAcceptanceCommand(repoRoot, g);
    ran += 1;
    const res = await _acceptanceGateDeps.run({
      commandName: `acceptance:${name}`,
      command,
      workdir,
      timeoutMs,
    });
    chunks.push(`[${name}] exit=${res.exitCode}\n${res.output}`);
    if (res.exitCode !== 0) {
      return { passed: false, ran, missing, output: chunks.join("\n\n") };
    }
  }

  if (missing.length > 0) {
    chunks.push(`[acceptance] no acceptance test file on disk for: ${missing.join(", ")}`);
  }
  if (ran === 0) {
    chunks.push("[acceptance] no acceptance test files present — nothing to run");
  }
  return { passed: true, ran, missing, output: chunks.join("\n\n") };
}
