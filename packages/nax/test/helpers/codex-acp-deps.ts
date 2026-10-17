/**
 * `_codexAcpEnvDeps` spies for the codex ACP env tests (US-002).
 *
 * `prepareIsolatedCodexHome` is the one thing in nax that would otherwise create
 * the developer's `~/.nax/acp/codex-home` and link their real
 * `~/.codex/auth.json` into it, so any test that lets a codex session reach that
 * path installs these spies first.
 *
 * Pair with `withDepsRestore(_codexAcpEnvDeps)` in the enclosing scope so the
 * module's real implementations come back afterwards.
 */

import { mock } from "bun:test";
import { _codexAcpEnvDeps } from "@/agents/shared/codex-acp-env";

export type CodexAcpEnvDeps = typeof _codexAcpEnvDeps;

/**
 * Fresh spies for every dep. The defaults describe the commonest real machine —
 * a user with `~/.codex/auth.json` and an isolated home that is still empty:
 * `homedir()` answers `"/u"`, `env()` answers nothing (so the source home is
 * `<homedir>/.codex`), `fileExists` is true and `entryExists` false.
 */
export function stubCodexAcpEnvDeps(overrides: Partial<CodexAcpEnvDeps> = {}): CodexAcpEnvDeps {
  const deps: CodexAcpEnvDeps = {
    mkdir: mock((_path: string): void => {}),
    entryExists: mock((_path: string): boolean => false),
    fileExists: mock((_path: string): boolean => true),
    symlink: mock((_target: string, _path: string): void => {}),
    env: mock((_name: string): string | undefined => undefined),
    homedir: mock((): string => "/u"),
    warn: mock((_message: string, _data: Record<string, unknown>): void => {}),
  };
  Object.assign(deps, overrides);
  Object.assign(_codexAcpEnvDeps, deps);
  return deps;
}
