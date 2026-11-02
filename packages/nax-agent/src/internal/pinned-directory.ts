/** Filesystem mutations relative to a process-pinned parent, not a re-resolved path. */
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname } from "node:path";
import { NaxError } from "#src/infra/nax-error";
import { runtimeSpawn } from "#src/runtime/index";
import { pinnedDirectoryWorker } from "./pinned-directory-worker.ts";

interface Identity {
  readonly dev: number;
  readonly ino: number;
}
interface PinnedDirectory {
  readonly path: string;
  request<T>(op: string, args: unknown[]): Promise<T>;
}
const activeDirectory = new AsyncLocalStorage<PinnedDirectory>();

function protocolError(message: string): NaxError {
  return new NaxError(message, "MEMORY_IO_FAILED", { stage: "memory" });
}

/** The suffix of a staging directory: the one two-level operand a request may name. */
const STAGE_SUFFIX = ".tmp";

/**
 * The path a pinned worker resolves entries through, when the platform has one.
 *
 * The worker's operations are relative, so the kernel resolves them against the cwd *inode* —
 * a rename of the directory cannot redirect them. Resolution to a real path needs an absolute
 * spelling, and a runtime may build one from a cached cwd string (Bun on Linux keeps the
 * spelling after the directory is renamed), which would resolve the name the directory left
 * behind. `/proc/self/cwd` is the magic link to the same inode and is Linux-only; macOS has no
 * traversable equivalent and needs none, because its `realpath` already answers from the inode.
 */
const CWD_ANCHOR = process.platform === "linux" ? "/proc/self/cwd" : null;

/**
 * The operand a request carries, relative to the pinned directory.
 *
 * A name in the pinned directory is one component; the only deeper operand is a name inside
 * one of its staging directories (`<name>.tmp/<name>`), which is how a write reaches the
 * namespace it created for itself. Nothing else is accepted: no `..`, no absolute path and
 * no further nesting.
 */
function operandIn(pinnedPath: string, path: string): string {
  if (dirname(path) === pinnedPath) return basename(path);
  const stage = dirname(path);
  if (dirname(stage) === pinnedPath && basename(stage).endsWith(STAGE_SUFFIX)) {
    return `${basename(stage)}/${basename(path)}`;
  }
  throw protocolError(`Path is not in the pinned directory: ${path}`);
}

/** Resolve one operand to a request: the same check for a single path and for a rename pair. */
export function pinnedOperation<T>(path: string, op: string, args: unknown[] = []): Promise<T> | null {
  const directory = activeDirectory.getStore();
  if (!directory) return null;
  if (op === "rename") {
    return directory.request<T>(op, [operandIn(directory.path, path), operandIn(directory.path, String(args[0]))]);
  }
  return directory.request<T>(op, [operandIn(directory.path, path), ...args]);
}

async function* responses(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let end = pending.indexOf("\n");
      while (end !== -1) {
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Spawn first, then verify the child's cwd identity before sending any mutation.
 * A swap during spawn therefore fails closed. Later swaps cannot redirect cwd-relative
 * operations. AsyncLocalStorage keeps concurrent stores/seam wrappers isolated without
 * changing the existing `_atomicWriteDeps` call signatures.
 */
export async function withPinnedDirectory<T>(
  input: { path: string; identity: Identity; changed: () => Error },
  action: () => Promise<T>,
): Promise<T> {
  // Builtins are supplied in the script, not imported inside the serialized function:
  // bundlers/test transforms may otherwise rewrite import() into closure-bound helpers.
  const script = `(${pinnedDirectoryWorker.toString()})(require("node:fs/promises"), {
    createInterface: require("node:readline").createInterface,
    input: process.stdin, write: (text) => process.stdout.write(text),
    anchor: ${JSON.stringify(CWD_ANCHOR)}
  })`;
  const child = runtimeSpawn([process.execPath, "-e", script], {
    cwd: input.path,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const lines = responses(child.stdout);
  let queue = Promise.resolve();
  const directory: PinnedDirectory = {
    path: input.path,
    request<R>(op: string, args: unknown[]): Promise<R> {
      const result = queue.then(async () => {
        child.stdin?.write(`${JSON.stringify({ op, args })}\n`);
        child.stdin?.flush();
        const reply = await lines.next();
        if (reply.done) throw protocolError(`Pinned directory worker exited: ${await stderr}`);
        const response = JSON.parse(reply.value) as { value: R; error?: string; code?: string };
        if (response.error)
          throw new NaxError(response.error, response.code ?? "MEMORY_IO_FAILED", { stage: "memory", op });
        return response.value;
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  try {
    const actual = await directory.request<Identity>("directory", []);
    if (actual.dev !== input.identity.dev || actual.ino !== input.identity.ino) throw input.changed();
    return await activeDirectory.run(directory, action);
  } finally {
    child.stdin?.end();
    await Promise.all([child.exited, stderr]);
    await lines.return(undefined);
  }
}

/** Opened stage RPCs use the worker's descriptor table, never a staging pathname. */
export async function openPinnedStage(
  path: string,
  flags: number,
  mode: number,
): Promise<{
  write(content: string | Uint8Array): Promise<void>;
  identity(): Promise<Identity>;
  close(): Promise<void>;
} | null> {
  const directory = activeDirectory.getStore();
  if (!directory) return null;
  const descriptor = await pinnedOperation<number>(path, "open", [flags, mode]);
  return {
    write: (content) => directory.request("write", [descriptor, Buffer.from(content).toString("base64")]),
    identity: () => directory.request("identity", [descriptor]),
    close: () => directory.request("close", [descriptor]),
  };
}

/** One entry of the pinned directory, open for reading; `null` outside a pinned session. */
export interface PinnedRead {
  readText(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Open one entry of the pinned directory and read it through the descriptor.
 *
 * `path` names an entry *of the pinned directory itself*: the worker resolves it against the
 * cwd it pinned, so no later rename of the directory on disk can redirect the read. The flags
 * the caller passes are the ones the worker opens with — `O_NOFOLLOW` included, so a link at
 * the name is refused rather than followed.
 */
export async function openPinnedRead(path: string, flags: number): Promise<PinnedRead | null> {
  const directory = activeDirectory.getStore();
  if (!directory) return null;
  const descriptor = await pinnedOperation<number>(path, "open", [flags, 0o666]);
  return {
    readText: () => directory.request<string>("read", [descriptor]),
    close: () => directory.request("close", [descriptor]),
  };
}

/**
 * The real path of one entry of the pinned directory, resolved from the pinned inode.
 *
 * The answer is what the entry is *inside the pinned directory*: the caller learns whether the
 * name is a plain file (the answer names the pinned path itself) or a link, and where that link
 * goes, without resolving the mutable parent a second time in this process. The worker spells
 * the resolution through `CWD_ANCHOR`, so the directory being renamed on disk changes the name
 * in the answer without changing what it describes.
 */
export async function resolvePinned(path: string): Promise<string | null> {
  const resolved = await pinnedOperation<string>(path, "resolve");
  return resolved === null ? null : await resolved;
}
