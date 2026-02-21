/**
 * Analyze Module Types
 *
 * Types for codebase scanning and LLM-enhanced classification.
 */

import type { Complexity } from "../config";

/** Codebase scan result */
export interface CodebaseScan {
  /** File tree (src/ directory, max depth 3) */
  fileTree: string;
  /** Package dependencies */
  dependencies: Record<string, string>;
  /** Dev dependencies */
  devDependencies: Record<string, string>;
  /** Detected test patterns */
  testPatterns: string[];
}

/** LLM classification result for a single story */
export interface StoryClassification {
  /** Story ID (e.g., "US-001") */
  storyId: string;
  /** Classified complexity */
  complexity: Complexity;
  /** Context files to inject into agent prompt before execution */
  contextFiles: string[];
  /** Reasoning for the classification */
  reasoning: string;
  /** Estimated lines of code to change */
  estimatedLOC: number;
  /** Potential implementation risks */
  risks: string[];
}

/** LLM classifier response (array of classifications) */
export type ClassifierResponse = StoryClassification[];

/** Classification method used */
export type ClassificationMethod = "llm" | "keyword-fallback";

/** Classification result with metadata */
export interface ClassificationResult {
  /** Classification data */
  classifications: StoryClassification[];
  /** Method used (llm or keyword-fallback) */
  method: ClassificationMethod;
  /** Error message if LLM failed and fallback was used */
  fallbackReason?: string;
}
