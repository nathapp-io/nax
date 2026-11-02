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

/** Only immediate children are accepted; no `..`, absolute or multi-component operands reach the worker. */
export function pinnedOperation<T>(path: string, op: string, args: unknown[] = []): Promise<T> | null {
  const directory = activeDirectory.getStore();
  if (!directory) return null;
  if (dirname(path) !== directory.path) throw protocolError(`Path is not in the pinned directory: ${path}`);
  if (op === "rename") {
    const target = String(args[0]);
    if (dirname(target) !== directory.path) throw protocolError(`Rename leaves the pinned directory: ${target}`);
    return directory.request<T>(op, [basename(path), basename(target)]);
  }
  return directory.request<T>(op, [basename(path), ...args]);
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
    input: process.stdin, write: (text) => process.stdout.write(text)
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
