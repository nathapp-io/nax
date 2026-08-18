/**
 * Auto-PR Plugin — Types
 *
 * Forge types and injected I/O now live in `@/forge`; this file keeps only the
 * plugin's own config surface and re-exports the shared names so existing
 * importers keep compiling.
 */
export type { ForgeDeps as AutoPrDeps, ForgeKind } from "@/forge";

/** Configuration surface for `autoPr` in `nax.config.json`. */
export interface AutoPrConfig {
  /** Whether auto-PR creation is enabled (default: false) */
  enabled: boolean;
  /** Whether to create the PR as a draft (default: true) */
  draft: boolean;
}
