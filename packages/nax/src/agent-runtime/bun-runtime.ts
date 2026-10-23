import { relative, resolve, sep } from "node:path";
import type { AgentRuntime, AgentSpawnResult } from "@nathapp/nax-agent";

/**
 * nax's runtime for nax-agent: Bun.spawn as is, so every nax CLI path keeps the
 * exact process behaviour it had before the runtime slot existed (spec S2 §4.2).
 * Installed by ./install.ts; nax-agent's own Node default stays unused in nax.
 */
const NAX_GLOB_SEGMENT = `.${"nax"}`;

function hasLiteralNaxPrefix(pattern: string): boolean {
  let normalized = pattern;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized.split("/")[0] === NAX_GLOB_SEGMENT;
}

function isVisibleGlobPath(path: string, exemptNax: boolean): boolean {
  const segments = path.split(sep).filter((segment) => segment !== "" && segment !== ".");
  return segments.every(
    (segment, index) => !segment.startsWith(".") || (exemptNax && index === 0 && segment === NAX_GLOB_SEGMENT),
  );
}

export const bunAgentRuntime: AgentRuntime = {
  async *glob(pattern, opts) {
    const cwd = resolve(opts.cwd);
    const exemptNax = hasLiteralNaxPrefix(pattern);
    for await (const hit of new Bun.Glob(pattern).scan({
      ...opts,
      cwd,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    })) {
      const path = opts.absolute ? relative(cwd, hit) : hit;
      if (isVisibleGlobPath(path, exemptNax)) yield hit;
    }
  },
  *globSync(pattern, opts) {
    const cwd = resolve(opts.cwd);
    const exemptNax = hasLiteralNaxPrefix(pattern);
    for (const hit of new Bun.Glob(pattern).scanSync({
      ...opts,
      cwd,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    })) {
      const path = opts.absolute ? relative(cwd, hit) : hit;
      if (isVisibleGlobPath(path, exemptNax)) yield hit;
    }
  },
  // nax-git-env-allow: the generic runtime; git callers (gitWithTimeout) pass hardenedGitEnv themselves
  spawn: (cmd, opts) => Bun.spawn([...cmd], opts) as unknown as AgentSpawnResult,
};
