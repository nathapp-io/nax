/**
 * `nax memory link` and `nax memory reset` — make a repository's memory mirror koda's.
 *
 * `link` points a repository at the koda project that holds its memories.
 *
 * Before it, a note saved in `nax chat` or a run lived in one machine's mirror (`local`) or in
 * an MCP server koda cannot read. Linking is the one write that moves a repository onto the
 * koda provider, and it is deliberately the only place `memory.koda.project` is set: a slug is
 * a fact about a repository, so it belongs in the project layer rather than in the global
 * config that also holds the API root and the bearer key.
 *
 * The order is what the command guarantees, and every step is a refusal rather than a repair:
 *
 *   1. the argument is a koda project slug;
 *   2. the project config is read raw — before the loader runs, because the loader throws on the
 *      unparsable file this command would otherwise be explaining — and it is that raw object,
 *      never the merged config, that is written back: the global url and headers must not end
 *      up in a committed file. It is rooted where `memoryContext` roots the host: the nearest
 *      `.nax` above `--dir`, or `--dir` itself when there is none;
 *   3. the merged config loads, failures going through the group's own error contract;
 *   4. it names a `memory.koda.url`, or there is nowhere to link to;
 *   5. a different project is only replaced with `--force`, and then only once the mirror holds
 *      no write it has not delivered;
 *   6. the project answers koda's write-mode probe with a mode an agent may write under;
 *   7. a relink records what it is about to do — `<root>/relink/<mirror>.json` — before it
 *      changes anything, so an interruption can be finished rather than guessed at;
 *   8. `config.json.tmp` is written and renamed onto `config.json`;
 *   9. a relink atomically quarantines the old mirror, records it as detached, then deletes only
 *      quarantine. A failed detach undoes step 8; a failed cleanup leaves the new project linked
 *      with a retryable record that cannot target a rebuilt mirror.
 *
 * A refusal is a `[memory] …` line on stderr and exit 1 with nothing written; a load failure is
 * the group's `Error: …`. The host is opened only when the project config already names a koda
 * project — a forced relink, a repeated link, or the retry of one an earlier run recorded — and
 * not at all when memory is disabled, so a null host is the whole condition steps 5 and 9 skip.
 *
 * `reset` is the half of the same idea that runs on a mirror already linked. The mirror is a
 * cache of what koda holds (design 6.5), so throwing it away and pulling it back is safe — but
 * only when koda really is the source of truth. Two refusals establish that before anything is
 * deleted: a provider whose id is not koda's keeps a mirror that is the only copy of its notes,
 * and a mirror still holding writes the provider has not delivered refuses, because clearing it
 * would lose the edit. Only the project mirror is cleared, and only its entries except
 * `koda-approvals.json` — the records of proposals still pending in koda, including the user-scope
 * ones whose notes live in the user mirror this command never touches. The sync that follows is
 * the rebuild, and its outcome is the exit status: anything but `synced` leaves a mirror that is
 * not whole again, which is the one place a reset departs from `nax memory sync`'s exit rule.
 *
 * Nothing here preserves comments or formatting: `.nax/config.json` is plain JSON and is
 * rewritten with two-space indentation. The file itself is `memory-admin-config.ts`'s subject,
 * the mirror transition `memory-admin-relink.ts`'s, and the seam plus the refusal shape
 * `memory-admin-deps.ts`'s.
 */
import { dirname, join } from "node:path";
import { MEMORY_PROBE_TIMEOUT_MS } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { KODA_PROJECT_SLUG_RE, type MemoryConfig, memoryConfigOf } from "@/config";
import { NaxError } from "@/errors";
import {
  createKodaClient,
  formatMemorySyncResult,
  KODA_APPROVALS_FILE,
  MEMORY_KODA_PROVIDER_PREFIX,
  type MemoryHost,
} from "@/memory";
import {
  applyLink,
  type ConfigObject,
  projectConfigPath,
  projectOf,
  type RawProjectConfig,
  readProjectConfig,
  stringField,
  writeProjectConfig,
} from "./memory-admin-config";
import {
  _memoryAdminDeps,
  linkRefusal,
  MEMORY_LINK_REFUSED,
  MEMORY_RESET_REFUSED,
  resetRefusal,
  STAGE_LABEL,
} from "./memory-admin-deps";
import {
  dropPendingRelink,
  finishRelink,
  type RelinkJob,
  readPendingRelink,
  writePendingRelink,
} from "./memory-admin-relink";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";

export { _memoryAdminDeps };

/** The write modes koda's probe answers with when the calling agent may write (the rule `reachable()` uses). */
const LINK_WRITE_MODES = ["direct", "proposal"] as const satisfies readonly MemoryConfig["writeMode"][];

/** What `nax memory link` takes: the directory it acts on, and its two switches. */
export interface MemoryLinkOptions {
  readonly dir: string;
  readonly json?: boolean;
  readonly force?: boolean;
}

/** One link that passed its checks: what to write, where, and what the last steps need. */
interface LinkWrite {
  readonly repoRoot: string;
  readonly configPath: string;
  /** The project config as the file held it. */
  readonly raw: RawProjectConfig;
  readonly slug: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: boolean;
  readonly deps: MemoryCliDeps;
}

/** The slug the argument must be, or the refusal naming what arrived. */
function assertKodaSlug(slug: string): void {
  if (KODA_PROJECT_SLUG_RE.test(slug)) return;
  throw linkRefusal(`"${slug}" is not a koda project slug`, { project: slug });
}

/** The loaded config's API root, or the refusal naming the one file that sets it. */
function requiredUrl(koda: { readonly url?: string } | undefined): string {
  if (koda?.url === undefined) throw linkRefusal("memory.koda.url is not set in ~/.nax/config.json");
  return koda.url;
}

/**
 * The koda project this link replaces — and therefore rebuilds the project mirror for — or
 * `undefined` when it replaces none.
 *
 * A config that names no project, or the same one, is not a relink: the write is idempotent and
 * discarding the mirror would throw away a cursor that is still valid. A different project is
 * replaced only when `--force` says so, because the mirror it discards holds undelivered writes.
 */
function relinkFrom(raw: ConfigObject, slug: string, force: boolean): string | undefined {
  const existing = projectOf(raw);
  if (existing === undefined || existing === slug) return undefined;
  if (force) return existing;
  throw linkRefusal(
    `already linked to koda project "${existing}"; pass --force to relink (the project mirror is rebuilt)`,
    { project: existing },
  );
}

/** The writes the mirror holds that its provider has not delivered: the ones a rebuild would lose. */
interface UndeliveredWrites {
  readonly total: number;
  /** The refusal text: how many of each kind, and the commands that clear them. */
  readonly advice: string;
}

/**
 * Count the undelivered writes and say what clears them. Queued writes go out on the next
 * sync; rejected ones (refused, or parked by a sync) never do until `nax memory requeue` puts
 * them back, so the advice names it whenever one is held.
 */
async function undeliveredWrites(host: MemoryHost): Promise<UndeliveredWrites> {
  const { queued, rejected } = await host.status();
  const steps = rejected > 0 ? "run nax memory requeue --all, then nax memory sync" : "run nax memory sync";
  const total = queued + rejected;
  return { total, advice: `${total} writes are not delivered (${queued} queued, ${rejected} rejected); ${steps}` };
}

/** Refuse a forced relink whose mirror still holds writes the provider has not delivered. */
async function assertNothingUndelivered(host: MemoryHost): Promise<void> {
  const undelivered = await undeliveredWrites(host);
  if (undelivered.total === 0) return;
  throw linkRefusal(`${undelivered.advice} before relinking`, { undelivered: undelivered.total });
}

/** The write mode `mode` names when it is one koda writes with, else `undefined`. */
function linkWriteModeOf(mode: string | undefined): MemoryConfig["writeMode"] | undefined {
  return LINK_WRITE_MODES.find((known) => known === mode);
}

/** A failure's message without its stage label, so the link's own line does not repeat it. */
function reasonOf(cause: unknown): string {
  const message = errorMessage(cause);
  return message.startsWith(STAGE_LABEL) ? message.slice(STAGE_LABEL.length) : message;
}

/** Why an answer whose mode is not one koda writes with cannot be used. */
function unusableWriteMode(data: unknown): string {
  const mode = stringField(data, "mode");
  return mode === undefined ? "the answer names no write mode" : `write mode "${mode}" is not direct or proposal`;
}

function notReachable(project: string, reason: string): NaxError {
  return linkRefusal(`koda project "${project}" is not reachable: ${reason}`, { project });
}

/**
 * The write mode koda answers the probe with, or the refusal saying it cannot be written to.
 *
 * The probe is the same one `reachable()` makes, so a link succeeds exactly when a sync would
 * find the project writable: a transport failure, a refused key and an answer naming no usable
 * mode are one fact here — nothing could be delivered, so there is no point linking to it.
 */
async function probeWriteMode(
  url: string,
  headers: Readonly<Record<string, string>>,
  project: string,
): Promise<MemoryConfig["writeMode"]> {
  const client = createKodaClient({ url, headers, timeoutMs: MEMORY_PROBE_TIMEOUT_MS });
  const answer = await client.get(`projects/${project}/memory/write-mode`).catch((cause: unknown) => {
    throw notReachable(project, reasonOf(cause));
  });
  const mode = linkWriteModeOf(stringField(answer.data, "mode"));
  if (mode === undefined) throw notReachable(project, unusableWriteMode(answer.data));
  return mode;
}

/** The document `--json` prints: the two facts the link established, and where it recorded them. */
function linkDocument(write: LinkWrite, mode: MemoryConfig["writeMode"]) {
  return { project: write.slug, writeMode: mode, configPath: write.configPath };
}

/**
 * The mirror work this run owes: a relink to record and discard, an interrupted one to finish, or
 * nothing.
 *
 * A record naming the project being linked is an earlier run's unfinished relink — the discard it
 * still owes is this run's to make, whether or not `--force` is passed again, because the flag
 * was already honoured when the record was written. An abandoned intent for another project
 * is dropped without touching the live mirror. A forced change
 * to a third project must first finish the pending relink rather than overwrite its generation.
 */
async function relinkJobOf(
  host: MemoryHost,
  write: LinkWrite,
  from: string | undefined,
): Promise<RelinkJob | undefined> {
  const job = { dirs: host.dirs, configPath: write.configPath, slug: write.slug, previousConfig: write.raw.text };
  const pending = await readPendingRelink(host.dirs);
  if (pending?.project === write.slug) return { ...job, from: pending.from, recorded: true, phase: pending.phase };
  if (pending !== undefined && from !== undefined) {
    throw linkRefusal(`finish the pending relink first: run \`nax memory link ${pending.project}\``);
  }
  if (from !== undefined) return { ...job, from, recorded: false, phase: "attached" };
  if (pending === undefined) return undefined;
  // A record for another project is one whose config write never landed, so the mirror still
  // belongs to the project the config names: nothing is owed, and the record is dropped.
  await dropPendingRelink(host.dirs);
  return undefined;
}

/**
 * Everything a link does once it has passed its checks: check, probe, record, write, discard, and
 * report.
 *
 * The record is written before the config changes and cleared after the discard, so an
 * interruption at any point leaves either the previous project linked or a record saying a
 * discard is owed — never a new project attached to a mirror that cannot report its own age. The
 * record lives outside the mirror, which the discard deletes recursively, so a discard that stops
 * half-way cannot take the record with it.
 */
async function linkThrough(write: LinkWrite, host: MemoryHost | null, from: string | undefined): Promise<number> {
  const job = host === null ? undefined : await relinkJobOf(host, write, from);
  if (host !== null && job !== undefined) await assertNothingUndelivered(host);
  const mode = await probeWriteMode(write.url, write.headers, write.slug);
  if (job !== undefined && !job.recorded)
    await writePendingRelink(job.dirs, { project: write.slug, from: job.from, phase: job.phase });
  await writeProjectConfig(write.configPath, applyLink(write.raw.config, write.slug));
  if (job !== undefined) await finishRelink(job);
  write.deps.log(
    write.json
      ? JSON.stringify(linkDocument(write, mode))
      : `linked ${write.repoRoot} to koda project ${write.slug} (write mode: ${mode})`,
  );
  return 0;
}

/** The checks a link runs before it writes anything, and the write they authorise. */
async function runLink(slug: string, opts: MemoryLinkOptions, deps: MemoryCliDeps): Promise<number> {
  assertKodaSlug(slug);
  const naxDir = deps.findProjectDir(opts.dir);
  const repoRoot = naxDir === null ? opts.dir : dirname(naxDir);
  const configPath = projectConfigPath(repoRoot);
  const raw = await readProjectConfig(configPath);
  const config = await deps.loadConfig(naxDir ?? undefined);
  const koda = memoryConfigOf(config).koda;
  const write: LinkWrite = {
    repoRoot,
    configPath,
    raw,
    slug,
    url: requiredUrl(koda),
    headers: koda?.headers ?? {},
    json: opts.json === true,
    deps,
  };
  const from = relinkFrom(raw.config, slug, opts.force === true);
  // The mirror is only in play when the project config already names a koda project: a forced
  // relink, a repeated link, or the retry of one an earlier run left recorded. A repository that
  // names none has no mirror to discard and no record to read, so it opens no host at all.
  if (from === undefined && projectOf(raw.config) === undefined) return await linkThrough(write, null, undefined);
  return await withMemoryHost({ config, repoRoot }, deps, (host) => linkThrough(write, host, from));
}

/**
 * Run one admin command's body, printing a refusal it raises as its own one line.
 *
 * A refusal is the command's answer, not a failure: `[memory] …` on stderr naming what to do
 * next, and exit 1. Everything else — a config that will not load, a mirror that will not be
 * written — is the group's own error contract and is rethrown for `withMemoryErrors`.
 */
async function withRefusals(code: string, run: () => Promise<number>, deps: MemoryCliDeps): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NaxError && error.code === code) {
      deps.logErr(error.message);
      return 1;
    }
    throw error;
  }
}

/**
 * `nax memory link <koda-project>`: write the slug into this repository's project config.
 *
 * The refusals this command makes are its own answers — a `[memory] …` line on stderr and exit
 * 1 — rather than the group's `Error: …`, because each of them says what to do next (pass
 * `--force`, run a sync, fix the project config) rather than reporting a failure. Everything
 * else, the config load included, is the group's error contract.
 */
export async function memoryLinkCommand(
  slug: string,
  opts: MemoryLinkOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(() => withRefusals(MEMORY_LINK_REFUSED, () => runLink(slug, opts, deps), deps), deps);
}

/**
 * Refuse a reset of a mirror that is not koda's.
 *
 * Without the koda provider there is no second copy: a `local` mirror is the notes themselves,
 * and an MCP mirror is one koda never wrote to, so "clearing it and pulling it back" would empty
 * it. The check is the provider id's prefix rather than the config, because it is the provider
 * actually composed for this host that decides where a pull would come from.
 */
function assertKodaMirror(providerId: string): void {
  if (providerId.startsWith(MEMORY_KODA_PROVIDER_PREFIX)) return;
  throw resetRefusal(`reset needs memory.provider "koda": the ${providerId} mirror is the only copy of its notes`, {
    provider: providerId,
  });
}

/** Refuse a reset whose mirror still holds writes the provider has not delivered. */
async function assertNothingUndeliveredBeforeReset(host: MemoryHost): Promise<void> {
  const undelivered = await undeliveredWrites(host);
  if (undelivered.total === 0) return;
  throw resetRefusal(`${undelivered.advice} before reset`, { undelivered: undelivered.total });
}

/**
 * Clear every entry of the project mirror except the approvals file.
 *
 * The approvals are the records of proposals still pending in koda — user-scope ones included,
 * whose notes live in the user mirror this command never touches — so deleting them would leave
 * a rejected proposal's slug `pending` in the mirror forever, with nothing left to resolve it.
 * The file is not rewritten either: its bytes are koda's answers, and a reset has nothing to add.
 *
 * The entries are joined beneath `dirs.projectDir`: nothing here reaches `userDir`, and nothing
 * is removed from the memory root that holds both.
 */
async function clearProjectMirror(projectDir: string): Promise<void> {
  for (const entry of await _memoryAdminDeps.listDir(projectDir)) {
    if (entry === KODA_APPROVALS_FILE) continue;
    await _memoryAdminDeps.removePath(join(projectDir, entry));
  }
}

/**
 * Everything a reset does once it has opened the host: check, clear, pull back, report.
 *
 * The exit status is the outcome, not an exception: `synced` is the only result that means the
 * mirror is whole again. `unreachable` leaves it empty, `locked` leaves it cleared and not
 * refilled, and `failed` says so in its own message — for all three the operator asked for a
 * rebuild and did not get one, which is the departure from `nax memory sync`'s exit rule. The
 * result is printed either way, for the reason `nax memory sync` prints it.
 */
async function runReset(opts: MemoryCliOptions, deps: MemoryCliDeps): Promise<number> {
  return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
    if (host === null) throw memoryDisabledError();
    assertKodaMirror(host.providerId);
    await assertNothingUndeliveredBeforeReset(host);
    await clearProjectMirror(host.dirs.projectDir);
    const result = await host.sync();
    deps.log(opts.json === true ? JSON.stringify(result) : formatMemorySyncResult(result));
    return result.outcome === "synced" ? 0 : 1;
  });
}

/**
 * `nax memory reset`: throw the project mirror away and pull it back from koda.
 *
 * A refusal prints its one `[memory] …` line and exits 1 with nothing removed; a config that
 * will not load, or a host that cannot be composed, is the group's `Error: …` contract as
 * everywhere else in this group.
 */
export async function memoryResetCommand(
  opts: MemoryCliOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(() => withRefusals(MEMORY_RESET_REFUSED, () => runReset(opts, deps), deps), deps);
}

/**
 * Register `link` and `reset` on the `memory` group, after the subcommands that read and write
 * notes. The group itself is registered by `memory.ts`; this file adds the subcommands that
 * manage a repository's link to koda, and takes the group's deps seam so a stubbed `loadConfig`,
 * `createMemoryHost` or `exit` reaches them unchanged.
 */
export function registerMemoryAdminCommands(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  memory
    .command("link")
    .description("Link this repository to the koda project that holds its memories")
    .argument("<koda-project>", "The koda project slug")
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--force", "Relink to another koda project, rebuilding the project mirror", false)
    .option("--json", "Emit one machine-readable document", false)
    .action(async (slug: string, opts: MemoryLinkOptions) => {
      deps.exit(await memoryLinkCommand(slug, opts, deps));
    });
  memory
    .command("reset")
    .description("Rebuild the project mirror by pulling every note from koda again")
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryCliOptions) => {
      deps.exit(await memoryResetCommand(opts, deps));
    });
  return memory;
}
