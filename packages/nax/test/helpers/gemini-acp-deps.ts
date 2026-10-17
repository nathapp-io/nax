/**
 * `_geminiAcpEnvDeps` spies for the gemini ACP env tests (US-002,
 * gemini-acp-read-only).
 *
 * `prepareIsolatedGeminiHome` is the one thing in nax that would otherwise
 * create the developer's `~/.nax/acp/gemini-home` and link their real
 * `~/.gemini/oauth_creds.json` / `gemini-credentials.json` into it, so any test
 * that lets a gemini session reach that path installs these spies first.
 *
 * Pair with `withDepsRestore(_geminiAcpEnvDeps)` in the enclosing scope so the
 * module's real implementations come back afterwards.
 */

import { mock } from "bun:test";
import { _geminiAcpEnvDeps } from "@/agents/shared/gemini-acp-env";

export type GeminiAcpEnvDeps = typeof _geminiAcpEnvDeps;

/**
 * Fresh spies for every dep. The defaults describe the commonest real machine —
 * an operator who signed in with Google: both credential files exist, the
 * isolated home is still empty, and the source `settings.json` names the
 * `oauth-personal` auth type. `homedir()` answers `"/u"` and `env()` answers
 * nothing, so the source home is `<homedir>/.gemini`.
 *
 * `readText` answers for every path, so a test that cares where the settings
 * are read from asserts on `readText`'s call itself.
 */
export function stubGeminiAcpEnvDeps(overrides: Partial<GeminiAcpEnvDeps> = {}): GeminiAcpEnvDeps {
  const deps: GeminiAcpEnvDeps = {
    mkdir: mock((_path: string): void => {}),
    entryExists: mock((_path: string): boolean => false),
    fileExists: mock((_path: string): boolean => true),
    symlink: mock((_target: string, _path: string): void => {}),
    readText: mock((_path: string): string | undefined =>
      JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    ),
    writeText: mock((_path: string, _text: string): void => {}),
    env: mock((_name: string): string | undefined => undefined),
    homedir: mock((): string => "/u"),
    warn: mock((_message: string, _data: Record<string, unknown>): void => {}),
  };
  Object.assign(deps, overrides);
  Object.assign(_geminiAcpEnvDeps, deps);
  return deps;
}
