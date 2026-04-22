/**
 * State Persistence for Pause/Resume (v0.15.0 US-003)
 *
 * Serializes run state when pausing, loads state when resuming.
 */

import { unlink } from "node:fs/promises";
import * as path from "node:path";
import type { InteractionRequest, InteractionResponse } from "./types";

/** Serialized run state for pause/resume */
export interface RunState {
  /** Feature name */
  feature: string;
  /** PRD path */
  prdPath: string;
  /** Current iteration number */
  iteration: number;
  /** Accumulated cost (USD) */
  totalCost: number;
  /** Stories completed */
  storiesCompleted: number;
  /** Pending interactions */
  pendingInteractions: InteractionRequest[];
  /** Completed interactions */
  completedInteractions: Array<{
    request: InteractionRequest;
    response: InteractionResponse;
  }>;
  /** Pause timestamp */
  pausedAt: number;
  /** Pause reason */
  pauseReason: string;
  /** Current story ID (if paused mid-story) */
  currentStoryId?: string;
  /** Current tier */
  currentTier?: string;
  /** Current model */
  currentModel?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/** Safe interaction ID: UUID-style or slug-only characters, bounded length */
const SAFE_INTERACTION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate that an interaction ID contains only safe characters.
 * Prevents path traversal when the ID is interpolated into filesystem paths.
 */
export function validateInteractionId(id: string): void {
  if (!SAFE_INTERACTION_ID_RE.test(id)) {
    throw new Error(`Invalid interaction ID — must match [a-zA-Z0-9_-]{1,128}: ${id}`);
  }
}

/**
 * Assert that a resolved file path stays within the expected base directory.
 * Defense-in-depth alongside ID validation.
 */
function assertPathWithin(filePath: string, baseDir: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(baseDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path traversal detected: ${filePath} is outside ${baseDir}`);
  }
}

/**
 * Serialize run state to JSON file
 */
export async function serializeRunState(state: RunState, featureDir: string): Promise<string> {
  const stateFile = path.join(featureDir, "run-state.json");
  const json = JSON.stringify(state, null, 2);
  await Bun.write(stateFile, json);
  return stateFile;
}

/**
 * Deserialize run state from JSON file
 */
export async function deserializeRunState(featureDir: string): Promise<RunState | null> {
  const stateFile = path.join(featureDir, "run-state.json");
  try {
    const file = Bun.file(stateFile);
    const exists = await file.exists();
    if (!exists) {
      return null;
    }
    const json = await file.text();
    const state = JSON.parse(json) as RunState;
    return state;
  } catch (err) {
    // Corrupted or invalid state file
    return null;
  }
}

/**
 * Delete run state file (after successful resume)
 */
export async function clearRunState(featureDir: string): Promise<void> {
  const stateFile = path.join(featureDir, "run-state.json");
  try {
    await unlink(stateFile);
  } catch {
    // Ignore errors (file may not exist)
  }
}

/**
 * Save a pending interaction to the interactions directory
 */
export async function savePendingInteraction(request: InteractionRequest, featureDir: string): Promise<string> {
  validateInteractionId(request.id);
  const interactionsDir = path.join(featureDir, "interactions");
  // Ensure directory exists
  await Bun.write(path.join(interactionsDir, ".gitkeep"), "");

  const filename = `${request.id}.json`;
  const filePath = path.join(interactionsDir, filename);
  assertPathWithin(filePath, interactionsDir);
  const json = JSON.stringify(request, null, 2);
  await Bun.write(filePath, json);
  return filePath;
}

/**
 * Load a pending interaction from the interactions directory
 */
export async function loadPendingInteraction(
  requestId: string,
  featureDir: string,
): Promise<InteractionRequest | null> {
  validateInteractionId(requestId);
  const interactionsDir = path.join(featureDir, "interactions");
  const filename = `${requestId}.json`;
  const filePath = path.join(interactionsDir, filename);
  assertPathWithin(filePath, interactionsDir);

  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) {
      return null;
    }
    const json = await file.text();
    const request = JSON.parse(json) as InteractionRequest;
    return request;
  } catch {
    return null;
  }
}

/**
 * Delete a pending interaction file (after response received)
 */
export async function deletePendingInteraction(requestId: string, featureDir: string): Promise<void> {
  validateInteractionId(requestId);
  const interactionsDir = path.join(featureDir, "interactions");
  const filename = `${requestId}.json`;
  const filePath = path.join(interactionsDir, filename);
  assertPathWithin(filePath, interactionsDir);

  try {
    await unlink(filePath);
  } catch {
    // Ignore errors (file may already be deleted)
  }
}

/**
 * List all pending interaction IDs
 */
export async function listPendingInteractions(featureDir: string): Promise<string[]> {
  const interactionsDir = path.join(featureDir, "interactions");

  try {
    const ids: string[] = [];
    const glob = new Bun.Glob("*.json");
    for await (const filename of glob.scan({ cwd: interactionsDir })) {
      const id = filename.slice(0, -5); // strip ".json"
      // Only yield IDs that pass validation (filters out any legacy malformed entries)
      try {
        validateInteractionId(id);
        ids.push(id);
      } catch {
        // Skip invalid filenames
      }
    }
    return ids;
  } catch {
    return [];
  }
}
