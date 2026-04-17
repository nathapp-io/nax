/**
 * Context Engine — Orchestrator Factory (Phase 7+)
 *
 * Extracted from orchestrator.ts to keep that file under the 400-line limit.
 * Callers should import createDefaultOrchestrator from the barrel (index.ts).
 */

import type { NaxConfig } from "../../config/types";
import type { UserStory } from "../../prd";
import { ContextOrchestrator } from "./orchestrator";
import { CodeNeighborProvider } from "./providers/code-neighbor";
import { FeatureContextProviderV2 } from "./providers/feature-context";
import { GitHistoryProvider } from "./providers/git-history";
import { SessionScratchProvider } from "./providers/session-scratch";
import { StaticRulesProvider } from "./providers/static-rules";
import type { IContextProvider } from "./types";

/**
 * Build a default orchestrator for Phase 0–7+.
 * Providers are constructed with story/config bound where needed.
 *
 * When storyScratchDirs is provided, `SessionScratchProvider` is registered
 * so the verify/rectify stages can see prior scratch observations.
 *
 * Phase 7: accepts pre-loaded plugin providers (RAG/graph/KB) via
 * `additionalProviders`. Callers are responsible for loading these via
 * `loadPluginProviders()` before invoking this factory.
 *
 * @param story              - current story (needed by FeatureContextProviderV2)
 * @param config             - nax config (needed by FeatureContextProviderV2)
 * @param storyScratchDirs   - scratch dirs for this story's sessions (Phase 1+)
 * @param additionalProviders - pre-loaded plugin providers (Phase 7+)
 */
export function createDefaultOrchestrator(
  story: UserStory,
  config: NaxConfig,
  storyScratchDirs?: string[],
  additionalProviders: IContextProvider[] = [],
): ContextOrchestrator {
  const allowLegacyClaudeMd = config.context.v2.rules.allowLegacyClaudeMd;
  const providers: IContextProvider[] = [
    new StaticRulesProvider({ allowLegacyClaudeMd }),
    new FeatureContextProviderV2(story, config),
  ];
  if (storyScratchDirs && storyScratchDirs.length > 0) {
    providers.push(new SessionScratchProvider());
  }
  // Phase 3: git history and code neighbors (always registered; active only when
  // request.touchedFiles is non-empty and the stage includes these provider IDs)
  // #507: scope is read from config so operators can tune for monorepo setups.
  const providerConfig = config.context.v2.providers;
  providers.push(new GitHistoryProvider({ historyScope: providerConfig.historyScope }));
  providers.push(
    new CodeNeighborProvider({
      neighborScope: providerConfig.neighborScope,
      crossPackageDepth: providerConfig.crossPackageDepth,
    }),
  );
  // Phase 7: plugin providers (RAG, graph, KB, etc.)
  providers.push(...additionalProviders);
  return new ContextOrchestrator(providers);
}
