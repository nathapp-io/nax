import { createHash } from "node:crypto";

/** In-memory deduplication key with 64 bits of collision resistance. */
export function digest64(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
