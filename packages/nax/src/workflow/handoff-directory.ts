/** Descriptor-relative reads for the handoff collector. Never fall back to reopening a checkout path. */
import { constants } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { NaxError } from "@/errors";

export const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Open exactly one child; the caller supplies O_NOFOLLOW. Linux resolves from the pinned kernel fd. */
export async function openHandoffChild(parent: FileHandle, name: string, flags: number): Promise<FileHandle> {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new NaxError("Invalid handoff record path component", "HANDOFF_RECORD_PATH_INVALID", {
      stage: "handoff-record",
    });
  }
  if (process.platform === "linux") return await open(`/proc/self/fd/${parent.fd}/${name}`, flags);
  if (process.platform !== "darwin") {
    throw new NaxError("Secure handoff record reads are unavailable on this platform", "HANDOFF_RECORD_UNSUPPORTED", {
      stage: "handoff-record",
    });
  }
  const { openDarwinChild } = await import("./handoff-directory-darwin");
  return await openDarwinChild(parent, name, flags);
}

export interface HandoffDirEntry {
  readonly name: string;
  /** Symlinks must be refused; ordinary non-directory entries can be ignored. */
  readonly kind: "directory" | "link" | "unknown";
}

export async function listHandoffChildren(parent: FileHandle): Promise<HandoffDirEntry[]> {
  if (process.platform === "darwin") {
    const { darwinEntries } = await import("./handoff-directory-darwin");
    return darwinEntries(parent, DIRECTORY_FLAGS);
  }
  if (process.platform === "linux") {
    const entries = await readdir(`/proc/self/fd/${parent.fd}`, { withFileTypes: true });
    return entries.flatMap((entry): HandoffDirEntry[] => {
      if (entry.isSymbolicLink()) return [{ name: entry.name, kind: "link" }];
      if (entry.isDirectory()) return [{ name: entry.name, kind: "directory" }];
      return [];
    });
  }
  throw new NaxError("Secure handoff record reads are unavailable on this platform", "HANDOFF_RECORD_UNSUPPORTED", {
    stage: "handoff-record",
  });
}
