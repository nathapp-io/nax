/**
 * A recording stand-in for `_policyFilesDeps` (SPEC-cursor-pi-acp-read-only
 * US-004): every call is recorded in the order it happened, and one named
 * operation can be made to reject. Restore with the returned `restore()`, or the
 * next test would keep writing through the stub.
 */
import { _policyFilesDeps, type PolicyFileDeps } from "#src/client/policy-files";

const REAL_DEPS: PolicyFileDeps = { ..._policyFilesDeps };

export type PolicyOp = "mkdir" | "writeFile" | "chmod" | "rename";

export interface PolicyDepRecorder {
  /** Every call, as ["mkdir", path, options] and so on, in the order it happened. */
  readonly io: readonly (readonly unknown[])[];
  restore(): void;
}

export function stubPolicyDeps(fail?: PolicyOp): PolicyDepRecorder {
  const io: (readonly unknown[])[] = [];
  const act = (op: string, args: readonly unknown[]): void => {
    io.push([op, ...args]);
    if (fail === op) throw new Error("no space left on device");
  };
  _policyFilesDeps.mkdir = async (path, options) => {
    act("mkdir", [path, options]);
  };
  _policyFilesDeps.writeFile = async (path, content) => {
    act("writeFile", [path, content]);
  };
  _policyFilesDeps.chmod = async (path, mode) => {
    act("chmod", [path, mode]);
  };
  _policyFilesDeps.rename = async (from, to) => {
    act("rename", [from, to]);
  };
  return { io, restore: () => Object.assign(_policyFilesDeps, REAL_DEPS) };
}
