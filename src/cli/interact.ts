/**
 * Interact CLI Command (v0.15.0 US-006)
 *
 * Manage pending interactions from CLI:
 * - nax interact list -f <feature>
 * - nax interact respond <id> --action approve|reject|choose|input --value <val>
 * - nax interact cancel <id>
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { resolveProject } from "../commands/common";
import type { InteractionRequest, InteractionResponse } from "../interaction";
import {
  deletePendingInteraction,
  listPendingInteractions,
  loadPendingInteraction,
  savePendingInteraction,
} from "../interaction";

/**
 * Options for interact list command
 */
export interface InteractListOptions {
  /** Feature name (required) */
  feature: string;
  /** Explicit project directory */
  dir?: string;
  /** JSON output mode */
  json?: boolean;
}

/**
 * Options for interact respond command
 */
export interface InteractRespondOptions {
  /** Feature name */
  feature?: string;
  /** Explicit project directory */
  dir?: string;
  /** Action to take */
  action: "approve" | "reject" | "choose" | "input" | "skip" | "abort";
  /** Value (for choose/input) */
  value?: string;
  /** JSON output mode */
  json?: boolean;
}

/**
 * Options for interact cancel command
 */
export interface InteractCancelOptions {
  /** Feature name */
  feature?: string;
  /** Explicit project directory */
  dir?: string;
  /** JSON output mode */
  json?: boolean;
}

/**
 * List pending interactions for a feature
 */
export async function interactListCommand(options: InteractListOptions): Promise<void> {
  const resolved = resolveProject({
    dir: options.dir,
    feature: options.feature,
  });

  if (!resolved.featureDir) {
    throw new Error("Feature directory not resolved");
  }

  const interactionsDir = join(resolved.featureDir, "interactions");
  if (!existsSync(interactionsDir)) {
    if (options.json) {
      console.log(JSON.stringify({ interactions: [] }));
    } else {
      console.log(chalk.dim("No pending interactions."));
    }
    return;
  }

  const ids = await listPendingInteractions(resolved.featureDir);

  if (ids.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ interactions: [] }));
    } else {
      console.log(chalk.dim("No pending interactions."));
    }
    return;
  }

  // Load full requests
  const requests: InteractionRequest[] = [];
  for (const id of ids) {
    const req = await loadPendingInteraction(id, resolved.featureDir);
    if (req) {
      requests.push(req);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ interactions: requests }, null, 2));
    return;
  }

  // Display table
  console.log(chalk.bold(`\n📬 Pending Interactions (${options.feature})\n`));

  for (const req of requests) {
    const safety = req.metadata?.safety ?? "unknown";
    const safetyIcon = safety === "red" ? "🔴" : safety === "yellow" ? "🟡" : "🟢";
    const timeRemaining = req.timeout ? Math.max(0, req.createdAt + req.timeout - Date.now()) : null;

    console.log(`${safetyIcon} ${chalk.bold(req.id)}`);
    console.log(chalk.dim(`   Type:     ${req.type}`));
    console.log(chalk.dim(`   Stage:    ${req.stage}`));
    console.log(chalk.dim(`   Summary:  ${req.summary}`));
    if (req.storyId) {
      console.log(chalk.dim(`   Story:    ${req.storyId}`));
    }
    console.log(chalk.dim(`   Fallback: ${req.fallback}`));
    if (timeRemaining !== null) {
      const timeoutSec = Math.floor(timeRemaining / 1000);
      console.log(chalk.dim(`   Timeout:  ${timeoutSec}s remaining`));
    }
    if (req.options && req.options.length > 0) {
      console.log(chalk.dim("   Options:"));
      for (const opt of req.options) {
        console.log(chalk.dim(`     [${opt.key}] ${opt.label}`));
      }
    }
    console.log();
  }
}

/**
 * Respond to a pending interaction
 */
export async function interactRespondCommand(requestId: string, options: InteractRespondOptions): Promise<void> {
  // Find the feature by searching all features for the request
  let featureDir: string | null = null;
  let request: InteractionRequest | null = null;

  if (options.feature) {
    const resolved = resolveProject({
      dir: options.dir,
      feature: options.feature,
    });
    featureDir = resolved.featureDir ?? null;
    if (featureDir) {
      request = await loadPendingInteraction(requestId, featureDir);
    }
  } else {
    // Search all features
    const resolved = resolveProject({ dir: options.dir });
    const featuresDir = join(resolved.projectDir, "nax", "features");
    if (existsSync(featuresDir)) {
      const { readdirSync } = await import("node:fs");
      const features = readdirSync(featuresDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      for (const feature of features) {
        const dir = join(featuresDir, feature);
        const req = await loadPendingInteraction(requestId, dir);
        if (req) {
          request = req;
          featureDir = dir;
          break;
        }
      }
    }
  }

  if (!request || !featureDir) {
    throw new Error(`Interaction request not found: ${requestId}`);
  }

  // Validate action matches request type
  if (options.action === "choose" && request.type !== "choose") {
    throw new Error(`Action "choose" only valid for type "choose" (request is ${request.type})`);
  }

  if (options.action === "input" && request.type !== "input") {
    throw new Error(`Action "input" only valid for type "input" (request is ${request.type})`);
  }

  if (options.action === "choose" && !options.value) {
    throw new Error("--value required for action choose");
  }

  if (options.action === "input" && !options.value) {
    throw new Error("--value required for action input");
  }

  // Create response
  const response: InteractionResponse = {
    requestId,
    action: options.action,
    value: options.value,
    respondedBy: "cli",
    respondedAt: Date.now(),
  };

  // Save response (write to responses/ directory)
  const responsesDir = join(featureDir, "responses");
  await Bun.write(join(responsesDir, ".gitkeep"), "");
  const responseFile = join(responsesDir, `${requestId}.json`);
  await Bun.write(responseFile, JSON.stringify(response, null, 2));

  // Delete pending interaction
  await deletePendingInteraction(requestId, featureDir);

  if (options.json) {
    console.log(JSON.stringify({ success: true, response }));
  } else {
    console.log(chalk.green(`✅ Response recorded: ${options.action}`));
    if (options.value) {
      console.log(chalk.dim(`   Value: ${options.value}`));
    }
  }
}

/**
 * Cancel a pending interaction (applies fallback)
 */
export async function interactCancelCommand(requestId: string, options: InteractCancelOptions): Promise<void> {
  // Find the feature by searching all features for the request
  let featureDir: string | null = null;
  let request: InteractionRequest | null = null;

  if (options.feature) {
    const resolved = resolveProject({
      dir: options.dir,
      feature: options.feature,
    });
    featureDir = resolved.featureDir ?? null;
    if (featureDir) {
      request = await loadPendingInteraction(requestId, featureDir);
    }
  } else {
    // Search all features
    const resolved = resolveProject({ dir: options.dir });
    const featuresDir = join(resolved.projectDir, "nax", "features");
    if (existsSync(featuresDir)) {
      const { readdirSync } = await import("node:fs");
      const features = readdirSync(featuresDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      for (const feature of features) {
        const dir = join(featuresDir, feature);
        const req = await loadPendingInteraction(requestId, dir);
        if (req) {
          request = req;
          featureDir = dir;
          break;
        }
      }
    }
  }

  if (!request || !featureDir) {
    throw new Error(`Interaction request not found: ${requestId}`);
  }

  // Create response with fallback action
  const fallbackAction = request.fallback === "continue" ? "approve" : request.fallback === "skip" ? "skip" : "abort";

  const response: InteractionResponse = {
    requestId,
    action: fallbackAction,
    respondedBy: "cli-cancel",
    respondedAt: Date.now(),
  };

  // Save response
  const responsesDir = join(featureDir, "responses");
  await Bun.write(join(responsesDir, ".gitkeep"), "");
  const responseFile = join(responsesDir, `${requestId}.json`);
  await Bun.write(responseFile, JSON.stringify(response, null, 2));

  // Delete pending interaction
  await deletePendingInteraction(requestId, featureDir);

  if (options.json) {
    console.log(JSON.stringify({ success: true, response }));
  } else {
    console.log(chalk.yellow(`⏭ Interaction cancelled (fallback: ${request.fallback})`));
  }
}
