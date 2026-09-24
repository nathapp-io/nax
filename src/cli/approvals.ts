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
  type ApprovalEntry,
  type ApprovalsFileRead,
  approvalId,
  approvalsPath,
  readApprovalsFileDetailed,
  removeApprovals,
} from "@/permissions";
import { projectOutputDir } from "@/runtime";
import { formatEntryBlock, formatTrustLine } from "./approvals-format";
import { promptForConfirmation } from "./confirm";

/** The stderr line for a store whose bytes the cache cannot parse (US-004). */
const PARSE_WARNING = "approvals.json could not be parsed; the cache reads it as empty";
/** The stderr line for one or more array elements the read dropped (US-004). */
const malformedEntriesWarning = (n: number): string => `${n} malformed entries ignored`;
/** The single stdout line for a missing or unparseable store (US-004). */
const missingNotice = (path: string): string => `No remembered approvals at ${path}`;

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
 * The `--json` body: one plain object with exactly the keys
 * `path`, `state`, `taint`, `droppedMalformed` and `entries`. Pure — no I/O
 * — so `test/unit/cli/approvals-list-states.test.ts` pins the shape by feeding
 * the function a synthesised `read` (US-004).
 *
 * `state` is the read's classification: `"missing"`, `"unparseable"` or `"ok"`.
 * `taint` is `null` when the store has none and the read's taint otherwise.
 * `entries` lists `{ id: approvalId(entry), ...entry }` — the id is computed
 * from (stage, command, approvedAt), so re-deriving it here lets a JSON
 * consumer delete by id without depending on the file format.
 */
export function toListJson(path: string, read: ApprovalsFileRead): object {
  const taint = read.file.taint === undefined ? null : read.file.taint;
  const entries: readonly object[] = read.file.entries.map((entry: ApprovalEntry) => ({
    id: approvalId(entry),
    ...entry,
  }));
  return {
    path,
    state: read.state,
    taint,
    droppedMalformed: read.droppedMalformed,
    entries,
  };
}

/**
 * The list action. Writes the trust line, count and one block per entry —
 * separated by a blank line for readability — through `deps.log` so a test
 * can capture stdout without touching the real console.
 *
 * US-004 extended the surface to missing / unparseable stores and to a
 * machine-readable JSON body. The three classifications of
 * `readApprovalsFileDetailed` map to:
 *   - `missing`     → the notice line on stdout, nothing else.
 *   - `unparseable` → parse warning on stderr, the notice line on stdout.
 *   - `ok`          → the US-003 header / count / per-entry blocks on stdout,
 *                     plus a `<n> malformed entries ignored` line on stderr
 *                     when the read dropped array elements.
 *
 * `opts.json` switches the rendering to a single JSON object — the same body
 * `toListJson` produces — written through `deps.log` so the registered
 * Commander action and a direct call share the path. With `json: true` the
 * unparseable state still warns on stderr (operator visibility) but stdout
 * carries the JSON body alone, which is the same `{ path, state, taint: null,
 * droppedMalformed: 0, entries: [] }` shape the missing state would print if
 * it ever ran json-mode.
 *
 * Any I/O failure during resolution or read surfaces as a stderr line and an
 * exit code of 1 — a bare Commander async action that rejects escapes the
 * parseAsync promise and never reaches `deps.exit`, so both seams need a
 * try/catch.
 */
export async function approvalsListCommand(
  opts: ApprovalsListOptions,
  deps: typeof _approvalsCliDeps = _approvalsCliDeps,
): Promise<number> {
  try {
    const path = await resolveApprovalsFile(opts.workdir);
    const read = await deps.readApprovalsFileDetailed(path);

    if (opts.json) {
      deps.log(JSON.stringify(toListJson(path, read)));
      if (read.state === "unparseable") deps.logErr(PARSE_WARNING);
      return 0;
    }

    if (read.state === "missing") {
      deps.log(missingNotice(path));
      return 0;
    }

    if (read.state === "unparseable") {
      deps.logErr(PARSE_WARNING);
      deps.log(missingNotice(path));
      return 0;
    }

    const entries = read.file.entries;
    const taint = read.file.taint;
    if (read.droppedMalformed > 0) deps.logErr(malformedEntriesWarning(read.droppedMalformed));

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logErr(`error: failed to read approvals store: ${message}`);
    return 1;
  }
}

/**
 * Register the `nax approvals list` command on a Commander program. Returns
 * no value: the registered action forwards its exit code to `deps.exit`.
 */
export function registerApprovalsCommand(program: Command, deps: typeof _approvalsCliDeps = _approvalsCliDeps): void {
  const group = program.command("approvals").description("Manage remembered approvals");
  const listAction = async (options: { dir: string; json?: unknown }): Promise<void> => {
    try {
      const exitCode = await approvalsListCommand({ workdir: options.dir, json: options.json === true }, deps);
      deps.exit(exitCode);
    } catch (err) {
      // Defence-in-depth: `approvealsListCommand` already catches and returns
      // 1 for I/O errors, but a throw from `deps.log`/`deps.exit` itself would
      // otherwise reject the action promise and surface as an unhandled
      // rejection from `program.parseAsync`, the same BUG-15 shape we just
      // closed.
      const message = err instanceof Error ? err.message : String(err);
      deps.logErr(`error: ${message}`);
      deps.exit(1);
    }
  };
  group
    .command("list")
    .description("List remembered approvals")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit the list as a machine-readable JSON object")
    .action(listAction);
}
