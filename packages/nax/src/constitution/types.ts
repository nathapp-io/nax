/**
 * Constitution types
 *
 * The constitution is a project-level governance document that defines coding
 * standards, architectural rules, testing requirements, and forbidden patterns.
 * It gets injected into every agent session prompt.
 */

/** Constitution configuration */
export interface ConstitutionConfig {
  /** Enable constitution loading and injection */
  enabled: boolean;
  /** Path to constitution file relative to nax/ directory */
  path: string;
  /** Maximum tokens allowed for constitution content */
  maxTokens: number;
  /** Skip loading global constitution (default: false) */
  skipGlobal?: boolean;
}

/** Constitution load result */
export interface ConstitutionResult {
  /** Constitution content (may be truncated) */
  content: string;
  /** Estimated token count */
  tokens: number;
  /** Whether content was truncated */
  truncated: boolean;
  /** Original token count before truncation (if truncated) */
  originalTokens?: number;
}
