/**
 * `nax trust list|add|rm|check` — the operator-facing surface over the
 * per-folder trust store (US-004).
 *
 * The store (`<globalConfigDir>/trust.json`, `src/trust/store.ts`) decides
 * whether repository-controlled code may run on this host: project plugins,
 * context plugin providers, hooks, MCP servers and the quality / test /
 * acceptance / setup commands. The gate (US-003, `./trust-gate.ts`) reads it
 * before every such command; this module is how entries get in and out.
 *
 * Every handler is a plain function that RETURNS an exit code — the caller
 * (`bin/nax.ts`, via `registerTrustCommand`) owns `process.exit`, so each
 * command is unit-testable without a real process exit. All terminal I/O goes
 * through `_cliTrustDeps`, which tests replace wholesale.
 *
 * Paths: a relative `<path>` resolves against `_cliTrustDeps.cwd()` (never
 * `process.cwd()` directly), then through `normalizeTrustPath`, so every
 * string this surface prints, compares or stores is the realpath-normalized
 * absolute form the store holds.
 *
 * Order of decisions in `trustAddCommand` is first-match and is the security
 * contract, not an implementation detail:
 *   1. a protected folder (`/`, or the operator's home) is refused before
 *      anything else — even when the store already covers it, and even
 *      noninteractively, so `--force` is the only way through (AC9, AC10);
 *   2. an already-covered path succeeds without a prompt or a TTY (AC11);
 *   3. a path that is neither covered nor protected needs either `--yes` or a
 *      terminal to confirm (AC12, AC13);
 *   4. only then is an entry written (AC14).
 */

import { homedir as osHomedir } from "node:os";
import { resolve } from "node:path";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import type { RemoveTrustResult, TrustEntry } from "@/trust";
import {
  addTrustEntry,
  findCoveringEntry,
  isProtectedFolder,
  normalizeTrustPath,
  readTrustStore,
  removeTrustEntry,
  resolveTrustRoot,
  trustStorePath,
  trustStoreUnreadableError,
} from "@/trust";
import { promptForConfirmation } from "./confirm";

/**
 * Injected seams for `nax trust`.
 *
 * `confirm` is `promptForConfirmation` itself, which auto-confirms a non-TTY —
 * that is why the handlers test `isTTY()` explicitly BEFORE consulting it
 * (design note for US-004): an unattended CI run must refuse rather than be
 * silently confirmed.
 */
export const _cliTrustDeps: {
  log: (text: string) => void;
  error: (text: string) => void;
  isTTY: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  homedir: () => string;
  cwd: () => string;
} = {
  log: (text: string) => {
    console.log(text);
  },
  error: (text: string) => {
    console.error(text);
  },
  isTTY: () => process.stdin.isTTY === true,
  confirm: promptForConfirmation,
  homedir: () => osHomedir(),
  cwd: () => process.cwd(),
};

/** The injectable surface, as consumed by every handler below. */
type TrustCliDeps = typeof _cliTrustDeps;

/** The stderr line for a store whose bytes a read cannot parse (AC21). */
function unreadableStoreLine(reason: string): string {
  return trustStoreUnreadableError(trustStorePath(), reason).message;
}

/**
 * The absolute path a command acts on: `<path>`, or the injected cwd when no
 * path was given, resolved against the injected cwd so a relative argument is
 * interpreted where the operator stood.
 */
function resolveAgainstCwd(path: string | undefined, deps: TrustCliDeps): string {
  return path === undefined ? deps.cwd() : resolve(deps.cwd(), path);
}

/** The store's entries, or `[]` when there is no store at all. */
function foldersOf(read: Awaited<ReturnType<typeof readTrustStore>>): readonly TrustEntry[] {
  return read.state === "ok" ? read.file.folders : [];
}

/**
 * `nax trust list` — one line per entry:
 *
 *   * <path>  (via <via>, added <addedAt>)    ← the entry covering the cwd
 *     <path>  (via <via>, added <addedAt>)    ← every other entry
 *
 * A store with no entries prints `No trusted folders (<trustStorePath()>)`.
 * `--json` prints `{ path, folders, coveringCwd }` instead — the same
 * information in the shape a script can consume; `coveringCwd` is the covering
 * entry's path, or `null`.
 *
 * An unparseable store is a refusal (exit 1), not an empty list: this surface
 * must not tell an operator their folders are untrusted when the truth is that
 * nax cannot read what they trusted.
 */
export async function trustListCommand(
  options: { json?: boolean },
  deps: TrustCliDeps = _cliTrustDeps,
): Promise<number> {
  const read = await readTrustStore();
  if (read.state === "unparseable") {
    deps.error(unreadableStoreLine(read.reason));
    return 1;
  }

  const folders = foldersOf(read);
  const covering = findCoveringEntry(folders, await normalizeTrustPath(deps.cwd()));

  if (options.json === true) {
    deps.log(
      JSON.stringify(
        { path: trustStorePath(), folders, coveringCwd: covering === null ? null : covering.path },
        null,
        2,
      ),
    );
    return 0;
  }

  if (folders.length === 0) {
    deps.log(`No trusted folders (${trustStorePath()})`);
    return 0;
  }

  for (const folder of folders) {
    const marker = covering !== null && covering.path === folder.path ? "* " : "  ";
    deps.log(`${marker}${folder.path}  (via ${folder.via}, added ${folder.addedAt})`);
  }
  return 0;
}

/** Report a `TRUST_STORE_UNREADABLE` refusal and return its exit code (AC21). */
function reportUnreadable(err: unknown, deps: TrustCliDeps): number | null {
  if (err instanceof NaxError && err.code === "TRUST_STORE_UNREADABLE") {
    deps.error(err.message);
    return 1;
  }
  return null;
}

/**
 * `nax trust add [path]` — grant `<path>` (default: the cwd) and everything
 * beneath it the right to run repository-controlled code.
 *
 * The five steps are documented on the module header; each one writes at most
 * one line and returns, so no step can leak a store write the operator did not
 * approve. `--force` is the only thing that skips the protected-folder refusal
 * (AC8) and `--yes` the only thing that skips the prompt — a non-TTY without
 * it refuses instead of relying on `promptForConfirmation`'s auto-confirm.
 */
export async function trustAddCommand(
  options: { path?: string; yes?: boolean; force?: boolean },
  deps: TrustCliDeps = _cliTrustDeps,
): Promise<number> {
  const target = await normalizeTrustPath(resolveAgainstCwd(options.path, deps));

  if (options.force !== true && isProtectedFolder(target, deps.homedir())) {
    deps.error(`Refusing to trust ${target}: it covers every project under it. Pass --force to trust it anyway.`);
    return 1;
  }

  const read = await readTrustStore();
  if (read.state === "unparseable") {
    deps.error(unreadableStoreLine(read.reason));
    return 1;
  }

  const coveredBy = findCoveringEntry(foldersOf(read), target);
  if (coveredBy !== null) {
    deps.log(`Already trusted: ${target} is covered by ${coveredBy.path}`);
    return 0;
  }

  if (options.yes !== true) {
    if (!deps.isTTY()) {
      deps.error(`Refusing to trust ${target} without confirmation: stdin is not a TTY. Pass --yes.`);
      return 1;
    }
    if (!(await deps.confirm(`Trust ${target} and run its repository-controlled code on this host?`))) {
      deps.log("Not trusted.");
      return 1;
    }
  }

  try {
    const result = await addTrustEntry(target, "cli");
    // A concurrent writer can cover `target` between the read above and the
    // lock inside `addTrustEntry`; that is not a failure, it is the same
    // "already trusted" outcome the earlier check would have reported.
    if (result.outcome === "already-covered") {
      deps.log(`Already trusted: ${target} is covered by ${result.coveredBy.path}`);
      return 0;
    }
    deps.log(`Trusted ${result.entry.path}`);
    return 0;
  } catch (err) {
    const reported = reportUnreadable(err, deps);
    if (reported !== null) return reported;
    throw err;
  }
}

/**
 * `nax trust rm <path>` — remove the entry whose path is exactly `<path>`.
 *
 * Only an exact entry is removed: a descendant of a trusted folder is reported
 * as such (with the folder still covering it) rather than silently revoking
 * the ancestor, which would revoke trust the operator did not name (AC17).
 */
export async function trustRmCommand(options: { path: string }, deps: TrustCliDeps = _cliTrustDeps): Promise<number> {
  const target = await normalizeTrustPath(resolveAgainstCwd(options.path, deps));

  let result: RemoveTrustResult;
  try {
    result = await removeTrustEntry(target);
  } catch (err) {
    const reported = reportUnreadable(err, deps);
    if (reported !== null) return reported;
    throw err;
  }

  if (result.outcome === "removed") {
    deps.log(`Removed ${target}`);
    return 0;
  }

  deps.error(`No trust entry for ${target}`);
  if (result.coveredBy !== null) {
    deps.error(`${target} is still trusted through ${result.coveredBy.path}`);
  }
  return 1;
}

/**
 * `nax trust check [path]` — report whether the project root that `<path>`
 * (default: the cwd) belongs to is trusted, and exit 0/1 accordingly.
 *
 * The root is whatever `resolveTrustRoot` finds (the nearest ancestor holding
 * a `.nax/config.json`, normalized), so a subdirectory answers for the project
 * it is in rather than for itself (AC20). Text mode prints one line; `--json`
 * prints `{ root, trusted, coveredBy }` — the shape a CI step can parse, and
 * the whole stdout, so it stays machine-readable.
 */
export async function trustCheckCommand(
  options: { path?: string; json?: boolean },
  deps: TrustCliDeps = _cliTrustDeps,
): Promise<number> {
  const root = await normalizeTrustPath(resolveTrustRoot(resolveAgainstCwd(options.path, deps)));

  const read = await readTrustStore();
  if (read.state === "unparseable") {
    deps.error(unreadableStoreLine(read.reason));
    return 1;
  }

  const coveredBy = findCoveringEntry(foldersOf(read), root);
  const trusted = coveredBy !== null;

  if (options.json === true) {
    deps.log(JSON.stringify({ root, trusted, coveredBy: coveredBy === null ? null : coveredBy.path }, null, 2));
  } else if (coveredBy !== null) {
    deps.log(`trusted: ${root} (covered by ${coveredBy.path})`);
  } else {
    deps.log(`untrusted: ${root}`);
  }

  return trusted ? 0 : 1;
}

/**
 * Register the `nax trust` group on a Commander program. The actions forward
 * each handler's return value to `process.exit`; nothing here is gated by the
 * trust gate itself, since managing trust is what the operator does when the
 * gate has already refused them.
 */
export function registerTrustCommand(program: Command): void {
  const group = program.command("trust").description("Manage which project folders may run repository-controlled code");

  group
    .command("list")
    .description("List trusted folders")
    .option("--json", "Emit the list as a machine-readable JSON object", false)
    .action(async (options: { json?: boolean }) => {
      process.exit(await trustListCommand({ json: options.json === true }));
    });

  group
    .command("add [path]")
    .description("Trust a folder and every folder beneath it (defaults to the current directory)")
    .option("--yes", "Skip the confirmation prompt", false)
    .option("--force", "Allow a protected folder such as / or your home directory", false)
    .action(async (path: string | undefined, options: { yes?: boolean; force?: boolean }) => {
      process.exit(await trustAddCommand({ path, yes: options.yes === true, force: options.force === true }));
    });

  group
    .command("rm <path>")
    .description("Remove an exact trust entry")
    .action(async (path: string) => {
      process.exit(await trustRmCommand({ path }));
    });

  group
    .command("check [path]")
    .description("Report whether a folder is trusted (defaults to the current directory)")
    .option("--json", "Emit the result as a machine-readable JSON object", false)
    .action(async (path: string | undefined, options: { json?: boolean }) => {
      process.exit(await trustCheckCommand({ path, json: options.json === true }));
    });
}
