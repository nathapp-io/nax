/** Darwin has no procfs fd paths: use openat and enumerate with fdopendir/readdir. */
import { CString, dlopen, FFIType, type Pointer, read, toArrayBuffer } from "bun:ffi";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { getSystemErrorName } from "node:util";
import { NaxError } from "@/errors";
import type { HandoffDirEntry } from "./handoff-directory";

// Darwin's <sys/fcntl.h> and inode64 struct dirent (<sys/dirent.h>).
const DARWIN_O_CLOEXEC = 0x01000000;
const DIRENT_TYPE_OFFSET = 20;
const DIRENT_NAME_OFFSET = 21;
const DT_UNKNOWN = 0;
const DT_DIR = 4;
const DT_LNK = 10;

const LIB_SYSTEM = "/usr/lib/libSystem.B.dylib";

function loadDarwinDirectoryApi() {
  return dlopen(LIB_SYSTEM, {
    openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  }).symbols;
}

const api = loadDarwinDirectoryApi();
const READDIR_SIGNATURE = { args: [FFIType.ptr], returns: FFIType.ptr } as const;
// x86_64 Darwin uses the inode64 symbol alias; arm64 only has the inode64 ABI.
const nextEntry =
  process.arch === "x64"
    ? dlopen(LIB_SYSTEM, { readdir$INODE64: READDIR_SIGNATURE }).symbols.readdir$INODE64
    : dlopen(LIB_SYSTEM, { readdir: READDIR_SIGNATURE }).symbols.readdir;

function errnoPointer(): Pointer {
  const pointer = api.__error();
  if (pointer === null) {
    throw new NaxError("Could not read Darwin errno", "HANDOFF_RECORD_NATIVE_ERROR", { stage: "handoff-record" });
  }
  return pointer;
}

function darwinError(operation: string, errno: number): NaxError {
  const code = getSystemErrorName(-errno);
  return new NaxError(`${operation}: ${code}`, code, { stage: "handoff-record" });
}

function openDarwinFd(parentFd: number, name: string, flags: number): number {
  const fd = api.openat(parentFd, Buffer.from(`${name}\0`), flags | DARWIN_O_CLOEXEC);
  if (fd === -1) throw darwinError("openat", read.i32(errnoPointer()));
  return fd;
}

export async function openDarwinChild(parent: FileHandle, name: string, flags: number): Promise<FileHandle> {
  const fd = openDarwinFd(parent.fd, name, flags);
  try {
    // Darwin's /dev/fd duplicates the open descriptor. This gives Bun a FileHandle to read/stat/close.
    return await open(`/dev/fd/${fd}`, constants.O_RDONLY);
  } finally {
    api.close(fd);
  }
}

export function darwinEntries(parent: FileHandle, directoryFlags: number): HandoffDirEntry[] {
  const fd = openDarwinFd(parent.fd, ".", directoryFlags);
  const dir = api.fdopendir(fd);
  if (dir === null) {
    const errno = read.i32(errnoPointer());
    api.close(fd);
    throw darwinError("fdopendir", errno);
  }
  try {
    const entries: HandoffDirEntry[] = [];
    const errno = new Int32Array(toArrayBuffer(errnoPointer(), 0, Int32Array.BYTES_PER_ELEMENT));
    for (;;) {
      // readdir returns the same sentinel for EOF and errors; distinguish via errno.
      errno[0] = 0;
      const entry = nextEntry(dir);
      if (entry === null) {
        if (errno[0] !== 0) throw darwinError("readdir", errno[0]);
        return entries;
      }
      const type = read.u8(entry, DIRENT_TYPE_OFFSET);
      if (type !== DT_LNK && type !== DT_DIR && type !== DT_UNKNOWN) continue;
      const name = String(new CString(entry, DIRENT_NAME_OFFSET));
      if (name === "." || name === "..") continue;
      entries.push({ name, kind: type === DT_LNK ? "link" : type === DT_DIR ? "directory" : "unknown" });
    }
  } finally {
    api.closedir(dir);
  }
}
