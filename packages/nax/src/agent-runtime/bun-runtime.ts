import { relative, resolve, sep } from "node:path";
import type { AgentRuntime, AgentSpawnResult } from "@nathapp/nax-agent";

/**
 * nax's runtime for nax-agent: Bun.spawn as is, so every nax CLI path keeps the
 * exact process behaviour it had before the runtime slot existed (spec S2 §4.2).
 * Installed by ./install.ts; nax-agent's own Node default stays unused in nax.
 */
export const bunAgentRuntime: AgentRuntime = {
  async *glob(pattern, opts) {
    const cwd = resolve(opts.cwd);
    for await (const hit of new Bun.Glob(pattern).scan({
      ...opts,
      cwd,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    })) {
      const path = opts.absolute ? relative(cwd, hit) : hit;
      if (!path.split(sep).some((segment) => segment !== "." && segment.startsWith("."))) yield hit;
    }
  },
  *globSync(pattern, opts) {
    const cwd = resolve(opts.cwd);
    for (const hit of new Bun.Glob(pattern).scanSync({
      ...opts,
      cwd,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    })) {
      const path = opts.absolute ? relative(cwd, hit) : hit;
      if (!path.split(sep).some((segment) => segment !== "." && segment.startsWith("."))) yield hit;
    }
  },
  // nax-git-env-allow: the generic runtime; git callers (gitWithTimeout) pass hardenedGitEnv themselves
  spawn: (cmd, opts) => Bun.spawn([...cmd], opts) as unknown as AgentSpawnResult,
};
