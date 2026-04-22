/**
 * Context Engine — Orchestrator Factory (Phase 7+)
 *
 * Extracted from orchestrator.ts to keep that file under the 400-line limit.
 * Callers should import createDefaultOrchestrator from the barrel (index.ts).
 */

import type { NaxConfig } from "../../config/types";
import type { UserStory } from "../../prd";
import { DEFAULT_CANONICAL_RULES_BUDGET_TOKENS } from "../rules/canonical-loader";
import { ContextOrchestrator } from "./orchestrator";
import { CodeNeighborProvider } from "./providers/code-neighbor";
import { FeatureContextProviderV2 } from "./providers/feature-context";
import { GitHistoryProvider } from "./providers/git-history";
import { SessionScratchProvider } from "./providers/session-scratch";
import { StaticRulesProvider } from "./providers/static-rules";
import { TestCoverageProvider } from "./providers/test-coverage";
import type { IContextProvider } from "./types";

/**
 * Build a default orchestrator for Phase 0–7+.
 * Providers are constructed with story/config bound where needed.
 *
 * `SessionScratchProvider` is always registered; the provider itself reads
 * scratch dirs from `ContextRequest.storyScratchDirs` at fetch time and
 * returns an empty result when none are supplied.
 *
 * Phase 7: accepts pre-loaded plugin providers (RAG/graph/KB) via
 * `additionalProviders`. Callers are responsible for loading these via
 * `loadPluginProviders()` before invoking this factory.
 *
 * @param story              - current story (needed by FeatureContextProviderV2)
 * @param config             - nax config (needed by FeatureContextProviderV2)
 * @param _storyScratchDirs  - retained for API compatibility; provider reads from request
 * @param additionalProviders - pre-loaded plugin providers (Phase 7+)
 */
export function createDefaultOrchestrator(
  story: UserStory,
  config: NaxConfig,
  _storyScratchDirs?: string[],
  additionalProviders: IContextProvider[] = [],
): ContextOrchestrator {
  const allowLegacyClaudeMd = config.context?.v2?.rules?.allowLegacyClaudeMd ?? false;
  const rulesBudgetTokens = config.context?.v2?.rules?.budgetTokens ?? DEFAULT_CANONICAL_RULES_BUDGET_TOKENS;
  const providers: IContextProvider[] = [
    new StaticRulesProvider({ allowLegacyClaudeMd, budgetTokens: rulesBudgetTokens }),
    new FeatureContextProviderV2(story, config),
  ];
  // TestCoverageProvider is always registered — provider itself gates via enabled flag.
  // Registered before additionalProviders so it appears in providerResults for manifest.
  providers.push(new TestCoverageProvider(story, config));
  // SessionScratchProvider is always registered so stage-config references to
  // "session-scratch" pass AC-16 validation. It returns empty chunks when
  // request.storyScratchDirs is empty (verify/rectify stages supply dirs).
  providers.push(new SessionScratchProvider());
  // Phase 3: git history and code neighbors (always registered; active only when
  // request.touchedFiles is non-empty and the stage includes these provider IDs)
  // #507: scope is read from config so operators can tune for monorepo setups.
  // Optional-chain: tests that bypass Zod schema may omit the providers sub-object.
  const providerConfig = config.context?.v2?.providers;
  providers.push(new GitHistoryProvider({ historyScope: providerConfig?.historyScope ?? "package" }));
  providers.push(
    new CodeNeighborProvider({
      neighborScope: providerConfig?.neighborScope ?? "package",
      crossPackageDepth: providerConfig?.crossPackageDepth ?? 1,
    }),
  );
  // Phase 7: plugin providers (RAG, graph, KB, etc.)
  providers.push(...additionalProviders);
  return new ContextOrchestrator(providers);
}
