/**
 * `nax approvals list` — store resolution, command registration and human
 * output (US-003).
 *
 * `nax approvals rm` — atomic revocation by full entry id or by stage (US-005).
 *
 * `nax approvals rm --all` — guarded full revocation and store-failure mapping
 * (US-006).
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
 * US-004 owns missing/unparseable/JSON bodies. US-005 owns selector
 * validation, id/stage revocation and the per-entry `removed` line. US-006
 * owns `--all` (the precheck, confirmation gate and store-error mapping).
 */

import { basename } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  _approvalsTaintDeps,
  type ApprovalEntry,
  type ApprovalsFileRead,
  approvalId,
  approvalsPath,
  type RemovalDecision,
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
 * The maximum length of the `<preview>` in the `removed <id>  <stage>  <preview>`
 * line (US-005). The preview is the command's first line, so multi-line scripts
 * are truncated to keep the line single-line and copy-paste-able.
 */
const REMOVAL_PREVIEW_LIMIT = 80;

/** The selector-message stderr line for AC15-AC19 (US-005). */
const SELECTOR_ERROR = "Specify exactly one of <id...>, --stage <stage>, --all";

/** `^[0-9a-f]{8}$` — every well-formed approval id (US-001 + US-005). */
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}$/;

/** The single line a removal prints for one entry, per the US-005 interface. */
export function formatRemovedLine(entry: ApprovalEntry): string {
  const id = approvalId(entry);
  // Strip a trailing CR so a CRLF first line still produces a single-line
  // `removed ...` record (the store layer parses commands with the same
  // tolerance, see readApprovalsFileDetailed).
  const preview = (entry.command.split("\n", 1)[0] ?? "").replace(/\r$/, "");
  return `removed ${id}  ${entry.stage}  ${preview.slice(0, REMOVAL_PREVIEW_LIMIT)}`;
}

/** Options accepted by `approvalsRmCommand` (US-005 + US-006). */
export interface ApprovalsRmOptions {
  readonly workdir: string;
  readonly ids: readonly string[];
  readonly stage?: string;
  readonly all: boolean;
  readonly yes: boolean;
}

/**
 * Resolve the store path and, when `opts.all`, run the `--all` precheck.
 * Four outcomes:
 *   - `kind: "ok"`           → store is readable; carry on to the
 *                              confirmation gate and the eventual
 *                              `removeApprovals` call.
 *   - `kind: "empty"`        → the precheck wrote the spec'd
 *                              `No remembered approvals at <path>` line on
 *                              stdout; the caller exits with `0`.
 *   - `kind: "unparseable"`  → the precheck wrote the spec'd
 *                              `approvals.json could not be parsed; not
 *                              rewriting it` line on stderr; the caller
 *                              exits with `1`.
 *   - `kind: "io-error"`     → a disk read during resolution or the
 *                              precheck rejected; the caller emits the
 *                              spec'd `Failed to update <path>: <message>`
 *                              line and exits with `1`.
 *
 * Both `resolveApprovalsFile` and `readApprovalsFileDetailed` touch disk —
 * the read calls `Bun.file().text()`, which can reject with EACCES — so a
 * single try/catch wraps them. Without this, a precheck rejection escapes
 * `approvalsRmCommand` and surfaces through `rmAction`'s outer catch as
 * `error: <message>`, a different shape than the spec'd CLI failure line.
 */
type PrecheckResult =
  | { readonly kind: "ok"; readonly path: string }
  | { readonly kind: "empty"; readonly path: string }
  | { readonly kind: "unparseable"; readonly path: string }
  | { readonly kind: "io-error"; readonly path: string | undefined; readonly message: string };

async function runPrecheck(opts: ApprovalsRmOptions, deps: typeof _approvalsCliDeps): Promise<PrecheckResult> {
  try {
    const path = await resolveApprovalsFile(opts.workdir);
    if (opts.all) {
      const read = await deps.readApprovalsFileDetailed(path);
      if (read.state === "missing" || (read.state === "ok" && read.file.entries.length === 0)) {
        deps.log(missingNotice(path));
        return { kind: "empty", path };
      }
      if (read.state === "unparseable") {
        deps.logErr("approvals.json could not be parsed; not rewriting it");
        return { kind: "unparseable", path };
      }
    }
    return { kind: "ok", path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `resolveApprovalsFile` may have failed before `path` was assigned;
    // report `undefined` and let the caller fall back to `opts.workdir`.
    return { kind: "io-error", path: undefined, message };
  }
}

/**
 * `nax approvals rm` — atomic revocation by full entry id, by stage, or
 * guarded full revocation under `--all` (US-005 + US-006).
 *
 * Selector validation runs before any store read:
 *   - zero or several selectors → `Specify exactly one of <id...>, --stage <stage>, --all`
 *     on stderr, exit 1, no `removeApprovals` call.
 *   - a malformed id (anything outside `^[0-9a-f]{8}$`) → `Invalid id: <id>` on
 *     stderr, exit 1, no store access.
 *
 * Once a single selector is in hand, the work is delegated to
 * `removeApprovals`:
 *   - `stage` → predicate selects every entry whose `stage` matches. An empty
 *     match returns `unchanged` from the store layer; the CLI prints
 *     `No entries for stage <stage>` on stdout, exit 0, no write.
 *   - `ids` → decide checks the read for the supplied ids; any absent id
 *     produces a `refuse: "Unknown id(s): <absent ids>"`. The CLI writes that
 *     reason to stderr, exit 1; the all-or-nothing guarantee is the store
 *     layer's refusal, which writes nothing.
 *   - `--all` → a precheck reads the store before the confirmation gate;
 *     a missing file or a present file with no entries prints
 *     `No remembered approvals at <path>` on stdout, exit 0, no
 *     `removeApprovals` call and no write. An unparseable file prints
 *     `approvals.json could not be parsed; not rewriting it` on stderr and
 *     exits 1, file untouched — the prompt would otherwise ask the
 *     operator to confirm a doomed operation. The confirmation gate then
 *     runs unless `--yes` was given: a missing TTY refuses without
 *     prompting (`Aborted` on stderr, exit 1); a TTY consults `deps.confirm`
 *     once — a `false` answer is `Aborted` / exit 1, a `true` answer revokes
 *     every entry via `removeApprovals`.
 *
 * For each removed entry, `formatRemovedLine` is printed on stdout
 * (`removed <id>  <stage>  <preview>`). The taint marker survives: the store
 * layer reads/writes it byte-for-byte, so a forge-capable run's revocation
 * leaves the cache as tainted as it found it. Only `clearApprovalsTaint`
 * (`approvals-taint.ts`) clears it, and only from a trusted run — the CLI
 * never touches it.
 */
export async function approvalsRmCommand(
  opts: ApprovalsRmOptions,
  deps: typeof _approvalsCliDeps = _approvalsCliDeps,
): Promise<number> {
  // Trim the stage up front so a whitespace-only `--stage ""` cannot slip
  // through as a valid selector and print `No entries for stage ` (trailing
  // space). The trimmed form is also what the predicate and the success
  // message use.
  const stage = opts.stage?.trim();
  const stageSelected = stage !== undefined && stage !== "";

  const selectorCount = (opts.ids.length > 0 ? 1 : 0) + (stageSelected ? 1 : 0) + (opts.all ? 1 : 0);
  if (selectorCount !== 1) {
    deps.logErr(SELECTOR_ERROR);
    return 1;
  }

  const givenIds = opts.ids;
  if (givenIds.length > 0) {
    for (const id of givenIds) {
      if (!APPROVAL_ID_PATTERN.test(id)) {
        deps.logErr(`Invalid id: ${id}`);
        return 1;
      }
    }
  }

  // Resolve the store path and, for `--all`, run the precheck. The helper
  // handles its own output and I/O errors so the caller only has to map
  // the result kind to an exit code.
  const precheck = await runPrecheck(opts, deps);
  if (precheck.kind === "empty") return 0;
  if (precheck.kind === "unparseable") return 1;
  if (precheck.kind === "io-error") {
    const reportedPath = precheck.path ?? opts.workdir;
    deps.logErr(`Failed to update ${reportedPath}: ${precheck.message}`);
    return 1;
  }
  const path = precheck.path;

  // `--all` confirmation gate. `--yes` opts out unconditionally. A missing
  // TTY without `--yes` refuses without prompting: the prompt would either
  // block forever (a real raw-mode read against a non-TTY stdin) or print a
  // question and read no answer, both worse than a refused `Aborted`. A TTY
  // consults `deps.confirm` exactly once; a `false` answer is also an abort.
  if (opts.all && !opts.yes) {
    if (!deps.isTTY()) {
      deps.logErr("Aborted");
      return 1;
    }
    const confirmed = await deps.confirm("Remove all remembered approvals?");
    if (!confirmed) {
      deps.logErr("Aborted");
      return 1;
    }
  }

  let decide: (read: ApprovalsFileRead) => RemovalDecision;
  if (stageSelected) {
    const stageForPredicate = stage as string;
    decide = () => ({ remove: (entry) => entry.stage === stageForPredicate });
  } else if (opts.all) {
    decide = () => ({ remove: () => true });
  } else {
    // Snapshot the ids array so a caller that mutates `opts.ids` between this
    // call and the locked decide cannot change the absent-check or the remove
    // set after validation already passed.
    const wanted = [...givenIds];
    decide = ({ file }) => {
      const present = new Set(file.entries.map((entry) => approvalId(entry)));
      const absent = [...new Set(wanted.filter((id) => !present.has(id)))];
      if (absent.length > 0) {
        return { refuse: `Unknown id(s): ${absent.join(" ")}` };
      }
      const wantedSet = new Set(wanted);
      return { remove: (entry) => wantedSet.has(approvalId(entry)) };
    };
  }

  let result: Awaited<ReturnType<typeof deps.removeApprovals>>;
  try {
    result = await deps.removeApprovals(path, decide);
  } catch (err) {
    // A locked store reports its `NaxError` with `code: "FILE_LOCK_TIMEOUT"`
    // (`src/utils/file-lock.ts:204-209`). Anything else is treated as a
    // catch-all store failure; the original error's `message` is forwarded to
    // operators verbatim. The CLI never rewrites or clears a taint marker —
    // `clearApprovalsTaint` (`approvals-taint.ts`) is the only place that
    // does, and only from a trusted run.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NaxError && err.code === "FILE_LOCK_TIMEOUT") {
      deps.logErr(`a nax run is writing ${path}; retry`);
    } else {
      deps.logErr(`Failed to update ${path}: ${message}`);
    }
    return 1;
  }

  if (result.outcome === "removed") {
    if (result.droppedMalformed > 0) {
      // The `--all` rewrite drops malformed array elements while reading,
      // which is a different surface than the id/stage selectors' "ignored"
      // warning. The wording matches the story's `<n> malformed entries
      // dropped` line so a reader of `nax approvals rm --help` output can
      // tell which selector produced the warning.
      deps.logErr(`${result.droppedMalformed} malformed entries dropped`);
    }
    for (const entry of result.removed) {
      deps.log(formatRemovedLine(entry));
    }
    return 0;
  }

  if (result.outcome === "unchanged") {
    // Stage is the only selector that can produce this: ids either refuse or
    // remove at least one entry (the present-id set is non-empty by the check
    // above, and `removeApprovals` reports `removed` for any matched entry),
    // and `--all` either short-circuited the precheck or removed at least one
    // entry (otherwise the precheck would have already returned 0).
    if (stageSelected) {
      deps.log(`No entries for stage ${stage as string}`);
    }
    return 0;
  }

  deps.logErr(result.reason);
  return 1;
}

/**
 * Register the `nax approvals list` and `nax approvals rm` subcommands on a
 * Commander program. Returns no value: the registered action forwards its
 * exit code to `deps.exit`.
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
  const rmAction = async (
    ids: readonly string[],
    options: { dir: string; stage?: unknown; all?: unknown; yes?: unknown },
  ): Promise<void> => {
    try {
      const exitCode = await approvalsRmCommand(
        {
          workdir: options.dir,
          ids,
          stage: typeof options.stage === "string" ? options.stage : undefined,
          all: options.all === true,
          yes: options.yes === true,
        },
        deps,
      );
      deps.exit(exitCode);
    } catch (err) {
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
  group
    .command("rm")
    .description("Revoke one or more remembered approvals")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--stage <stage>", "Remove every approval for the given stage")
    .option("--all", "Remove every remembered approval")
    .option("--yes", "Skip the confirmation prompt")
    .argument("[ids...]", "One or more approval ids to revoke")
    .action(rmAction);
}
