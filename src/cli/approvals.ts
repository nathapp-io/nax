/**
 * `nax approvals list` — store resolution, command registration and human
 * output (US-003).
 *
 * Terminal I/O only. Every read of `approvals.json` goes through
 * `_approvalsCliDeps.readApprovalsFileDetailed` so the store is read by the
 * same module that owns writes (`src/permissions/approvals-store.ts`); the
 * CLI here is a thin surface and never touches the file directly.
 *
 * Store resolution mirrors `src/cli/runs.ts:14-19`:
 *   - `loadConfig(workdir)` — a throw is read as `null`.
 *   - project key = `config?.name?.trim() || basename(workdir)`.
 *   - `projectOutputDir(key, config?.outputDir)` then `approvalsPath(...)`.
 *
 * US-004 owns missing/unparseable/JSON bodies and US-005 the `rm` subcommand.
 */

import { basename } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "@/config";
import {
  _approvalsTaintDeps,
  type ApprovalsFileRead,
  approvalsPath,
  readApprovalsFileDetailed,
  removeApprovals,
} from "@/permissions";
import { projectOutputDir } from "@/runtime";
import { formatEntryBlock, formatTrustLine } from "./approvals-format";
import { promptForConfirmation } from "./confirm";

/**
 * Injected seams for `nax approvals`. Defaults reach the real store, the real
 * `process.kill(pid, 0)` liveness probe and the interactive confirm prompt;
 * tests stub one or more to keep the suite hermetic and to drive the liveness
 * branch deterministically.
 */
export const _approvalsCliDeps: {
  readApprovalsFileDetailed: (path: string) => Promise<ApprovalsFileRead>;
  removeApprovals: typeof removeApprovals;
  isProcessAlive: (pid: number) => boolean;
  confirm: (question: string) => Promise<boolean>;
  isTTY: () => boolean;
  log: (text: string) => void;
  logErr: (text: string) => void;
  exit: (code: number) => void;
} = {
  readApprovalsFileDetailed,
  removeApprovals,
  isProcessAlive: _approvalsTaintDeps.isProcessAlive,
  confirm: promptForConfirmation,
  isTTY: () => process.stdin.isTTY === true,
  log: (text: string) => {
    console.log(text);
  },
  logErr: (text: string) => {
    console.error(text);
  },
  exit: (code: number) => {
    process.exit(code);
  },
};

/**
 * The path the `<workdir>`-keyed approvals store lives at. Mirrors
 * `src/cli/runs.ts:14-19`: any failure to load the project's `.nax/config.json`
 * reads as no config; the project key is `config.name` trimmed, falling back to
 * `basename(workdir)`; the file path is the resolved output dir's
 * `approvals.json`.
 */
export async function resolveApprovalsFile(workdir: string): Promise<string> {
  const config = await loadConfig(workdir).catch(() => null);
  const projectKey = config?.name?.trim() || basename(workdir);
  const outputDir = projectOutputDir(projectKey, config?.outputDir);
  return approvalsPath(outputDir);
}

/** Options passed by Commander; `json` is the US-004 flag, kept for shape. */
export interface ApprovalsListOptions {
  readonly workdir: string;
  readonly json: boolean;
}

/**
 * The list action. Writes the trust line, count and one block per entry —
 * separated by a blank line for readability — through `deps.log` so a test
 * can capture stdout without touching the real console.
 */
export async function approvalsListCommand(
  opts: ApprovalsListOptions,
  deps: typeof _approvalsCliDeps = _approvalsCliDeps,
): Promise<number> {
  const path = await resolveApprovalsFile(opts.workdir);
  const read = await deps.readApprovalsFileDetailed(path);
  const entries = read.file.entries;
  const taint = read.file.taint;

  deps.log(`Approvals store: ${path}`);
  deps.log(formatTrustLine(taint, deps.isProcessAlive));
  deps.log(`${entries.length} remembered approvals`);
  deps.log("");

  for (const entry of entries) {
    for (const line of formatEntryBlock(entry)) {
      deps.log(line);
    }
    deps.log("");
  }

  return 0;
}

/**
 * Register the `nax approvals list` command on a Commander program. Returns
 * no value: the registered action forwards its exit code to `deps.exit`.
 */
export function registerApprovalsCommand(program: Command, deps: typeof _approvalsCliDeps = _approvalsCliDeps): void {
  const group = program.command("approvals").description("Manage remembered approvals");
  const listAction = async (options: { dir: string }): Promise<void> => {
    const exitCode = await approvalsListCommand({ workdir: options.dir, json: false }, deps);
    deps.exit(exitCode);
  };
  group
    .command("list")
    .description("List remembered approvals")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "JSON output (US-004)")
    .action(listAction);
}
