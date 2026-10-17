/**
 * `_opencodeAcpEnvDeps` spies for the opencode ACP env tests (US-002,
 * opencode-acp-read-only).
 *
 * `withOpencodeAcpEnv` is the one thing in nax that would otherwise create the
 * developer's `~/.nax/acp/opencode-config`, so any test that lets an opencode
 * session reach that path installs these spies first.
 *
 * Pair with `withDepsRestore(_opencodeAcpEnvDeps)` in the enclosing scope so the
 * module's real implementations come back afterwards.
 */

import { mock } from "bun:test";
import { _opencodeAcpEnvDeps } from "@/agents/shared/opencode-acp-env";

export type OpencodeAcpEnvDeps = typeof _opencodeAcpEnvDeps;

/** Fresh spies for every dep: `mkdir` succeeds silently and `warn` records. */
export function stubOpencodeAcpEnvDeps(overrides: Partial<OpencodeAcpEnvDeps> = {}): OpencodeAcpEnvDeps {
  const deps: OpencodeAcpEnvDeps = {
    mkdir: mock((_path: string): void => {}),
    warn: mock((_message: string, _data: Record<string, unknown>): void => {}),
  };
  Object.assign(deps, overrides);
  Object.assign(_opencodeAcpEnvDeps, deps);
  return deps;
}
