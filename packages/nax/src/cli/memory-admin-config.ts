/**
 * The project config as a document: `<repoRoot>/.nax/config.json` as JSON holds it.
 *
 * Two things about that file matter to a link, and they are different things. The *object* is
 * what the link merges into — `memory.provider` and `memory.koda.project` set, every other key
 * and value carried over untouched, because the file is the project's and not this command's.
 * The *text* is what a failed relink puts back: restoring a re-serialisation of the object would
 * rewrite a file the link had decided not to change.
 *
 * Every write goes through `config.json.tmp` and a rename, so a reader sees the old file or the
 * new one and never a half-written one, and so a write that fails leaves the real file untouched.
 *
 * It lives beside `memory-admin.ts` rather than in it because the command is at its size limit
 * and this concern is whole on its own: it is the only place that knows the file's shape, its
 * name, and the JSON readers the checks and the write agree on.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import { _memoryAdminDeps, linkRefusal, STAGE, STAGE_LABEL } from "./memory-admin-deps";

/** The file a config write is staged in before the rename puts it in place. */
const CONFIG_TMP_SUFFIX = ".tmp";

/** One project config as JSON holds it: keys and values this command only carries over. */
export type ConfigObject = Record<string, unknown>;

/** A project config as it was read: what to merge into, and the exact text to put back. */
export interface RawProjectConfig {
  /** The parsed object, or `{}` when the file did not exist. */
  readonly config: ConfigObject;
  /** The text the file held, or `null` when there was no file. */
  readonly text: string | null;
}

/** A parsed document, or the fact that the text is not JSON at all. */
type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function isRecord(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The non-empty string `value[key]` holds, or `undefined` when it holds anything else. */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** The project config's path in a repository: the one file `nax memory link` rewrites. */
export function projectConfigPath(repoRoot: string): string {
  return join(repoRoot, PROJECT_NAX_DIR, "config.json");
}

/** The `memory.koda.project` a project config holds, or `undefined` when it names none. */
export function projectOf(raw: ConfigObject): string | undefined {
  const memory = raw.memory;
  return isRecord(memory) ? stringField(memory.koda, "project") : undefined;
}

function tryParseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Not JSON: the caller names the file it could not read.
    return { ok: false };
  }
}

/**
 * The project config as the file holds it, read before the loader runs.
 *
 * An absent file is an empty project layer, so linking into a repository with no `.nax` writes
 * one. A file that is not JSON, or is JSON that is not an object, is refused with the path: the
 * operator cannot edit what the command does not name.
 */
export async function readProjectConfig(configPath: string): Promise<RawProjectConfig> {
  const text = await _memoryAdminDeps.readText(configPath);
  if (text === null) return { config: {}, text };
  const parsed = tryParseJson(text);
  if (!parsed.ok) throw linkRefusal(`cannot link: ${configPath} is not valid JSON`, { path: configPath });
  if (!isRecord(parsed.value)) {
    throw linkRefusal(`cannot link: ${configPath} is not a JSON object`, { path: configPath });
  }
  return { config: parsed.value, text };
}

/**
 * The project config the link writes: the raw object with `memory.provider` and
 * `memory.koda.project` set, and every other key and value as the file held it.
 *
 * A `memory` or `memory.koda` value that is not an object is replaced rather than merged — the
 * loader would reject it anyway, and a link must not fail after it has already been probed.
 */
export function applyLink(raw: ConfigObject, slug: string): ConfigObject {
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const koda = isRecord(memory.koda) ? memory.koda : {};
  return { ...raw, memory: { ...memory, provider: "koda", koda: { ...koda, project: slug } } };
}

/** Stage `text` in `config.json.tmp` and rename it onto the config, so a reader sees one file. */
async function stageConfigWrite(configPath: string, text: string): Promise<void> {
  const tmpPath = `${configPath}${CONFIG_TMP_SUFFIX}`;
  await _memoryAdminDeps.writeText(tmpPath, text);
  await _memoryAdminDeps.rename(tmpPath, configPath);
}

/** Write the project config, naming the file the seam could not write. */
export async function writeProjectConfig(configPath: string, config: ConfigObject): Promise<void> {
  try {
    await stageConfigWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (cause) {
    throw new NaxError(`${STAGE_LABEL}cannot write ${configPath}: ${errorMessage(cause)}`, "MEMORY_LINK_WRITE_FAILED", {
      stage: STAGE,
      path: configPath,
      cause,
    });
  }
}

/**
 * Put the project config back exactly as it was read, before a link rewrote it.
 *
 * `previous` is the text the file held, or `null` when there was no file — in which case undoing
 * the link means removing the file it made.
 */
export async function restoreProjectConfig(configPath: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await _memoryAdminDeps.removePath(configPath);
    return;
  }
  await stageConfigWrite(configPath, previous);
}
