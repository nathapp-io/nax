/**
 * Context Engine v2 — Manifest Types
 *
 * Defines the manifest and chunk types that are persisted to disk.
 * These types are extracted from types.ts to keep that file within size limits.
 *
 * See: docs/specs/SPEC-context-engine-v2.md
 */

import type { AdapterFailure } from "./types";
import type { ChunkKind, ChunkRole, ChunkScope } from "./types";

/** Effectiveness signal annotated on a chunk post-story (Amendment A AC-45). */
export interface ChunkEffectiveness {
  /** Whether the chunk's advice was followed, contradicted, ignored, or unknown. */
  signal: "followed" | "contradicted" | "ignored" | "unknown";
  /** Short evidence string (review finding text, diff excerpt, etc.) */
  evidence?: string;
}

/** A single context chunk produced by a provider and packed into the bundle. */
export interface ContextChunk {
  /** Stable id: `<providerId>:<contentHash8>` */
  id: string;
  /** Provider that produced this chunk */
  providerId: string;
  /** Chunk classification */
  kind: ChunkKind;
  /** Rendering scope (determines section order in push markdown) */
  scope: ChunkScope;
  /** Audience filter — chunk is included only when caller role matches */
  role: ChunkRole[];
  /** Chunk content (markdown) */
  content: string;
  /** Estimated token count */
  tokens: number;
  /** Provider's raw relevance score before adjustments (preserved for traceability) */
  rawScore?: number;
  /** Final score after role × freshness × kind adjustments */
  score: number;
  /** True when chunk is detected as stale (post-GA: staleness signal) */
  stale?: boolean;
  /** True when chunk is a stale candidate (Amendment A AC-46) */
  staleCandidate?: boolean;
  /** Reason recorded in manifest when chunk was floor-included despite budget overflow */
  reason?: string;
  /** Effectiveness signal annotated post-story (Amendment A AC-45) */
  effectiveness?: ChunkEffectiveness;
}

/**
 * Packing manifest — written alongside ContextBundle for audit and debugging.
 * Records exactly what was included/excluded and why.
 */
export interface ContextManifest {
  /** Unique ID for this assemble() call */
  requestId: string;
  /** Pipeline stage that requested context */
  stage: string;
  /** Total token budget passed in ContextRequest.budgetTokens */
  totalBudgetTokens: number;
  /**
   * Effective token ceiling actually used by `packChunks` — i.e.
   * `min(totalBudgetTokens, availableBudgetTokens)` after agent-profile and
   * reserve subtractions. Absent on manifests written before this field
   * existed (US-003); downstream consumers must treat absence as
   * "unknown ceiling" and fall back gracefully.
   */
  effectiveBudget?: number;
  /** Tokens actually used by included chunks + digest */
  usedTokens: number;
  /** IDs of chunks that were packed into the push markdown */
  includedChunks: string[];
  /** Chunks that were excluded, with reason */
  excludedChunks: Array<{
    id: string;
    reason: "below-min-score" | "budget" | "dedupe" | "role-filter" | "stale";
  }>;
  /**
   * All chunk IDs that were floor-packed (static + feature kinds).
   * Every chunk that the budget floor rule included lands here, whether or not
   * it caused an overage. Operators can check this to verify that floor
   * providers actually contributed to the bundle.
   */
  floorItems: string[];
  /**
   * Subset of floorItems whose inclusion pushed usedTokens past budgetTokens.
   * Empty when the floor fit comfortably within budget.
   */
  floorOverageItems?: string[];
  /**
   * Per-chunk token cost, keyed by chunk ID, for every chunk in
   * `includedChunks`. Absent when nothing was packed.
   *
   * Written so downstream consumers (curator `chunk-included` observations)
   * can report a real token cost per chunk instead of a placeholder. Without
   * it the context budget cannot be tuned against measured data — see #1421.
   * A sibling map rather than a shape change to `includedChunks`, which is a
   * persisted schema other readers index by ID.
   */
  chunkTokens?: Record<string, number>;
  /** Tokens used by the digest string */
  digestTokens: number;
  /** Wall-clock time for the assemble() call in milliseconds */
  buildMs: number;
  /**
   * Per-provider execution outcomes for this assemble() call.
   * Recorded even when a provider fails or returns nothing, so the manifest
   * can explain whether absent context was due to policy, budget, or provider error.
   */
  providerResults?: Array<{
    providerId: string;
    /** "ok" = returned ≥1 chunk; "empty" = succeeded but returned no chunks; "failed" = threw; "timeout" = timed out */
    status: "ok" | "empty" | "failed" | "timeout";
    /**
     * How this provider was activated for the stage.
     * Omitted for synthetic entries such as "plan-digest".
     */
    source?: "stage-config" | "extra";
    chunkCount: number;
    durationMs: number;
    /** Total tokens across all chunks returned by this provider */
    tokensProduced: number;
    /**
     * Total LLM cost for this provider call in USD (AC-25).
     * Sum of costUsd across all chunks returned. Absent when the provider
     * reported no chunk costs (i.e. free providers such as git or file-scan).
     */
    costUsd?: number;
    error?: string;
  }>;
  /**
   * Absolute path to the repository root at the time of assembly (AC-60).
   * Populated from ContextRequest.repoRoot. Lets nax context inspect
   * show which repo a manifest came from.
   */
  repoRoot?: string;
  /**
   * Absolute path to the story's package directory at the time of assembly (AC-60).
   * Equals repoRoot for non-monorepo projects (AC-61).
   */
  packageDir?: string;
  /**
   * Set by rebuildForAgent() when an agent-swap failure triggered the rebuild.
   * Records which agents were involved and why the swap occurred (Phase 5.5).
   */
  rebuildInfo?: {
    priorAgentId: string;
    newAgentId: string;
    failureCategory: AdapterFailure["category"];
    failureOutcome: AdapterFailure["outcome"];
    /** Chunk IDs from the prior bundle before the rebuild (AC-39). */
    priorChunkIds: string[];
    /** Chunk IDs in the rebuilt bundle, including any injected failure-note (AC-39). */
    newChunkIds: string[];
    /** Best-effort correlation from prior chunk ID to rebuilt chunk ID (AC-39). */
    chunkIdMap: Array<{ priorChunkId: string; newChunkId: string }>;
  };
  /**
   * First 300 chars of each included chunk's content (Amendment A AC-45).
   * Written at assemble() time; used by annotateManifestEffectiveness() post-story
   * to compare chunk content against agent output / diff / review findings.
   * Keyed by chunk ID.
   */
  chunkSummaries?: Record<string, string>;
  /**
   * IDs of included chunks that had staleCandidate: true (Amendment A AC-46).
   * Populated by orchestrator at assemble() time when staleness detection fires.
   */
  staleChunks?: string[];
  /**
   * Per-chunk effectiveness signals written post-story (Amendment A AC-45).
   * Keyed by chunk ID. Written by annotateManifestEffectiveness() after the
   * story pipeline completes; absent until then.
   */
  chunkEffectiveness?: Record<string, ChunkEffectiveness>;
}
