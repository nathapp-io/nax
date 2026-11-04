/**
 * `nax memory link` — point a repository at the koda project that holds its memories.
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
 *   7. `config.json.tmp` is written and renamed onto `config.json`;
 *   8. a forced relink discards the project mirror, so the next sync pulls the new project from
 *      the start — the old cursor would decode in the new project and skip its older rows.
 *
 * A refusal is a `[memory] …` line on stderr and exit 1 with nothing written; a load failure is
 * the group's `Error: …`. The host is opened only for a forced relink, and not at all when
 * memory is disabled, so a non-null host is the whole condition steps 5 and 8 need.
 *
 * Nothing here preserves comments or formatting: `.nax/config.json` is plain JSON and is
 * rewritten with two-space indentation.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MEMORY_PROBE_TIMEOUT_MS } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { KODA_PROJECT_SLUG_RE, type MemoryConfig, memoryConfigOf, PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import { createKodaClient, type MemoryHost } from "@/memory";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  memoryDefaultDir,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";

/** The `[stage]` label every line these commands print carries. */
const STAGE = "memory";
/** The label a message starts with, so a quoted reason does not repeat it. */
const STAGE_LABEL = "[memory] ";
/** The error code a refusal — a line, not a failure — is carried by. */
const MEMORY_LINK_REFUSED = "MEMORY_LINK_REFUSED";
/** The write modes koda's probe answers with when the calling agent may write (the rule `reachable()` uses). */
const LINK_WRITE_MODES = ["direct", "proposal"] as const satisfies readonly MemoryConfig["writeMode"][];
/** The file a config write is staged in before the rename puts it in place. */
const CONFIG_TMP_SUFFIX = ".tmp";

/** One project config as JSON holds it: keys and values this command only carries over. */
type ConfigObject = Record<string, unknown>;

/**
 * The filesystem seam these commands act through.
 *
 * It is the whole surface `link` touches, and the surface `reset` reports over: the project
 * config it rewrites, the temporary file that rewrite is staged in, the project mirror a
 * relink discards, and a directory listing. A test overrides members to record a write or to
 * drive a read that fails, without a mirror on disk.
 */
export const _memoryAdminDeps: {
  /** The file's text, or `null` when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Write `text` to `path`, creating the parent directories. */
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Entry names, or `[]` when the directory does not exist. */
  listDir(path: string): Promise<readonly string[]>;
  /** Remove `path` and everything under it; a missing path is not an error. */
  removePath(path: string): Promise<void>;
} = {
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, text);
  },
  rename: (from, to) => rename(from, to),
  listDir: readDirNames,
  removePath: (path) => rm(path, { recursive: true, force: true }),
};

/** One directory's entry names, or `[]` when it does not exist. */
async function readDirNames(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (cause) {
    if (isMissingPath(cause)) return [];
    throw cause;
  }
}

/** True when `cause` is the filesystem's own "no such file or directory". */
function isMissingPath(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

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
  /** The project config exactly as the file holds it. */
  readonly raw: ConfigObject;
  readonly slug: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: boolean;
  readonly deps: MemoryCliDeps;
}

/** The refusal a link answers with: a `[memory] …` line, exit 1, nothing written. */
function linkRefusal(message: string, data: Record<string, unknown> = {}): NaxError {
  return new NaxError(`${STAGE_LABEL}${message}`, MEMORY_LINK_REFUSED, { stage: STAGE, ...data });
}

function isRecord(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The non-empty string `value[key]` holds, or `undefined` when it holds anything else. */
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
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

/** The `memory.koda.project` a raw project config holds, or `undefined` when it names none. */
function projectOf(raw: ConfigObject): string | undefined {
  const memory = raw.memory;
  return isRecord(memory) ? stringField(memory.koda, "project") : undefined;
}

/**
 * Whether this link replaces another koda project — and therefore rebuilds the project mirror.
 *
 * A config that names no project, or the same one, is not a relink: the write is idempotent and
 * discarding the mirror would throw away a cursor that is still valid. A different project is
 * replaced only when `--force` says so, because the mirror it discards holds undelivered writes.
 */
function isForcedRelink(raw: ConfigObject, slug: string, force: boolean): boolean {
  const existing = projectOf(raw);
  if (existing === undefined || existing === slug) return false;
  if (force) return true;
  throw linkRefusal(
    `already linked to koda project "${existing}"; pass --force to relink (the project mirror is rebuilt)`,
    { project: existing },
  );
}

/**
 * The project config the link writes: the raw object with `memory.provider` and
 * `memory.koda.project` set, and every other key and value as the file held it.
 *
 * A `memory` or `memory.koda` value that is not an object is replaced rather than merged — the
 * loader would reject it anyway, and a link must not fail after it has already been probed.
 */
function applyLink(raw: ConfigObject, slug: string): ConfigObject {
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const koda = isRecord(memory.koda) ? memory.koda : {};
  return { ...raw, memory: { ...memory, provider: "koda", koda: { ...koda, project: slug } } };
}

/**
 * The project config as the file holds it, read before the loader runs.
 *
 * An absent file is an empty project layer, so linking into a repository with no `.nax` writes
 * one. A file that is not JSON, or is JSON that is not an object, is refused with the path: the
 * operator cannot edit what the command does not name.
 */
async function readRawProjectConfig(configPath: string): Promise<ConfigObject> {
  const text = await _memoryAdminDeps.readText(configPath);
  if (text === null) return {};
  const parsed = tryParseJson(text);
  if (!parsed.ok) throw linkRefusal(`cannot link: ${configPath} is not valid JSON`, { path: configPath });
  if (!isRecord(parsed.value)) {
    throw linkRefusal(`cannot link: ${configPath} is not a JSON object`, { path: configPath });
  }
  return parsed.value;
}

/** A parsed document, or the fact that the text is not JSON at all. */
type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function tryParseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Not JSON: the caller names the file it could not read.
    return { ok: false };
  }
}

/** Refuse a forced relink whose mirror still holds writes the provider has not delivered. */
async function assertNothingUndelivered(host: MemoryHost): Promise<void> {
  const status = await host.status();
  const undelivered = status.queued + status.rejected;
  if (undelivered === 0) return;
  throw linkRefusal(
    `${undelivered} writes are not delivered; run nax memory sync (or nax memory forget) before relinking`,
    { undelivered },
  );
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

/** Write the project config through a temporary file in the same directory, then rename it. */
async function writeProjectConfig(configPath: string, config: ConfigObject): Promise<void> {
  const tmpPath = `${configPath}${CONFIG_TMP_SUFFIX}`;
  try {
    await _memoryAdminDeps.writeText(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
    await _memoryAdminDeps.rename(tmpPath, configPath);
  } catch (cause) {
    throw new NaxError(`${STAGE_LABEL}cannot write ${configPath}: ${errorMessage(cause)}`, "MEMORY_LINK_WRITE_FAILED", {
      stage: STAGE,
      path: configPath,
      cause,
    });
  }
}

/** The document `--json` prints: the two facts the link established, and where it recorded them. */
function linkDocument(write: LinkWrite, mode: MemoryConfig["writeMode"]) {
  return { project: write.slug, writeMode: mode, configPath: write.configPath };
}

/** Everything a link does once it has passed its checks: probe, write, and report. */
async function linkThrough(write: LinkWrite, host: MemoryHost | null): Promise<number> {
  // A host exists only for a forced relink, and not at all when memory is disabled, so a
  // non-null host is the whole condition the undelivered check and the removal are read from.
  if (host !== null) await assertNothingUndelivered(host);
  const mode = await probeWriteMode(write.url, write.headers, write.slug);
  await writeProjectConfig(write.configPath, applyLink(write.raw, write.slug));
  if (host !== null) await _memoryAdminDeps.removePath(host.dirs.projectDir);
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
  const configPath = join(repoRoot, PROJECT_NAX_DIR, "config.json");
  const raw = await readRawProjectConfig(configPath);
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
  if (!isForcedRelink(raw, slug, opts.force === true)) return await linkThrough(write, null);
  return await withMemoryHost({ config, repoRoot }, deps, (host) => linkThrough(write, host));
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
  return withMemoryErrors(async () => {
    try {
      return await runLink(slug, opts, deps);
    } catch (error) {
      if (error instanceof NaxError && error.code === MEMORY_LINK_REFUSED) {
        deps.logErr(error.message);
        return 1;
      }
      throw error;
    }
  }, deps);
}

/**
 * Register `link` on the `memory` group, after the subcommands that read and write notes.
 * The group itself is registered by `memory.ts`; this file adds the subcommands that manage a
 * repository's link to koda, and takes the group's deps seam so a stubbed `loadConfig`,
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
  return memory;
}
