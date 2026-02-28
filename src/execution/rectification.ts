/**
 * Rectification Core Logic (v0.11)
 *
 * DEPRECATED: Use src/verification/rectification.ts instead.
 * This file is kept for backward compatibility only.
 */

// Re-export from unified verification layer
export {
  type RectificationState,
  shouldRetryRectification,
  createRectificationPrompt,
} from "../verification/rectification";
