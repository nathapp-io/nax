import type { SandboxRecord } from "./types.ts";

/**
 * Where a Bash/Exec command ran, as the session events and the chat card say it.
 * Deliberately only the boolean: the audit record's argv and paths stay in the
 * tool-audit ledger and never ride a session event.
 */
export type SandboxStatus = "sandboxed" | "unsandboxed";

/** `wrapped` true is sandboxed, false is unsandboxed; no record (not a launched command) says nothing. */
export function sandboxStatusOf(record: SandboxRecord | undefined): SandboxStatus | undefined {
  if (record === undefined) return undefined;
  return record.wrapped ? "sandboxed" : "unsandboxed";
}

/** The `{ sandbox }` field of a tool outcome or event, or nothing when the record says nothing. */
export function sandboxStatusField(record: SandboxRecord | undefined): { readonly sandbox?: SandboxStatus } {
  const sandbox = sandboxStatusOf(record);
  return sandbox === undefined ? {} : { sandbox };
}
