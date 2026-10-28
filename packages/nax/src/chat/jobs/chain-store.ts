import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { CHAIN_ID_PATTERN, type ChatChain } from "./chain-types";

export const CHAT_CHAINS_DIR = "chat-chains";
const RANDOM_HEX_LENGTH = 8;
const CHAIN_STATES: readonly string[] = ["active", "completed", "stopped"];

export const _chainStoreDeps = {
  randomHex: (): string => crypto.randomUUID().slice(0, RANDOM_HEX_LENGTH),
  randomUUID: (): string => crypto.randomUUID(),
  file: Bun.file,
  write: Bun.write,
  mkdir: mkdirSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export function chainsDir(outputDir: string): string {
  return join(outputDir, CHAT_CHAINS_DIR);
}

export function newChainId(): string {
  return `chain-${_chainStoreDeps.randomHex()}`;
}

/** Publish complete audit records atomically using a unique sibling temporary file. */
export async function writeChainRecord(outputDir: string, chain: ChatChain): Promise<void> {
  if (!CHAIN_ID_PATTERN.test(chain.id)) {
    throw new NaxError(`[chat] Invalid chain id: ${chain.id}`, "CHAT_CHAIN_INVALID_ID", { stage: "chat" });
  }
  const dir = chainsDir(outputDir);
  const temp = join(dir, `${chain.id}.${_chainStoreDeps.randomUUID()}.tmp`);
  try {
    _chainStoreDeps.mkdir(dir, { recursive: true });
    await _chainStoreDeps.write(temp, JSON.stringify(chain, null, 2));
    _chainStoreDeps.rename(temp, join(dir, `${chain.id}.json`));
  } catch (cause) {
    const cleanupCause = removeTemp(temp);
    throw new NaxError(`[chat] Failed to write chain ${chain.id}`, "CHAT_CHAIN_WRITE_FAILED", {
      stage: "chat",
      id: chain.id,
      cause,
      cleanupCause,
    });
  }
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Preserve cleanup failures without masking the write failure. */
function removeTemp(path: string): unknown {
  try {
    _chainStoreDeps.unlink(path);
  } catch (err) {
    if (!isMissing(err)) return err;
  }
  return undefined;
}

function isChainRecord(value: unknown): value is ChatChain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    CHAIN_ID_PATTERN.test(record.id) &&
    typeof record.state === "string" &&
    CHAIN_STATES.includes(record.state) &&
    Array.isArray(record.steps) &&
    ["sessionId", "cwd", "approvedAt"].every((key) => typeof record[key] === "string")
  );
}

/** Read audit data only; callers must not reactivate records left by a prior host. */
export async function readChainRecord(outputDir: string, id: string): Promise<ChatChain | null> {
  if (!CHAIN_ID_PATTERN.test(id)) return null;
  try {
    const value: unknown = await _chainStoreDeps.file(join(chainsDir(outputDir), `${id}.json`)).json();
    return isChainRecord(value) ? value : null;
  } catch (err) {
    // Missing records and malformed JSON are ordinary audit skips, not I/O failures.
    if (err instanceof SyntaxError || isMissing(err)) return null;
    throw err;
  }
}
