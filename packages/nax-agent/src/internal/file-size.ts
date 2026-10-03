import { statSync } from "node:fs";

/** Preserve missing-file size probes without suppressing other I/O errors. */
export function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}
