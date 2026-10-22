import type { ForgeDeps, PrRef } from "@/forge";

export interface ForgeReadBinding {
  readonly resolveRef: () => Promise<PrRef>;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}

export interface ToolResultParts {
  readonly header: readonly string[];
  /** Forge-derived metadata kept inside the fence even when entries are dropped. */
  readonly fencedHeader?: readonly string[];
  readonly entries: readonly string[];
  readonly footer: readonly string[];
}
