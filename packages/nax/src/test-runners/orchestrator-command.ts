/**
 * Monorepo Orchestrator Command (turbo / nx)
 *
 * Leaf module: its only dependency is `@nathapp/nax-agent/internal`. The
 * predicate used to live in `scoped-selection.ts`, whose import graph pulls in
 * `@/logger` and `verification/smart-runner` — too heavy for the config guards
 * to depend on. It moved here unchanged and `scoped-selection.ts` re-exports
 * it, so every existing importer is untouched.
 */

import { normalizeCommandSpec, type QualityCommandSpec } from "@nathapp/nax-agent/internal";

/**
 * Monorepo orchestrators (turbo, nx) carry their own change-filter syntax
 * (e.g. `--filter=...[HEAD~1]`, `nx affected`). Smart-runner must not append
 * file paths to such commands — it would produce invalid syntax.
 */
export function isMonorepoOrchestratorCommand(command: QualityCommandSpec): boolean {
  const commands = normalizeCommandSpec(command);
  return commands.length > 0 && commands.every((entry) => /\bturbo\b/.test(entry) || /\bnx\b/.test(entry));
}
