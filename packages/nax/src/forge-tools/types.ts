import type { ForgeDeps, PrRef } from "@/forge";

export interface ForgeReadBinding {
  readonly resolveRef: () => Promise<PrRef>;
  readonly deps: ForgeDeps;
  readonly cwd: string;
}

export interface ToolResultParts {
  readonly header: readonly string[];
  /** Minimal validated identity is retained; untrusted detail is budgeted separately. */
  readonly fencedHeader?: { readonly identity: string; readonly detail: string };
  /** Semantic prefix retained even when the remaining entry is partially fitted. */
  readonly entryPrefix?: (entry: string) => string;
  readonly entries: readonly string[];
  readonly footer: readonly string[];
}
