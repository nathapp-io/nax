/**
 * Login-first onboarding (#2414): after `nax-agent login <provider>`, when no
 * default model is configured, offer to write `models.native.balanced` into the
 * config dir's `config.json`. It merges into the existing document, creates the
 * file 0600 when absent, and never touches the credentials file. A document it
 * cannot merge into safely (malformed, or `models` of the wrong shape) is left
 * unchanged and the one-line instruction is printed instead.
 */
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AuthInteraction,
  listProviderModels,
  PromptCancelledError,
  type ProviderModel,
  redactSecrets,
} from "@nathapp/nax-agent";
import { messageOf } from "#src/server/errors";
import { loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";

export interface ModelPorts {
  /** The provider's catalog models, sorted by id. */
  listModels(provider: string): Promise<readonly ProviderModel[]>;
}

export const NAX_AGENT_MODELS: ModelPorts = { listModels: (provider) => listProviderModels(provider) };

/**
 * Writes `text` to `path`, creating the directory (0700) and, if absent, the file (0600).
 * Atomic: a temp file in the same directory (flag "wx", the existing file's mode), synced,
 * then renamed over the target. A symlinked config.json keeps its link: the target is replaced.
 */
export type ConfigWriter = (path: string, text: string) => Promise<void>;

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function existingTarget(path: string): Promise<{ readonly target: string; readonly mode: number }> {
  try {
    const target = await realpath(path);
    return { target, mode: (await stat(target)).mode & 0o777 };
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { target: path, mode: 0o600 };
    throw error;
  }
}

export const NODE_CONFIG_WRITER: ConfigWriter = async (path, text) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { target, mode } = await existingTarget(path);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.chmod(mode); // the umask must not narrow an existing file's mode
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

export type MergeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `existing` (config.json text, or undefined when absent) with models.native.balanced set to `model`. */
export function mergeBalancedModel(existing: string | undefined, model: string): MergeResult {
  let root: unknown = {};
  if (existing !== undefined) {
    try {
      root = JSON.parse(existing);
    } catch {
      return { ok: false, reason: "it is not valid JSON" };
    }
  }
  if (!isRecord(root)) return { ok: false, reason: "it is not a JSON object" };
  if (root.models !== undefined && !isRecord(root.models)) return { ok: false, reason: '"models" is not an object' };
  const models = isRecord(root.models) ? root.models : {};
  if (models.native !== undefined && !isRecord(models.native)) {
    return { ok: false, reason: '"models.native" is not an object' };
  }
  const native = isRecord(models.native) ? models.native : {};
  const merged = { ...root, models: { ...models, native: { ...native, balanced: model } } };
  return { ok: true, text: `${JSON.stringify(merged, null, 2)}\n` };
}

export interface OfferInput {
  readonly provider: string;
  readonly configDir: string;
  readonly isTTY: boolean;
  /** A model is already chosen by --model or NAX_AGENT_MODEL. */
  readonly pinned: boolean;
  readonly interaction: AuthInteraction;
  readonly out: (line: string) => void;
  readonly models: ModelPorts;
  readonly readFile: ReadTextFile;
  readonly write: ConfigWriter;
}

const SKIP = "skip";
const MODEL_PREFIX = "model:";

function instruction(provider: string, path: string): string {
  return `No default model is set: set models.native.balanced to "${provider}/<model>" in ${path} (or NAX_AGENT_MODEL), then retry in your editor.`;
}

async function readExisting(path: string, readFile: ReadTextFile): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function pickModel(input: OfferInput, models: readonly ProviderModel[]): Promise<string | undefined> {
  if (models.length === 0) return undefined;
  try {
    const answer = await input.interaction.prompt({
      type: "select",
      message: "Pick the default model for new threads (models.native.balanced)",
      options: [
        ...models.map((m) => ({
          id: `${MODEL_PREFIX}${m.id}`,
          label: m.id,
          description: `${m.contextWindow} token window`,
        })),
        { id: SKIP, label: "Skip", description: "set models.native.balanced yourself" },
      ],
    });
    return answer.startsWith(MODEL_PREFIX) ? `${input.provider}/${answer.slice(MODEL_PREFIX.length)}` : undefined;
  } catch (error) {
    if (error instanceof PromptCancelledError) return undefined;
    throw error;
  }
}

async function listModels(input: OfferInput): Promise<readonly ProviderModel[]> {
  try {
    return await input.models.listModels(input.provider);
  } catch (error) {
    input.out(`Could not list ${input.provider} models: ${redactSecrets(messageOf(error))}`);
    return [];
  }
}

export async function offerDefaultModel(input: OfferInput): Promise<void> {
  if (input.pinned) return;
  const path = join(input.configDir, "config.json");
  const loaded = await loadNaxConfig(input.configDir, input.readFile);
  if (loaded.warning === undefined && loaded.config.tiers.some((t) => t.tier === "balanced")) return;
  if (loaded.warning !== undefined) {
    input.out(`${path} was left unchanged (${loaded.warning}).`);
    input.out(instruction(input.provider, path));
    return;
  }
  const based = await readExisting(path, input.readFile);
  const model = input.isTTY ? await pickModel(input, await listModels(input)) : undefined;
  if (model === undefined) {
    input.out(instruction(input.provider, path));
    return;
  }
  const merged = mergeBalancedModel(based, model);
  if (!merged.ok) {
    input.out(`${path} was left unchanged (${merged.reason}).`);
    input.out(instruction(input.provider, path));
    return;
  }
  // The pick can take a while; another writer may have changed the file meanwhile.
  if ((await readExisting(path, input.readFile)) !== based) {
    input.out(`${path} changed while picking; left unchanged.`);
    input.out(instruction(input.provider, path));
    return;
  }
  await input.write(path, merged.text);
  input.out(`Set models.native.balanced to ${model} in ${path}. Retry in your editor.`);
}
