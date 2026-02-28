/**
 * State Persistence for Pause/Resume (v0.15.0 US-003)
 *
 * Serializes run state when pausing, loads state when resuming.
 */

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
    await Bun.write(stateFile, ""); // truncate
    // Note: Bun doesn't have fs.unlink, so we truncate instead
  } catch {
    // Ignore errors
  }
}

/**
 * Save a pending interaction to the interactions directory
 */
export async function savePendingInteraction(request: InteractionRequest, featureDir: string): Promise<string> {
  const interactionsDir = path.join(featureDir, "interactions");
  // Ensure directory exists
  await Bun.write(path.join(interactionsDir, ".gitkeep"), "");

  const filename = `${request.id}.json`;
  const filePath = path.join(interactionsDir, filename);
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
  const interactionsDir = path.join(featureDir, "interactions");
  const filename = `${requestId}.json`;
  const filePath = path.join(interactionsDir, filename);

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
  const interactionsDir = path.join(featureDir, "interactions");
  const filename = `${requestId}.json`;
  const filePath = path.join(interactionsDir, filename);

  try {
    await Bun.write(filePath, ""); // truncate
  } catch {
    // Ignore errors
  }
}

/**
 * List all pending interaction IDs
 */
export async function listPendingInteractions(featureDir: string): Promise<string[]> {
  const interactionsDir = path.join(featureDir, "interactions");

  try {
    const dir = Bun.file(interactionsDir);
    const exists = await dir.exists();
    if (!exists) {
      return [];
    }

    // Use Bun.spawn to list files
    const proc = Bun.spawn(["ls", interactionsDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const files = output
      .split("\n")
      .filter((f) => f.endsWith(".json") && f !== ".gitkeep")
      .map((f) => f.replace(".json", ""));

    return files;
  } catch {
    return [];
  }
}
